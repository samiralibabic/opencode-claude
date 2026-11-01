/**
 * Several Claude subscriptions, one provider each: account options, the
 * per-request login, resuming one Claude session across accounts, separate
 * limits, account-aware errors, provider seeding and subagents following
 * their parent's account. No live Claude CLI required.
 *
 * Run: bun test/accounts.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assert, bashTool, callTool, mockHandle, startMockedProxy, textDelta, textTurn } from "./helpers.ts";

// The default account's config home must not be the real ~/.claude.
const root = mkdtempSync(join(tmpdir(), "opencode-claude-accounts-"));
const defaultDir = join(root, "default");
const sharedDir = join(root, "shared");
const ownDir = join(root, "own");
mkdirSync(join(defaultDir, "projects", "-work"), { recursive: true });
writeFileSync(join(defaultDir, "projects", "-work", "sess-A.jsonl"), "{}\n");
mkdirSync(sharedDir);
symlinkSync(join(defaultDir, "projects"), join(sharedDir, "projects"));
mkdirSync(join(ownDir, "projects"), { recursive: true });
process.env.CLAUDE_CONFIG_DIR = defaultDir;

const ctx = await startMockedProxy("accounts");
const accounts = await import("../src/accounts.ts");
const rateLimit = await import("../src/rate-limit.ts");
const { withAccountSwitchHint } = await import("../src/failure.ts");
const { ACCOUNT_HEADER, EFFORT_HEADER } = await import("../src/constants.ts");

function post(account: string | null, session: string, body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-claude-session": session,
      ...(account ? { [ACCOUNT_HEADER]: account } : {}),
    },
    body: JSON.stringify({ model: "sonnet", stream: false, ...body }),
  });
}

function failingTurn(text: string) {
  return mockHandle(
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-failed" };
      yield { type: "result", is_error: true, result: text, usage: {} };
    })(),
  );
}

function configure() {
  accounts.configureAccounts([
    { provider: "claude-code-2", configDir: sharedDir },
    { provider: "claude-code-3", configDir: ownDir },
  ]);
}

function accountOptions() {
  // A setup without the option behaves as before: one account, no hints.
  accounts.configureAccounts(undefined);
  assert.deepEqual(accounts.getAccounts().map((a) => a.provider), ["claude-code"]);
  assert.equal(accounts.accountLabel(accounts.defaultAccount()), "Claude Code");
  assert.equal(withAccountSwitchHint("limit", accounts.defaultAccount()), "limit");

  accounts.configureAccounts([
    { provider: "claude-code-2", configDir: "~/.claude-accounts-test" },
    { provider: "claude-code-2", configDir: "/tmp/elsewhere" },
    { provider: "claude-code", configDir: "/tmp/default-again" },
    { provider: "not an id", configDir: "/tmp/z" },
    { provider: "claude-code-3", configDir: "relative/dir" },
    { provider: "claude-code-4", configDir: defaultDir },
    { provider: "claude-code-5" },
    "garbage",
  ]);
  const list = accounts.getAccounts();
  assert.deepEqual(list.map((a) => a.provider), ["claude-code", "claude-code-2"]);
  assert.equal(list[1]!.configDir, join(homedir(), ".claude-accounts-test"), "~/ expands");
  assert.equal(list[0]!.configDir, undefined, "the default account keeps the CLI's own home");
  assert.match(
    readFileSync(join(ctx.tmp, "opencode-claude", "debug.log"), "utf8"),
    /ignoring Claude account/,
    "rejected entries are logged",
  );

  accounts.configureAccounts("not a list");
  assert.deepEqual(accounts.getAccounts().map((a) => a.provider), ["claude-code"]);

  configure();
  const second = accounts.findAccount("claude-code-2")!;
  const env = accounts.accountEnv(second, { PATH: "/bin", ANTHROPIC_API_KEY: "sk", CLAUDE_CONFIG_DIR: "/x" });
  assert.equal(env.CLAUDE_CONFIG_DIR, sharedDir, "an extra account signs in from its own home");
  assert.equal(env.ANTHROPIC_API_KEY, undefined, "credential overrides are still stripped");
  assert.equal(accounts.accountEnv(accounts.defaultAccount(), { CLAUDE_CONFIG_DIR: "/x" }).CLAUDE_CONFIG_DIR, "/x");
  assert.equal(accounts.accountConfigDir(accounts.defaultAccount()), defaultDir);
  assert.equal(accounts.isAccountProvider("claude-code-3"), true);
  assert.equal(accounts.isAccountProvider("openai"), false);

  assert.equal(
    accounts.accountLoginCommand({ provider: "x", configDir: join(homedir(), ".claude-2") }),
    "CLAUDE_CONFIG_DIR=~/.claude-2 claude auth login --claudeai",
  );
  assert.equal(
    accounts.accountLoginCommand({ provider: "x", configDir: "/tmp/with space" }),
    "CLAUDE_CONFIG_DIR='/tmp/with space' claude auth login --claudeai",
  );
  assert.equal(accounts.accountLoginCommand(accounts.defaultAccount()), "claude auth login --claudeai");

  assert.equal(accounts.accountLabel(second), "Claude Code (claude-code-2)");
  accounts.__setAccountStatus("claude-code-2", { loggedIn: true, email: "b@example.test" });
  assert.equal(accounts.accountLabel(second), "Claude · b@example.test", "labelled by sign-in email");
  assert.equal(accounts.accountLabel({ provider: "y", name: "Overflow" }), "Overflow");
  assert.equal(accounts.accountLabel(accounts.defaultAccount()), "Claude Code");
  configure();
  assert.equal(accounts.accountLabel(second), "Claude · b@example.test", "loading the same list again keeps known logins");
}

function separateLimits() {
  configure();
  accounts.__setAccountStatus("claude-code-2", { loggedIn: true, email: "b@example.test" });
  const limit = "You've hit your usage limit · resets 2099-12-01T00:00:00Z";
  rateLimit.recordRateLimitErrorText(limit, "claude-code-9");
  assert.equal(rateLimit.rateLimitGate(Date.now(), "claude-code-9").blocked, true);
  assert.equal(rateLimit.rateLimitGate(Date.now()).blocked, false, "the default account is not blocked");
  assert.equal(rateLimit.rateLimitGate(Date.now(), "claude-code-3").blocked, false);
  assert.ok(existsSync(join(ctx.tmp, "rate-limit.claude-code-9.json")));
  assert.equal(existsSync(join(ctx.tmp, "rate-limit.json")), false);

  rateLimit.__resetRateLimitNoteDedupe();
  const event = { status: "allowed_warning", utilization: 0.93, rateLimitType: "seven_day" };
  const first = rateLimit.recordRateLimitInfo(event, "claude-code-2");
  assert.match(String(rateLimit.maybeRateLimitNote(first, event, "claude-code-2")), /Claude · b@example\.test · seven day · 93%/);
  assert.equal(rateLimit.maybeRateLimitNote(first, event, "claude-code-2"), null, "deduped per account");
  const other = rateLimit.recordRateLimitInfo(event);
  assert.match(String(rateLimit.maybeRateLimitNote(other, event)), /^\[rate-limit\] Claude Code · seven day/, "each account warns once");
  assert.equal(
    rateLimit.normalizeClaudeErrorText(`${limit} · To continue now, switch this session to X in the model picker.`),
    rateLimit.normalizeClaudeErrorText(limit),
    "the switch hint does not defeat error dedupe",
  );
}

async function resumeAcrossAccounts() {
  configure();
  const seen: Array<Record<string, any>> = [];
  let nextSession = "sess-A";
  ctx.proxy.setClaudeQueryStarter(async (params) => {
    seen.push(params as Record<string, any>);
    return textTurn("ok", nextSession);
  });

  const first = await post(null, "ses_move", { messages: [{ role: "user", content: "first question" }] });
  assert.equal(first.status, 200);
  assert.equal(seen[0]!.env.CLAUDE_CONFIG_DIR, defaultDir, "no header runs on the default account");
  assert.equal(seen[0]!.resume, undefined);

  const history = [
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
  ];
  const second = await post("claude-code-2", "ses_move", {
    messages: [...history, { role: "user", content: "second question" }],
  });
  assert.equal(second.status, 200);
  assert.equal(seen[1]!.env.CLAUDE_CONFIG_DIR, sharedDir, "the selected account's login runs the turn");
  assert.equal(seen[1]!.resume, "sess-A", "a shared projects folder resumes the same Claude session");
  assert.equal(seen[1]!.prompt, "second question", "nothing is transferred into the prompt");

  const back = await post("claude-code", "ses_move", {
    messages: [...history, { role: "assistant", content: "x" }, { role: "user", content: "third" }],
  });
  assert.equal(back.status, 200);
  assert.equal(seen[2]!.resume, "sess-A", "moving back resumes it too");
  assert.equal(seen[2]!.env.CLAUDE_CONFIG_DIR, defaultDir);

  nextSession = "sess-C";
  const own = await post("claude-code-3", "ses_move", {
    messages: [...history, { role: "user", content: "fourth" }],
  });
  assert.equal(own.status, 200);
  assert.equal(seen[3]!.resume, undefined, "an account with its own history cannot see the transcript");
  assert.match(String(seen[3]!.prompt), /first question[\s\S]*first answer[\s\S]*fourth/, "so the history is transferred");
  const sessions = JSON.parse(readFileSync(join(ctx.tmp, "opencode-claude", "sessions.json"), "utf8"));
  assert.equal(sessions.ses_move.foreignSessionId, "sess-C");
  assert.equal(sessions.ses_move.account, "claude-code-3", "the binding records the account");

  const unknown = await post("claude-code-9", "ses_move", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(unknown.status, 400);
  const body = (await unknown.json()) as any;
  assert.equal(body.error.code, "claude_unknown_account");
  assert.equal(seen.length, 4, "an unknown account never starts a turn");
}

async function moveMidTurn() {
  configure();
  const starts: Array<Record<string, any>> = [];
  let toolOutcome = "";
  ctx.proxy.setClaudeQueryStarter(async (params) => {
    starts.push(params as Record<string, any>);
    if (starts.length > 1) return textTurn("on B", "sess-B");
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-A" };
        try {
          const result = await callTool(params, "bash", { command: "make" });
          toolOutcome = JSON.stringify(result);
        } catch (error) {
          toolOutcome = String(error);
        }
        yield textDelta("A finished");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    );
  });
  const send = (account: string, messages: unknown[]) =>
    post(account, "ses_mid", { tools: [bashTool], messages });

  const parked = (await (await send("claude-code", [{ role: "user", content: "build it" }])).json()) as any;
  const call = parked.choices[0].message.tool_calls[0];
  assert.ok(call, "the turn on A parks on its tool call");

  const moved = await send("claude-code-2", [
    { role: "user", content: "build it" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "build output 42" },
    { role: "user", content: "continue on the other account" },
  ]);
  const reply = (await moved.json()) as any;
  assert.equal(starts.length, 2, "the queued message starts a new turn");
  assert.equal(starts[1]!.env.CLAUDE_CONFIG_DIR, sharedDir, "on the account the session moved to");
  assert.equal(starts[1]!.resume, undefined, "the old session's open tool call is not resumed");
  const prompt = await promptText(starts[1]!.prompt);
  assert.match(prompt, /build output 42/, "the finished tool result reaches the new turn");
  assert.match(prompt, /continue on the other account/);
  assert.match(String(reply.choices[0].message.content), /on B/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(toolOutcome, "the old turn's tool call was settled");
  assert.doesNotMatch(toolOutcome, /build output 42/, "the old account never gets the tool result");

  // Moving to an account whose limit gate answers starts no turn; the next
  // turn must still not resume the abandoned session.
  writeFileSync(join(defaultDir, "projects", "-work", "sess-A.jsonl"), "{}\n");
  starts.length = 0;
  const again = (await (await post("claude-code", "ses_gated", {
    tools: [bashTool],
    messages: [{ role: "user", content: "build again" }],
  })).json()) as any;
  const call2 = again.choices[0].message.tool_calls[0];
  rateLimit.recordRateLimitErrorText("You've hit your usage limit · resets 2099-12-01T00:00:00Z", "claude-code-3");
  const history = [
    { role: "user", content: "build again" },
    { role: "assistant", content: null, tool_calls: [call2] },
    { role: "tool", tool_call_id: call2.id, content: "build output 77" },
    { role: "user", content: "go on" },
  ];
  const gated = await post("claude-code-3", "ses_gated", { tools: [bashTool], messages: history });
  assert.equal(gated.status, 429);
  assert.equal(starts.length, 1, "the gated account starts no turn");
  await post("claude-code", "ses_gated", {
    tools: [bashTool],
    messages: [...history, { role: "user", content: "retry here" }],
  });
  assert.equal(starts.length, 2);
  assert.equal(starts[1]!.resume, undefined, "the abandoned session stays abandoned");
  assert.match(await promptText(starts[1]!.prompt), /build output 77/);
  rmSync(join(ctx.tmp, "rate-limit.claude-code-3.json"));
  ctx.proxy.setClaudeQueryStarter(null);
}

/** The text of a bridged turn's first prompt message. */
async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const first = await (prompt as AsyncIterable<any>)[Symbol.asyncIterator]().next();
  const content = first.value?.message?.content;
  return typeof content === "string"
    ? content
    : (content ?? []).map((block: any) => block.text ?? "").join("\n");
}

async function limitEventsPerAccount() {
  configure();
  ctx.proxy.setClaudeQueryStarter(async () =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "sess-E" };
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed_warning", utilization: 0.97, rateLimitType: "five_hour" },
        };
        yield textDelta("fine");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    ),
  );
  const res = await post("claude-code-2", "ses_events", {
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  const sse = await res.text();
  assert.match(sse, /fine/);
  const stored = JSON.parse(readFileSync(join(ctx.tmp, "rate-limit.claude-code-2.json"), "utf8"));
  assert.equal(stored.utilization, 0.97, "streamed limit telemetry is recorded for the account that ran");
  assert.equal(
    JSON.parse(readFileSync(join(ctx.tmp, "rate-limit.json"), "utf8")).rateLimitType,
    "seven_day",
    "the default account's window is untouched",
  );
  ctx.proxy.setClaudeQueryStarter(null);
}

async function accountAwareErrors() {
  configure();
  accounts.__setAccountStatus("claude-code-2", { loggedIn: true, email: "b@example.test" });
  accounts.__setAccountStatus("claude-code", { loggedIn: true, email: "a@example.test" });

  ctx.proxy.setClaudeQueryStarter(async () => failingTurn("Not logged in · Please run /login"));
  const auth = await post("claude-code-2", "ses_auth", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(auth.status, 401);
  const authBody = (await auth.json()) as any;
  assert.ok(
    authBody.error.message.includes(`CLAUDE_CONFIG_DIR=${sharedDir} claude auth login --claudeai`),
    authBody.error.message,
  );

  ctx.proxy.setClaudeQueryStarter(async () =>
    failingTurn("You've hit your usage limit · resets 2099-12-01T00:00:00Z"),
  );
  const limited = await post("claude-code-3", "ses_limit", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(limited.status, 429);
  const limitBody = (await limited.json()) as any;
  assert.match(
    limitBody.error.message,
    /switch this session to Claude · a@example\.test or Claude · b@example\.test in the model picker/,
  );
  assert.equal(limitBody.error.message.match(/in the model picker/g).length, 1, "hinted once");

  let started = 0;
  ctx.proxy.setClaudeQueryStarter(async () => {
    started++;
    return textTurn("never");
  });
  const gated = await post("claude-code-3", "ses_limit", { messages: [{ role: "user", content: "again" }] });
  assert.equal(gated.status, 429, "the account's own limit gate answers");
  assert.equal(started, 0);
  assert.match(((await gated.json()) as any).error.message, /switch this session to .* in the model picker/);
  const other = await post("claude-code-2", "ses_other", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(other.status, 200, "other accounts keep working");
  assert.equal(started, 1);

  const counter = async (query: string) =>
    fetch(`http://127.0.0.1:${ctx.port}/v1/rate-limit${query}`);
  assert.equal(((await (await counter("?account=claude-code-3")).json()) as any).limited, true);
  assert.equal(((await (await counter("")).json()) as any).limited, false);
  assert.equal((await counter("?account=nope")).status, 400);
  ctx.proxy.setClaudeQueryStarter(null);
}

async function pluginHooks() {
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Fake CLI: one login per config home; the "own" account is signed out.
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh
dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi
if [ "$1" = "auth" ]; then
  case "$dir" in
    ${defaultDir}) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"a@example.test","projectsDirectory":"${defaultDir}/projects"}' ;;
    ${sharedDir}) echo '{"loggedIn":true,"authMethod":"claude.ai","email":"b@example.test","projectsDirectory":"${sharedDir}/projects"}' ;;
    *) echo '{"loggedIn":false,"authMethod":"none","projectsDirectory":"'"$dir"'/projects"}'; exit 1 ;;
  esac
  exit 0
fi
echo '{}'
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  const { resetClaudeCliResolutionCache } = await import("../src/executable-path.ts");
  resetClaudeCliResolutionCache();
  const { __resetSessionAccounts } = await import("../src/session-accounts.ts");
  __resetSessionAccounts();

  const parents: Record<string, string | undefined> = { child: "root", child2: "root", grandchild: "child" };
  let lookups = 0;
  let failLookup = false;
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => {
        lookups++;
        if (failLookup) return { error: { message: "boom" } };
        return { data: { id: path.id, parentID: parents[path.id] } };
      },
    },
  };
  try {
    const { ClaudeCodePlugin } = await import("../src/index.ts");
    const hooks = (await ClaudeCodePlugin(
      { directory: process.cwd(), client } as any,
      { accounts: [
        { provider: "claude-code-2", configDir: sharedDir },
        { provider: "claude-code-3", configDir: ownDir },
      ] },
    )) as any;

    const config: any = { provider: { "claude-code-3": { name: "Overflow" } } };
    await hooks.config(config);
    const one = config.provider["claude-code"];
    const two = config.provider["claude-code-2"];
    assert.equal(one.name, "Claude · a@example.test", "providers are named by sign-in email");
    assert.equal(two.name, "Claude · b@example.test");
    assert.equal(config.provider["claude-code-3"].name, "Overflow", "a configured name wins");
    assert.equal(two.options.baseURL, one.options.baseURL, "one proxy serves every account");
    assert.equal(two.options.headers[ACCOUNT_HEADER], "claude-code-2", "calls that skip chat.headers still name the account");
    assert.equal(one.options.headers[ACCOUNT_HEADER], "claude-code");
    assert.equal(two.npm, one.npm);
    assert.deepEqual(Object.keys(two.models), Object.keys(one.models), "same model catalog");
    const log = readFileSync(join(ctx.tmp, "opencode-claude", "debug.log"), "utf8");
    assert.match(log, /Claude account is not signed in.*claude-code-3.*CLAUDE_CONFIG_DIR=/);
    assert.match(log, /keeps its own session history.*claude-code-3.*mv .*projects\.own && ln -s/, "an existing folder is moved aside first");
    assert.doesNotMatch(log, /keeps its own session history[^\n]*claude-code-2/, "the linked account shares history");

    const modelFor = (providerID: string) => ({ providerID, id: "claude-opus-5-5[1m]" });
    const headers: Record<string, string> = {};
    await hooks["chat.headers"](
      { sessionID: "root", model: modelFor("claude-code-2"), message: { model: { variant: "high" } } },
      { headers },
    );
    assert.equal(headers[ACCOUNT_HEADER], "claude-code-2");
    assert.ok(headers[EFFORT_HEADER]);
    const gptHeaders: Record<string, string> = {};
    await hooks["chat.headers"](
      { sessionID: "root", model: { providerID: "openai", id: "gpt" }, message: { model: {} } },
      { headers: gptHeaders },
    );
    assert.deepEqual(gptHeaders, {});
    const params = { options: { reasoningEffort: "high" } as Record<string, unknown> };
    await hooks["chat.params"]({ model: modelFor("claude-code-2") }, params);
    assert.equal(params.options.reasoningEffort, undefined);

    const message = async (sessionID: string, providerID: string) => {
      const output = {
        message: { model: { providerID, modelID: "claude-sonnet-5-5[1m]", variant: "high" } },
        parts: [],
      };
      await hooks["chat.message"]({ sessionID }, output);
      return output.message.model;
    };
    assert.equal((await message("root", "claude-code-2")).providerID, "claude-code-2", "a root session keeps its pick");
    const moved = await message("child", "claude-code");
    assert.deepEqual(
      moved,
      { providerID: "claude-code-2", modelID: "claude-sonnet-5-5[1m]", variant: "high" },
      "a pinned Claude subagent follows its parent's account, same model and variant",
    );
    assert.equal((await message("grandchild", "claude-code")).providerID, "claude-code-2", "and so do its own subagents");
    assert.equal((await message("child2", "openai")).providerID, "openai", "non-Claude pins stay");

    await message("root", "openai");
    assert.equal((await message("child2", "claude-code")).providerID, "claude-code", "a parent on GPT leaves Claude pins alone");
    await message("root", "claude-code");
    assert.equal((await message("child2", "claude-code-2")).providerID, "claude-code", "following works in both directions");

    const before = lookups;
    await message("child", "claude-code");
    assert.equal(lookups, before, "parents are looked up once");
    failLookup = true;
    assert.equal((await message("orphan", "claude-code-2")).providerID, "claude-code-2", "a failed lookup changes nothing");
    await message("orphan", "claude-code-2");
    assert.equal(lookups, before + 2, "and is retried on the next message");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
}

try {
  accountOptions();
  separateLimits();
  await resumeAcrossAccounts();
  await moveMidTurn();
  await limitEventsPerAccount();
  await accountAwareErrors();
  await pluginHooks();
  console.log("ok — multi-account tests passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  ctx.proxy.setClaudeQueryStarter(null);
  await ctx.proxy.stopProxy();
}
