/**
 * OpenCode's skills list in the conversation (src/skills.ts): what reaches
 * Claude when a session starts, when history is carried into a new session
 * and after Claude Code compacts the conversation. And the skills a session
 * loaded, which come back after OpenCode compacts it.
 *
 * Run: bun test/skills-in-conversation.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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


// Skills a session loaded, after OpenCode compacts it.

const taskTool = {
  type: "function",
  function: {
    name: "task",
    description: "Start a helper agent",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" }, subagent_type: { type: "string" } },
      required: ["prompt"],
    },
  },
};

/** OpenCode's skill tool output (tool/skill.ts). */
function skillOutput(name: string, body: string) {
  return [
    `<skill_content name="${name}">`,
    `# Skill: ${name}`,
    "",
    body,
    "",
    `Base directory for this skill: /home/u/skills/${name}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    "",
    "</skill_files>",
    "</skill_content>",
  ].join("\n");
}

const GITHUB_RULES = skillOutput("github-rules", "1. Name the branch after the task.\n2. Link the Notion story.");
const GITHUB_RULES_V2 = skillOutput("github-rules", "1. Name the branch after the task.\n2. Link the Notion story.\n3. No Actions.");
const UI_RULES = skillOutput("professional-ui-design", "Use the design guide's tones for states.");

const REATTACH_HEAD =
  "<system-reminder>\nThe following skills were loaded with the mcp__opencode__skill tool EARLIER in this session (before the conversation was compacted)";

const count = (text: string, part: string) => text.split(part).length - 1;

/**
 * One turn in which Claude loads each skill in turn through OpenCode's skill
 * tool. Returns OpenCode's history after the turn.
 */
async function loadSkillsTurn(
  ctx: Ctx,
  session: string,
  claudeSession: string,
  history: any[],
  outputs: string[],
  tools: unknown[] = [bashTool, skillTool],
): Promise<any[]> {
  ctx.proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: claudeSession };
        for (const output of outputs) {
          const name = /name="([^"]+)"/.exec(output)![1];
          await callTool(params, "skill", { name });
          yield { type: "user", message: { role: "user", content: [] }, session_id: claudeSession };
        }
        yield textDelta("loaded");
        yield { type: "result", is_error: false, usage: {}, session_id: claudeSession };
      })(),
    ),
  );
  const messages = [...history];
  for (const output of outputs) {
    const parked = (await (await ctx.post(session, { tools, messages })).json()) as any;
    const call = parked.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "skill");
    messages.push(
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: output },
    );
  }
  const done = (await (await ctx.post(session, { tools, messages })).json()) as any;
  assert.match(String(done.choices[0].message.content), /loaded/);
  messages.push({ role: "assistant", content: "loaded" });
  return messages;
}

/** OpenCode's history after a compaction: its prompt, the summary, the next message. */
function compactedHistory(latest: string) {
  return [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "What did we do so far?" },
    { role: "assistant", content: "## Objective\n- Fix the docs typo and push it on a branch" },
    { role: "user", content: latest },
  ];
}

type Hooks = { event: (input: { event: unknown }) => Promise<void> };

async function compact(hooks: Hooks, session: string) {
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: session } } });
}

/** The skills list reminder for these OpenCode messages. */
async function listOf(messages: any[]): Promise<string> {
  const { openCodeContext } = await import("../src/opencode-context.ts");
  const { takeSkills, skillsReminder } = await import("../src/skills.ts");
  return skillsReminder(takeSkills(openCodeContext(messages))!.skills);
}

/** What 0.16.0 sends as the first prompt of a new Claude session (that code is unchanged). */
async function newSessionPrompt(messages: any[], latest: string): Promise<string> {
  const prompt = await import("../src/prompt.ts");
  return prompt.withSystemReminder(
    prompt.withConversationContext(
      latest,
      prompt.buildConversationTranscript(prompt.priorMessagesOf(messages)),
    ),
    await listOf(messages),
  ) as string;
}

/** The same with these skill outputs (newest first) back between the list and the history. */
async function withReattached(messages: any[], latest: string, outputs: string[]): Promise<string> {
  const { loadedSkillsReminder } = await import("../src/skills.ts");
  const base = await newSessionPrompt(messages, latest);
  const list = await listOf(messages);
  const reattach = loadedSkillsReminder(
    outputs.map((content, i) => ({
      name: /name="([^"]+)"/.exec(content)![1]!,
      content,
      loadedAt: outputs.length - i,
    })),
  );
  assert.ok(base.startsWith(`${list}\n\n`));
  return `${list}\n\n${reattach}\n\n${base.slice(list.length + 2)}`;
}

/** Nothing loaded, or never compacted: exactly what 0.16.0 sends. */
async function reattachNothing(ctx: Ctx, hooks: Hooks) {
  const { getLoadedSkills, setForeignSessionId } = await import("../src/session-store.ts");

  // No skill loaded before the compaction.
  await turn(ctx, "reattach-none", "none-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "fix the typo" },
  ]);
  await compact(hooks, "reattach-none");
  assert.equal(getLoadedSkills("reattach-none"), undefined, "nothing recorded");
  const messages = compactedHistory("now push the branch");
  const after = await turn(ctx, "reattach-none", "none-sess-2", messages);
  assert.equal(after.params.resume, undefined);
  assert.equal(after.prompt, await newSessionPrompt(messages, "now push the branch"));
  assert.doesNotMatch(after.prompt, /EARLIER in this session/);

  // A skill loaded, never compacted: resumed turns and a carried-over history
  // (the Claude session's transcript went missing) stay as they were.
  const history = await loadSkillsTurn(ctx, "reattach-never", "never-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "fix the typo" },
  ], [GITHUB_RULES]);
  assert.equal(getLoadedSkills("reattach-never")?.skills.length, 1, "recorded");
  sessionOnDisk("never-sess");
  const resumed = await turn(ctx, "reattach-never", "never-sess", [
    ...history,
    { role: "user", content: "now push the branch" },
  ]);
  assert.equal(resumed.params.resume, "never-sess");
  assert.equal(resumed.prompt, "now push the branch");

  setForeignSessionId("reattach-never", "never-gone-sess");
  const carried = [...history, { role: "user", content: "and open the PR" }];
  const fresh = await turn(ctx, "reattach-never", "never-sess-2", carried);
  assert.equal(fresh.params.resume, undefined);
  assert.equal(fresh.prompt, await newSessionPrompt(carried, "and open the PR"));
}

/** One skill: back once, in the first Claude session after the compaction. */
async function reattachOne(ctx: Ctx, hooks: Hooks) {
  const { getLoadedSkills } = await import("../src/session-store.ts");
  await loadSkillsTurn(ctx, "reattach-one", "one-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "load the skill github-rules, then fix the typo" },
  ], [GITHUB_RULES]);
  await compact(hooks, "reattach-one");
  assert.equal(getLoadedSkills("reattach-one")?.reattach, true);

  const messages = compactedHistory("now push the branch");
  const after = await turn(ctx, "reattach-one", "one-sess-2", messages);
  assert.equal(after.params.resume, undefined);
  assert.equal(after.prompt, await withReattached(messages, "now push the branch", [GITHUB_RULES]));
  assert.equal(count(after.prompt, GITHUB_RULES), 1);
  assert.ok(after.prompt.indexOf(REATTACH_HEAD) > after.prompt.indexOf("The following skills are available"));
  assert.ok(after.prompt.indexOf(GITHUB_RULES) < after.prompt.indexOf("<conversation_history>"));
  assert.equal(getLoadedSkills("reattach-one")?.reattach, undefined, "sent");

  // Resumed afterwards, or carried into yet another Claude session without
  // a new compaction: not sent again.
  sessionOnDisk("one-sess-2");
  const later = await turn(ctx, "reattach-one", "one-sess-2", [
    ...messages,
    { role: "assistant", content: "Pushed." },
    { role: "user", content: "and open the PR" },
  ]);
  assert.equal(later.prompt, "and open the PR");

  // Compacted again: back again.
  await compact(hooks, "reattach-one");
  const again = await turn(ctx, "reattach-one", "one-sess-3", compactedHistory("merge it"));
  assert.equal(count(again.prompt, GITHUB_RULES), 1);
}

/** Several skills, one loaded twice: each back once, the newest version, newest first. */
async function reattachSeveral(ctx: Ctx, hooks: Hooks) {
  const first = await loadSkillsTurn(ctx, "reattach-several", "several-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "change the screen and push it" },
  ], [GITHUB_RULES, UI_RULES]);
  sessionOnDisk("several-sess");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await loadSkillsTurn(ctx, "reattach-several", "several-sess", [
    ...first,
    { role: "user", content: "check the rules again" },
  ], [GITHUB_RULES_V2]);
  await compact(hooks, "reattach-several");

  const messages = compactedHistory("now push the branch");
  const after = await turn(ctx, "reattach-several", "several-sess-2", messages);
  assert.equal(after.prompt, await withReattached(messages, "now push the branch", [GITHUB_RULES_V2, UI_RULES]));
  assert.equal(count(after.prompt, GITHUB_RULES_V2), 1);
  assert.equal(count(after.prompt, UI_RULES), 1);
  assert.equal(count(after.prompt, "3. No Actions."), 1);
  assert.equal(count(after.prompt, GITHUB_RULES), 0, "older version gone");
  assert.equal(count(after.prompt, '<skill_content name="github-rules">'), 1);
  assert.ok(after.prompt.indexOf(GITHUB_RULES_V2) < after.prompt.indexOf(UI_RULES), "newest first");

  // A skill the history after the compaction still carries in full stays there.
  const small = skillOutput("notion-rules", "Tick the box.");
  await loadSkillsTurn(ctx, "reattach-tail", "tail-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "start" },
  ], [small, UI_RULES]);
  await compact(hooks, "reattach-tail");
  const call = { id: "call_tail", type: "function", function: { name: "skill", arguments: '{"name":"notion-rules"}' } };
  const tail = [
    ...compactedHistory("go on").slice(0, -1),
    { role: "user", content: "tick it" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "call_tail", content: small },
    { role: "assistant", content: "Ticked." },
    { role: "user", content: "go on" },
  ];
  const kept = await turn(ctx, "reattach-tail", "tail-sess-2", tail);
  assert.equal(count(kept.prompt, small), 1, "once, in the history");
  assert.equal(count(kept.prompt, UI_RULES), 1, "the other one comes back");
}

/** 5,000 tokens per skill, 25,000 in total (characters / 4). */
async function reattachCaps(ctx: Ctx, hooks: Hooks) {
  const {
    REATTACH_SKILL_TOKENS,
    REATTACH_TOTAL_TOKENS,
    estimateTokens,
    loadedSkillsReminder,
    selectLoadedSkills,
  } = await import("../src/skills.ts");
  assert.equal(REATTACH_SKILL_TOKENS, 5_000);
  assert.equal(REATTACH_TOTAL_TOKENS, 25_000);
  assert.equal(estimateTokens("abcde"), 2);

  const huge = skillOutput("catalog-service", "x".repeat(30_000));
  const [capped] = selectLoadedSkills([{ name: "catalog-service", content: huge, loadedAt: 1 }]);
  assert.ok(estimateTokens(capped!.content) <= 5_000);
  assert.ok(capped!.content.length > 19_000, "cut at the cap, not before");
  assert.ok(capped!.content.startsWith('<skill_content name="catalog-service">\n# Skill: catalog-service'));
  assert.match(capped!.content, /\[\.\.\. skill content truncated after the compaction; load the skill again with the mcp__opencode__skill tool if you need the full text\]$/);

  // Seven skills of ~4,900 tokens, newest first, and a small old one: five
  // fit, the sixth would pass the total, the small one still fits.
  const big = (i: number) => ({
    name: `big-${i}`,
    content: skillOutput(`big-${i}`, "y".repeat(19_000)),
    loadedAt: 100 - i,
  });
  const skills = [1, 2, 3, 4, 5, 6, 7].map(big);
  skills.push({ name: "tiny", content: skillOutput("tiny", "z"), loadedAt: 1 });
  const selected = selectLoadedSkills(skills);
  assert.deepEqual(selected.map((s) => s.name), ["big-1", "big-2", "big-3", "big-4", "big-5", "tiny"]);
  const reminder = loadedSkillsReminder(skills);
  assert.ok(estimateTokens(reminder) <= 25_000, `whole reminder ${estimateTokens(reminder)} tokens`);
  assert.ok(estimateTokens(reminder) > 24_000);

  // Through the proxy: the store keeps what can come back, and the prompt
  // carries the capped skills within the total.
  const { getLoadedSkills } = await import("../src/session-store.ts");
  const outputs = [huge, ...[1, 2, 3, 4, 5, 6].map((i) => big(i).content)];
  await loadSkillsTurn(ctx, "reattach-caps", "caps-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "load them all" },
  ], outputs);
  const stored = getLoadedSkills("reattach-caps")!.skills;
  assert.ok(stored.every((s) => estimateTokens(s.content) <= 5_000));
  assert.ok(stored.reduce((sum, s) => sum + estimateTokens(s.content), 0) <= 25_000, "store bounded");
  await compact(hooks, "reattach-caps");
  const after = await turn(ctx, "reattach-caps", "caps-sess-2", compactedHistory("go on"));
  const start = after.prompt.indexOf(REATTACH_HEAD);
  const end = after.prompt.indexOf("</system-reminder>", start) + "</system-reminder>".length;
  const sent = after.prompt.slice(start, end);
  assert.ok(estimateTokens(sent) <= 25_000);
  assert.equal(count(sent, "<skill_content name="), 5, "five of seven fit");
  assert.equal(count(sent, '<skill_content name="big-6">'), 1, "newest first");
  assert.equal(count(sent, '<skill_content name="catalog-service">'), 0, "oldest left out");
  for (const block of sent.split("<skill_content").slice(1)) {
    assert.ok(estimateTokens(`<skill_content${block}`) <= 5_000 + 10);
  }

  // The store keeps at most 200 sessions, dropping the least recently updated.
  const { recordLoadedSkill } = await import("../src/session-store.ts");
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "opencode-claude-skills-bound-"));
  try {
    for (let i = 0; i < 205; i++) {
      recordLoadedSkill(`bound-${i}`, { name: "github-rules", content: GITHUB_RULES, loadedAt: i });
    }
    const file = join(process.env.XDG_DATA_HOME, "opencode-claude", "loaded-skills.json");
    const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")));
    assert.equal(keys.length, 200);
    assert.ok(!keys.includes("bound-0") && keys.includes("bound-204"));
  } finally {
    process.env.XDG_DATA_HOME = previous;
  }
}

/** A helper started with the task tool keeps its own skills, the parent its own. */
async function reattachHelper(ctx: Ctx, hooks: Hooks) {
  const { getLoadedSkills } = await import("../src/session-store.ts");
  const tools = [bashTool, skillTool, taskTool];
  const parentHistory = await loadSkillsTurn(ctx, "reattach-parent", "parent-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "change the screen, then push" },
  ], [GITHUB_RULES], tools);

  // The parent starts a helper; while it is parked on the task tool, the
  // helper's own session loads a skill.
  sessionOnDisk("parent-sess");
  ctx.proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "parent-sess" };
        await callTool(params, "task", { prompt: "change the screen", subagent_type: "implement" });
        yield { type: "user", message: { role: "user", content: [] }, session_id: "parent-sess" };
        yield textDelta("helper done");
        yield { type: "result", is_error: false, usage: {}, session_id: "parent-sess" };
      })(),
    ),
  );
  const messages = [...parentHistory, { role: "user", content: "start a helper for the screen" }];
  const parked = (await (await ctx.post("reattach-parent", { tools, messages })).json()) as any;
  const call = parked.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "task");
  await loadSkillsTurn(ctx, "reattach-child", "child-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "change the screen" },
  ], [UI_RULES]);
  messages.push(
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: "The screen is changed." },
  );
  const done = (await (await ctx.post("reattach-parent", { tools, messages })).json()) as any;
  assert.match(String(done.choices[0].message.content), /helper done/);
  assert.deepEqual(getLoadedSkills("reattach-parent")!.skills.map((s) => s.name), ["github-rules"]);
  assert.deepEqual(getLoadedSkills("reattach-child")!.skills.map((s) => s.name), ["professional-ui-design"]);

  await compact(hooks, "reattach-parent");
  const parent = await turn(ctx, "reattach-parent", "parent-sess-2", compactedHistory("now push"), { tools });
  assert.equal(count(parent.prompt, GITHUB_RULES), 1);
  assert.equal(count(parent.prompt, UI_RULES), 0, "not the helper's");

  await compact(hooks, "reattach-child");
  const child = await turn(ctx, "reattach-child", "child-sess-2", compactedHistory("go on"));
  assert.equal(count(child.prompt, UI_RULES), 1);
  assert.equal(count(child.prompt, GITHUB_RULES), 0, "not the parent's");
}

/**
 * Resume: OpenCode restarted (`opencode -s`) between the compaction and the
 * next message, and a first turn after the compaction that failed before its
 * Claude session existed.
 */
async function reattachResume(ctx: Ctx, hooks: Hooks) {
  const { getLoadedSkills } = await import("../src/session-store.ts");
  await loadSkillsTurn(ctx, "reattach-restart", "restart-sess", [
    ...openCodeSystem(SKILLS_V1),
    { role: "user", content: "load the skill github-rules" },
  ], [GITHUB_RULES]);
  await compact(hooks, "reattach-restart");

  // A new process with the same data and Claude homes sends the next message.
  const script = join(ctx.tmp, "restarted.ts");
  writeFileSync(script, `
    const proxy = await import(${JSON.stringify(new URL("../src/proxy.ts", import.meta.url).pathname)});
    const port = await proxy.startProxy();
    let seen = null;
    proxy.setClaudeQueryStarter(async (params) => {
      const first = (await params.prompt[Symbol.asyncIterator]().next()).value;
      const content = first.message.content;
      seen = { resume: params.resume ?? null, prompt: typeof content === "string" ? content : content.map((b) => b.text ?? "").join("\\n") };
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "restart-sess-2" };
          yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } };
          yield { type: "result", is_error: false, usage: {}, session_id: "restart-sess-2" };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });
    const res = await fetch("http://127.0.0.1:" + port + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-claude-session": "reattach-restart" },
      body: process.env.TEST_BODY,
    });
    await res.json();
    await proxy.stopProxy();
    console.log(JSON.stringify(seen));
  `);
  const body = JSON.stringify({
    model: "sonnet",
    stream: false,
    tools: [bashTool, skillTool],
    messages: compactedHistory("now push the branch"),
  });
  const child = Bun.spawnSync([process.execPath, script], {
    env: { ...process.env, TEST_BODY: body },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert.equal(child.exitCode, 0, child.stderr.toString());
  const seen = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
  assert.equal(seen.resume, null);
  assert.equal(count(seen.prompt, GITHUB_RULES), 1, "back after the restart");
  assert.equal(getLoadedSkills("reattach-restart")?.reattach, undefined, "sent");

  // The first turn after the compaction fails before Claude starts a session:
  // the skills wait for the next one.
  await compact(hooks, "reattach-restart");
  ctx.proxy.setClaudeQueryStarter(async () =>
    mockHandle(
      (async function* () {
        yield { type: "result", is_error: true, subtype: "error_during_execution", errors: ["spawn failed"] };
      })(),
    ),
  );
  const failed = await ctx.post("reattach-restart", {
    tools: [bashTool, skillTool],
    messages: compactedHistory("now push the branch"),
  });
  assert.notEqual(failed.status, 200);
  await failed.text();
  assert.equal(getLoadedSkills("reattach-restart")?.reattach, true, "still waiting");
  const retried = await turn(ctx, "reattach-restart", "restart-sess-3", compactedHistory("now push the branch"));
  assert.equal(count(retried.prompt, GITHUB_RULES), 1);
  assert.equal(getLoadedSkills("reattach-restart")?.reattach, undefined);
  assert.ok(existsSync(join(ctx.tmp, "opencode-claude", "loaded-skills.json")));
}

async function main() {
  await listing();
  const ctx = await startMockedProxy("skills");
  const { ClaudeCodePlugin } = await import("../src/index.ts");
  const hooks = (await ClaudeCodePlugin({
    directory: ctx.tmp,
  } as Parameters<typeof ClaudeCodePlugin>[0])) as unknown as Hooks;
  try {
    await newSession(ctx);
    await withoutSkillTool(ctx);
    await historyCarriedOver(ctx);
    await compactedBetweenTurns(ctx);
    await compactedMidTurn(ctx);
    await reattachNothing(ctx, hooks);
    await reattachOne(ctx, hooks);
    await reattachSeveral(ctx, hooks);
    await reattachCaps(ctx, hooks);
    await reattachHelper(ctx, hooks);
    await reattachResume(ctx, hooks);
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
