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
