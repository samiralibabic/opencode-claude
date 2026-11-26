/**
 * OpenCode's skills, shown to Claude the way Claude Code shows its own.
 *
 * OpenCode lists the available skills at the end of its system prompt
 * (session/system.ts on 1.x, core/skill/guidance.ts on V2) and its `skill`
 * tool only points there. Behind the Claude Code preset that list sits in
 * the middle of a long appended system prompt, and Claude rarely loaded a
 * skill unless the user's message named it. Claude Code itself announces
 * skills in the conversation, as a <system-reminder>, and its Skill tool asks
 * to be called first when a listed skill covers the task. This module takes
 * the list out of OpenCode's context, renders that reminder and provides the
 * matching tool description; proxy.ts decides when the reminder is sent.
 */
import { createHash } from "node:crypto";
import type { OpenCodeContext } from "./opencode-context.js";

/** OpenCode's tool name; Claude sees it as mcp__opencode__skill. */
export const SKILL_TOOL = "skill";

/** One entry of OpenCode's skills list. */
export type SkillListing = { name: string; description: string };

/**
 * OpenCode's skills section: two lines of guidance, then the list. The
 * guidance lines are optional so a rewording upstream only leaves them in
 * place instead of breaking the match.
 */
const SKILLS_SECTION =
  /(?:Skills provide specialized instructions[^\n]*\n)?(?:Use the skill tool[^\n]*\n)?<available_skills>([\s\S]*?)<\/available_skills>\n?/;

/** One <skill> entry; V2 omits <location>, a skill may lack a description. */
const SKILL_ENTRY =
  /<skill>\s*<name>([\s\S]*?)<\/name>(?:\s*<description>([\s\S]*?)<\/description>)?[\s\S]*?<\/skill>/g;

/**
 * Takes OpenCode's skills list out of its context. Null when the context has
 * no list or no entry can be read; the caller then keeps the context as is,
 * so the list is never lost.
 */
export function takeSkills(
  context: OpenCodeContext,
): { context: OpenCodeContext; skills: SkillListing[] } | null {
  for (let i = 0; i < context.blocks.length; i++) {
    const block = context.blocks[i]!;
    const match = SKILLS_SECTION.exec(block);
    if (!match) continue;
    const skills = [...match[1]!.matchAll(SKILL_ENTRY)]
      .map(([, name, description]) => ({
        name: name!.trim(),
        description: (description ?? "").replace(/\s+/g, " ").trim(),
      }))
      .filter((skill) => skill.name);
    if (skills.length === 0) return null;
    const rest = (
      block.slice(0, match.index) + block.slice(match.index + match[0].length)
    ).trim();
    return {
      context: {
        ...context,
        blocks: [
          ...context.blocks.slice(0, i),
          ...(rest ? [rest] : []),
          ...context.blocks.slice(i + 1),
        ],
      },
      skills,
    };
  }
  return null;
}

/** The skills list as Claude Code announces its own: one line per skill. */
export function skillsReminder(skills: SkillListing[]): string {
  return [
    "<system-reminder>",
    `The following skills are available for use with the mcp__opencode__${SKILL_TOOL} tool. When the task, or a step you are about to take, is one a skill below covers, load that skill first:`,
    "",
    ...skills.map((skill) =>
      skill.description ? `- ${skill.name}: ${skill.description}` : `- ${skill.name}`,
    ),
    "</system-reminder>",
  ].join("\n");
}

/**
 * Identifies a reminder's content, so a resumed Claude session gets the list
 * again only when it has not seen this exact list since its last compaction.
 */
export function skillsListingKey(reminder: string): string {
  return createHash("sha1").update(reminder).digest("hex").slice(0, 16);
}

/**
 * Description of OpenCode's skill tool as Claude sees it, after Claude
 * Code's own Skill tool. It replaces OpenCode's, which points to a list in
 * the system prompt that is no longer there.
 */
export const SKILL_TOOL_DESCRIPTION = [
  "Load a skill: instructions the user or project has set up for a particular kind of task or step (company rules, a checklist, a design guide, a repository workflow). The available skills appear in a system-reminder listing with one-line descriptions.",
  "",
  "When the task at hand, or a step you are about to take (creating a branch, committing, pushing, opening or merging a pull request, changing a user interface, writing text for publication), is one a listed skill covers, call this tool first, before you start that work: the skill's instructions load into the conversation for you to follow in place of your default approach. Check the listing again before each such step, not only at the start of the task. When the user or the task names a skill, load it.",
  "",
  "- `name`: the exact skill name from the listing.",
  "",
  "Only names from the listing, or names the user gave, are valid. If a skill's instructions are already in this conversation, follow them instead of loading the skill again.",
].join("\n");

/**
 * Skills a session loaded come back after OpenCode compacts it. The
 * compaction resets the Claude session (index.ts) and OpenCode's summary
 * keeps no skill content, so an agent that loaded github-rules early in a
 * long session no longer had it at its next push. Claude Code re-attaches the
 * skills it invoked before a compaction: the most recent version of each,
 * newest first, each cut to 5,000 tokens and 25,000 in total. The plugin
 * does the same with the skills it bridged.
 *
 * Tokens are estimated as characters / 4, as Claude Code does for this cut;
 * the plugin has no tokenizer. The total covers the whole reminder.
 */
export const REATTACH_SKILL_TOKENS = 5_000;
export const REATTACH_TOTAL_TOKENS = 25_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A skill as the session last loaded it: OpenCode's <skill_content> block. */
export type LoadedSkill = { name: string; content: string; loadedAt: number };

/** OpenCode's skill tool output (tool/skill.ts); the end tag may be cut off. */
const SKILL_CONTENT = /<skill_content name="([^"]+)">[\s\S]*?(?:<\/skill_content>|$)/;

/** The skill a skill tool result loaded, or null when it loaded none. */
export function loadedSkillFromResult(
  text: string,
): { name: string; content: string } | null {
  const match = SKILL_CONTENT.exec(text);
  const name = match?.[1]?.trim();
  return match && name ? { name, content: match[0].trim() } : null;
}

const TRUNCATED_NOTE = `\n\n[... skill content truncated after the compaction; load the skill again with the mcp__opencode__${SKILL_TOOL} tool if you need the full text]`;

/** A skill's content cut to the per-skill budget. */
export function capSkillContent(content: string): string {
  if (estimateTokens(content) <= REATTACH_SKILL_TOKENS) return content;
  return content.slice(0, REATTACH_SKILL_TOKENS * 4 - TRUNCATED_NOTE.length) + TRUNCATED_NOTE;
}

const REATTACH_HEAD = [
  "<system-reminder>",
  `The following skills were loaded with the mcp__opencode__${SKILL_TOOL} tool EARLIER in this session (before the conversation was compacted), not on the current turn. Their instructions still apply: keep following them wherever they are relevant, without loading them again.`,
  "",
  "Do NOT repeat a skill's one-time setup actions (for example scheduling or creating files) because it appears here.",
].join("\n");
const REATTACH_TAIL = "</system-reminder>";
const BLOCK_SEPARATOR = "\n\n";

/**
 * The skills that fit the budgets, newest first, one per name, each capped:
 * Claude Code's selection. A skill that would pass the total is left out and
 * smaller older ones still get their turn. `skip` leaves out skills whose
 * content is already in context.
 */
export function selectLoadedSkills(
  skills: LoadedSkill[],
  skip: (content: string) => boolean = () => false,
): LoadedSkill[] {
  const newest = [...skills].sort((a, b) => b.loadedAt - a.loadedAt);
  const seen = new Set<string>();
  const selected: LoadedSkill[] = [];
  let total = estimateTokens(REATTACH_HEAD) + estimateTokens(`\n${REATTACH_TAIL}`);
  for (const skill of newest) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    if (skip(skill.content)) continue;
    const content = capSkillContent(skill.content);
    const cost = estimateTokens(BLOCK_SEPARATOR + content);
    if (total + cost > REATTACH_TOTAL_TOKENS) continue;
    total += cost;
    selected.push({ ...skill, content });
  }
  return selected;
}

/**
 * The reminder that brings the session's skills back in its first Claude
 * session after a compaction, worded after Claude Code's. Empty when none is
 * left to send.
 */
export function loadedSkillsReminder(
  skills: LoadedSkill[],
  skip?: (content: string) => boolean,
): string {
  const selected = selectLoadedSkills(skills, skip);
  if (selected.length === 0) return "";
  return [
    REATTACH_HEAD,
    ...selected.map((skill) => skill.content),
  ].join(BLOCK_SEPARATOR) + `\n${REATTACH_TAIL}`;
}
