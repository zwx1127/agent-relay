import type { AgentActivity, AgentOutputHandler, AgentUserInputQuestion } from "../../../ports/agent.ts";
import type { Logger } from "../../../domain/logger.ts";
import { approvalCopy, approvalKindForMethod, asRecord, getString, getTurnId, toMcpElicitationSchema, toQuestion } from "./protocol.ts";
import type { JsonRpcRequest } from "./rpc.ts";
import type { CodexRpcClient } from "./rpc.ts";
import type { RunningSession, SideConversationCollector } from "./state.ts";

export interface ServerRequestContext {
  sessions: Map<string, RunningSession>;
  threadToSessions: Map<string, Set<string>>;
  sideConversations: Map<string, SideConversationCollector>;
  rpc: CodexRpcClient;
  logger: Logger;
  onOutput: AgentOutputHandler;
  emitActivity(key: string, activity: AgentActivity, params?: Record<string, unknown>): Promise<void>;
  registerRequest(requestId: string | number, threadId: string, sessionKeys: string[]): void;
}

export async function handleCodexServerRequest(message: JsonRpcRequest, context: ServerRequestContext): Promise<void> {
  const params = asRecord(message.params);
  const threadId = typeof params?.threadId === "string"
    ? params.threadId
    : typeof params?.conversationId === "string"
      ? params.conversationId
      : undefined;
  const keys = threadId ? [...(context.threadToSessions.get(threadId) ?? [])] : [];
  const key = keys[0];
  const sideConversation = threadId ? context.sideConversations.get(threadId) : undefined;
  if (sideConversation) {
    await context.rpc.rejectRequest(message.id, -32000, "Interactive prompts and approvals are not supported in Relay side conversations.");
    return;
  }
  if (message.method === "item/tool/call" || message.method === "account/chatgptAuthTokens/refresh" || message.method === "attestation/generate") {
    const drift = `Unsupported Codex server request received despite disabled capability: ${message.method}`;
    if (keys.length > 0) {
      for (const sessionKey of keys) {
        const running = context.sessions.get(sessionKey);
        if (running) running.status.recentError = drift;
      }
    } else {
      for (const running of context.sessions.values()) running.status.recentError = drift;
    }
    context.logger.error("codex.disabled_capability_request", { method: message.method, thread_id: threadId, session_key: key });
    if (key) await context.emitActivity(key, { kind: "notice", level: "error", title: "Codex protocol drift", detail: drift }, params);
    await context.rpc.rejectRequest(message.id, -32601, drift);
    return;
  }
  if (!key) {
    await context.rpc.rejectRequest(message.id, -32000, "Unknown thread.");
    return;
  }

  if (message.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params?.questions) ? params.questions.map(toQuestion).filter(Boolean) as AgentUserInputQuestion[] : [];
    context.registerRequest(message.id, threadId!, keys);
    for (const sessionKey of keys) {
      await context.onOutput({
        type: "user_input_request",
        sessionKey,
        requestId: message.id,
        questions,
        turnId: getTurnId(params),
        itemId: typeof params?.itemId === "string" ? params.itemId : undefined,
      });
      const running = context.sessions.get(sessionKey);
      if (running) running.status.waitingForUserInput = true;
    }
    return;
  }

  if (message.method === "mcpServer/elicitation/request") {
    const mode = getString(params, "mode");
    if (mode === "openai/form") {
      await context.rpc.respond(message.id, { action: "cancel", content: null, _meta: null });
      const running = context.sessions.get(key);
      if (running) running.status.recentError = "Codex sent an MCP openai/form elicitation even though Relay disabled that capability.";
      await context.emitActivity(key, { kind: "notice", level: "error", title: "Unsupported MCP form", detail: "Codex requested openai/form even though Relay disabled that capability; the request was cancelled." }, params);
      return;
    }
    if (mode !== "form" && mode !== "url") {
      await context.rpc.respond(message.id, { action: "cancel", content: null, _meta: null });
      return;
    }
    const requestedSchema = mode === "form" ? toMcpElicitationSchema(params?.requestedSchema) : undefined;
    if (mode === "form" && !requestedSchema) {
      await context.rpc.respond(message.id, { action: "cancel", content: null, _meta: null });
      const running = context.sessions.get(key);
      if (running) running.status.recentError = "Codex sent an invalid MCP elicitation schema.";
      return;
    }
    context.registerRequest(message.id, threadId!, keys);
    for (const sessionKey of keys) {
      await context.onOutput({
        type: "mcp_elicitation_request",
        sessionKey,
        requestId: message.id,
        serverName: getString(params, "serverName") ?? "MCP server",
        mode,
        message: getString(params, "message") ?? "The MCP server requested additional input.",
        ...(requestedSchema ? { requestedSchema } : {}),
        ...(getString(params, "url") ? { url: getString(params, "url") } : {}),
        ...(getString(params, "elicitationId") ? { elicitationId: getString(params, "elicitationId") } : {}),
        ...(params?._meta !== undefined ? { meta: params._meta } : {}),
        ...(getTurnId(params) ? { turnId: getTurnId(params) } : {}),
      });
      const running = context.sessions.get(sessionKey);
      if (running) running.status.waitingForUserInput = true;
    }
    return;
  }

  const approvalKind = approvalKindForMethod(message.method);
  if (approvalKind) {
    const { title, body } = approvalCopy(approvalKind, params);
    context.registerRequest(message.id, threadId!, keys);
    for (const sessionKey of keys) {
      await context.onOutput({
        type: "approval_request",
        sessionKey,
        requestId: message.id,
        method: message.method,
        approvalKind,
        title,
        body,
        params: message.params,
        turnId: getTurnId(params),
        itemId: typeof params?.itemId === "string" ? params.itemId : undefined,
      });
      const running = context.sessions.get(sessionKey);
      if (running) running.status.waitingForApproval = true;
    }
    return;
  }

  const running = context.sessions.get(key);
  if (running) running.status.recentError = `Unsupported Codex server request: ${message.method}`;
  context.logger.error("codex.unsupported_server_request", { method: message.method, thread_id: threadId, session_key: key });
  await context.emitActivity(key, { kind: "notice", level: "error", title: "Unsupported Codex request", detail: message.method }, params);
  await context.rpc.rejectRequest(message.id, -32601, `Unsupported server request: ${message.method}`);
}
