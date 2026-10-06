/**
 * Resolve the `claude` CLI binary (from OpenChamber harness executable-path).
 */
import { execFile, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { log } from "./log.js";

/** Pins the CLI the plugin runs instead of resolving `claude` from PATH. */
export const CLI_PATH_ENV = "OPENCODE_CLAUDE_CLI_PATH";

const loggedCliVersions = new Set<string>();

/**
 * Record once per process which CLI build serves the turns: the default
 * install updates itself, so its behaviour can change under the plugin.
 * Async, so the probe never blocks the host's event loop.
 */
function logCliVersionOnce(
  path: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  if (loggedCliVersions.has(path)) return;
  loggedCliVersions.add(path);
  execFile(
    path,
    ["--version"],
    { timeout: 4000, env: buildClaudeCodeChildEnv(env) as NodeJS.ProcessEnv },
    (error, stdout) => {
      log.info("[opencode-claude] Claude Code CLI", {
        path,
        version: error ? null : `${stdout}`.trim() || null,
      });
    },
  );
}

function probeClaude(
  candidate: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  try {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: 4000,
      env: buildClaudeCodeChildEnv(env) as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) return false;
    return result.status === 0 || Boolean((result.stdout || "").trim());
  } catch {
    return false;
  }
}

/**
 * Install locations the managed OpenChamber server commonly misses because its
 * PATH is not a login shell's PATH: the official installer's `~/.local/bin`
 * and the npm global bin.
 */
function knownClaudeLocations(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  const candidates = [join(home, ".local", "bin", "claude")];

  try {
    const prefix = spawnSync("npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 6000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dir = `${prefix.stdout || ""}`.trim();
    if (dir) candidates.push(join(dir, "bin", "claude"));
  } catch {
    // no npm prefix available — PATH and ~/.local/bin remain
  }
  return candidates;
}

export function findBinaryOnPath(
  name: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const pathEnv = typeof env.PATH === "string" ? env.PATH : "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of parts) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir.replace(/[/\\]$/, "")}/${name}${ext}`;
      if (probeClaude(candidate, env)) return candidate;
    }
  }

  try {
    if (probeClaude(name, env)) return name;
  } catch {
    // missing
  }
  return null;
}

/**
 * `claude` as the managed server sees it: PATH first, then the install
 * locations that a clean server environment usually cannot see.
 *
 * Resolution is memoized per PATH+HOME: each probe is a synchronous spawn
 * (`npm prefix -g`, `claude --version`) that hard-blocks the host's event
 * loop, and this runs on every Agent SDK query. On a shared long-lived
 * server (OpenChamber's health probe has a 5s timeout) repeated second-long
 * stalls stack into health-check failures and forced restarts.
 */
let cachedResolution: { key: string; path: string | null } | null = null;

export function resolveClaudeCli(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const pinned = env[CLI_PATH_ENV]?.trim();
  if (pinned) {
    logCliVersionOnce(pinned, env);
    return pinned;
  }
  const key = `${env.PATH ?? ""}${env.HOME ?? ""}`;
  if (cachedResolution && cachedResolution.key === key) {
    return cachedResolution.path;
  }
  const onPath = findBinaryOnPath("claude", env);
  const resolved =
    onPath ??
    knownClaudeLocations(env).find((candidate) => probeClaude(candidate, env)) ??
    null;
  // Only positive hits are memoized — a CLI installed mid-process (the
  // one-click install action) must be found on the next detect.
  if (resolved) {
    cachedResolution = { key, path: resolved };
    logCliVersionOnce(resolved, env);
  }
  return resolved;
}

/** Test hook: drop the memoized resolution. */
export function resetClaudeCliResolutionCache(): void {
  cachedResolution = null;
}

export function resolveClaudeCodeExecutable(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): string | null {
  return resolveClaudeCli(options?.env ?? process.env);
}

export function assertClaudeWorkingDirectory(cwd: unknown): string {
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
}
