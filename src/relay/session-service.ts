import type { ConversationId } from "../domain/ids.ts";
import type { Logger } from "../domain/logger.ts";
import { sessionKey } from "../domain/session.ts";
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
  currentWorkspace(conversationId: ConversationId): WorkspaceRecord | undefined;
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
    const key = sessionKey(conversationId, workspace.name);
    const existing = this.deps.agent.getStatus(key);
    if (existing?.running && !threadId) return existing;

    const resumePrevious = options.resumePrevious ?? true;
    const previous = threadId || !resumePrevious ? undefined : this.deps.store.getSession(key);
    const resumeThreadId = threadId ?? previous?.thread_id ?? undefined;
    this.deps.logger.info("router.session_starting", { conversation_id: conversationId, workspace: workspace.name, session_key: key, thread_id: resumeThreadId });
    let status: AgentSessionStatus;
    try {
      status = await this.deps.agent.start({
        conversationId,
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
        conversationId,
        workspaceName: workspace.name,
        workspacePath: workspace.path,
      });
    }
    this.deps.store.markSessionStarted(key, conversationId, workspace.name, Date.now(), status.threadId);
    this.deps.logger.info("router.session_started", { conversation_id: conversationId, workspace: workspace.name, session_key: key, thread_id: status.threadId });
    return status;
  }

  appendSystem(conversationId: ConversationId, text: string): void {
    const workspace = this.deps.currentWorkspace(conversationId);
    if (!workspace) return;
    this.deps.store.appendTranscript({ conversationId, workspaceName: workspace.name, role: "system", text, createdAt: Date.now() });
  }

  statusView(conversationId: ConversationId): StatusView {
    const workspace = this.deps.currentWorkspace(conversationId);
    if (!workspace) return {};
    const status = this.deps.agent.getStatus(sessionKey(conversationId, workspace.name));
    const recentOutput = this.deps.store.latestTranscriptEvent(conversationId, workspace.name, "agent");
    const recentError = this.deps.store.latestTranscriptEvent(conversationId, workspace.name, "system");
    return statusViewFromParts(
      workspace,
      status,
      recentOutput?.createdAt,
      recentError?.text,
      this.deps.store.countTasks(conversationId, workspace.name, ["waiting"]),
      this.deps.store.countTasks(conversationId, workspace.name, ["queued"]),
      this.deps.store.countTasks(conversationId, workspace.name, ["blocked"]),
      this.deps.store.activeTask(conversationId, workspace.name),
    );
  }

  hasTaskCreatedAfter(conversationId: ConversationId, workspaceName: string, timestamp: number): boolean {
    return this.deps.store.listTasks(conversationId, workspaceName, undefined, 1)
      .some((task: RelayTask) => task.createdAt > timestamp);
  }
}

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("no rollout found");
}
