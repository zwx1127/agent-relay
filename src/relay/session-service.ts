import type { ConversationId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import { sessionKey } from "../domain/session.ts";
import { parseChatScopeKey } from "../domain/scope.ts";
import { isRealDirectory } from "../domain/workspace.ts";
import type { AgentDriver, AgentSessionStatus } from "../ports/agent.ts";
import type { RelayStore } from "../storage/store.ts";
import type { RelayTask, WorkspaceRecord } from "./types.ts";
import { statusViewFromParts } from "./ui/status-message.ts";
import type { StatusView } from "./ui/status-view.ts";

export interface RelaySessionServiceDeps {
  store: RelayStore;
  agent: AgentDriver;
  logger: Logger;
  currentWorkspace(scopeKey: ConversationId): WorkspaceRecord | undefined;
}

export class RelaySessionService {
  constructor(private readonly deps: RelaySessionServiceDeps) {}

  async ensureStarted(
    conversationId: ConversationId,
    workspace: WorkspaceRecord,
    threadId?: string,
    options: { resumePrevious?: boolean } = {},
  ): Promise<AgentSessionStatus> {
    if (!isRealDirectory(workspace.path)) throw new Error(`Workspace path does not exist: ${workspace.path}`);
    const scope = parseChatScopeKey(String(conversationId));
    const key = sessionKey(scope.scopeKey, workspace.name);
    const existing = this.deps.agent.getStatus(key);
    if (existing?.running && !threadId) {
      await this.hydrateThreadGoal(key, existing);
      return existing;
    }

    const resumePrevious = options.resumePrevious ?? true;
    const previous = threadId || !resumePrevious ? undefined : this.deps.store.getSession(key);
    const resumeThreadId = threadId ?? previous?.thread_id ?? undefined;
    this.deps.logger.info("router.session_starting", { conversation_id: conversationId, workspace: workspace.name, session_key: key, thread_id: resumeThreadId });
    let status: AgentSessionStatus;
    try {
      status = await this.deps.agent.start({
        conversationId: scope.conversationId,
        scopeKey: scope.scopeKey,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
        threadId: resumeThreadId,
      });
    } catch (error) {
      if (threadId || !previous?.thread_id || !isMissingCodexThreadError(error)) throw error;
      this.deps.logger.warn("router.session_auto_resume_failed_starting_fresh", {
        conversation_id: conversationId,
        workspace: workspace.name,
        session_key: key,
        thread_id: previous.thread_id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this.deps.store.clearSessionThreadId(key);
      status = await this.deps.agent.start({
        conversationId: scope.conversationId,
        scopeKey: scope.scopeKey,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
      });
    }
    this.deps.store.markSessionStarted(key, scope.conversationId, workspace.name, Date.now(), status.threadId, scope.scopeKey);
    await this.hydrateThreadGoal(key, status);
    this.deps.logger.info("router.session_started", { conversation_id: scope.conversationId, scope_key: scope.scopeKey, workspace: workspace.name, session_key: key, thread_id: status.threadId });
    return status;
  }

  private async hydrateThreadGoal(key: string, status: AgentSessionStatus): Promise<void> {
    if (status.threadGoal !== undefined || this.deps.agent.capabilities?.threadGoals !== true || !this.deps.agent.getThreadGoal) return;
    try {
      status.threadGoal = await this.deps.agent.getThreadGoal(key);
    } catch (error) {
      this.deps.logger.warn("router.session_goal_load_failed", {
        session_key: key,
        thread_id: status.threadId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  appendSystem(conversationId: ConversationId, text: string): void {
    const scope = parseChatScopeKey(String(conversationId));
    const workspace = this.deps.currentWorkspace(scope.scopeKey);
    if (!workspace) return;
    this.deps.store.appendTranscript({ conversationId: scope.conversationId, scopeKey: scope.scopeKey, workspaceName: workspace.name, role: "system", text, createdAt: Date.now() });
  }

  statusView(conversationId: ConversationId): StatusView {
    const scope = parseChatScopeKey(String(conversationId));
    const workspace = this.deps.currentWorkspace(scope.scopeKey);
    if (!workspace) return {};
    const status = this.deps.agent.getStatus(sessionKey(scope.scopeKey, workspace.name));
    const recentOutput = this.deps.store.latestTranscriptEvent(scope.scopeKey, workspace.name, "agent");
    const latestSystemEvent = this.deps.store.latestTranscriptEvent(scope.scopeKey, workspace.name, "system");
    return statusViewFromParts(
      workspace,
      status,
      recentOutput?.createdAt,
      systemErrorText(latestSystemEvent?.text),
      this.deps.store.countTasks(scope.scopeKey, workspace.name, ["waiting"]),
      this.deps.store.countTasks(scope.scopeKey, workspace.name, ["queued"]),
      this.deps.store.countTasks(scope.scopeKey, workspace.name, ["blocked"]),
      this.deps.store.activeTask(scope.scopeKey, workspace.name),
    );
  }

  hasTaskCreatedAfter(conversationId: ConversationId, workspaceName: string, timestamp: number): boolean {
    const scope = parseChatScopeKey(String(conversationId));
    return this.deps.store.listTasks(scope.scopeKey, workspaceName, undefined, 1)
      .some((task: RelayTask) => task.createdAt > timestamp);
  }
}

function systemErrorText(text: string | undefined): string | undefined {
  const prefix = "Error:";
  if (!text?.startsWith(prefix)) return undefined;
  return text.slice(prefix.length).trim() || undefined;
}

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no rollout found");
}
