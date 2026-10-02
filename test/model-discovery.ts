/** Offline discovery, cache, cleanup, and OpenCode 1 registration checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "opencode-claude-models-"));
const oldDataHome = process.env.XDG_DATA_HOME;
const oldPath = process.env.PATH;
const realNow = Date.now;
process.env.XDG_DATA_HOME = data;

try {
  const {
    CLAUDE_CODE_MODELS, getClaudeModels, modelsFromSdk, modelNameFromId,
    setDiscoveredModels, refreshClaudeModels, resolveClaudeModelId, buildEffortVariants,
  } = await import("../src/models.ts");
  const { listClaudeSupportedModels } = await import("../src/query.ts");
  const rows = [
    { value: "default", resolvedModel: "claude-opus-5-5" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus (latest)", supportedEffortLevels: ["low", "high", "bad", "low"] },
    { value: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["medium", "high"] },
    { value: "claude-opus-4-8" },
    { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    { value: "claude-nova-9" },
  ];
  const models = modelsFromSdk(rows);
  assert.deepEqual(models.map((m) => m.id), [
    "claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-sonnet-5-5[1m]",
    "claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-nova-9",
  ]);
  assert.equal(models[0]!.name, "Opus 5.5");
  assert.equal(models[0]!.contextWindow, 1_000_000);
  assert.equal(models[0]!.maxTokens, 128_000);
  assert.equal(models[1]!.contextWindow, 200_000);
  assert.equal(models[2]!.name, "Sonnet 5.5 (1M)");
  assert.equal(models[3]!.contextWindow, 1_000_000);
  assert.equal(models[5]!.contextWindow, 200_000, "unknown families are not assumed to have 1M");
  assert.equal(modelNameFromId("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelNameFromId("opus"), undefined);
  assert.deepEqual(modelsFromSdk([{ value: "default" }, { value: "" }, null as any]), []);
  assert.deepEqual(modelsFromSdk([{ value: "opus" }, { value: "sonnet[1m]" }, { value: "haiku" }]), [], "unresolved aliases cannot replace concrete IDs");
  const duplicates = [
    { value: "claude-opus-5-5" },
    { value: "opus", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] },
  ];
  for (const order of [duplicates, duplicates.slice().reverse()]) {
    const deduplicated = modelsFromSdk(order);
    assert.equal(deduplicated.length, 1);
    assert.deepEqual(deduplicated[0]!.efforts, ["low", "high"], "duplicate metadata is preserved in either row order");
    assert.deepEqual(buildEffortVariants(deduplicated[0]!).high, { effort: "high" });
  }
  assert.equal(modelsFromSdk([{ value: "custom[1m]", displayName: "Custom" }])[0]!.contextWindow, 1_000_000);
  assert.equal(modelsFromSdk([{ value: "opus[1m]", resolvedModel: "claude-opus-5[1m]" }])[0]!.id, "claude-opus-5[1m]");
  const efforts = buildEffortVariants(models[0]!);
  assert.deepEqual(efforts.low, { effort: "low" });
  assert.deepEqual(efforts.high, { effort: "high" });
  assert.deepEqual(efforts.max, { disabled: true });
  assert.deepEqual(buildEffortVariants(models[4]!), {});

  assert.equal(setDiscoveredModels(models), true);
  assert.equal(CLAUDE_CODE_MODELS, getClaudeModels());
  assert.equal(setDiscoveredModels(models), false);
  assert.equal(setDiscoveredModels([]), false);
  assert.equal(resolveClaudeModelId("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  assert.equal(resolveClaudeModelId("opus"), "opus", "legacy IDs still pass through the proxy");
  assert.equal(resolveClaudeModelId("haiku"), "claude-haiku-4-5");
  const cache = join(data, "opencode-claude", "models.json");
  assert.deepEqual(JSON.parse(readFileSync(cache, "utf8")), models);
  const cached = spawnSync(process.execPath, ["-e", `import { getClaudeModels } from "./src/models.ts"; console.log(JSON.stringify(getClaudeModels()));`], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, XDG_DATA_HOME: data },
    encoding: "utf8",
  });
  assert.equal(cached.status, 0, cached.stderr);
  assert.deepEqual(JSON.parse(cached.stdout), models);
  writeFileSync(cache, JSON.stringify([{ id: "broken", efforts: ["bogus"] }]));
  const invalid = spawnSync(process.execPath, ["-e", `import { getClaudeModels } from "./src/models.ts"; console.log(JSON.stringify(getClaudeModels()));`], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, XDG_DATA_HOME: data },
    encoding: "utf8",
  });
  assert.equal(invalid.status, 0, invalid.stderr);
  assert.ok(JSON.parse(invalid.stdout).some((m: any) => m.id === "claude-opus-5-5[1m]"), "malformed cache falls back");
  writeFileSync(cache, JSON.stringify(models));

  let now = realNow();
  Date.now = () => now;
  let loads = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const first = refreshClaudeModels(process.cwd(), async () => { loads++; await pending; return rows; });
  const second = refreshClaudeModels(process.cwd(), async () => { loads++; return []; });
  release();
  await Promise.all([first, second]);
  assert.equal(loads, 1, "concurrent plugin initialization shares discovery");
  await refreshClaudeModels(process.cwd(), async () => { loads++; return []; });
  assert.equal(loads, 1, "discovery is throttled for ten minutes");
  now += 11 * 60_000;
  await refreshClaudeModels(process.cwd(), async () => { throw new Error("mock CLI unavailable"); });
  assert.deepEqual(getClaudeModels(), models, "failure preserves the successful catalog");
  now += 11 * 60_000;
  await refreshClaudeModels(process.cwd(), async () => []);
  assert.deepEqual(getClaudeModels(), models, "empty discovery preserves the successful catalog");
  now += 11 * 60_000;
  await refreshClaudeModels(process.cwd(), async () => [{ value: "opus" }, { value: "haiku" }]);
  assert.deepEqual(getClaudeModels(), models, "unresolved discovery preserves the successful catalog");
  assert.equal(resolveClaudeModelId("haiku"), "claude-haiku-4-5");

  let options: any;
  let promptDone: Promise<IteratorResult<unknown>>;
  let closed = 0;
  const queryImpl = ((input: any) => {
    options = input.options;
    promptDone = input.prompt[Symbol.asyncIterator]().next();
    return { supportedModels: async () => rows, close: () => { closed++; } };
  }) as any;
  assert.deepEqual(await listClaudeSupportedModels({ cwd: process.cwd(), queryImpl }), rows);
  assert.equal((await promptDone!).done, true, "discovery never yields an inference prompt");
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.settings.disableClaudeAiConnectors, true);
  assert.equal(options.abortController.signal.aborted, true);
  assert.equal(closed, 1);
  await assert.rejects(listClaudeSupportedModels({
    cwd: process.cwd(), timeoutMs: 10,
    queryImpl: ((input: any) => {
      options = input.options;
      return { supportedModels: () => new Promise(() => {}), close: () => { closed++; } };
    }) as any,
  }), /timed out/);
  assert.equal(options.abortController.signal.aborted, true);
  assert.equal(closed, 2, "timeout forcibly closes the discovery query");
  await assert.rejects(listClaudeSupportedModels({
    cwd: process.cwd(),
    queryImpl: (() => ({ supportedModels: async () => { throw new Error("mock discovery rejected"); }, close: () => { closed++; } })) as any,
  }), /mock discovery rejected/);
  assert.equal(closed, 3, "rejection closes the discovery query");

  const bin = join(data, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; else echo \'{"loggedIn":false}\'; fi\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath ?? ""}`;
  const { resetClaudeCliResolutionCache } = await import("../src/executable-path.ts");
  resetClaudeCliResolutionCache();
  const { ClaudeCodePlugin } = await import("../src/index.ts");
  const { stopProxy } = await import("../src/proxy.ts");
  try {
    const hooks = await ClaudeCodePlugin({ directory: process.cwd() } as any) as any;
    const config: any = { provider: { openai: { models: { sentinel: {} } } } };
    await hooks.config(config);
    const runtime = await hooks.provider.models({ models: {} });
    const id = "claude-opus-5-5[1m]";
    assert.deepEqual(config.provider["claude-code"].models[id].limit, { context: 1_000_000, input: 900_000, output: 128_000 });
    assert.deepEqual(runtime[id].limit, config.provider["claude-code"].models[id].limit);
    assert.deepEqual(runtime[id].variants, efforts);
    assert.equal(runtime["sonnet"], undefined, "no fabricated default alias model");
    assert.deepEqual(config.provider.openai, { models: { sentinel: {} } });
  } finally {
    await stopProxy();
  }
  console.log("Model discovery, cache, cleanup, effort and legacy registration tests passed.");
} finally {
  Date.now = realNow;
  if (oldDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = oldDataHome;
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  rmSync(data, { recursive: true, force: true });
}
