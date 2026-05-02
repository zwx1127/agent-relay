import type { AgentDriver, AgentExitHandler, AgentOutputHandler } from "./types.ts";

export function sessionKey(chatId: number, workspaceName: string): string {
  return `${chatId}:${workspaceName}`;
}

export abstract class BaseAgentDriver implements AgentDriver {
  constructor(
    protected readonly onOutput: AgentOutputHandler,
    protected readonly onExit: AgentExitHandler,
  ) {}

  abstract start(...args: Parameters<AgentDriver["start"]>): ReturnType<AgentDriver["start"]>;
  abstract send(...args: Parameters<AgentDriver["send"]>): ReturnType<AgentDriver["send"]>;
  abstract stop(...args: Parameters<AgentDriver["stop"]>): ReturnType<AgentDriver["stop"]>;
  abstract getStatus(...args: Parameters<AgentDriver["getStatus"]>): ReturnType<AgentDriver["getStatus"]>;
}
