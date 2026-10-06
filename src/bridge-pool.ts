/**
 * Parked Claude Agent SDK turns waiting for OpenCode tool results
 * (Cursor bridge-pool pattern).
 */
import type { AnthropicContentBlock, McpToolResultContent } from "./prompt.js";
import type { ClaudeQueryHandle } from "./query.js";

export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: McpToolResultContent[]) => void;
  reject: (error: Error) => void;
};

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  handle: ClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  /** SDK assistant messages whose usage was already reported to OpenCode. */
  seenAssistantUsageIds: Set<string>;
  /** Keys of mid-turn user messages already handed to Claude (sha1). */
  forwardedSteering: Set<string>;
  /** Hashes of tool-result media already handed to Claude. */
  forwardedMedia: Set<string>;
  /**
   * Attachments that cannot ride a tool result (PDFs, URL media), sent as a
   * follow-up message when the current turn ends.
   */
  followUps: AnthropicContentBlock[];
  createdAt: number;
  /** Continues consuming the SDK stream after tools resolve. */
  continueStream?: () => AsyncGenerator<unknown, void, unknown>;
};

const bridges = new Map<string, ParkedBridge>();

export function putBridge(bridge: ParkedBridge): void {
  // One active bridge per conversation — drop any prior turn for this key.
  for (const [id, existing] of bridges) {
    if (existing.conversationKey === bridge.conversationKey && id !== bridge.id) {
      for (const tool of existing.pendingTools.values()) {
        tool.reject(new Error("Superseded by a newer turn"));
      }
      existing.pendingTools.clear();
      try {
        existing.handle.close();
      } catch {
        // ignore
      }
      bridges.delete(id);
    }
  }
  bridges.set(bridge.id, bridge);
}

export function getBridge(id: string): ParkedBridge | undefined {
  return bridges.get(id);
}

export function findBridgeByConversation(
  conversationKey: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.conversationKey === conversationKey) return bridge;
  }
  return undefined;
}

export function findBridgeByPendingTool(
  toolCallId: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.pendingTools.has(toolCallId)) return bridge;
  }
  return undefined;
}

export function deleteBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  for (const tool of bridge.pendingTools.values()) {
    tool.reject(new Error("Bridge closed"));
  }
  bridge.handle.close();
  bridges.delete(id);
}

export function clearAllBridges(): void {
  for (const id of [...bridges.keys()]) {
    deleteBridge(id);
  }
}
