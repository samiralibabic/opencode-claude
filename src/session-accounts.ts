/**
 * Subagents follow their parent session's Claude account.
 *
 * OpenCode runs a subagent on its agent's pinned model (`claude-code/...`),
 * whatever account the parent session moved to. When the parent runs on
 * another Claude account, the child's message is moved to that account's
 * provider — same model and variant — before OpenCode stores it, so the
 * child really runs there and the UI shows it. Children pinned to a
 * non-Claude provider, or whose parent is on one, keep their pin.
 */
import { getAccounts, isAccountProvider } from "./accounts.js";
import { log } from "./log.js";

/** Provider of each OpenCode session's latest user message. */
const sessionProviders = new Map<string, string>();
/** Parent session IDs (null for a root session); never change. */
const parents = new Map<string, string | null>();

export type ParentLookup = (sessionID: string) => Promise<string | null>;

export function rememberSessionProvider(sessionID: string, providerID: string): void {
  if (!sessionID || !providerID) return;
  sessionProviders.set(sessionID, providerID);
}

export function sessionProvider(sessionID: string): string | undefined {
  return sessionProviders.get(sessionID);
}

async function parentOf(sessionID: string, lookup: ParentLookup): Promise<string | null> {
  if (parents.has(sessionID)) return parents.get(sessionID) ?? null;
  try {
    const parentID = await lookup(sessionID);
    parents.set(sessionID, parentID);
    return parentID;
  } catch (error) {
    // Not cached: the next message of this session asks again.
    log.warn("[opencode-claude] could not look up the parent session", {
      sessionID,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The Claude provider a session's new message should run on instead of
 * `providerID`, or null to keep it.
 */
export async function followParentAccount(
  sessionID: string,
  providerID: string,
  lookup: ParentLookup,
): Promise<string | null> {
  if (getAccounts().length < 2 || !isAccountProvider(providerID)) return null;
  const parentID = await parentOf(sessionID, lookup);
  if (!parentID) return null;
  const parentProvider = sessionProviders.get(parentID);
  if (!parentProvider || parentProvider === providerID) return null;
  return isAccountProvider(parentProvider) ? parentProvider : null;
}

/** Test helper. */
export function __resetSessionAccounts(): void {
  sessionProviders.clear();
  parents.clear();
}
