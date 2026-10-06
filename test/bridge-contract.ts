/**
 * Bridge contract tests: what reaches Claude from an OpenCode 1.x request,
 * and what Claude can reach. The contract itself is documented in the
 * opencode-config repo (docs/claude-bridge-contract.md).
 *
 * Run: bun test/bridge-contract.ts
 */
import {
  assert,
  bashTool,
  callTool,
  mockHandle,
  startMockedProxy,
  textDelta,
  textTurn,
} from "./helpers.ts";

type Ctx = Awaited<ReturnType<typeof startMockedProxy>>;

async function userMessages() {
  const {
    collectSteeringMessages,
    latestUserPrompt,
    priorMessagesOf,
    SYNTHETIC_TOOL_MEDIA_PROMPT,
  } = await import("../src/prompt.ts");

  // Steering: only real user messages after the last tool result.
  const texts = (messages: unknown[]) =>
    collectSteeringMessages(messages as any).map((m) => m.text);
  assert.deepEqual(texts([{ role: "user", content: "hi" }]), []);
  assert.deepEqual(texts([{ role: "user", content: "old" }, { role: "tool", content: "r" }]), []);
  assert.deepEqual(
    texts([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: [{ type: "text", text: "use port 8080" }] },
      { role: "user", content: "and skip tests" },
    ]),
    ["use port 8080", "and skip tests"],
  );
  assert.deepEqual(
    texts([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: SYNTHETIC_TOOL_MEDIA_PROMPT },
    ]),
    [],
    "OpenCode's tool-media message is not steering",
  );

  // Queued messages at turn start all reach Claude, in order.
  const queued = [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "stop using python" },
    { role: "user", content: "stop! now!" },
  ];
  assert.equal(latestUserPrompt(queued), "stop using python\n\nstop! now!");
  assert.equal(priorMessagesOf(queued).length, 2, "queued messages not repeated in history");

  // After a tool step the newest real user message stands in, never an
  // older answered one, and the tool-media message is skipped.
  assert.equal(
    latestUserPrompt([
      { role: "user", content: "run it" },
      { role: "assistant", content: null },
      { role: "tool", content: "r" },
      { role: "user", content: SYNTHETIC_TOOL_MEDIA_PROMPT },
    ]),
    "run it",
  );
}

async function steering(ctx: Ctx) {
  const { post, proxy } = ctx;

  async function run(session: string, afterResult: unknown[]) {
    let received: string | null = null;
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          const res = await callTool(params, "bash", { command: "sleep 40" });
          received = res.content.map((b) => b.text ?? "").join("\n");
          yield { type: "user", message: { role: "user", content: [] } };
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      ),
    );
    const first = (await (await post(session, {
      tools: [bashTool],
      messages: [{ role: "user", content: "run it" }],
    })).json()) as any;
    const call = first.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "bash");
    const resume = (await (await post(session, {
      tools: [bashTool],
      messages: [
        { role: "user", content: "run it" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "exit 0" },
        ...afterResult,
      ],
    })).json()) as any;
    assert.match(String(resume.choices[0].message.content), /DONE/);
    return received as string | null;
  }

  const steered = await run("steer-yes", [
    { role: "user", content: "Actually, the secret word is PINEAPPLE." },
  ]);
  assert.ok(steered, "tool result delivered");
  assert.ok(steered!.startsWith("exit 0"));
  assert.match(steered!, /<system-reminder>[\s\S]*PINEAPPLE[\s\S]*<\/system-reminder>/);

  const plain = await run("steer-no", []);
  assert.equal(plain, "exit 0");

  // Results of one park arriving over two resume requests: the queued
  // message rides the first resolved result only, never both.
  const got: string[] = [];
  proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "steer-split-sess" };
        const a = callTool(params, "bash", { command: "a" });
        const b = callTool(params, "bash", { command: "b" });
        for (const res of await Promise.all([a, b])) {
          got.push(res.content.map((c) => c.text ?? "").join("\n"));
        }
        yield { type: "user", message: { role: "user", content: [] } };
        yield textDelta("DONE");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    ),
  );
  const turn = [{ role: "user", content: "run both" }];
  const parked = (await (await post("steer-split", { tools: [bashTool], messages: turn })).json()) as any;
  const calls = parked.choices[0].message.tool_calls as any[];
  assert.equal(calls.length, 2, "both calls parked");
  const asst = { role: "assistant", content: null, tool_calls: calls };
  const steer = { role: "user", content: "Use MANGO instead." };
  const partial = (await (await post("steer-split", {
    tools: [bashTool],
    messages: [...turn, asst, { role: "tool", tool_call_id: calls[0].id, content: "ra" }, steer],
  })).json()) as any;
  assert.equal(partial.choices[0].finish_reason, "tool_calls");
  const done = (await (await post("steer-split", {
    tools: [bashTool],
    messages: [
      ...turn,
      asst,
      { role: "tool", tool_call_id: calls[0].id, content: "ra" },
      { role: "tool", tool_call_id: calls[1].id, content: "rb" },
      steer,
    ],
  })).json()) as any;
  assert.match(String(done.choices[0].message.content), /DONE/);
  assert.equal(got.join("\n").match(/MANGO/g)?.length, 1, "steering forwarded once");
}

async function queuedTurnStart(ctx: Ctx) {
  const { post, proxy } = ctx;
  let prompt: unknown = null;
  proxy.setClaudeQueryStarter(async (params) => {
    prompt = params.prompt;
    return textTurn("ok", "queued-sess");
  });
  await (await post("queued", {
    messages: [
      { role: "user", content: "first question" },
      { role: "user", content: "and a second one" },
    ],
  })).json();
  assert.match(String(prompt), /first question\n\nand a second one/);
}

async function isolation(ctx: Ctx) {
  const { post, proxy } = ctx;
  let seen: Record<string, any> | null = null;
  proxy.setClaudeQueryStarter(async (params) => {
    seen = params as Record<string, any>;
    return textTurn("ok", "iso-sess");
  });

  // Chat turn with OpenCode tools: only those tools, through OpenCode.
  await (await post("iso-tools", {
    tools: [bashTool],
    messages: [{ role: "user", content: "hi" }],
  })).json();
  assert.deepEqual(seen!.tools, [], "built-in tools disabled");
  assert.equal(seen!.isolateMcp, true, "user MCP servers/connectors not attached");
  assert.equal(seen!.permissionMode, "bypassPermissions");
  assert.equal(seen!.canUseTool, undefined);
  assert.deepEqual(seen!.allowedTools, ["mcp__opencode__bash"]);

  // Chat turn without OpenCode tools: no tools at all, nothing auto-approved.
  seen = null;
  await (await post("iso-none", {
    messages: [{ role: "user", content: "hi" }],
  })).json();
  assert.deepEqual(seen!.tools, []);
  assert.equal(seen!.isolateMcp, true);
  assert.equal(seen!.permissionMode, "dontAsk");
  assert.equal(seen!.canUseTool, undefined);
  assert.equal(seen!.allowDangerouslySkipPermissions, false);

  // Meta turn (title) is isolated too.
  seen = null;
  await (await post("iso-title", {
    messages: [
      { role: "system", content: "You are a title generator. Output only the title." },
      { role: "user", content: "hi" },
    ],
  })).json();
  assert.equal(seen!.isolateMcp, true);
  assert.deepEqual(seen!.tools, []);
}

async function queryOptions() {
  const { startClaudeQuery } = await import("../src/query.ts");
  const capture = async (params: Record<string, unknown>) => {
    let options: Record<string, any> | null = null;
    const handle = await startClaudeQuery({
      prompt: "hi",
      cwd: process.cwd(),
      ...params,
      queryImpl: () => (input: { options: Record<string, any> }) => {
        options = input.options;
        return (async function* () {})();
      },
    } as any);
    handle.close();
    return options!;
  };

  const isolated = await capture({ isolateMcp: true, disableAutoMemory: true });
  assert.equal(isolated.strictMcpConfig, true);
  assert.equal(isolated.settings.disableClaudeAiConnectors, true);
  assert.equal(isolated.settings.autoMemoryEnabled, false);
  assert.equal(isolated.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");

  const plain = await capture({});
  assert.equal(plain.strictMcpConfig, undefined);
  assert.equal(plain.settings, undefined);
  assert.equal(plain.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);

  // OPENCODE_CLAUDE_CLI_PATH pins the CLI without resolving PATH.
  const { CLI_PATH_ENV } = await import("../src/executable-path.ts");
  const pinned = await capture({
    env: { ...process.env, [CLI_PATH_ENV]: "/opt/pinned/claude" },
  });
  assert.equal(pinned.pathToClaudeCodeExecutable, "/opt/pinned/claude");
}

async function main() {
  const ctx = await startMockedProxy("contract");
  try {
    await userMessages();
    await steering(ctx);
    await queuedTurnStart(ctx);
    await isolation(ctx);
    await queryOptions();
  } finally {
    ctx.proxy.setClaudeQueryStarter(null);
    await ctx.proxy.stopProxy();
  }
  console.log("ok — bridge contract tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
