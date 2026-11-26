/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { selectLoadedSkills, type LoadedSkill } from "./skills.js";

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId: string;
  modelId?: string;
  cwd?: string;
  /** Provider ID of the Claude account that last ran this session. */
  account?: string;
  /**
   * Key of the skills list (skills.ts) the Claude session has in context:
   * sent in it and not compacted away since. Absent when it has none.
   */
  skillsListing?: string;
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
  return getSessionBinding(conversationKey)?.foreignSessionId;
}

export function getSessionBinding(
  conversationKey: string,
): ClaudeSessionBinding | undefined {
  return readStore()[conversationKey];
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string; account?: string; skillsListing?: string },
): void {
  const store = readStore();
  store[conversationKey] = {
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    ...(meta?.account ? { account: meta.account } : {}),
    ...(meta?.skillsListing ? { skillsListing: meta.skillsListing } : {}),
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
 * Skills an OpenCode session loaded (skills.ts), kept so they can come back
 * after OpenCode compacts the session. They live next to the bindings, in
 * their own file: a binding goes whenever its Claude session does (missing
 * transcript, account move, compaction), the skills stay with the OpenCode
 * session.
 */
export type LoadedSkillsRecord = {
  conversationKey: string;
  /** Newest first, one per name, capped and within budget as when sent. */
  skills: LoadedSkill[];
  /** Compacted since: the next new Claude session gets the skills back. */
  reattach?: boolean;
  updatedAt: number;
};

/** Sessions kept; the least recently updated go first. */
const MAX_LOADED_SKILL_SESSIONS = 200;

function loadedSkillsPath(): string {
  return join(dirname(storePath()), "loaded-skills.json");
}

function readLoadedSkills(): Record<string, LoadedSkillsRecord> {
  const path = loadedSkillsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      LoadedSkillsRecord
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLoadedSkills(store: Record<string, LoadedSkillsRecord>): void {
  const path = loadedSkillsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function getLoadedSkills(
  conversationKey: string,
): LoadedSkillsRecord | undefined {
  return readLoadedSkills()[conversationKey];
}

/** The session loaded a skill: its newest version replaces any older one. */
export function recordLoadedSkill(
  conversationKey: string,
  skill: LoadedSkill,
): void {
  const store = readLoadedSkills();
  const previous = store[conversationKey];
  store[conversationKey] = {
    conversationKey,
    skills: selectLoadedSkills([
      skill,
      ...(previous?.skills ?? []).filter((s) => s.name !== skill.name),
    ]),
    ...(previous?.reattach ? { reattach: true } : {}),
    updatedAt: Date.now(),
  };
  const keys = Object.keys(store);
  if (keys.length > MAX_LOADED_SKILL_SESSIONS) {
    keys
      .sort((a, b) => store[a]!.updatedAt - store[b]!.updatedAt)
      .slice(0, keys.length - MAX_LOADED_SKILL_SESSIONS)
      .forEach((key) => delete store[key]);
  }
  writeLoadedSkills(store);
}

/** OpenCode compacted the session: its skills come back with the next new Claude session. */
export function markSkillsForReattach(conversationKey: string): void {
  const store = readLoadedSkills();
  const record = store[conversationKey];
  if (!record || record.skills.length === 0) return;
  store[conversationKey] = { ...record, reattach: true, updatedAt: Date.now() };
  writeLoadedSkills(store);
}

/** A new Claude session got the skills back. */
export function clearSkillsReattach(conversationKey: string): void {
  const store = readLoadedSkills();
  const record = store[conversationKey];
  if (!record?.reattach) return;
  store[conversationKey] = {
    conversationKey,
    skills: record.skills,
    updatedAt: Date.now(),
  };
  writeLoadedSkills(store);
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
 *
 * `configDir` is the config home of the account about to resume: another
 * account's transcripts are only visible when both share `projects/`.
 */
export function findClaudeSessionFile(
  foreignSessionId: string,
  configDir: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
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
