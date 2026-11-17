/**
 * OpenCode's skills list in the conversation (src/skills.ts): what reaches
 * Claude when a session starts, when history is carried into a new session
 * and after Claude Code compacts the conversation.
 *
 * Run: bun test/skills-in-conversation.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  bashTool,
  callTool,
  listTools,
  mockHandle,
  startMockedProxy,
  textDelta,
} from "./helpers.ts";

// Resumable sessions are found by their transcript under this config home.
const claudeHome = mkdtempSync(join(tmpdir(), "opencode-claude-skills-home-"));
process.env.CLAUDE_CONFIG_DIR = claudeHome;

type Ctx = Awaited<ReturnType<typeof startMockedProxy>>;

const skillTool = {
  type: "function",
  function: {
    name: "skill",
    description:
      "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The name of the skill from available_skills" },
      },
      required: ["name"],
    },
  },
};

/** OpenCode 1.x skills section (session/system.ts, Skill.fmt verbose). */
const SKILLS_V1 = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <name>github-rules</name>",
  "    <description>Before branches, pull requests, merges, issues or settings: company rules.</description>",
  "    <location>/home/u/skills/github-rules/SKILL.md</location>",
  "  </skill>",
  "  <skill>",
  "    <name>professional-ui-design</name>",
  "    <description>Apply established UI/UX principles\n  when changing interfaces.</description>",
  "    <location>/home/u/skills/professional-ui-design/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

/** OpenCode V2 skills section (core/skill/guidance.ts): no <location>. */
const SKILLS_V2 = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <name>wrangler</name>",
  "    <description>Cloudflare Workers CLI.</description>",
  "  </skill>",
  "</available_skills>",
].join("\n");

function openCodeSystem(skillsSection: string) {
  return [
    {
      role: "system",
      content: [
        "You are OpenCode, the best coding agent on the planet.",
        "You are powered by the model named claude-opus-5-5. The exact model ID is claude-code/claude-opus-5-5",
        "Here is some useful information about the environment you are running in:",
        "<env>",
        "  Working directory: /work/app",
        "</env>",
        "Instructions from: /work/app/AGENTS.md\nPROJECT-RULE-3: run make check.",
        skillsSection,
        "<mcp_instructions>\n  <server name=\"pencil\">\n    Use pencil for .pen files.\n  </server>\n</mcp_instructions>",
      ].join("\n"),
    },
  ];
}

const GITHUB_LINE =
  "- github-rules: Before branches, pull requests, merges, issues or settings: company rules.";

/** A stored Claude session the CLI could resume. */
function sessionOnDisk(id: string) {
  const dir = join(claudeHome, "projects", "-work-app");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
}

/** Text of the first user message the turn sent to Claude. */
async function firstPromptText(prompt: unknown): Promise<string> {
  const first = typeof prompt === "string"
    ? { message: { content: prompt } }
    : (await (prompt as AsyncIterable<any>)[Symbol.asyncIterator]().next()).value;
  const content = first.message.content;
  return typeof content === "string"
    ? content
    : content.map((block: { text?: string }) => block.text ?? "").join("\n");
}

type Seen = { params: Record<string, any>; prompt: string; tools: any[] };

/**
 * Runs one turn on a mocked Claude session: records what the turn sent and
 * plays `events` (system events, text) before the result.
 */
async function turn(
  ctx: Ctx,
  session: string,
  claudeSession: string,
  messages: unknown[],
  options: { tools?: unknown[]; events?: unknown[] } = {},
): Promise<Seen> {
  let seen: Seen | null = null;
  ctx.proxy.setClaudeQueryStarter(async (params) => {
    seen = {
      params: params as Record<string, any>,
      prompt: await firstPromptText(params.prompt),
      tools: params.mcpServers ? await listTools(params) : [],
    };
    return mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: claudeSession };
        for (const event of options.events ?? []) yield event;
        yield textDelta("ok");
        yield { type: "result", is_error: false, usage: {}, session_id: claudeSession };
      })(),
    );
  });
  const res = await ctx.post(session, {
    tools: options.tools ?? [bashTool, skillTool],
    messages,
  });
  assert.equal(res.status, 200);
  await res.json();
  return seen!;
}

const compactBoundary = (sessionId: string) => ({
  type: "system",
  subtype: "compact_boundary",
  session_id: sessionId,
  compact_metadata: { trigger: "auto", pre_tokens: 180_000 },
});

async function listing() {
  const { openCodeContext } = await import("../src/opencode-context.ts");
  const { CLAUDE_TOOL_DESCRIPTION_LIMIT } = await import("../src/proxy.ts");
  const { takeSkills, skillsReminder, SKILL_TOOL_DESCRIPTION } = await import(
    "../src/skills.ts"
  );

  const taken = takeSkills(openCodeContext(openCodeSystem(SKILLS_V1)))!;
  assert.deepEqual(taken.skills, [
    {
      name: "github-rules",
      description: "Before branches, pull requests, merges, issues or settings: company rules.",
    },
    {
      name: "professional-ui-design",
      description: "Apply established UI/UX principles when changing interfaces.",
    },
  ]);
  const rest = taken.context.blocks.join("\n\n");
  assert.doesNotMatch(rest, /available_skills|Skills provide specialized|Use the skill tool/);
  assert.match(rest, /PROJECT-RULE-3/, "the instructions around the list stay");
  assert.match(rest, /<mcp_instructions>/);

  const v2 = takeSkills(openCodeContext(openCodeSystem(SKILLS_V2)))!;
  assert.deepEqual(v2.skills, [{ name: "wrangler", description: "Cloudflare Workers CLI." }]);

  // Nothing to move: no list, OpenCode's empty notice, or no readable entry.
  assert.equal(takeSkills(openCodeContext(openCodeSystem(""))), null);
  assert.equal(
    takeSkills(openCodeContext(openCodeSystem(
      "Skills provide specialized instructions and workflows for specific tasks.\nNo skills are currently available.",
    ))),
    null,
  );
  assert.equal(
    takeSkills(openCodeContext(openCodeSystem("<available_skills>\n</available_skills>"))),
    null,
  );

  const reminder = skillsReminder(taken.skills);
  assert.ok(reminder.startsWith("<system-reminder>\nThe following skills are available for use with the mcp__opencode__skill tool."));
  assert.ok(reminder.endsWith("</system-reminder>"));
  assert.ok(reminder.includes(`\n${GITHUB_LINE}\n`), "one name: description line per skill");
  assert.ok(SKILL_TOOL_DESCRIPTION.length <= CLAUDE_TOOL_DESCRIPTION_LIMIT, "not cut by Claude Code");
}

/** Injection point 1: a new Claude session starts with the list. */
async function newSession(ctx: Ctx) {
  const { SKILL_TOOL_DESCRIPTION } = await import("../src/skills.ts");
  const seen = await turn(ctx, "skills-new", "skills-new-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "change the button colour" },
  ]);
  assert.ok(seen.prompt.startsWith("<system-reminder>\nThe following skills"));
  assert.ok(seen.prompt.includes(GITHUB_LINE));
  assert.ok(seen.prompt.endsWith("</system-reminder>\n\nchange the button colour"));
  const append = String(seen.params.systemPrompt.append);
  assert.doesNotMatch(append, /available_skills|Skills provide specialized/, "list moved out of the system prompt");
  assert.match(append, /PROJECT-RULE-3/);
  assert.match(append, /<mcp_instructions>/);
  const skill = seen.tools.find((t) => t.name === "skill");
  assert.equal(skill.description, SKILL_TOOL_DESCRIPTION);
  assert.deepEqual(skill.inputSchema, skillTool.function.parameters, "schema unchanged");
  assert.equal(seen.tools.find((t) => t.name === "bash").description, "Run a command");

  // Resumed with the list in context: not sent again.
  sessionOnDisk("skills-new-sess");
  const resumed = await turn(ctx, "skills-new", "skills-new-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "change the button colour" },
    { role: "assistant", content: "Done." },
    { role: "user", content: "now push it" },
  ]);
  assert.equal(resumed.params.resume, "skills-new-sess");
  assert.equal(resumed.prompt, "now push it");

  // A changed list is sent again.
  const changed = await turn(ctx, "skills-new", "skills-new-sess", [
    ...openCodeSystem(SKILLS_V2),
    { role: "user", content: "change the button colour" },
    { role: "assistant", content: "Done." },
    { role: "user", content: "deploy it" },
  ]);
  assert.equal(changed.params.resume, "skills-new-sess");
  assert.ok(changed.prompt.startsWith("<system-reminder>"));
  assert.ok(changed.prompt.includes("- wrangler: Cloudflare Workers CLI."));
  assert.ok(changed.prompt.endsWith("deploy it"));
}

/** Without OpenCode's skill tool nothing moves: the list stays in the system prompt. */
async function withoutSkillTool(ctx: Ctx) {
  const seen = await turn(
    ctx,
    "skills-no-tool",
    "skills-no-tool-sess",
    [...openCodeSystem(SKILLS_V1), { role: "user", content: "look around" }],
    { tools: [bashTool] },
  );
  assert.equal(seen.prompt, "look around");
  assert.match(String(seen.params.systemPrompt.append), /<available_skills>[\s\S]*github-rules/);
}

/** Injection point 2: history carried into a new Claude session. */
async function historyCarriedOver(ctx: Ctx) {
  const { setForeignSessionId } = await import("../src/session-store.ts");
  // The stored session's transcript is gone, so the history moves instead.
  setForeignSessionId("skills-history", "skills-gone-sess");
  const seen = await turn(ctx, "skills-history", "skills-history-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "remember AXIOM-9042" },
    { role: "assistant", content: "Noted." },
    { role: "user", content: "now push it" },
  ]);
  assert.equal(seen.params.resume, undefined);
  assert.ok(seen.prompt.startsWith("<system-reminder>\nThe following skills"));
  assert.ok(seen.prompt.includes(GITHUB_LINE));
  const history = seen.prompt.indexOf("<conversation_history>");
  assert.ok(history > seen.prompt.indexOf("</system-reminder>"), "list first, then the history");
  assert.match(seen.prompt, /AXIOM-9042/);
  assert.ok(seen.prompt.endsWith("Latest user message:\nnow push it"));

  // A session started before the list moved (no key stored) gets it on resume.
  sessionOnDisk("skills-older-sess");
  setForeignSessionId("skills-older", "skills-older-sess");
  const older = await turn(ctx, "skills-older", "skills-older-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hi." },
    { role: "user", content: "now push it" },
  ]);
  assert.equal(older.params.resume, "skills-older-sess");
  assert.ok(older.prompt.startsWith("<system-reminder>"));
  assert.ok(older.prompt.endsWith("</system-reminder>\n\nnow push it"));
}

/** Injection point 3a: compacted at the end of a turn, sent with the next prompt. */
async function compactedBetweenTurns(ctx: Ctx) {
  const { getSessionBinding } = await import("../src/session-store.ts");
  const first = [...openCodeSystem(SKILLS_V1), { role: "user", content: "start" }];
  await turn(ctx, "skills-compact", "compact-sess", first, {
    events: [compactBoundary("compact-sess")],
  });
  assert.equal(getSessionBinding("skills-compact")?.skillsListing, undefined, "list compacted away");

  sessionOnDisk("compact-sess");
  const next = [...first, { role: "assistant", content: "ok" }, { role: "user", content: "now push it" }];
  const after = await turn(ctx, "skills-compact", "compact-sess", next);
  assert.equal(after.params.resume, "compact-sess");
  assert.ok(after.prompt.startsWith("<system-reminder>\nThe following skills"));
  assert.ok(after.prompt.endsWith("</system-reminder>\n\nnow push it"));
  assert.ok(getSessionBinding("skills-compact")?.skillsListing, "back in context");

  const later = await turn(ctx, "skills-compact", "compact-sess", [
    ...next,
    { role: "assistant", content: "ok" },
    { role: "user", content: "and open the PR" },
  ]);
  assert.equal(later.prompt, "and open the PR", "sent once per compaction");
}

/** Injection point 3b: compacted mid-turn, sent with the next tool result. */
async function compactedMidTurn(ctx: Ctx) {
  const { getSessionBinding } = await import("../src/session-store.ts");
  const received: string[] = [];
  ctx.proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "midturn-sess" };
        const before = await callTool(params, "bash", { command: "a" });
        received.push(before.content.map((b) => b.text ?? "").join("\n"));
        yield { type: "user", message: { role: "user", content: [] }, session_id: "midturn-sess" };
        yield compactBoundary("midturn-sess");
        const after = await callTool(params, "bash", { command: "b" });
        received.push(after.content.map((b) => b.text ?? "").join("\n"));
        yield { type: "user", message: { role: "user", content: [] }, session_id: "midturn-sess" };
        yield textDelta("DONE");
        yield { type: "result", is_error: false, usage: {}, session_id: "midturn-sess" };
      })(),
    ),
  );
  const messages: any[] = [...openCodeSystem(SKILLS_V1), { role: "user", content: "run both" }];
  const tools = [bashTool, skillTool];
  for (const output of ["out a", "out b"]) {
    const parked = (await (await ctx.post("skills-midturn", { tools, messages })).json()) as any;
    const call = parked.choices[0].message.tool_calls[0];
    messages.push(
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: output },
    );
  }
  const done = (await (await ctx.post("skills-midturn", { tools, messages })).json()) as any;
  assert.match(String(done.choices[0].message.content), /DONE/);
  assert.equal(received[0], "out a", "no list before the compaction");
  assert.ok(received[1]!.startsWith("out b\n<system-reminder>\nThe following skills"));
  assert.ok(received[1]!.includes(GITHUB_LINE));
  assert.ok(getSessionBinding("skills-midturn")?.skillsListing, "back in context");
}

async function main() {
  await listing();
  const ctx = await startMockedProxy("skills");
  try {
    await newSession(ctx);
    await withoutSkillTool(ctx);
    await historyCarriedOver(ctx);
    await compactedBetweenTurns(ctx);
    await compactedMidTurn(ctx);
  } finally {
    ctx.proxy.setClaudeQueryStarter(null);
    await ctx.proxy.stopProxy();
  }
  console.log("ok — skills-in-conversation tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
