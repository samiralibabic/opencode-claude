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
  startMockedProxy,
  textTurn,
} from "./helpers.ts";

async function isolation(
  ctx: Awaited<ReturnType<typeof startMockedProxy>>,
) {
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
