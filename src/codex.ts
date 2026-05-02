import { BaseAgentDriver, sessionKey } from "./agent.ts";
import { cleanTerminalOutput } from "./text.ts";
import { noopLogger, type Logger } from "./logger.ts";
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
    private readonly logger: Logger = noopLogger,
  ) {
    super(onOutput, onExit);
  }

  async start(options: StartAgentOptions): Promise<AgentSessionStatus> {
    const key = sessionKey(options.chatId, options.workspaceName);
    const existing = this.sessions.get(key);
    if (existing) {
      this.logger.info("codex.session_reused", {
        session_key: key,
        chat_id: options.chatId,
        workspace: options.workspaceName,
      });
      return existing.status;
    }

    const status: AgentSessionStatus = {
      sessionKey: key,
      chatId: options.chatId,
      workspaceName: options.workspaceName,
      workspacePath: options.workspacePath,
      running: true,
      startedAt: Date.now(),
    };

    this.logger.info("codex.session_starting", {
      session_key: key,
      chat_id: options.chatId,
      workspace: options.workspaceName,
      workspace_path: options.workspacePath,
      codex_bin: this.options.codexBin,
      sandbox: this.options.sandbox,
      approval: this.options.approval,
    });

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
          if (chunk.length > 0) {
            this.logger.debug("codex.output_chunk", { session_key: key, chunk_len: chunk.length, agent_chunk: chunk });
            void this.onOutput({ sessionKey: key, chunk });
          }
        },
      },
    });

    if (!proc.terminal) {
      this.logger.error("codex.pty_attach_failed", { session_key: key, workspace: options.workspaceName });
      throw new Error("Bun did not attach a PTY terminal to the Codex process.");
    }

    const running: RunningSession = {
      status,
      proc,
      terminal: proc.terminal,
    };
    this.sessions.set(key, running);
    this.logger.info("codex.session_started", {
      session_key: key,
      chat_id: options.chatId,
      workspace: options.workspaceName,
    });

    void proc.exited.then((exitCode) => {
      this.sessions.delete(key);
      status.running = false;
      this.logger.info("codex.session_exited", {
        session_key: key,
        chat_id: options.chatId,
        workspace: options.workspaceName,
        exit_code: exitCode,
        signal_code: proc.signalCode,
      });
      void this.onExit({ sessionKey: key, exitCode, signalCode: proc.signalCode });
      proc.terminal?.close();
    }).catch((error) => {
      this.logger.error("codex.session_exit_wait_failed", {
        session_key: key,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });

    return status;
  }

  async send(key: string, text: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) {
      this.logger.warn("codex.send_without_session", { session_key: key, text_len: text.length });
      throw new Error("Codex session is not running.");
    }
    this.logger.info("codex.input_sent", {
      session_key: key,
      chat_id: running.status.chatId,
      workspace: running.status.workspaceName,
      text_len: text.length,
    });
    this.logger.debug("codex.input_text", { session_key: key, message_text: text });
    running.terminal.write(text);
    await Bun.sleep(25);
    running.terminal.write("\r");
  }

  async stop(key: string): Promise<void> {
    const running = this.sessions.get(key);
    if (!running) {
      this.logger.info("codex.stop_without_session", { session_key: key });
      return;
    }
    this.logger.info("codex.session_stop_requested", {
      session_key: key,
      chat_id: running.status.chatId,
      workspace: running.status.workspaceName,
    });
    running.terminal.write("\x03");
    const exited = await Promise.race([
      running.proc.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) {
      this.logger.warn("codex.session_kill_requested", { session_key: key });
      running.proc.kill();
      await running.proc.exited.catch(() => undefined);
    }
    running.terminal.close();
    this.sessions.delete(key);
    running.status.running = false;
    this.logger.info("codex.session_stopped", { session_key: key });
  }

  getStatus(key: string): AgentSessionStatus | undefined {
    return this.sessions.get(key)?.status;
  }
}
