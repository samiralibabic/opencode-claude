/**
 * Account model discovery, with OpenChamber's context-family rules.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { EFFORT_LEVELS, isClaudeEffort, type ClaudeEffort } from "./constants.js";
import { log } from "./log.js";
import { listClaudeSupportedModels } from "./query.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
  efforts?: ClaudeEffort[];
};

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;

/** OpenCode may inject these before merging plugin variants — disable extras. */
export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function model(
  id: string,
  name: string,
  limit: { context: number; output: number },
  resolvedId?: string,
  efforts: ClaudeEffort[] = [...EFFORT_LEVELS],
): ClaudeModel {
  return {
    id,
    name,
    reasoning: efforts.length > 0,
    contextWindow: limit.context,
    maxTokens: limit.output,
    efforts,
    ...(resolvedId ? { resolvedId } : {}),
  };
}

const FALLBACK_MODELS: ClaudeModel[] = [
  model("claude-opus-5-5[1m]", "Opus 5.5", LIMIT_1M),
  model("claude-fable-5-1[1m]", "Fable 5.1", LIMIT_1M),
  model("claude-sonnet-5", "Sonnet 5", LIMIT_200K),
  model("claude-sonnet-5[1m]", "Sonnet 5 (1M)", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K, undefined, []),
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
];

export type SdkModelRow = {
  value: string;
  displayName?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
};

const LEGACY_ALIAS_ID = /^(fable|opus|sonnet|haiku)(?:\[1m\])?$/i;

const ONE_M_FAMILIES: Array<{
  match: RegExp;
  mode: "default" | "optional" | "fixed";
}> = [
  { match: /^claude-fable-5/, mode: "default" },
  { match: /^claude-opus-5/, mode: "default" },
  { match: /^claude-opus-4-6/, mode: "default" },
  { match: /^claude-opus-4-[78]/, mode: "fixed" },
  { match: /^claude-sonnet-(5|4-6)/, mode: "optional" },
];

export function modelNameFromId(id: string | undefined): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(
    id?.trim() ?? "",
  );
  if (!match) return undefined;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

export function modelsFromSdk(rows: SdkModelRow[]): ClaudeModel[] {
  const out: ClaudeModel[] = [];
  for (const row of rows) {
    const value = typeof row?.value === "string" ? row.value.trim() : "";
    if (!value || value === "default") continue;
    const resolved = typeof row.resolvedModel === "string" ? row.resolvedModel.trim() : "";
    if (LEGACY_ALIAS_ID.test(resolved || value)) continue;
    const base = (resolved || value).replace(/\[1m\]$/i, "");
    const efforts = Array.isArray(row.supportedEffortLevels)
      ? [...new Set(row.supportedEffortLevels.filter(isClaudeEffort))]
      : [];
    const name = modelNameFromId(resolved) ?? modelNameFromId(value) ??
      (typeof row.displayName === "string" && row.displayName.trim() || value);
    const rule = /\[1m\]$/i.test(value) || /\[1m\]$/i.test(resolved)
      ? { mode: "default" as const }
      : ONE_M_FAMILIES.find((family) => family.match.test(base));
    if (rule?.mode === "default") {
      out.push(model(`${base}[1m]`, name, LIMIT_1M, undefined, efforts));
    } else if (rule?.mode === "fixed") {
      out.push(model(base, name, LIMIT_1M, undefined, efforts));
    } else if (rule?.mode === "optional") {
      out.push(model(base, name, LIMIT_200K, undefined, efforts));
      out.push(model(`${base}[1m]`, `${name} (1M)`, LIMIT_1M, undefined, efforts));
    } else {
      out.push(model(base, name, LIMIT_200K, undefined, efforts));
    }
  }
  const unique = new Map<string, ClaudeModel>();
  for (const entry of out) {
    const existing = unique.get(entry.id);
    if (!existing) {
      unique.set(entry.id, entry);
    } else {
      existing.efforts = [...new Set([...(existing.efforts ?? []), ...(entry.efforts ?? [])])];
      existing.reasoning = existing.efforts.length > 0;
    }
  }
  return [...unique.values()];
}

function modelCachePath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "models.json");
}

function readCachedModels(): ClaudeModel[] | null {
  try {
    const parsed = JSON.parse(readFileSync(modelCachePath(), "utf8"));
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((entry) =>
      entry && typeof entry.id === "string" && entry.id.trim() &&
      !LEGACY_ALIAS_ID.test(entry.id) &&
      typeof entry.name === "string" && entry.name.trim() &&
      typeof entry.reasoning === "boolean" &&
      Number.isFinite(entry.contextWindow) && entry.contextWindow > 0 &&
      Number.isFinite(entry.maxTokens) && entry.maxTokens > 0 &&
      (entry.resolvedId === undefined || typeof entry.resolvedId === "string") &&
      (entry.efforts === undefined || Array.isArray(entry.efforts) && entry.efforts.every(isClaudeEffort))
    )) return null;
    return parsed as ClaudeModel[];
  } catch {
    return null;
  }
}

export const CLAUDE_CODE_MODELS: ClaudeModel[] = readCachedModels() ?? FALLBACK_MODELS.slice();

export function getClaudeModels(): ClaudeModel[] {
  return CLAUDE_CODE_MODELS;
}

export function setDiscoveredModels(models: ClaudeModel[]): boolean {
  if (!models.length || JSON.stringify(models) === JSON.stringify(CLAUDE_CODE_MODELS)) return false;
  CLAUDE_CODE_MODELS.splice(0, CLAUDE_CODE_MODELS.length, ...models);
  try {
    const file = modelCachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(models, null, 2));
  } catch {
    // Discovery remains usable when the optional cache cannot be written.
  }
  return true;
}

let lastModelRefresh = 0;
let modelRefresh: Promise<void> | null = null;

export async function refreshClaudeModels(
  cwd: string,
  load: () => Promise<SdkModelRow[]> = () => listClaudeSupportedModels({ cwd }),
): Promise<void> {
  if (modelRefresh) return modelRefresh;
  const now = Date.now();
  if (now - lastModelRefresh < 10 * 60_000) return;
  lastModelRefresh = now;
  modelRefresh = (async () => {
    try {
      setDiscoveredModels(modelsFromSdk(await load()));
    } catch (error) {
      log.warn("[opencode-claude] model discovery failed; keeping cached or fallback models", error);
    }
  })();
  try {
    await modelRefresh;
  } finally {
    modelRefresh = null;
  }
}

export function resolveClaudeModelId(modelId: string): string {
  const match = CLAUDE_CODE_MODELS.find((m) => m.id === modelId);
  if (!match) return modelId === "haiku" ? "claude-haiku-4-5" : modelId;
  return match.resolvedId || match.id;
}

/**
 * Runtime variants for the provider.models() hook.
 * Keys are OpenCode UI choices; values carry the effort level for chat.headers.
 */
export function buildEffortVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  if (!model.reasoning) return {};
  const variants: Record<
    string,
    { effort: ClaudeEffort } | { disabled: true }
  > = Object.fromEntries((model.efforts ?? EFFORT_LEVELS).map((effort) => [effort, { effort }]));
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

/**
 * Static config variants. Same effort map; OpenCode merges these into the menu.
 * Mark config model `reasoning: false` so OpenCode does not prepend its own
 * generic low/medium/high ahead of this map.
 */
export function buildConfigVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  return buildEffortVariants(model);
}
