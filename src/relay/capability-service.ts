import { resolve } from "node:path";
import type { ConversationId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import { parseSessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import type { AgentDriver } from "../ports/agent.ts";
import type { ImAdapter } from "../ports/im.ts";
import type { AppConfig } from "../runtime/config.ts";
import type { RelayStore } from "../storage/store.ts";
import type { MentionAgentCapabilityRequest } from "./capabilities/mention-agent.ts";
import { pathContains } from "./ui/media-format.ts";

export interface RelayCapabilityServiceDeps {
  config: Pick<AppConfig, "relayPeerAgents" | "imProvider">;
  store: Pick<RelayStore, "setControlMessage" | "appendTranscript" | "listRunningSessions" | "getWorkspace">;
  adapter: Pick<ImAdapter, "sendMessage">;
  agent: Pick<AgentDriver, "getStatus">;
  logger: Logger;
}

export class RelayCapabilityService {
  constructor(private readonly deps: RelayCapabilityServiceDeps) {}

  async mentionPeerAgent(input: MentionAgentCapabilityRequest): Promise<{ peerId: string }> {
    const peer = this.deps.config.relayPeerAgents.find((candidate) => candidate.id === input.peerId);
    if (!peer) throw new Error(`Unknown peer agent: ${input.peerId}`);
    if (this.deps.config.imProvider === "telegram" && !peer.telegramUsername) {
      throw new Error(`Peer agent ${input.peerId} does not define telegramUsername`);
    }
    if (this.deps.config.imProvider === "lark" && !peer.larkOpenId && !peer.larkUserId) {
      throw new Error(`Peer agent ${input.peerId} does not define larkOpenId or larkUserId`);
    }
    const { sessionKey, conversationId, workspaceName } = this.resolveSession(input);
    const scope = parseChatScopeKey(String(conversationId));
    const result = await this.deps.adapter.sendMessage(scope.conversationId, input.message, {
      mentions: [{
        label: peer.name ?? peer.id,
        ...(peer.telegramUsername ? { telegramUsername: peer.telegramUsername } : {}),
        ...(peer.larkOpenId ? { larkOpenId: peer.larkOpenId } : {}),
        ...(peer.larkUserId ? { larkUserId: peer.larkUserId } : {}),
      }],
      ...(scope.topic ? { topic: scope.topic } : {}),
    });
    if (result.messageId) this.deps.store.setControlMessage(scope.conversationId, result.messageId, scope.scopeKey, "message");
    this.deps.store.appendTranscript({
      conversationId: scope.conversationId,
      scopeKey: scope.scopeKey,
      workspaceName,
      role: "agent",
      text: `[mentioned peer ${peer.id} via ${sessionKey}]\n${input.message}\n`,
      createdAt: Date.now(),
    });
    this.deps.logger.info("router.peer_agent_mentioned", {
      conversation_id: scope.conversationId,
      scope_key: scope.scopeKey,
      workspace: workspaceName,
      session_key: sessionKey,
      peer_id: peer.id,
    });
    return { peerId: peer.id };
  }

  private resolveSession(input: { sessionKey?: string; cwd?: string }): { sessionKey: string; conversationId: ConversationId; workspaceName: string } {
    if (input.sessionKey) {
      const parsed = parseSessionKey(input.sessionKey);
      if (!parsed) throw new Error("sessionKey is invalid");
      const status = this.deps.agent.getStatus(input.sessionKey);
      if (!status?.running) throw new Error("session is not running");
      return { sessionKey: input.sessionKey, conversationId: parsed.scopeKey, workspaceName: parsed.workspaceName };
    }

    const cwd = input.cwd ? resolve(input.cwd) : undefined;
    const matches = this.deps.store.listRunningSessions().flatMap((session) => {
      const workspace = this.deps.store.getWorkspace(session.workspace_name);
      const status = this.deps.agent.getStatus(session.session_key);
      if (!workspace || !status?.running || (cwd && !pathContains(workspace.path, cwd))) return [];
      return [{
        sessionKey: session.session_key,
        conversationId: session.scope_key ?? session.conversation_id,
        workspaceName: session.workspace_name,
      }];
    });
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error("No running relay session matches this request.");
    throw new Error("Multiple running relay sessions match this request; pass --session-key.");
  }
}
