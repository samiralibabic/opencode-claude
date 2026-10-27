/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId: string;
  modelId?: string;
  cwd?: string;
  updatedAt: number;
};

function storePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "sessions.json");
}

function readStore(): Record<string, ClaudeSessionBinding> {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      ClaudeSessionBinding
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClaudeSessionBinding>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function getForeignSessionId(
  conversationKey: string,
): string | undefined {
  const entry = readStore()[conversationKey];
  return entry?.foreignSessionId;
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string },
): void {
  const store = readStore();
  store[conversationKey] = {
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

export function clearForeignSessionId(conversationKey: string): void {
  const store = readStore();
  if (!(conversationKey in store)) return;
  delete store[conversationKey];
  writeStore(store);
}

/**
 * Stable key from OpenAI messages so follow-ups resume the same Claude session.
 * Hashes the first user message only — including the message count made the key
 * change on every turn, which defeated resume entirely when the session header
 * is absent.
 */
export function conversationKeyFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const firstUser = messages.find((m) => m.role === "user");
  const seed =
    typeof firstUser?.content === "string"
      ? firstUser.content.slice(0, 200)
      : JSON.stringify(firstUser?.content ?? "").slice(0, 200);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `conv_${hash.toString(16)}`;
}

/**
 * Locate the Claude Code transcript for a foreign session id. The Agent SDK
 * resumes via the claude CLI, which (checked in 2.1.289) looks for the
 * session in ~/.claude/projects/<cwd-slug>/ first, then in the folders of the
 * repository's other git worktrees, and finally in every projects folder,
 * accepting a file there only if exactly one folder has it. Searching every
 * folder here therefore matches what the CLI can resume. When the CLI cannot
 * load the session it fails the turn with "No conversation found" (see
 * forgetDeadSession in proxy.ts), so callers transfer the history into the
 * prompt when no folder has the file.
 */
export function findClaudeSessionFile(
  foreignSessionId: string,
): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
