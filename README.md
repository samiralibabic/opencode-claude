# opencode-claude

[![npm](https://img.shields.io/npm/v/%40samiralibabic%2Fopencode-claude?style=flat&labelColor=100F0F&color=24837B)](https://www.npmjs.com/package/@samiralibabic/opencode-claude)
[![License](https://img.shields.io/badge/license-MIT-black?style=flat&labelColor=100F0F&color=EC8B49)](LICENSE)

> **A maintained fork for OpenCode 1.** [`@openchamber/opencode-claude`](https://github.com/openchamber/opencode-claude) requires OpenCode 2 since 1.0 and was archived on 2026-10-31, superseded by OpenCode's native Claude Code support (2.2.3 and later). This fork continues its last OpenCode 1 release, `0.14.0`, with backported and local fixes: model discovery, mid-turn messages, tool images and PDFs, several Claude accounts and parallel subagents ([changelog](CHANGELOG.md)). On OpenCode 2, use OpenCode's own Claude Code support instead.

## Claude Code in OpenCode. Local CLI auth. Agent SDK.

**opencode-claude is the OpenCode plugin for running Claude models — Fable, Opus, Sonnet, and Haiku — from a Claude Pro/Max subscription, with effort variants, tools, attachments, and auto-compact.**

Use Claude from [OpenCode](https://opencode.ai) and [OpenChamber](https://github.com/openchamber/openchamber) without an Anthropic API key. The plugin runs the official Anthropic Agent SDK plus the local `claude` CLI and proxies an OpenAI-compatible `/v1/chat/completions` surface into OpenCode. Claude Code owns authentication; the plugin never reads, copies, refreshes, or sends your credentials itself.

### Official Claude runtime

**Built on Anthropic's official Agent SDK and Claude Code authentication flow. Designed for local, user-operated Claude Code usage.**

No OAuth tokens are extracted, copied, stored, injected, or sent by this plugin. All authentication and model access are performed internally by the official Claude Code runtime. The plugin does not call Anthropic inference endpoints directly and does not impersonate Anthropic API clients.

![opencode-claude — Claude Code in OpenCode, local CLI auth, Agent SDK](docs/header.svg)

## What you can do

### Use your local Claude Code login

The OpenCode/OpenChamber sign-in action launches `claude auth login --claudeai` and relays it: the CLI's own sign-in page opens from the host, and the code Claude shows is pasted back into the host, not a separate terminal. The official CLI performs the OAuth exchange and stores its own credentials. The plugin stores no credentials or connection markers in OpenCode; every inference request, including title and summary generation, runs through the Agent SDK.

### Pick models and thinking effort

Models come from Claude Code's `supportedModels()` during provider initialization, with concrete IDs and only the effort choices it advertises. Known families expose 1M variants through `[1m]`; limits follow the official plugin's family rules. Discovery uses an idle control session, not an inference prompt, and caches its last successful catalog. Restart OpenCode to refresh the picker on this OpenCode 1-compatible branch.

### Keep agent loops moving

OpenCode tools bridge as in-process MCP. Calls park and resume instead of deadlocking or inventing output. Streaming, MCP, and sticky Claude session IDs keep follow-ups on the same Agent SDK turn.

### Attachments, compact, and history

Images and PDFs from OpenCode reach Claude (data URLs and remote URLs). Long sessions auto-compact like Claude Code. When a Claude session cannot be resumed, the prior conversation is serialized into the prompt so Claude does not start blind.

### Rate-limit counter

Subscription limit state is tracked with its reset time. `GET /v1/rate-limit` answers when limits return; doomed turns fail fast with 429 and `Retry-After`.

## Quick start

`claude-code` is **not** a built-in OpenCode provider. Install the plugin first, or `opencode auth login --provider claude-code` fails with `Unknown provider "claude-code"`.

### 1. Install the plugin

```bash
npm install -g @samiralibabic/opencode-claude
```

Or with OpenCode:

```bash
# global (recommended)
opencode plugin @samiralibabic/opencode-claude -g

# or project-local (writes .opencode/opencode.json)
opencode plugin @samiralibabic/opencode-claude
```

### 2. Register it in OpenCode

Add (or merge) this into `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@samiralibabic/opencode-claude"],
  "provider": {
    "claude-code": { "name": "Claude Code" }
  }
}
```

### 3. Authenticate

```bash
claude auth login
opencode auth login --provider claude-code
# pick "Sign in with Claude Code CLI"
```

### 4. Run a Claude model

```bash
opencode models claude-code
opencode run "Summarise this repository in five bullets." --model claude-code/claude-sonnet-5
```

In the TUI, pick provider **claude-code**, choose an account-advertised model, and set an available **effort** variant when you want deeper thinking. Existing sessions using an old alias may need a concrete model selected once; discovery does not automatically switch sessions to a newer release.

### From source (optional)

```bash
git clone https://github.com/samiralibabic/opencode-claude.git
cd opencode-claude
bun install && bun run build
opencode plugin file://$PWD
```

## Authenticate

| Step | What happens |
| --- | --- |
| **Sign in with Claude Code CLI** | Shown when the CLI is installed: launches the official CLI login and opens the sign-in page the CLI asked for |
| **Install Claude Code CLI and sign in** | Shown only when the CLI is missing: runs the official installer (`npm i -g @anthropic-ai/claude-code`, official install script as fallback), then continues with the sign-in relay |
| Paste the code from the Claude page | Goes straight to the CLI's stdin; the CLI does the token exchange and owns the result |
| `claude auth login --claudeai` | Terminal alternative, always called out in the instructions — also the offered fallback when the CLI is missing (with the install command alongside) |
| Successful verification | Completes without writing to OpenCode's auth store |
| Access expires | Claude Code refreshes its own credentials |

Signing in is either the link and its code or the terminal command — the sign-in page the CLI asks for is the only URL the plugin ever hands to the host.

The plugin does not implement OAuth, inspect Claude credential files, inject tokens, or call Anthropic inference endpoints directly.

## Several Claude accounts

Each extra subscription becomes its own provider with the same models, signed in under its own `CLAUDE_CONFIG_DIR` (the CLI keeps a separate login and Keychain entry per directory). Pick the account per session in the model picker; switching keeps the OpenCode session.

1. Give the account a config home that shares Claude's session history, then sign in:

   ```bash
   mkdir -p ~/.claude-2 && ln -s ~/.claude/projects ~/.claude-2/projects
   CLAUDE_CONFIG_DIR=~/.claude-2 claude auth login --claudeai
   ```

2. Declare it in the global config (the list applies to every project) and restart OpenCode:

   ```jsonc
   {
     "plugin": [
       ["@samiralibabic/opencode-claude", {
         "accounts": [{ "provider": "claude-code-2", "configDir": "~/.claude-2" }]
       }]
     ]
   }
   ```

| Behaviour | Detail |
| --- | --- |
| Names | `name` from the option, else `Claude · <sign-in email>`; a `provider.<id>.name` in config wins |
| Switching a session | Resumes the same Claude session when both config homes share `projects/`; otherwise transfers the history into the prompt (the startup log says so) |
| Switching mid-turn | A message queued after switching ends the open turn and starts it again on the new account, with the history transferred |
| Limits | Tracked per account (`rate-limit.<provider>.json`, `GET /v1/rate-limit?account=<provider>`); limit errors name the other accounts |
| Subagents | A subagent pinned to a Claude account runs on its parent's current Claude account, same model and variant; non-Claude pins stay |
| Signed out | Startup log and auth errors give the account's `CLAUDE_CONFIG_DIR=… claude auth login --claudeai` |

## Architecture

```text
OpenCode
  └─ /v1/chat/completions
       └─ Bun.serve proxy (ephemeral port; configured by the plugin)
            └─ Claude Agent SDK query()
                 └─ claude CLI (subscription OAuth)
```

| Layer | Responsibility |
| --- | --- |
| **Plugin hooks** | Provider config, model catalog, effort headers |
| **Proxy** | OpenAI ↔ Agent SDK protocol, tool parking, compact, rate-limit gate |
| **CLI** | Subscription credentials and the Claude Code harness |

Model catalog: account discovery, cached at `~/.local/share/opencode-claude/models.json` (or under `XDG_DATA_HOME`), with an offline fallback. Concurrent initialization shares one discovery probe, with a 15-second query timeout and a ten-minute refresh throttle. OpenCode 1 has no supported provider hot-reload hook, so initialization waits for discovery and running pickers update after restart. 1M models declare 900k input and 128k output limits; input and output share the total window. Effort selection is encoded in `x-opencode-claude-effort` so the proxy passes the selected supported effort into the Agent SDK.

### Rate-limit counter

The proxy records Agent SDK `rate_limit_event` telemetry and hard session-limit errors (including the parsed reset time) to `~/.local/share/opencode-claude/rate-limit.json`.

- `GET /v1/rate-limit` → `{ limited, status, rateLimitType, utilization, resetsAt, resetsAtISO, resetInSeconds, message, updatedAt }` — poll this for a "limits reset in …" countdown. `utilization` is only present when the latest SDK event reported it — it is never carried over from an earlier limit window.
- `GET /health` includes a compact `rateLimit` summary.
- While a confirmed hard limit is active, new turns return HTTP **429** with `Retry-After` + `x-claude-rate-limit-reset` headers and an `error.type = "rate_limit_error"` body. The block lifts automatically at reset time; the next turn resumes the same Claude session.
- `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0` disables the 429 gate (turns are attempted and error normally).

## Requirements

- [OpenCode](https://opencode.ai) 1.x (`>=1.18.15 <2`)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — on `PATH` or installed via the provider's install action (npm is used, or the official install script); the plugin also checks `~/.local/bin` and the npm global bin for a CLI the server PATH cannot see
- Claude plan supported by Claude Code
- Bun (plugin runtime) · Node.js ≥ 18

## Development

```bash
bun install
bun run build
bun run test
```

Debug logging: `OPENCODE_CLAUDE_DEBUG=1`. Warnings and errors always go to `~/.local/share/opencode-claude/debug.log`; they reach stderr only with debug logging on, because the OpenCode TUI paints stray stderr over the screen.

Optional knobs:

- `OPENCODE_CLAUDE_PROXY_PORT` — optional pinned proxy port (default: ephemeral / OS-assigned; live URL is published to OpenCode via plugin config)
- `OPENCODE_CLAUDE_CWD` — working directory passed to the Agent SDK
- `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL` — `0` disables the 429 rate-limit gate
- `OPENCODE_CLAUDE_RATE_LIMIT_STORE` — override the rate-limit store path (tests)
- `OPENCODE_CLAUDE_HISTORY_MAX_CHARS` — budget for transferred conversation history when a Claude session cannot be resumed (default `400000`; newest messages are kept, `0` disables transfer)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Unknown provider `claude-code` | Install `@samiralibabic/opencode-claude` and restart OpenCode |
| Claude Code missing from provider list | Confirm `plugin` includes `@samiralibabic/opencode-claude` and restart OpenCode |
| Authentication error | Run `claude auth login`, verify `claude auth status --json`, then restart OpenCode |
| 429 / rate-limit | Poll `GET /v1/rate-limit` or wait until `resetsAt`; the next turn resumes the same session |
| Tools hang or invent output | Update to the latest plugin — park/resume MCP bridging is required |
| Attachments ignored | Use a current build; image/PDF parts are converted to Claude blocks |

## Release

Releases are published from GitHub Actions when a `v<version>` tag is pushed, through npm Trusted Publishing with provenance; see [RELEASING.md](RELEASING.md).

## Contributing

Issues and pull requests belong in this repository: [samiralibabic/opencode-claude](https://github.com/samiralibabic/opencode-claude). The original project, [openchamber/opencode-claude](https://github.com/openchamber/opencode-claude), is archived.

```bash
bun install
bun run build
bun run test
```

## Acknowledgments

This plugin started as community work around Claude Code in OpenCode, published as [`@openchamber/opencode-claude`](https://github.com/openchamber/opencode-claude); this fork continues its `0.14.0` release. Special thanks to:

- [OpenCode](https://opencode.ai) for the plugin API
- [OpenChamber](https://github.com/openchamber/openchamber) for the workspace that runs this plugin in production
- Anthropic for the Claude Agent SDK and Claude Code CLI
- Contributors who shaped OAuth, the proxy, tools, and compact

## License

[MIT](LICENSE)
