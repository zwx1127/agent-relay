export interface GatewayLiveEvent {
  seq: number;
  threadId: string;
  method: string;
}

interface RecentLiveEvent {
  clientId: string;
  event: GatewayLiveEvent;
  recordedAt: number;
}

interface ThreadLiveState {
  nextSeq: number;
  recentByPayload: Map<string, RecentLiveEvent>;
}

/**
 * Assigns connection-lifetime sequence numbers and suppresses app-server
 * broadcasts observed through more than one client. It intentionally retains
 * no replayable event payloads or offline progress history.
 */
export class GatewayLiveEventSequencer {
  private readonly threads = new Map<string, ThreadLiveState>();

  sequence(clientId: string, message: Record<string, unknown>, now = Date.now()): GatewayLiveEvent | undefined {
    if ("id" in message || typeof message.method !== "string") return undefined;
    const threadId = messageThreadId(message);
    if (!threadId) return undefined;
    const state: ThreadLiveState = this.threads.get(threadId) ?? { nextSeq: 1, recentByPayload: new Map() };
    this.threads.set(threadId, state);
    const payloadKey = JSON.stringify(message);
    const duplicate = state.recentByPayload.get(payloadKey);
    if (duplicate && duplicate.clientId !== clientId && now - duplicate.recordedAt <= 1_000) return duplicate.event;
    const event: GatewayLiveEvent = { seq: state.nextSeq++, threadId, method: message.method };
    state.recentByPayload.set(payloadKey, { clientId, event, recordedAt: now });
    for (const [key, value] of state.recentByPayload) {
      if (now - value.recordedAt > 1_000) state.recentByPayload.delete(key);
    }
    return event;
  }
}

export function messageThreadId(message: Record<string, unknown>): string | undefined {
  const params = asRecord(message.params);
  const direct = typeof params?.threadId === "string" ? params.threadId : undefined;
  if (direct) return direct;
  const thread = asRecord(params?.thread);
  if (typeof thread?.id === "string") return thread.id;
  const result = asRecord(message.result);
  const resultThread = asRecord(result?.thread);
  return typeof resultThread?.id === "string" ? resultThread.id : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
