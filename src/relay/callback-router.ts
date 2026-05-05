import type { InboundMessage } from "../ports/im.ts";
import { CALLBACK_PREFIX } from "./ui/constants.ts";
import { isConsolePayload } from "./ui/callback-data.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;
type CallbackResult = string | void;

export interface CallbackHandlers {
  isStaleConsoleCallback(message: CallbackMessage, payload: string): boolean;
  renderStaleConsole(message: CallbackMessage): Promise<CallbackResult>;
  home(message: CallbackMessage): Promise<CallbackResult>;
  status(message: CallbackMessage): Promise<CallbackResult>;
  workspaces(message: CallbackMessage, pageIndex: number): Promise<CallbackResult>;
  newWorkspace(message: CallbackMessage): Promise<CallbackResult>;
  toggleStatusMode(message: CallbackMessage): Promise<CallbackResult>;
  approval(message: CallbackMessage, payload: string): Promise<CallbackResult>;
  pagedOutput(message: CallbackMessage, payload: string): Promise<CallbackResult>;
  command(message: CallbackMessage, payload: string): Promise<CallbackResult>;
  stop(message: CallbackMessage): Promise<CallbackResult>;
  confirmDeleteWorkspace(message: CallbackMessage, token: string): Promise<CallbackResult>;
  deleteWorkspace(message: CallbackMessage, token: string): Promise<CallbackResult>;
  selectWorkspace(message: CallbackMessage, token: string): Promise<CallbackResult>;
}

export class CallbackRouter {
  constructor(private readonly handlers: CallbackHandlers) {}

  async route(message: CallbackMessage): Promise<string | undefined> {
    if (!message.data.startsWith(CALLBACK_PREFIX)) throw new Error("Unknown callback.");
    const payload = message.data.slice(CALLBACK_PREFIX.length);
    if (this.handlers.isStaleConsoleCallback(message, payload)) {
      return callbackText(await this.handlers.renderStaleConsole(message));
    }

    if (payload === "home") {
      return callbackText(await this.handlers.home(message));
    }
    if (payload === "s") {
      return callbackText(await this.handlers.status(message));
    }
    if (payload === "w") {
      return callbackText(await this.handlers.workspaces(message, 0));
    }
    if (payload === "n") {
      return callbackText(await this.handlers.newWorkspace(message));
    }
    if (payload === "status") {
      return callbackText(await this.handlers.toggleStatusMode(message));
    }
    if (payload.startsWith("a:")) {
      return callbackText(await this.handlers.approval(message, payload));
    }
    if (payload.startsWith("p:")) {
      return callbackText(await this.handlers.pagedOutput(message, payload));
    }
    if (payload.startsWith("cmd:")) {
      return callbackText(await this.handlers.command(message, payload));
    }
    if (payload.startsWith("wl:")) {
      return callbackText(await this.handlers.workspaces(message, Number(payload.slice("wl:".length))));
    }
    if (payload === "stop") {
      return callbackText(await this.handlers.stop(message));
    }
    if (payload.startsWith("wd?:")) {
      return callbackText(await this.handlers.confirmDeleteWorkspace(message, payload.slice("wd?:".length)));
    }
    if (payload.startsWith("wd!:")) {
      return callbackText(await this.handlers.deleteWorkspace(message, payload.slice("wd!:".length)));
    }
    if (payload.startsWith("uh:")) {
      return callbackText(await this.handlers.selectWorkspace(message, payload.slice("uh:".length)));
    }

    throw new Error("Unknown callback.");
  }
}

function callbackText(result: CallbackResult): string | undefined {
  return typeof result === "string" ? result : undefined;
}

export function isConsoleCallbackPayload(payload: string): boolean {
  return isConsolePayload(payload);
}
