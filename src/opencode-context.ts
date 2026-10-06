/**
 * OpenCode's own context for a chat turn, taken from the system messages of
 * an OpenCode 1.x request. Claude Code runs without filesystem settings
 * (no CLAUDE.md, memory, MCP servers or plugins of its own), so this is the
 * only instruction context Claude gets besides the Claude Code preset.
 *
 * OpenCode 1.x layout (session/llm/request.ts, session/system.ts):
 * - System message 1: the agent's prompt, or OpenCode's stock prompt for the
 *   built-in agents; then the environment block ("You are powered by the
 *   model named ..." through "</env>"); then project references,
 *   "Instructions from: <path>" files (global and project AGENTS.md,
 *   configured instructions), <mcp_instructions>, the skills list and
 *   session notices.
 * - System messages 2+: what plugins add through
 *   experimental.chat.system.transform (durable task state, temporal
 *   metadata, ...).
 *
 * Dropped, because Claude Code supplies its own: OpenCode's stock prompt and
 * the stock lines of the environment block. Plugin edits inside the
 * environment block (temporal-context's "Current date:" line) are kept.
 */
import { log } from "./log.js";
import { extractTextContent } from "./prompt.js";

type MessageLike = { role?: string; content?: unknown };

export type OpenCodeContext = {
  /** A custom agent's own prompt; empty for OpenCode's built-in agents. */
  agentPrompt: string;
  /** Everything else worth forwarding, in OpenCode's order. */
  blocks: string[];
};

const ENV_START = "You are powered by the model named";
const ENV_END = "</env>";

/** How OpenCode's stock prompts open (anthropic.txt, default.txt). */
const STOCK_PROMPT = /^\s*You are (?:OpenCode|opencode)\b/;

/** Lines OpenCode writes into every environment block. */
const STOCK_ENV_LINE =
  /^\s*(?:You are powered by the model named |Here is some useful information about the environment you are running in:|<env>|<\/env>|Working directory:|Workspace root folder:|Is directory a git repo:|Platform:|Today's date:)/;

let warnedUnknownLayout = false;

export function openCodeContext(messages: MessageLike[]): OpenCodeContext {
  const systems = messages
    .filter((m) => m?.role === "system")
    .map((m) => extractTextContent(m.content))
    .filter((text) => text.trim());
  if (systems.length === 0) return { agentPrompt: "", blocks: [] };

  const [first, ...pluginBlocks] = systems as [string, ...string[]];
  const blocks: string[] = [];
  let agentPrompt = "";

  const envStart = first.indexOf(ENV_START);
  const envEndAt = envStart < 0 ? -1 : first.indexOf(ENV_END, envStart);
  if (envStart < 0 || envEndAt < 0) {
    // Not the layout this module knows. Forward it whole rather than lose
    // the user's instructions.
    if (!warnedUnknownLayout) {
      warnedUnknownLayout = true;
      log.warn("[opencode-claude] unrecognised OpenCode system prompt layout; forwarding it whole");
    }
    blocks.push(first.trim());
  } else {
    const head = first.slice(0, envStart).trim();
    if (head && !STOCK_PROMPT.test(head)) agentPrompt = head;

    const envEnd = envEndAt + ENV_END.length;
    const envExtras = first
      .slice(envStart, envEnd)
      .split(/\r?\n/)
      .filter((line) => line.trim() && !STOCK_ENV_LINE.test(line))
      .map((line) => line.trim());
    if (envExtras.length > 0) blocks.push(envExtras.join("\n"));

    const tail = first.slice(envEnd).trim();
    if (tail) blocks.push(tail);
  }

  for (const block of pluginBlocks) blocks.push(block.trim());
  return { agentPrompt, blocks };
}

/** The OpenCode part of Claude's appended system prompt. */
export function openCodeContextPrompt(context: OpenCodeContext): string[] {
  const sections: string[] = [];
  if (context.agentPrompt) {
    sections.push(
      `# Agent role (from this session's OpenCode agent configuration; it defines who you are in this session and takes precedence over the generic role above)\n\n${context.agentPrompt}`,
    );
  }
  if (context.blocks.length > 0) {
    sections.push(
      [
        "# OpenCode context",
        "OpenCode loaded the following for this session: instruction files (global and project AGENTS.md), skills, MCP server notes and plugin instructions. Treat it as system instructions. Tool names in it (read, edit, task_state, ...) refer to the matching mcp__opencode__* tools.",
        ...context.blocks,
      ].join("\n\n"),
    );
  }
  return sections;
}
