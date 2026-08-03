import type {
  AgentActivityEvent,
  AgentApprovalRequestEvent,
  AgentImageOutputEvent,
  AgentMcpElicitationRequestEvent,
  AgentOutputEvent,
  AgentThreadLifecycleEvent,
  AgentTurnCompletedEvent,
  AgentUserInputRequestEvent,
} from "../ports/agent.ts";
import type { Logger } from "../domain/logger.ts";
import { parseSessionKey } from "../domain/session.ts";
import type { RelayStore } from "../storage/store.ts";
import type { RenderedTelegramText } from "../presentation/telegram/text.ts";
import type { ConversationId } from "../domain/ids.ts";
import { messageWithTitle } from "./ui/text-parts.ts";

export interface RelayAgentEventRouterDeps {
  logger: Logger;
  store: Pick<RelayStore, "markSessionStopped" | "clearSessionThreadId">;
  activity: {
    handle(event: AgentActivityEvent): Promise<void>;
    finalize(sessionKey: string, turnId: string | undefined, status: string, error?: string, durationMs?: number): Promise<void>;
    setPhase(sessionKey: string, phase: "working" | "waitingForInput" | "waitingForApproval", detail?: string): Promise<void>;
    terminate(sessionKey: string, phase: "interrupted" | "failed", detail?: string): Promise<void>;
  };
  media: { sendAgentImageOutput(event: AgentImageOutputEvent): Promise<void> };
  prompts: {
    handleUserInputRequest(event: AgentUserInputRequestEvent): Promise<void>;
    handleApprovalRequest(event: AgentApprovalRequestEvent): Promise<void>;
    handleMcpElicitationRequest(event: AgentMcpElicitationRequestEvent): Promise<void>;
  };
  finalizeOutput(sessionKey: string): Promise<void>;
  sendPlanReadyPrompt(sessionKey: string, turnId?: string): Promise<void>;
  appendSystem(scopeKey: ConversationId, text: string): void;
  sendRendered(conversationId: ConversationId, rendered: RenderedTelegramText): Promise<unknown>;
  completeTask(sessionKey: string, turnId: string | undefined, status: "done" | "interrupted" | "failed"): Promise<void>;
  markActiveTask(sessionKey: string, status: "blocked", turnId?: string): Promise<void>;
  cancelActiveTasks(sessionKey: string): Promise<void>;
  failActiveTasks(sessionKey: string): Promise<void>;
  currentThreadId(sessionKey: string): string | undefined;
  resetSessionPresentation(sessionKey: string, options?: { deletePages?: boolean }): Promise<void>;
}

export class RelayAgentEventRouter {
  constructor(private readonly deps: RelayAgentEventRouterDeps) {}

  async handle(event: AgentOutputEvent): Promise<boolean> {
    switch (event.type) {
      case "activity":
        await this.deps.activity.handle(event);
        return true;
      case "image":
        // Preserve transcript ordering by flushing text before an image.
        await this.deps.finalizeOutput(event.sessionKey);
        await this.deps.media.sendAgentImageOutput(event);
        return true;
      case "turn_completed":
        await this.handleTurnCompleted(event);
        return true;
      case "user_input_request":
        await this.blockForPrompt(event, "waitingForInput", () => this.deps.prompts.handleUserInputRequest(event));
        return true;
      case "approval_request":
        await this.blockForPrompt(event, "waitingForApproval", () => this.deps.prompts.handleApprovalRequest(event));
        return true;
      case "mcp_elicitation_request":
        await this.blockForPrompt(event, "waitingForInput", () => this.deps.prompts.handleMcpElicitationRequest(event));
        return true;
      case "thread_lifecycle":
        await this.handleThreadLifecycle(event);
        return true;
      default:
        return false;
    }
  }

  private async handleTurnCompleted(event: AgentTurnCompletedEvent): Promise<void> {
    const turnStatus = event.status ?? "completed";
    this.deps.logger.info("router.turn_completed", {
      session_key: event.sessionKey,
      turn_id: event.turnId,
      status: turnStatus,
      duration_ms: event.durationMs,
    });
    await this.deps.activity.finalize(event.sessionKey, event.turnId, turnStatus, event.error?.message, event.durationMs);
    await this.deps.finalizeOutput(event.sessionKey);
    if (turnStatus === "completed") await this.deps.sendPlanReadyPrompt(event.sessionKey, event.turnId);
    if (turnStatus === "failed") {
      const parsed = parseSessionKey(event.sessionKey);
      if (parsed) {
        const detail = event.error?.message ?? "Codex turn failed.";
        this.deps.appendSystem(parsed.scopeKey, `Error: ${detail}\n`);
        await this.deps.sendRendered(parsed.scopeKey, messageWithTitle("Codex turn failed.", detail));
      }
    }
    await this.deps.completeTask(
      event.sessionKey,
      event.turnId,
      turnStatus === "completed" ? "done" : turnStatus === "interrupted" ? "interrupted" : "failed",
    );
  }

  private async blockForPrompt(
    event: AgentUserInputRequestEvent | AgentApprovalRequestEvent | AgentMcpElicitationRequestEvent,
    phase: "waitingForInput" | "waitingForApproval",
    render: () => Promise<void>,
  ): Promise<void> {
    await this.deps.finalizeOutput(event.sessionKey);
    await this.deps.activity.setPhase(event.sessionKey, phase);
    await this.deps.markActiveTask(event.sessionKey, "blocked", event.turnId);
    await render();
  }

  private async handleThreadLifecycle(event: AgentThreadLifecycleEvent): Promise<void> {
    const parsed = parseSessionKey(event.sessionKey);
    if (!parsed) return;
    const currentThreadId = this.deps.currentThreadId(event.sessionKey);
    if (currentThreadId && currentThreadId !== event.threadId) {
      this.deps.logger.info("router.thread_lifecycle_stale", {
        session_key: event.sessionKey,
        event_thread_id: event.threadId,
        current_thread_id: currentThreadId,
        action: event.action,
      });
      return;
    }
    await this.deps.activity.terminate(event.sessionKey, "interrupted", `Chat ${event.action}.`);
    await this.deps.resetSessionPresentation(event.sessionKey, { deletePages: true });
    this.deps.store.markSessionStopped(event.sessionKey);
    if (event.action === "archived" || event.action === "deleted") {
      this.deps.store.clearSessionThreadId(event.sessionKey);
      await this.deps.cancelActiveTasks(event.sessionKey);
    } else {
      await this.deps.failActiveTasks(event.sessionKey);
    }
    if (!event.initiatedByClient) {
      await this.deps.sendRendered(parsed.scopeKey, messageWithTitle(
        event.action === "archived" ? "Chat archived externally." : event.action === "deleted" ? "Chat deleted externally." : "Chat closed.",
      ));
    }
  }
}
