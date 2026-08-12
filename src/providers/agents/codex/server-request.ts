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
  registerRequest(requestId: string | number, threadId: string, sessionKeys: string[], method: string, turnId: string | undefined, signature: string): boolean;
  requestIsResolved(requestId: string | number, threadId: string): boolean;
  claimRequestDelivery(requestId: string | number, threadId: string, sessionKey: string): boolean;
  markRequestDelivered(requestId: string | number, threadId: string, sessionKey: string): Promise<void>;
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
    await handleSideConversationRequest(message, params, threadId!, sideConversation, context);
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
    const turnId = getTurnId(params);
    if (!context.registerRequest(message.id, threadId!, keys, message.method, turnId, serverRequestSignature(message))) return;
    for (const sessionKey of keys) {
      const running = context.sessions.get(sessionKey);
      if (running) running.status.waitingForUserInput = true;
    }
    for (const sessionKey of keys) {
      if (context.requestIsResolved(message.id, threadId!)) break;
      if (!context.claimRequestDelivery(message.id, threadId!, sessionKey)) continue;
      try {
        await context.onOutput({
          type: "user_input_request",
          sessionKey,
          requestId: message.id,
          threadId: threadId!,
          questions,
          turnId,
          itemId: typeof params?.itemId === "string" ? params.itemId : undefined,
        });
      } catch (error) {
        context.logger.warn("codex.user_input_request_delivery_failed", {
          session_key: sessionKey,
          thread_id: threadId,
          request_id: String(message.id),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      } finally {
        await context.markRequestDelivered(message.id, threadId!, sessionKey);
      }
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
    const turnId = getTurnId(params);
    if (!context.registerRequest(message.id, threadId!, keys, message.method, turnId, serverRequestSignature(message))) return;
    for (const sessionKey of keys) {
      const running = context.sessions.get(sessionKey);
      if (running) running.status.waitingForUserInput = true;
    }
    for (const sessionKey of keys) {
      if (context.requestIsResolved(message.id, threadId!)) break;
      if (!context.claimRequestDelivery(message.id, threadId!, sessionKey)) continue;
      try {
        await context.onOutput({
          type: "mcp_elicitation_request",
          sessionKey,
          requestId: message.id,
          threadId: threadId!,
          serverName: getString(params, "serverName") ?? "MCP server",
          mode,
          message: getString(params, "message") ?? "The MCP server requested additional input.",
          ...(requestedSchema ? { requestedSchema } : {}),
          ...(getString(params, "url") ? { url: getString(params, "url") } : {}),
          ...(getString(params, "elicitationId") ? { elicitationId: getString(params, "elicitationId") } : {}),
          ...(params?._meta !== undefined ? { meta: params._meta } : {}),
          ...(turnId ? { turnId } : {}),
        });
      } catch (error) {
        context.logger.warn("codex.mcp_elicitation_request_delivery_failed", {
          session_key: sessionKey,
          thread_id: threadId,
          request_id: String(message.id),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      } finally {
        await context.markRequestDelivered(message.id, threadId!, sessionKey);
      }
    }
    return;
  }

  const approvalKind = approvalKindForMethod(message.method);
  if (approvalKind) {
    const { title, body } = approvalCopy(approvalKind, params);
    const turnId = getTurnId(params);
    if (!context.registerRequest(message.id, threadId!, keys, message.method, turnId, serverRequestSignature(message))) return;
    for (const sessionKey of keys) {
      const running = context.sessions.get(sessionKey);
      if (running) running.status.waitingForApproval = true;
    }
    for (const sessionKey of keys) {
      if (context.requestIsResolved(message.id, threadId!)) break;
      if (!context.claimRequestDelivery(message.id, threadId!, sessionKey)) continue;
      try {
        await context.onOutput({
          type: "approval_request",
          sessionKey,
          requestId: message.id,
          threadId: threadId!,
          method: message.method,
          approvalKind,
          title,
          body,
          params: message.params,
          turnId,
          itemId: typeof params?.itemId === "string" ? params.itemId : undefined,
        });
      } catch (error) {
        context.logger.warn("codex.approval_request_delivery_failed", {
          session_key: sessionKey,
          thread_id: threadId,
          request_id: String(message.id),
          error: error instanceof Error ? error : new Error(String(error)),
        });
      } finally {
        await context.markRequestDelivered(message.id, threadId!, sessionKey);
      }
    }
    return;
  }

  const running = context.sessions.get(key);
  if (running) running.status.recentError = `Unsupported Codex server request: ${message.method}`;
  context.logger.error("codex.unsupported_server_request", { method: message.method, thread_id: threadId, session_key: key });
  await context.emitActivity(key, { kind: "notice", level: "error", title: "Unsupported Codex request", detail: message.method }, params);
  await context.rpc.rejectRequest(message.id, -32601, `Unsupported server request: ${message.method}`);
}

async function handleSideConversationRequest(
  message: JsonRpcRequest,
  params: Record<string, unknown> | undefined,
  threadId: string,
  side: SideConversationCollector,
  context: ServerRequestContext,
): Promise<void> {
  const emit = async (event: Parameters<NonNullable<SideConversationCollector["onEvent"]>>[0]) => {
    try {
      await side.onEvent?.(event);
    } catch (error) {
      context.logger.warn("codex.side_conversation_request_delivery_failed", {
        thread_id: threadId,
        method: message.method,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  };

  if (message.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params?.questions) ? params.questions.map(toQuestion).filter(Boolean) as AgentUserInputQuestion[] : [];
    if (!context.registerRequest(message.id, threadId, [side.sessionKey], message.method, getTurnId(params), serverRequestSignature(message))) return;
    if (!context.claimRequestDelivery(message.id, threadId, side.sessionKey)) return;
    try {
      await emit({
        type: "user_input_request",
        sessionKey: side.sessionKey,
        requestId: message.id,
        threadId,
        questions,
        ...(getTurnId(params) ? { turnId: getTurnId(params) } : {}),
        ...(typeof params?.itemId === "string" ? { itemId: params.itemId } : {}),
      });
    } finally {
      await context.markRequestDelivered(message.id, threadId, side.sessionKey);
    }
    return;
  }

  if (message.method === "mcpServer/elicitation/request") {
    const mode = getString(params, "mode");
    if (mode === "openai/form" || (mode !== "form" && mode !== "url")) {
      await context.rpc.respond(message.id, { action: "cancel", content: null, _meta: null });
      return;
    }
    const requestedSchema = mode === "form" ? toMcpElicitationSchema(params?.requestedSchema) : undefined;
    if (mode === "form" && !requestedSchema) {
      await context.rpc.respond(message.id, { action: "cancel", content: null, _meta: null });
      return;
    }
    if (!context.registerRequest(message.id, threadId, [side.sessionKey], message.method, getTurnId(params), serverRequestSignature(message))) return;
    if (!context.claimRequestDelivery(message.id, threadId, side.sessionKey)) return;
    try {
      await emit({
        type: "mcp_elicitation_request",
        sessionKey: side.sessionKey,
        requestId: message.id,
        threadId,
        serverName: getString(params, "serverName") ?? "MCP server",
        mode,
        message: getString(params, "message") ?? "The MCP server requested additional input.",
        ...(requestedSchema ? { requestedSchema } : {}),
        ...(getString(params, "url") ? { url: getString(params, "url") } : {}),
        ...(getString(params, "elicitationId") ? { elicitationId: getString(params, "elicitationId") } : {}),
        ...(params?._meta !== undefined ? { meta: params._meta } : {}),
        ...(getTurnId(params) ? { turnId: getTurnId(params) } : {}),
      });
    } finally {
      await context.markRequestDelivered(message.id, threadId, side.sessionKey);
    }
    return;
  }

  const approvalKind = approvalKindForMethod(message.method);
  if (approvalKind) {
    const { title, body } = approvalCopy(approvalKind, params);
    if (!context.registerRequest(message.id, threadId, [side.sessionKey], message.method, getTurnId(params), serverRequestSignature(message))) return;
    if (!context.claimRequestDelivery(message.id, threadId, side.sessionKey)) return;
    try {
      await emit({
        type: "approval_request",
        sessionKey: side.sessionKey,
        requestId: message.id,
        threadId,
        method: message.method,
        approvalKind,
        title,
        body,
        params: message.params,
        ...(getTurnId(params) ? { turnId: getTurnId(params) } : {}),
        ...(typeof params?.itemId === "string" ? { itemId: params.itemId } : {}),
      });
    } finally {
      await context.markRequestDelivered(message.id, threadId, side.sessionKey);
    }
    return;
  }

  await context.rpc.rejectRequest(message.id, -32601, `Unsupported server request in side conversation: ${message.method}`);
}

function serverRequestSignature(message: JsonRpcRequest): string {
  return JSON.stringify({ method: message.method, params: message.params ?? null });
}
