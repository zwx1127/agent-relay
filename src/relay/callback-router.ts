import type { InboundMessage } from "../ports/messaging.ts";
import { CALLBACK_PREFIX } from "./ui/constants.ts";
import { isConsolePayload } from "./ui/callback-data.ts";

type CallbackMessage = Extract<InboundMessage, { kind: "callback_query" }>;

export interface CallbackHandlers {
  isStaleConsoleCallback(message: CallbackMessage, payload: string): boolean;
  renderStaleConsole(message: CallbackMessage): Promise<void>;
  home(message: CallbackMessage): Promise<void>;
  status(message: CallbackMessage): Promise<void>;
  workspaces(message: CallbackMessage, pageIndex: number): Promise<void>;
  newWorkspace(message: CallbackMessage): Promise<void>;
  toggleStatusMode(message: CallbackMessage): Promise<void>;
  approval(message: CallbackMessage, payload: string): Promise<void>;
  pagedOutput(message: CallbackMessage, payload: string): Promise<void>;
  command(message: CallbackMessage, payload: string): Promise<void>;
  stop(message: CallbackMessage): Promise<void>;
  confirmDeleteWorkspace(message: CallbackMessage, token: string): Promise<void>;
  deleteWorkspace(message: CallbackMessage, token: string): Promise<void>;
  selectWorkspace(message: CallbackMessage, token: string): Promise<void>;
}

export class CallbackRouter {
  constructor(private readonly handlers: CallbackHandlers) {}

  async route(message: CallbackMessage): Promise<void> {
    if (!message.data.startsWith(CALLBACK_PREFIX)) throw new Error("Unknown callback.");
    const payload = message.data.slice(CALLBACK_PREFIX.length);
    if (this.handlers.isStaleConsoleCallback(message, payload)) {
      await this.handlers.renderStaleConsole(message);
      return;
    }

    if (payload === "home") {
      await this.handlers.home(message);
      return;
    }
    if (payload === "s") {
      await this.handlers.status(message);
      return;
    }
    if (payload === "w") {
      await this.handlers.workspaces(message, 0);
      return;
    }
    if (payload === "n") {
      await this.handlers.newWorkspace(message);
      return;
    }
    if (payload === "status") {
      await this.handlers.toggleStatusMode(message);
      return;
    }
    if (payload.startsWith("a:")) {
      await this.handlers.approval(message, payload);
      return;
    }
    if (payload.startsWith("p:")) {
      await this.handlers.pagedOutput(message, payload);
      return;
    }
    if (payload.startsWith("cmd:")) {
      await this.handlers.command(message, payload);
      return;
    }
    if (payload.startsWith("wl:")) {
      await this.handlers.workspaces(message, Number(payload.slice("wl:".length)));
      return;
    }
    if (payload === "stop") {
      await this.handlers.stop(message);
      return;
    }
    if (payload.startsWith("wd?:")) {
      await this.handlers.confirmDeleteWorkspace(message, payload.slice("wd?:".length));
      return;
    }
    if (payload.startsWith("wd!:")) {
      await this.handlers.deleteWorkspace(message, payload.slice("wd!:".length));
      return;
    }
    if (payload.startsWith("uh:")) {
      await this.handlers.selectWorkspace(message, payload.slice("uh:".length));
      return;
    }

    throw new Error("Unknown callback.");
  }
}

export function isConsoleCallbackPayload(payload: string): boolean {
  return isConsolePayload(payload);
}
