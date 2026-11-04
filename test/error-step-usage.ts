/**
 * Regression: a resumed Claude query can fail before making another API call.
 * Its terminal result usage is cumulative for the query, not this OpenCode
 * step, so that step must omit usage rather than trigger context compaction.
 *
 * Run: bun test/error-step-usage.ts
 */
import { assert, bashTool, callTool, mockHandle, startMockedProxy } from "./helpers.ts";

type SseResult = {
  usage?: Record<string, unknown>;
  finish?: string | null;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
};

async function readSse(res: Response): Promise<SseResult> {
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: Record<string, unknown> | undefined;
  let finish: string | null = null;
  for (const line of (await res.text()).split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const payload = JSON.parse(line.slice(6)) as any;
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    for (const call of choice.delta?.tool_calls ?? []) {
      toolCalls.set(call.index, {
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return { usage, finish, toolCalls: [...toolCalls.values()] };
}

function assistantUsage(id: string) {
  return {
    type: "assistant",
    message: {
      id,
      role: "assistant",
      content: [],
      usage: {
        input_tokens: 100,
        output_tokens: 7,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 3,
      },
    },
  };
}

const cumulativeResultUsage = {
  sonnet: {
    inputTokens: 108_485,
    outputTokens: 4_321,
    cacheReadInputTokens: 6_129_712,
    cacheCreationInputTokens: 0,
    costUSD: 123.45,
  },
};

function parkedTurn(options: { error: boolean; replayAssistant?: boolean; nextAssistant?: string; textBeforeResult?: string }) {
  return async (params: any) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "usage-regression" };
        yield assistantUsage("assistant-step-1");
        await callTool(params, "bash", { command: "true" });
        if (options.replayAssistant) yield assistantUsage("assistant-step-1");
        if (options.nextAssistant) yield assistantUsage(options.nextAssistant);
        if (options.textBeforeResult) {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: options.textBeforeResult },
            },
          };
        }
        yield {
          type: "result",
          is_error: options.error,
          result: options.error ? "request rejected before another API call" : "",
          modelUsage: cumulativeResultUsage,
          total_cost_usd: 123.45,
        };
      })(),
    );
}

function turnMessages(call: { id: string; name: string; arguments: string }) {
  return [
    { role: "user", content: "run the tool" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        },
      ],
    },
    { role: "tool", tool_call_id: call.id, content: "ok" },
  ];
}

async function firstStep(post: any, session: string) {
  const step = await readSse(
    await post(session, {
      stream: true,
      tools: [bashTool],
      messages: [{ role: "user", content: "run the tool" }],
    }),
  );
  assert.equal(step.finish, "tool_calls");
  assert.equal(step.toolCalls.length, 1);
  assert.deepEqual(step.usage, {
    prompt_tokens: 143,
    completion_tokens: 7,
    total_tokens: 150,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
  });
  return step.toolCalls[0]!;
}

async function main() {
  const { post, proxy } = await startMockedProxy("error-step-usage");
  let starts = 0;
  proxy.setClaudeQueryStarter(async (params) => {
    starts += 1;
    if (starts === 1) return parkedTurn({ error: true })(params);
    if (starts === 2) return parkedTurn({ error: true, textBeforeResult: "partial" })(params);
    if (starts === 3) return parkedTurn({ error: false, replayAssistant: true })(params);
    if (starts === 4) return parkedTurn({ error: false, nextAssistant: "assistant-step-2" })(params);
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "title-usage" };
        yield {
          type: "result",
          is_error: false,
          modelUsage: {
            haiku: {
              inputTokens: 12,
              outputTokens: 5,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 0,
              costUSD: 0.01,
            },
          },
          total_cost_usd: 0.01,
        };
      })(),
    );
  });

  try {
    // Streaming continuation: only error/result events carry a cumulative
    // snapshot. The prior step still reports the real per-call amount.
    const streamCall = await firstStep(post, "usage-stream-error");
    const streamError = await readSse(
      await post("usage-stream-error", {
        stream: true,
        tools: [bashTool],
        messages: turnMessages(streamCall),
      }),
    );
    assert.equal(streamError.usage, undefined, "error step omits cumulative result usage");

    // Buffered continuation must apply the same rule. A partial text delta
    // keeps this as a 200 response so the response usage is observable.
    const bufferedCall = await firstStep(post, "usage-buffered-error");
    const buffered = (await (
      await post("usage-buffered-error", {
        stream: false,
        tools: [bashTool],
        messages: turnMessages(bufferedCall),
      })
    ).json()) as any;
    assert.equal(buffered.usage, undefined, "buffered error omits cumulative result usage");

    // A duplicate assistant event contributes no new per-call usage. Its
    // successful terminal snapshot is still cumulative, so do not fall back.
    const replayCall = await firstStep(post, "usage-success-replay");
    const replay = await readSse(
      await post("usage-success-replay", {
        stream: true,
        tools: [bashTool],
        messages: turnMessages(replayCall),
      }),
    );
    assert.equal(replay.usage, undefined, "replayed assistant usage does not fall back to cumulative result");

    // New assistant usage on a continued bridge is per-call, but the
    // result cost/model snapshot remains cumulative and must stay omitted.
    const continuedCall = await firstStep(post, "usage-success-cost");
    const continued = await readSse(
      await post("usage-success-cost", {
        stream: true,
        tools: [bashTool],
        messages: turnMessages(continuedCall),
      }),
    );
    assert.deepEqual(continued.usage, {
      prompt_tokens: 143,
      completion_tokens: 7,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
    });

    // A one-shot utility request has no assistant event and no prior bridge
    // usage, so its successful result remains a valid usage fallback.
    const utility = (await (
      await post("usage-title", {
        stream: false,
        messages: [
          { role: "system", content: "You are a title generator." },
          { role: "user", content: "rename this session" },
        ],
      })
    ).json()) as any;
    assert.deepEqual(utility.usage, {
      prompt_tokens: 15,
      completion_tokens: 5,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 3 },
      cost_usd: 0.01,
      model_usage: {
        haiku: {
          input_tokens: 12,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 0,
          cost_usd: 0.01,
        },
      },
    });
    console.log("ok — error-step usage regression passed");
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
