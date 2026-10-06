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

/** System messages shaped like OpenCode 1.18's (session/llm/request.ts). */
function openCodeSystem(head: string) {
  const env = [
    "You are powered by the model named claude-opus-5-5[1m]. The exact model ID is claude-code/claude-opus-5-5[1m]",
    "Here is some useful information about the environment you are running in:",
    "<env>",
    "  Working directory: /work/app",
    "  Workspace root folder: /work/app",
    "  Is directory a git repo: yes",
    "  Platform: darwin",
    // temporal-context rewrites OpenCode's "Today's date:" line in place.
    "  Current date: 2026-10-06 (Tuesday; timezone: Europe/Berlin)",
    "</env>",
  ].join("\n");
  const first = [
    head,
    env,
    "Instructions from: /home/u/.config/opencode/AGENTS.md\n# Decision ownership\nAsk before choosing GLOBAL-RULE-7.",
    "Instructions from: /work/app/AGENTS.md\nPROJECT-RULE-3: run make check.",
    "Skills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description.\n<available_skills>\n  <skill><name>wrangler</name></skill>\n</available_skills>",
    "<mcp_instructions>\n  <server name=\"pencil\">\n    Use pencil for .pen files.\n  </server>\n</mcp_instructions>",
  ].join("\n");
  return [
    { role: "system", content: first },
    {
      role: "system",
      content: "## Session-scoped durable task state\n\nThis OpenCode session's durable state path is `.agent/sessions/ses_1/task.md`.",
    },
    {
      role: "system",
      content: "<temporal_metadata>\nConversation history may contain <conversation_date/> markers.\n</temporal_metadata>",
    },
  ];
}

const STOCK_HEAD =
  "You are OpenCode, the best coding agent on the planet.\n\nYou are an interactive CLI tool that helps users with software engineering tasks.";

async function systemContext(ctx: Ctx) {
  const { openCodeContext } = await import("../src/opencode-context.ts");

  // Built-in agent: stock prompt and stock env lines dropped, the rest kept.
  const built = openCodeContext(openCodeSystem(STOCK_HEAD));
  assert.equal(built.agentPrompt, "");
  const text = built.blocks.join("\n\n");
  for (const kept of [
    "Current date: 2026-10-06 (Tuesday; timezone: Europe/Berlin)",
    "Instructions from: /home/u/.config/opencode/AGENTS.md",
    "GLOBAL-RULE-7",
    "PROJECT-RULE-3",
    "<available_skills>",
    "<mcp_instructions>",
    "durable state path is `.agent/sessions/ses_1/task.md`",
    "<temporal_metadata>",
  ]) {
    assert.ok(text.includes(kept), `forwarded: ${kept}`);
  }
  for (const dropped of [
    "best coding agent on the planet",
    "You are powered by the model named",
    "Working directory:",
    "Platform: darwin",
    "<env>",
  ]) {
    assert.ok(!text.includes(dropped), `not forwarded: ${dropped}`);
  }

  // Custom agent: its own prompt becomes the agent role.
  const custom = openCodeContext(
    openCodeSystem("Independently review the assigned work. Return SCOPE REQUIRED when unclear."),
  );
  assert.match(custom.agentPrompt, /^Independently review the assigned work/);

  // Unknown layout: forwarded whole rather than lost.
  const odd = openCodeContext([{ role: "system", content: "Some other layout. KEEP-ME." }]);
  assert.deepEqual(odd.blocks, ["Some other layout. KEEP-ME."]);

  // End to end: chat turns get only OpenCode's context, nothing from disk.
  const { post, proxy } = ctx;
  let seen: Record<string, any> | null = null;
  proxy.setClaudeQueryStarter(async (params) => {
    seen = params as Record<string, any>;
    return textTurn("ok", "ctx-sess");
  });
  await (await post("ctx-chat", {
    tools: [bashTool],
    messages: [...openCodeSystem(STOCK_HEAD), { role: "user", content: "hi" }],
  })).json();
  assert.deepEqual(seen!.settingSources, [], "no CLAUDE.md, settings or plugins from disk");
  assert.deepEqual(seen!.skills, []);
  assert.equal(seen!.disableAutoMemory, true);
  const append = String(seen!.systemPrompt.append);
  assert.match(append, /mcp__opencode__\* tools/);
  assert.match(append, /# OpenCode context/);
  assert.match(append, /GLOBAL-RULE-7/);
  assert.match(append, /durable state path/);
  assert.match(append, /<temporal_metadata>/);
  assert.doesNotMatch(append, /# Agent role/);
  assert.doesNotMatch(append, /best coding agent on the planet/);

  seen = null;
  await (await post("ctx-sub", {
    tools: [bashTool],
    messages: [
      ...openCodeSystem("Investigate the assigned question. EXPLORE-ROLE."),
      { role: "user", content: "hi" },
    ],
  })).json();
  assert.match(String(seen!.systemPrompt.append), /# Agent role[\s\S]*EXPLORE-ROLE/);

  // Meta turns keep their own one-purpose prompt.
  seen = null;
  await (await post("ctx-title", {
    messages: [
      { role: "system", content: "You are a title generator. Output only the title." },
      { role: "user", content: "hi" },
    ],
  })).json();
  assert.equal(typeof seen!.systemPrompt, "string");
  assert.equal(seen!.disableAutoMemory, true);
}

async function toolSurface(ctx: Ctx) {
  const { fitToolDescription, CLAUDE_TOOL_DESCRIPTION_LIMIT } = await import(
    "../src/proxy.ts"
  );
  // OpenCode 1.18: task.txt (2305 chars) + the subagent list appended last.
  const guidance = "Launch a new agent to handle complex tasks. ".repeat(53);
  const list =
    "Available agent types and the tools they have access to:\n- explore: Read-only research.\n- implement: Implement bounded changes.\n- review: Independent review.";
  const fitted = fitToolDescription(`${guidance}\n${list}`);
  assert.ok(guidance.length > CLAUDE_TOOL_DESCRIPTION_LIMIT);
  assert.ok(
    fitted.slice(0, CLAUDE_TOOL_DESCRIPTION_LIMIT).includes("- review: Independent review."),
    "subagent list survives Claude Code's description cut",
  );
  assert.ok(fitted.includes(guidance.trim()), "nothing dropped");
  assert.equal(fitToolDescription("short"), "short");

  const questionTool = {
    type: "function",
    function: {
      name: "question",
      description: "Ask the user questions.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "Questions to ask",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The question" },
                mode: { type: "string", enum: ["single", "multiple"] },
              },
              required: ["question"],
            },
          },
        },
        required: ["questions"],
      },
    },
  };
  const { post, proxy } = ctx;
  let listedTools: any[] = [];
  let toolArgs: Record<string, unknown> | null = null;
  const { callTool, listTools } = await import("./helpers.ts");
  proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "tools-sess" };
        listedTools = await listTools(params);
        toolArgs = { questions: [{ question: "Ship it?", mode: "single" }], extra: true };
        await callTool(params, "question", toolArgs);
        yield { type: "user", message: { role: "user", content: [] } };
        yield textDelta("DONE");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    ),
  );
  const parked = (await (await post("tools-schema", {
    tools: [questionTool],
    messages: [{ role: "user", content: "ask me" }],
  })).json()) as any;
  const listed = listedTools.find((t) => t.name === "question");
  assert.deepEqual(listed.inputSchema, questionTool.function.parameters, "schema verbatim");
  const call = parked.choices[0].message.tool_calls[0];
  assert.deepEqual(JSON.parse(call.function.arguments), toolArgs, "arguments intact");
  await (await post("tools-schema", {
    tools: [questionTool],
    messages: [
      { role: "user", content: "ask me" },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "yes" },
    ],
  })).json();
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
    await systemContext(ctx);
    await toolSurface(ctx);
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
