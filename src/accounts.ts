/**
 * Claude subscriptions served by this plugin, one OpenCode provider each.
 *
 * The default account is `claude-code` on the CLI's own config home. Extra
 * accounts come from the plugin's `accounts` option and run the same claude
 * CLI with their own CLAUDE_CONFIG_DIR — so each has its own login (the CLI
 * keys its macOS Keychain entry to that directory) and its own quota.
 *
 * A conversation keeps its Claude session when it moves to another account
 * only if both config homes see the same `projects/` folder: the CLI resumes
 * from the transcript on disk. Link it once, before the account's first
 * login: `ln -s ~/.claude/projects <configDir>/projects`.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { PROVIDER_ID } from "./constants.js";
import { resolveClaudeCli } from "./executable-path.js";
import { log } from "./log.js";

export type ClaudeAccount = {
  /** OpenCode provider ID. */
  provider: string;
  /** CLAUDE_CONFIG_DIR of this account; unset for the default account. */
  configDir?: string;
  /** Provider name from the plugin options. */
  name?: string;
};

export type ClaudeAccountStatus = {
  loggedIn: boolean;
  email?: string;
  projectsDirectory?: string;
};

const DEFAULT_ACCOUNT: ClaudeAccount = Object.freeze({ provider: PROVIDER_ID });
const AUTH_STATUS_TIMEOUT_MS = 6_000;

let accounts: ClaudeAccount[] = [DEFAULT_ACCOUNT];
const statuses = new Map<string, ClaudeAccountStatus>();

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Read the plugin's `accounts` option: `[{ provider, configDir, name? }]`.
 * Invalid entries are logged and skipped; the default account always stays.
 *
 * OpenCode starts the plugin once per project, and all of them share one
 * proxy, so the list is process-wide: keep `accounts` in the global config.
 */
export function configureAccounts(raw: unknown): void {
  const next: ClaudeAccount[] = [DEFAULT_ACCOUNT];
  if (raw !== undefined && !Array.isArray(raw)) {
    log.error("[opencode-claude] plugin option `accounts` must be an array; ignoring it");
  }
  for (const entry of Array.isArray(raw) ? raw : []) {
    const account = parseAccount(entry, next);
    if (account) next.push(account);
  }
  const signature = (list: ClaudeAccount[]) => JSON.stringify(list);
  if (signature(next) === signature(accounts)) return;
  if (accounts.length > 1) {
    log.warn(
      "[opencode-claude] the `accounts` option differs between OpenCode configs; the last one loaded applies to every project — keep it in the global config",
      { accounts: next.map((account) => account.provider) },
    );
  }
  accounts = next;
  statuses.clear();
}

function parseAccount(entry: unknown, known: ClaudeAccount[]): ClaudeAccount | null {
  const fields =
    entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const provider = typeof fields.provider === "string" ? fields.provider.trim() : "";
  const reject = (reason: string) => {
    log.error("[opencode-claude] ignoring Claude account", {
      provider: provider || undefined,
      reason,
    });
    return null;
  };
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(provider)) {
    return reject("`provider` must be a provider ID such as claude-code-2");
  }
  if (known.some((account) => account.provider === provider)) {
    return reject("provider ID is already used");
  }
  const rawDir =
    typeof fields.configDir === "string" ? expandHome(fields.configDir.trim()) : "";
  if (!rawDir || !isAbsolute(rawDir)) {
    return reject("`configDir` must be an absolute path or start with ~/");
  }
  const configDir = resolve(rawDir);
  if (known.some((account) => realDir(accountConfigDir(account)) === realDir(configDir))) {
    return reject("another account already uses this configDir");
  }
  const name =
    typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : undefined;
  return { provider, configDir, ...(name ? { name } : {}) };
}

export function getAccounts(): readonly ClaudeAccount[] {
  return accounts;
}

export function defaultAccount(): ClaudeAccount {
  return DEFAULT_ACCOUNT;
}

export function findAccount(provider: string | null | undefined): ClaudeAccount | undefined {
  if (!provider) return undefined;
  return accounts.find((account) => account.provider === provider);
}

export function isAccountProvider(provider: string | null | undefined): boolean {
  return findAccount(provider) !== undefined;
}

/** The config home the CLI uses for this account. */
export function accountConfigDir(account: ClaudeAccount): string {
  return (
    account.configDir ??
    (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"))
  );
}

/** Child env for the claude CLI running on this account. */
export function accountEnv(
  account: ClaudeAccount,
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = buildClaudeCodeChildEnv(baseEnv);
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

/** Provider name: the configured name, else the account's sign-in email. */
export function accountLabel(account: ClaudeAccount): string {
  if (account.name) return account.name;
  const email = statuses.get(account.provider)?.email;
  if (email) return `Claude · ${email}`;
  return account.provider === PROVIDER_ID ? "Claude Code" : `Claude Code (${account.provider})`;
}

/** The other accounts a conversation can move to. */
export function otherAccounts(account: ClaudeAccount): ClaudeAccount[] {
  return accounts.filter((other) => other.provider !== account.provider);
}

function shellPath(path: string): string {
  const home = homedir();
  const display = path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  return /^[~\w./-]+$/.test(display) ? display : `'${path.replace(/'/g, "'\\''")}'`;
}

/** Command that links `projects` to `shared`, moving an existing folder aside. */
function linkCommand(projects: string, shared: string): string {
  const link = `ln -s ${shellPath(shared)} ${shellPath(projects)}`;
  return existsSync(projects) ? `mv ${shellPath(projects)} ${shellPath(`${projects}.own`)} && ${link}` : link;
}

/** The terminal command that signs this account in. */
export function accountLoginCommand(account: ClaudeAccount): string {
  const login = "claude auth login --claudeai";
  return account.configDir ? `CLAUDE_CONFIG_DIR=${shellPath(account.configDir)} ${login}` : login;
}

export function getAccountStatus(provider: string): ClaudeAccountStatus | undefined {
  return statuses.get(provider);
}

function readAuthStatus(account: ClaudeAccount): Promise<ClaudeAccountStatus | null> {
  const env = accountEnv(account) as NodeJS.ProcessEnv;
  const binary = resolveClaudeCli(env);
  if (!binary) return Promise.resolve(null);
  return new Promise((done) => {
    execFile(
      binary,
      ["auth", "status", "--json"],
      { env, timeout: AUTH_STATUS_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
      (_error, stdout) => {
        // `auth status` exits non-zero when signed out but still prints JSON.
        const text = `${stdout ?? ""}`;
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start < 0 || end <= start) return done(null);
        try {
          const payload = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
          done({
            loggedIn: payload.loggedIn === true,
            ...(typeof payload.email === "string" ? { email: payload.email } : {}),
            ...(typeof payload.projectsDirectory === "string"
              ? { projectsDirectory: payload.projectsDirectory }
              : {}),
          });
        } catch {
          done(null);
        }
      },
    );
  });
}

/**
 * Ask the CLI for each account's login, email and projects folder. Only runs
 * when extra accounts are configured; a single-account setup stays as is.
 * Warns about an account that is signed out or keeps its own session history.
 */
export async function refreshAccountStatuses(): Promise<void> {
  if (accounts.length < 2) return;
  const results = await Promise.all(
    accounts.map(async (account) => [account, await readAuthStatus(account)] as const),
  );
  for (const [account, status] of results) {
    if (status) statuses.set(account.provider, status);
    else statuses.delete(account.provider);
  }

  const shared = statuses.get(PROVIDER_ID)?.projectsDirectory;
  for (const [account, status] of results) {
    if (!status) {
      log.warn("[opencode-claude] could not read Claude login status", {
        account: account.provider,
      });
      continue;
    }
    if (!status.loggedIn) {
      log.warn("[opencode-claude] Claude account is not signed in", {
        account: account.provider,
        signIn: accountLoginCommand(account),
      });
    }
    if (
      account.configDir &&
      shared &&
      status.projectsDirectory &&
      realDir(status.projectsDirectory) !== realDir(shared)
    ) {
      log.warn(
        "[opencode-claude] Claude account keeps its own session history; switching a conversation to it transfers the history into the prompt instead of resuming the Claude session",
        {
          account: account.provider,
          link: linkCommand(join(account.configDir, "projects"), shared),
        },
      );
    }
  }
}

/** Test helper: set an account's status without running the CLI. */
export function __setAccountStatus(provider: string, status: ClaudeAccountStatus | null): void {
  if (status) statuses.set(provider, status);
  else statuses.delete(provider);
}
