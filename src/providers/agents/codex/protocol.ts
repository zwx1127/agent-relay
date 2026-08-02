import type { AgentApprovalKind, AgentCollaborationMode, AgentImageInput, AgentInputAttachment, AgentMcpElicitationFieldSchema, AgentMcpElicitationSchema, AgentModelSummary, AgentReviewTarget, AgentSessionStatus, AgentThreadGoal, AgentThreadGoalStatus, AgentThreadSummary, AgentTokenBreakdown, AgentTurnCompletedEvent, AgentTurnError, AgentTurnStatus, AgentUserInputQuestion } from "../../../ports/agent.ts";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function getThreadId(value: unknown): string | undefined {
  const record = asRecord(value);
  const thread = asRecord(record?.thread);
  return typeof thread?.id === "string" ? thread.id : undefined;
}

export function getTurnId(value: unknown): string | undefined {
  const record = asRecord(value);
  const turn = asRecord(record?.turn);
  if (typeof turn?.id === "string") return turn.id;
  return typeof record?.turnId === "string" ? record.turnId : undefined;
}

export function getTurnStatus(value: unknown): string | undefined {
  const record = asRecord(value);
  const turn = asRecord(record?.turn);
  return typeof turn?.status === "string" ? turn.status : undefined;
}

export function applySessionMetadata(status: AgentSessionStatus, result: unknown): void {
  const record = asRecord(result);
  // App-server response shapes are intentionally treated as loose records so the
  // relay can tolerate minor protocol additions without breaking session startup.
  applyThreadMetadata(status, asRecord(record?.thread));
  status.model = getString(record, "model") ?? status.model;
  status.modelProvider = getString(record, "modelProvider") ?? status.modelProvider;
  status.reasoningEffort = getString(record, "reasoningEffort") ?? status.reasoningEffort;
  status.approvalPolicy = summarizeUnknown(record?.approvalPolicy) ?? status.approvalPolicy;
  status.approvalsReviewer = getString(record, "approvalsReviewer") ?? status.approvalsReviewer;
  status.sandboxPolicy = summarizeUnknown(record?.sandbox) ?? status.sandboxPolicy;
  status.instructionSources = Array.isArray(record?.instructionSources)
    ? record.instructionSources.filter((source): source is string => typeof source === "string")
    : status.instructionSources;
}

export function applyThreadMetadata(status: AgentSessionStatus, thread: Record<string, unknown> | undefined): void {
  if (!thread) return;
  status.threadId = getString(thread, "id") ?? status.threadId;
  status.threadName = getString(thread, "name") ?? status.threadName;
  const threadStatus = asRecord(thread.status);
  status.threadStatus = getString(threadStatus, "type") ?? status.threadStatus;
}

export function toThreadSummary(value: unknown): AgentThreadSummary | undefined {
  const record = asRecord(value);
  const id = getString(record, "id");
  if (!id) return undefined;
  const status = asRecord(record?.status);
  return {
    id,
    name: getString(record, "name"),
    preview: getString(record, "preview"),
    cwd: getString(record, "cwd"),
    status: getString(status, "type"),
    modelProvider: getString(record, "modelProvider"),
    createdAt: typeof record?.createdAt === "number" ? record.createdAt : undefined,
    updatedAt: typeof record?.updatedAt === "number" ? record.updatedAt : undefined,
  };
}

export function toModelSummary(value: unknown): AgentModelSummary | undefined {
  const record = asRecord(value);
  const id = getString(record, "id");
  if (!id) return undefined;
  return {
    id,
    model: getString(record, "model"),
    displayName: getString(record, "displayName"),
    description: getString(record, "description"),
    isDefault: typeof record?.isDefault === "boolean" ? record.isDefault : undefined,
    defaultReasoningEffort: getString(record, "defaultReasoningEffort"),
    supportedReasoningEfforts: Array.isArray(record?.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts.map((effort) => typeof effort === "string"
        ? effort
        : getString(asRecord(effort), "reasoningEffort")).filter((effort): effort is string => Boolean(effort))
      : undefined,
  };
}

export function toThreadGoal(value: unknown): AgentThreadGoal | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const threadId = getString(record, "threadId");
  const objective = getString(record, "objective");
  const status = toThreadGoalStatus(getString(record, "status"));
  if (!threadId || !objective || !status) return undefined;
  return {
    threadId,
    objective,
    status,
    tokenBudget: typeof record?.tokenBudget === "number" ? record.tokenBudget : null,
    tokensUsed: getNumber(record, "tokensUsed") ?? 0,
    timeUsedSeconds: getNumber(record, "timeUsedSeconds") ?? 0,
    createdAt: getNumber(record, "createdAt") ?? 0,
    updatedAt: getNumber(record, "updatedAt") ?? 0,
  };
}

export function toThreadGoalStatus(value: string | undefined): AgentThreadGoalStatus | undefined {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
    case "complete":
      return value;
    default:
      return undefined;
  }
}

export function reviewTargetPayload(target: AgentReviewTarget): unknown {
  switch (target.type) {
    case "baseBranch":
      return { type: "baseBranch", branch: target.branch };
    case "commit":
      return { type: "commit", sha: target.sha, title: target.title ?? null };
    case "custom":
      return { type: "custom", instructions: target.instructions };
    case "uncommittedChanges":
      return { type: "uncommittedChanges" };
  }
}

export function collaborationModePayload(status: AgentSessionStatus, mode: AgentCollaborationMode, defaultModel?: string): unknown {
  // Codex expects a complete settings object for collaboration mode changes.
  // Relay reuses the current session metadata and lets Codex fill unavailable
  // optional settings with its defaults.
  return {
    mode,
    settings: {
      model: status.model ?? defaultModel ?? requiredModelError(),
      reasoning_effort: status.reasoningEffort ?? null,
      developer_instructions: null,
    },
  };
}

function requiredModelError(): never {
  throw new Error("Codex app-server did not advertise a default model for collaboration mode.");
}

export function toTurnCompletedEvent(sessionKey: string, value: unknown): AgentTurnCompletedEvent {
  const record = asRecord(value);
  const turn = asRecord(record?.turn);
  const status = toTurnStatus(getString(turn, "status"));
  const error = toTurnError(turn?.error);
  const duration = turn?.durationMs;
  return {
    type: "turn_completed",
    sessionKey,
    ...(getString(turn, "id") ? { turnId: getString(turn, "id") } : {}),
    status,
    ...(error ? { error } : {}),
    ...(typeof duration === "number" ? { durationMs: duration } : {}),
  };
}

export function toTurnStatus(value: string | undefined): AgentTurnStatus {
  switch (value) {
    case "completed":
    case "interrupted":
    case "failed":
    case "inProgress":
      return value;
    default:
      return "failed";
  }
}

function toTurnError(value: unknown): AgentTurnError | undefined {
  const record = asRecord(value);
  const message = getString(record, "message");
  if (!message) return undefined;
  return {
    message,
    ...(record?.codexErrorInfo !== undefined && record.codexErrorInfo !== null ? { codexErrorInfo: record.codexErrorInfo } : {}),
    ...(getString(record, "additionalDetails") ? { additionalDetails: getString(record, "additionalDetails") } : {}),
  };
}

export function toMcpElicitationSchema(value: unknown): AgentMcpElicitationSchema | undefined {
  const record = asRecord(value);
  const properties = asRecord(record?.properties);
  if (record?.type !== "object" || !properties) return undefined;
  const normalized: Record<string, AgentMcpElicitationFieldSchema> = {};
  for (const [name, schemaValue] of Object.entries(properties)) {
    const field = toMcpElicitationFieldSchema(schemaValue);
    if (!field) return undefined;
    normalized[name] = field;
  }
  return {
    type: "object",
    properties: normalized,
    ...(Array.isArray(record.required)
      ? { required: record.required.filter((name): name is string => typeof name === "string") }
      : {}),
  };
}

function toMcpElicitationFieldSchema(value: unknown): AgentMcpElicitationFieldSchema | undefined {
  const record = asRecord(value);
  const type = getString(record, "type");
  if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean" && type !== "array") return undefined;
  const oneOf = Array.isArray(record?.oneOf) ? record.oneOf.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const items = asRecord(record?.items);
  const itemOneOf = Array.isArray(items?.oneOf) ? items.oneOf.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const enumValues = Array.isArray(record?.enum)
    ? record.enum
    : oneOf.length > 0
      ? oneOf.map((option) => option.const)
      : undefined;
  const enumNames = Array.isArray(record?.enumNames)
    ? record.enumNames.filter((name): name is string => typeof name === "string")
    : oneOf.length > 0
      ? oneOf.map((option) => getString(option, "title") ?? String(option.const))
      : undefined;
  const itemEnum = Array.isArray(items?.enum)
    ? items.enum
    : itemOneOf.length > 0
      ? itemOneOf.map((option) => option.const)
      : undefined;
  const result: AgentMcpElicitationFieldSchema = {
    type,
    ...(getString(record, "title") ? { title: getString(record, "title") } : {}),
    ...(getString(record, "description") ? { description: getString(record, "description") } : {}),
    ...(record?.default !== undefined ? { default: record.default } : {}),
    ...(typeof record?.minLength === "number" ? { minLength: record.minLength } : {}),
    ...(typeof record?.maxLength === "number" ? { maxLength: record.maxLength } : {}),
    ...(typeof record?.minimum === "number" ? { minimum: record.minimum } : {}),
    ...(typeof record?.maximum === "number" ? { maximum: record.maximum } : {}),
    ...(isMcpStringFormat(getString(record, "format")) ? { format: getString(record, "format") as AgentMcpElicitationFieldSchema["format"] } : {}),
    ...(enumValues ? { enum: enumValues } : {}),
    ...(enumNames ? { enumNames } : {}),
    ...(items ? { items: { ...(getString(items, "type") ? { type: getString(items, "type") } : {}), ...(itemEnum ? { enum: itemEnum } : {}) } } : {}),
    ...(typeof record?.minItems === "number" ? { minItems: record.minItems } : {}),
    ...(typeof record?.maxItems === "number" ? { maxItems: record.maxItems } : {}),
  };
  if (type === "array" && !result.items?.enum) return undefined;
  return result;
}

function isMcpStringFormat(value: string | undefined): boolean {
  return value === "email" || value === "uri" || value === "date" || value === "date-time";
}

export function applyThreadSettings(status: AgentSessionStatus, value: unknown): void {
  const settings = asRecord(value);
  if (!settings) return;
  status.model = getString(settings, "model") ?? status.model;
  status.modelProvider = getString(settings, "modelProvider") ?? status.modelProvider;
  status.reasoningEffort = getString(settings, "effort") ?? status.reasoningEffort;
  status.approvalPolicy = summarizeUnknown(settings.approvalPolicy) ?? status.approvalPolicy;
  status.approvalsReviewer = getString(settings, "approvalsReviewer") ?? status.approvalsReviewer;
  status.sandboxPolicy = summarizeUnknown(settings.sandboxPolicy) ?? status.sandboxPolicy;
}

export function toTokenBreakdown(record: Record<string, unknown> | undefined): AgentTokenBreakdown | undefined {
  if (!record) return undefined;
  return {
    inputTokens: getNumber(record, "inputTokens"),
    cachedInputTokens: getNumber(record, "cachedInputTokens"),
    outputTokens: getNumber(record, "outputTokens"),
    reasoningOutputTokens: getNumber(record, "reasoningOutputTokens"),
    totalTokens: getNumber(record, "totalTokens"),
  };
}

export function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

export function userInputPayload(
  text: string,
  attachments: AgentInputAttachment[] | undefined,
  legacyImages?: AgentImageInput[],
): unknown[] {
  const input: unknown[] = [{ type: "text", text, text_elements: [] }];
  for (const attachment of attachments ?? []) {
    switch (attachment.type) {
      case "image":
        input.push({ type: "image", url: attachment.url });
        break;
      case "localImage":
        input.push({ type: "localImage", path: attachment.path });
        break;
      case "audio":
        input.push({ type: "audio", url: attachment.url });
        break;
      case "localAudio":
        input.push({ type: "localAudio", path: attachment.path });
        break;
      case "skill":
        input.push({ type: "skill", name: attachment.name, path: attachment.path });
        break;
      case "mention":
        input.push({ type: "mention", name: attachment.name, path: attachment.path });
        break;
    }
  }
  // Captions stay in the text prompt. Legacy images are appended after ordered
  // attachments so tasks persisted by older relay builds remain resumable.
  const structuredLocalImages = new Set((attachments ?? [])
    .filter((attachment): attachment is Extract<AgentInputAttachment, { type: "localImage" }> => attachment.type === "localImage")
    .map((attachment) => attachment.path));
  for (const image of legacyImages ?? []) {
    if (!structuredLocalImages.has(image.path)) input.push({ type: "localImage", path: image.path });
  }
  return input;
}

export function imageOutputEvent(sessionKey: string, item: Record<string, unknown>, turnId: string | undefined): {
  type: "image";
  sessionKey: string;
  path?: string;
  data?: string;
  caption?: string;
  turnId?: string;
  itemId?: string;
} {
  // Image output has existed under both saved-path and inline-result shapes.
  // Normalize either shape before the relay stores and sends the file.
  const savedPath = getString(item, "savedPath");
  const result = getString(item, "result");
  const revisedPrompt = getString(item, "revisedPrompt") ?? getString(item, "revised_prompt");
  return {
    type: "image",
    sessionKey,
    ...(savedPath ? { path: savedPath } : result ? { data: result } : {}),
    ...(revisedPrompt ? { caption: revisedPrompt } : {}),
    ...(turnId ? { turnId } : {}),
    ...(getString(item, "id") ? { itemId: getString(item, "id") } : {}),
  };
}

export function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  if (typeof record?.type === "string") return record.type;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function updateActiveTurnFromResult(running: { status: AgentSessionStatus }, result: unknown): void {
  const turnId = getTurnId(result);
  if (!turnId) return;
  const status = getTurnStatus(result);
  if (status && status !== "inProgress") {
    running.status.activeTurnId = undefined;
    return;
  }
  running.status.activeTurnId = turnId;
}

export function isNoActiveTurnToSteerError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("no active turn to steer");
}

export function isNoActiveTurnToInterruptError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("no active turn to interrupt");
}

export function toQuestion(value: unknown): AgentUserInputQuestion | undefined {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.header !== "string" || typeof record.question !== "string") {
    return undefined;
  }
  return {
    id: record.id,
    header: record.header,
    question: record.question,
    ...(typeof record.isSecret === "boolean" ? { isSecret: record.isSecret } : {}),
    ...(typeof record.isOther === "boolean" ? { isOther: record.isOther } : {}),
    options: Array.isArray(record.options)
      ? record.options.map((option) => {
        const optionRecord = asRecord(option);
        return optionRecord && typeof optionRecord.label === "string"
          ? { label: optionRecord.label, description: typeof optionRecord.description === "string" ? optionRecord.description : "" }
          : undefined;
      }).filter(Boolean) as Array<{ label: string; description: string }>
      : null,
  };
}

export function approvalKindForMethod(method: string): AgentApprovalKind | undefined {
  // Keep legacy method names while newer app-server builds migrate to item/*.
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command";
    case "item/fileChange/requestApproval":
      return "file_change";
    case "item/permissions/requestApproval":
      return "permissions";
    case "execCommandApproval":
      return "legacy_command";
    case "applyPatchApproval":
      return "legacy_patch";
    default:
      return undefined;
  }
}

export function approvalCopy(kind: AgentApprovalKind, params: Record<string, unknown> | undefined): { title: string; body: string } {
  if (kind === "command" || kind === "legacy_command") {
    const command = Array.isArray(params?.command) ? params.command.join(" ") : typeof params?.command === "string" ? params.command : "(command unavailable)";
    const cwd = typeof params?.cwd === "string" ? params.cwd : undefined;
    const reason = typeof params?.reason === "string" ? params.reason : undefined;
    return {
      title: "Approve command?",
      body: [reason, cwd ? `cwd: ${cwd}` : undefined, command].filter(Boolean).join("\n"),
    };
  }
  if (kind === "permissions") {
    const cwd = typeof params?.cwd === "string" ? params.cwd : undefined;
    const reason = typeof params?.reason === "string" ? params.reason : undefined;
    return {
      title: "Approve permission change?",
      body: [reason, cwd ? `cwd: ${cwd}` : undefined].filter(Boolean).join("\n") || "Codex requested additional permissions.",
    };
  }
  return {
    title: "Approve file changes?",
    body: typeof params?.reason === "string" ? params.reason : "Codex requested permission to modify files.",
  };
}
