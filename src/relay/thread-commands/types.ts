import type { InboundMessage } from "../../ports/im.ts";

export type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;
