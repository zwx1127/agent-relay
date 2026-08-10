import { randomUUID } from "node:crypto";
import type { MessageId } from "../domain/ids.ts";
import type { AgentTaskInput } from "../ports/agent.ts";
import type { InboundMessage, InboundTextPresentation, TextEntity } from "../ports/im.ts";
import {
  appendRendered,
  renderCodexMarkdownForTelegram,
  type RenderedTelegramText,
} from "../presentation/telegram/text.ts";
import { attachmentSummaryForInput } from "./tasks/input.ts";
import { textMessage } from "./ui/text-parts.ts";

const CAPTURED_SOURCE_LIMIT = 2_048;
const PENDING_CONTEXT_LIMIT = 2_048;
const PENDING_CONTEXT_TTL_MS = 30 * 60_000;
const REFERENCE_LIMIT = 4_096;

export interface SharedTextPresentation extends InboundTextPresentation {
  text: string;
}

export interface SharedUserMessageContext {
  threadId: string;
  referenceKey: string;
  presentation: SharedTextPresentation;
  replyReferenceKey?: string;
}

interface CapturedSource {
  scopeKey: string;
  messageId: MessageId;
  replyToMessageId?: MessageId;
  presentation: SharedTextPresentation;
}

interface PendingContext extends SharedUserMessageContext {
  createdAt: number;
}

interface ReferenceEntry {
  threadId: string;
  primaryByScope: Map<string, MessageId>;
  aliasesByScope: Map<string, Map<string, MessageId>>;
}

/**
 * Keeps provider-local message ids aligned with one shared Codex thread for the
 * lifetime of this Relay process. It intentionally has no storage dependency.
 */
export class SharedMessageRegistry {
  private readonly capturedSources = new Map<string, CapturedSource>();
  private readonly pendingContexts = new Map<string, PendingContext>();
  private readonly references = new Map<string, ReferenceEntry>();
  private readonly localReferences = new Map<string, { threadId: string; referenceKey: string }>();

  constructor(private readonly enabled: boolean) {}

  captureInbound(message: InboundMessage): void {
    if (!this.enabled || message.kind === "callback_query") return;
    const rawText = message.kind === "message" ? message.text : message.caption ?? "";
    const rawPresentation = message.kind === "message" ? message.textPresentation : message.captionPresentation;
    const presentation = normalizePresentation(rawText, rawPresentation);
    const source: CapturedSource = {
      scopeKey: String(message.conversationId),
      messageId: message.messageId,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      presentation,
    };
    this.setBounded(this.capturedSources, localKey(source.scopeKey, source.messageId), source, CAPTURED_SOURCE_LIMIT);
  }

  prepareUserMessage(threadId: string | undefined, scopeKey: string, messageId: MessageId | undefined, effectiveText: string): string | undefined {
    if (!this.enabled || !threadId || messageId === undefined) return undefined;
    this.prunePendingContexts();
    const captured = this.capturedSources.get(localKey(scopeKey, messageId));
    const presentation = captured?.presentation.text === effectiveText
      ? captured.presentation
      : { format: "plain" as const, text: effectiveText };
    const replyReferenceKey = captured?.replyToMessageId !== undefined
      ? this.referenceForLocal(threadId, scopeKey, captured.replyToMessageId)
      : undefined;
    const clientUserMessageId = `agent-relay:${randomUUID()}`;
    const referenceKey = `user:${threadId}:${clientUserMessageId}`;
    this.registerAlias(threadId, referenceKey, scopeKey, messageId);
    this.setBounded(this.pendingContexts, clientUserMessageId, {
      threadId,
      referenceKey,
      presentation,
      ...(replyReferenceKey ? { replyReferenceKey } : {}),
      createdAt: Date.now(),
    }, PENDING_CONTEXT_LIMIT);
    return clientUserMessageId;
  }

  discardUserMessage(clientUserMessageId: string | undefined): void {
    if (!clientUserMessageId) return;
    const context = this.pendingContexts.get(clientUserMessageId);
    this.pendingContexts.delete(clientUserMessageId);
    if (context) this.removeReference(context.referenceKey);
  }

  userMessageContext(threadId: string, clientUserMessageId: string | undefined): SharedUserMessageContext | undefined {
    if (!clientUserMessageId) return undefined;
    this.prunePendingContexts();
    const context = this.pendingContexts.get(clientUserMessageId);
    if (!context || context.threadId !== threadId) return undefined;
    return context;
  }

  externalUserReference(threadId: string, itemId: string | undefined): string | undefined {
    return itemId ? `user:${threadId}:item:${itemId}` : undefined;
  }

  assistantReference(threadId: string, turnId: string): string {
    return `assistant:${threadId}:${turnId}`;
  }

  registerAssistantMessage(threadId: string | undefined, turnId: string | undefined, scopeKey: string, messageId: MessageId | undefined): void {
    if (!this.enabled || !threadId || !turnId || messageId === undefined) return;
    this.registerAlias(threadId, this.assistantReference(threadId, turnId), scopeKey, messageId);
  }

  registerAlias(threadId: string, referenceKey: string, scopeKey: string, messageId: MessageId): void {
    if (!this.enabled) return;
    let entry = this.references.get(referenceKey);
    if (!entry) {
      while (this.references.size >= REFERENCE_LIMIT) {
        const oldest = this.references.keys().next().value;
        if (typeof oldest !== "string") break;
        this.removeReference(oldest);
      }
      entry = { threadId, primaryByScope: new Map(), aliasesByScope: new Map() };
      this.references.set(referenceKey, entry);
    }
    if (entry.threadId !== threadId) return;
    const key = localKey(scopeKey, messageId);
    const previous = this.localReferences.get(key);
    if (previous && previous.referenceKey !== referenceKey) this.detachLocalAlias(previous.referenceKey, scopeKey, messageId);
    const aliases = entry.aliasesByScope.get(scopeKey) ?? new Map<string, MessageId>();
    aliases.set(String(messageId), messageId);
    entry.aliasesByScope.set(scopeKey, aliases);
    entry.primaryByScope.set(scopeKey, messageId);
    this.localReferences.set(key, { threadId, referenceKey });
  }

  messageIdForReference(threadId: string, referenceKey: string | undefined, scopeKey: string): MessageId | undefined {
    if (!this.enabled || !referenceKey) return undefined;
    const entry = this.references.get(referenceKey);
    return entry?.threadId === threadId ? entry.primaryByScope.get(scopeKey) : undefined;
  }

  private referenceForLocal(threadId: string, scopeKey: string, messageId: MessageId): string | undefined {
    const reference = this.localReferences.get(localKey(scopeKey, messageId));
    return reference?.threadId === threadId ? reference.referenceKey : undefined;
  }

  private detachLocalAlias(referenceKey: string, scopeKey: string, messageId: MessageId): void {
    const entry = this.references.get(referenceKey);
    const aliases = entry?.aliasesByScope.get(scopeKey);
    aliases?.delete(String(messageId));
    if (aliases?.size === 0) entry?.aliasesByScope.delete(scopeKey);
    if (entry?.primaryByScope.get(scopeKey) === messageId) {
      const replacement = aliases?.values().next().value;
      if (replacement !== undefined) entry.primaryByScope.set(scopeKey, replacement);
      else entry.primaryByScope.delete(scopeKey);
    }
  }

  private removeReference(referenceKey: string): void {
    const entry = this.references.get(referenceKey);
    if (!entry) return;
    for (const [scopeKey, aliases] of entry.aliasesByScope) {
      for (const messageId of aliases.values()) this.localReferences.delete(localKey(scopeKey, messageId));
    }
    this.references.delete(referenceKey);
  }

  private prunePendingContexts(now = Date.now()): void {
    const cutoff = now - PENDING_CONTEXT_TTL_MS;
    for (const [clientId, context] of this.pendingContexts) {
      if (context.createdAt >= cutoff) break;
      this.pendingContexts.delete(clientId);
    }
  }

  private setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
    while (map.size >= limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    map.set(key, value);
  }
}

export function renderSharedUserInput(input: AgentTaskInput, presentation: SharedTextPresentation | undefined): RenderedTelegramText {
  const rendered = presentation?.text === input.text
    ? presentation.format === "markdown"
      ? renderCodexMarkdownForTelegram(presentation.text)
      : { text: presentation.text, entities: validEntities(presentation.text, presentation.entities) }
    : textMessage(input.text);
  const summary = attachmentSummaryForInput(input);
  return summary ? appendRendered(rendered, textMessage(`${rendered.text ? "\n" : ""}[${summary} attached]`)) : rendered;
}

function normalizePresentation(text: string, presentation: InboundTextPresentation | undefined): SharedTextPresentation {
  const leadingTrim = text.length - text.trimStart().length;
  const normalized = text.trim();
  const normalizedEnd = leadingTrim + normalized.length;
  const entities = (presentation?.entities ?? []).flatMap((entity): TextEntity[] => {
    const start = Math.max(entity.offset, leadingTrim);
    const end = Math.min(entity.offset + entity.length, normalizedEnd);
    return end > start ? [{ ...entity, offset: start - leadingTrim, length: end - start }] : [];
  });
  return {
    format: presentation?.format ?? "plain",
    text: normalized,
    ...(entities.length > 0 ? { entities } : {}),
  };
}

function validEntities(text: string, entities: TextEntity[] | undefined): TextEntity[] {
  return (entities ?? []).filter((entity) => entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= text.length);
}

function localKey(scopeKey: string, messageId: MessageId): string {
  return `${scopeKey}\0${String(messageId)}`;
}
