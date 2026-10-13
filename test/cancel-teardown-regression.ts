/**
 * Regression: aborting a turn (Esc-Esc / session.abort) must terminate the
 * Claude query, quietly.
 *
 * Leak paths fixed earlier:
 * 1. Abort while the bridge is parked waiting for an OpenCode tool result —
 *    there is no in-flight proxy request, so the SSE cancel() teardown never
 *    runs. Fix: OpenCode publishes `session.idle` when a runner finishes OR is
 *    interrupted; the plugin's event hook tears down any bridge still live
 *    for that session (main, title: and summary: keys).
 * 2. handle.close() could not guarantee teardown: the SDK query handle
 *    exposes no usable child pid. Fix: every query gets its own
 *    AbortController, aborted from close().
 *
 * Noise fixed now:
 * 3. Abort before the turn's first output: the teardown ends the SDK stream
 *    empty and the proxy reported "Claude Code ended the turn without any
 *    output" as a failed turn — a warning that went to stderr and was painted
 *    over the TUI. Abandoned turns now answer quietly; genuine empty turns
 *    still fail truthfully, and warnings stay out of stderr unless debugging.
 *
 * Run: bun test/cancel-teardown-regression.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, startMockedProxy } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FakeHandle = {
  stream: AsyncIterable<unknown>;
  interrupt: () => Promise<void>;
  close: () => void;
  getPid: () => number | null;
  closeCount: () => number;
};

function makeFakeHandle(
  body: (isDone: () => boolean) => AsyncIterable<unknown>,
): FakeHandle {
  let closes = 0;
  let done = false;
  return {
    stream: body(() => done),
    interrupt: async () => {},
    close: () => {
      closes += 1;
      done = true;
    },
    getPid: () => null,
    closeCount: () => closes,
  };
}

const init = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
});

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

/** A turn that stays silent (no content) until it is closed. */
const silentUntilClosed = (sessionId: string) => (isDone: () => boolean) =>
  (async function* () {
    yield init(sessionId);
    while (!isDone()) await sleep(25);
  })();

function bridgeFor(conversationKey: string, id: string, handle: FakeHandle) {
  return {
    id,
    conversationKey,
    handle,
    pendingTools: new Map(),
    seenAssistantUsageIds: new Set<string>(),
    forwardedSteering: new Set<string>(),
    forwardedMedia: new Set<string>(),
    followUps: [],
    createdAt: Date.now(),
  };
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

async function main() {
  const { tmp, port, proxy } = await startMockedProxy("cancel-teardown");
  const { setClaudeQueryStarter, stopProxy } = proxy;
  const { log } = await import("../src/log.ts");
  const { putBridge, findBridgeByConversation, clearAllBridges } =
    await import("../src/bridge-pool.ts");
  const { ClaudeCodePlugin, teardownBridgesForSession } = await import(
    "../src/index.ts"
  );
  const { startClaudeQuery } = await import("../src/query.ts");

  // ---- 0. warn/error reach debug.log, stderr only when debugging ----
  {
    const realConsoleError = console.error;
    let stderrLines = 0;
    console.error = () => {
      stderrLines += 1;
    };
    try {
      log.warn("[test] routing probe quiet");
      assert.equal(stderrLines, 0, "warnings must not hit stderr (TUI) by default");
      process.env.OPENCODE_CLAUDE_DEBUG = "1";
      log.warn("[test] routing probe debug");
      assert.equal(stderrLines, 1, "debug mode echoes warnings to stderr");
    } finally {
      delete process.env.OPENCODE_CLAUDE_DEBUG;
      console.error = realConsoleError;
    }
    const file = readFileSync(join(tmp, "opencode-claude", "debug.log"), "utf8");
    assert.match(file, /level=warn \[test\] routing probe quiet/);
    assert.match(file, /level=warn \[test\] routing probe debug/);
    console.log("ok 0 — warnings go to debug.log, stderr only when debugging");
  }

  // Record what the proxy logs from here on.
  const warns: string[] = [];
  const infos: string[] = [];
  const realWarn = log.warn;
  const realInfo = log.info;
  log.warn = (...args: unknown[]) => {
    warns.push(String(args[0]));
    realWarn(...args);
  };
  log.info = (...args: unknown[]) => {
    infos.push(String(args[0]));
    realInfo(...args);
  };

  // The plugin's event hook is what OpenCode calls with bus events; use the
  // real plugin so the wiring (event type + sessionID extraction) is covered.
  const hooks = (await ClaudeCodePlugin({ directory: tmp } as any)) as any;
  const fireIdle = (sessionID: string) =>
    hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

  const streamTurn = (session: string, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": session,
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

  // ---- 1. close() aborts the query's own AbortController ----
  {
    let seenOptions: Record<string, unknown> | null = null;
    const handle = await startClaudeQuery({
      prompt: "test",
      cwd: tmp,
      model: "sonnet",
      queryImpl: () => (input: { options: Record<string, unknown> }) => {
        seenOptions = input.options;
        return {
          [Symbol.asyncIterator]: async function* () {},
          interrupt: async () => {},
        };
      },
    });
    assert.ok(seenOptions, "query stub captured options");
    const ac = seenOptions!.abortController as AbortController | undefined;
    assert.ok(ac, "SDK query receives an AbortController");
    assert.equal(ac!.signal.aborted, false);
    handle.close();
    assert.equal(ac!.signal.aborted, true, "close() must abort the controller");
    handle.close(); // idempotent
    console.log("ok 1 — close() aborts the query AbortController");
  }

  try {
    // ---- 2. Abort during active streaming tears the turn down ----
    {
      let fake: FakeHandle | null = null;
      setClaudeQueryStarter(async () => {
        fake = makeFakeHandle((isDone) =>
          (async function* () {
            yield init("mock-stream");
            yield textDelta("STREAMING");
            while (!isDone()) {
              await sleep(25);
              yield { type: "system", subtype: "keepalive" };
            }
          })(),
        );
        return fake!;
      });

      const client = new AbortController();
      const res = await streamTurn("cancel-stream", client.signal);
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      assert.equal((await reader.read()).done, false, "stream produced bytes");
      assert.ok(findBridgeByConversation("cancel-stream"), "bridge live while streaming");

      client.abort(); // OpenCode aborts the provider fetch on Esc-Esc
      const torn = await waitFor(
        () =>
          findBridgeByConversation("cancel-stream") === undefined &&
          fake !== null &&
          fake.closeCount() >= 1,
      );
      assert.ok(torn, "mid-stream abort must delete the bridge and close it");
      console.log("ok 2 — abort during active streaming closes the query");
    }

    // ---- 3. Abort while parked on a tool call (no in-flight request) ----
    // ---- 4. Unrelated bridges are untouched ----
    {
      setClaudeQueryStarter(null);
      clearAllBridges();
      const parked = makeFakeHandle(async function* () {});
      let toolRejected: Error | null = null;
      putBridge({
        ...bridgeFor("ses_parked", "bridge-parked", parked),
        pendingTools: new Map([
          [
            "call_1",
            {
              id: "call_1",
              name: "mcp__opencode__bash",
              arguments: "{}",
              resolve: () => {},
              reject: (err: Error) => {
                toolRejected = err;
              },
            },
          ],
        ]),
      });
      const unrelated = makeFakeHandle(async function* () {});
      putBridge(bridgeFor("ses_other", "bridge-other", unrelated));
      // Meta bridges of the same session must go too.
      const titleBridge = makeFakeHandle(async function* () {});
      putBridge(bridgeFor("title:ses_parked", "bridge-title", titleBridge));
      const summaryBridge = makeFakeHandle(async function* () {});
      putBridge(bridgeFor("summary:ses_parked", "bridge-summary", summaryBridge));

      await fireIdle("ses_parked");

      assert.equal(parked.closeCount(), 1, "parked query must be closed");
      assert.ok(toolRejected, "parked tool call must be rejected");
      assert.match(toolRejected!.message, /Bridge closed/);
      assert.equal(findBridgeByConversation("ses_parked"), undefined);
      assert.equal(titleBridge.closeCount(), 1, "title bridge must be closed");
      assert.equal(findBridgeByConversation("title:ses_parked"), undefined);
      assert.equal(summaryBridge.closeCount(), 1, "summary bridge must be closed");
      assert.equal(findBridgeByConversation("summary:ses_parked"), undefined);
      assert.equal(unrelated.closeCount(), 0, "unrelated bridge must not be touched");
      assert.ok(findBridgeByConversation("ses_other"), "unrelated bridge stays parked");
      // Non-idle and foreign events are ignored.
      await hooks.event({
        event: { type: "session.updated", properties: { sessionID: "ses_other" } },
      });
      await fireIdle("ses_missing");
      assert.equal(unrelated.closeCount(), 0);
      assert.ok(
        !warns.some((w) => w.includes("went idle")),
        "an expected teardown must not log a warning",
      );
      clearAllBridges();
      console.log("ok 3 — parked bridge (and its title/summary turns) torn down on idle");
      console.log("ok 4 — unrelated queries untouched");
    }

    // ---- 5. Idle before the first output: quiet cancellation, not a failure ----
    {
      let fake: FakeHandle | null = null;
      setClaudeQueryStarter(async () => {
        fake = makeFakeHandle(silentUntilClosed("mock-early"));
        return fake!;
      });
      warns.length = 0;
      const pending = streamTurn("cancel-early");
      assert.ok(
        await waitFor(() => findBridgeByConversation("cancel-early") !== undefined),
        "turn started",
      );
      await fireIdle("cancel-early");
      const res = await pending;
      assert.equal(res.status, 499, "abandoned turn answers as cancelled");
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, "claude_turn_cancelled");
      assert.ok(fake!.closeCount() >= 1, "the query is closed");
      assert.equal(findBridgeByConversation("cancel-early"), undefined);
      assert.deepEqual(warns, [], "a cancelled turn must not log a failure");
      console.log("ok 5 — idle before first output cancels quietly");
    }

    // ---- 6. Esc-Esc before the first output (fetch aborted + idle) ----
    {
      let fake: FakeHandle | null = null;
      setClaudeQueryStarter(async () => {
        fake = makeFakeHandle(silentUntilClosed("mock-esc"));
        return fake!;
      });
      warns.length = 0;
      infos.length = 0;
      const client = new AbortController();
      const pending = streamTurn("cancel-esc", client.signal).catch(() => null);
      assert.ok(
        await waitFor(() => findBridgeByConversation("cancel-esc") !== undefined),
        "turn started",
      );
      client.abort();
      await fireIdle("cancel-esc");
      assert.equal(await pending, null, "client saw its own abort");
      assert.ok(
        await waitFor(() => infos.some((i) => i.includes("turn cancelled before any output"))),
        "proxy settles the abandoned turn as cancelled",
      );
      assert.ok(fake!.closeCount() >= 1, "the query is closed");
      assert.deepEqual(warns, [], "Esc-Esc must not log a failure");
      console.log("ok 6 — Esc-Esc before first output is quiet");
    }

    // ---- 7. A genuinely empty turn still fails truthfully ----
    {
      setClaudeQueryStarter(async () =>
        makeFakeHandle(() =>
          (async function* () {
            yield init("mock-empty");
          })(),
        ),
      );
      warns.length = 0;
      const res = await streamTurn("empty-turn");
      assert.equal(res.status, 500);
      const body = (await res.json()) as { error: { message: string } };
      assert.match(body.error.message, /ended the turn without any output/);
      assert.ok(
        warns.some((w) => w.includes("turn failed fast")),
        "a real empty turn is still recorded as a failure",
      );
      console.log("ok 7 — genuine zero-output turn still returns 500");
    }

    // ---- 8. Normal completion still cleans up; idle afterwards is a no-op ----
    {
      let fake: FakeHandle | null = null;
      setClaudeQueryStarter(async () => {
        fake = makeFakeHandle(() =>
          (async function* () {
            yield init("mock-done");
            yield textDelta("ALL_DONE");
            yield { type: "result", is_error: false, usage: {} };
          })(),
        );
        return fake!;
      });
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": "cancel-complete",
        },
        body: JSON.stringify({
          model: "sonnet",
          stream: false,
          messages: [{ role: "user", content: "say ALL_DONE" }],
        }),
      });
      assert.equal(res.status, 200);
      assert.ok(JSON.stringify(await res.json()).includes("ALL_DONE"));
      const cleaned = await waitFor(
        () =>
          findBridgeByConversation("cancel-complete") === undefined &&
          fake !== null &&
          fake.closeCount() >= 1,
      );
      assert.ok(cleaned, "normal completion deletes the bridge and closes it");
      const closesAfterTurn = fake!.closeCount();
      assert.deepEqual(teardownBridgesForSession("cancel-complete"), []);
      await fireIdle("cancel-complete");
      assert.equal(
        fake!.closeCount(),
        closesAfterTurn,
        "idle after a clean turn must not tear down anything",
      );
      console.log("ok 8 — normal completion cleans up, idle is a no-op");
    }
  } finally {
    log.warn = realWarn;
    log.info = realInfo;
    setClaudeQueryStarter(null);
    clearAllBridges();
    await stopProxy();
  }

  console.log("ok — cancel teardown regression tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
