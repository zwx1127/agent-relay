import { BaseAgentDriver, sessionKey } from "./agent.ts";
import { cleanTerminalOutput } from "./text.ts";
import type { AgentExitHandler, AgentOutputHandler, AgentSessionStatus, StartAgentOptions } from "./types.ts";

interface RunningSession {
  status: AgentSessionStatus;
  proc: Bun.Subprocess;
  terminal: NonNullable<Bun.Subprocess["terminal"]>;
}

export interface CodexDriverOptions {
  codexBin: string;
  sandbox: string;
  approval: string;
}

export class CodexDriver extends BaseAgentDriver {
  private readonly sessions = new Map<string, RunningSession>();

  constructor(
    private readonly options: CodexDriverOptions,
    onOutput: AgentOutputHandler,
    onExit: AgentExitHandler,
  ) {
    super(onOutput, onExit);
  }

  async start(options: StartAgentOptions): Promise<AgentSessionStatus> {
    const key = sessionKey(options.chatId, options.workspaceName);
    const existing = this.sessions.get(key);
    if (existing) return existing.status;

    const status: AgentSessionStatus = {
      sessionKey: key,
      chatId: options.chatId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: Date.now(),
    };

    const proc = Bun.spawn([
      this.options.codexBin,
      "--no-alt-screen",
      "-C",
      options.workspacePath,
      "-s",
      this.options.sandbox,
      "-a",
      this.options.approval,
    ], {
      cwd: options.workspacePath,
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: 120,
        rows: 40,
        data: (_terminal, data) => {
          const chunk = cleanTerminalOutput(new TextDecoder().decode(data));
          if (chunk.length > 0) void this.onOutput({ sessionKey: key, chunk });
        },
      },
    });

    if (!proc.terminal) {
      throw new Error("Bun did not attach a PTY terminal to the Codex process.");
    }

    const running: RunningSession = {
      status,
      proc,
      terminal: proc.terminal,
    };
    this.sessions.set(key, running);

    void proc.exited.then((exitCode) => {
      this.sessions.delete(key);
      status.running = false;
      void this.onExit({ sessionKey: key, exitCode, signalCode: proc.signalCode });
      proc.terminal?.close();
    });

    return status;
  }

  async send(key: string, text: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) throw new Error("Codex session is not running.");
    running.terminal.write(`${text}\n`);
  }

  async stop(key: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) return;
    running.terminal.write("\x03");
    const exited = await Promise.race([
      running.proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) {
      running.proc.kill();
      await running.proc.exited.catch(() => undefined);
    }
    running.terminal.close();
    this.sessions.delete(key);
    running.status.running = false;
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.sessions.get(key)?.status;
  }
}
