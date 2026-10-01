import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { nativeAgentSpawnCommand } from "../native-spawn.ts";
import { record, string, safeMessage, type JsonObject } from "./protocol.ts";

type Pending = { resolve(value: JsonObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** Claude's newline-delimited control protocol, verified against Agent SDK 0.3.285. */
export class ClaudeTransport {
  readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private stderr = "";
  private closed = false;
  private sequence = Promise.resolve();

  constructor(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
    private readonly onFrame: (frame: JsonObject) => Promise<void>,
    private readonly onClose: (code: number | null, signal: string | null, error: Error) => void,
    private readonly timeoutMs = 30_000) {
    const spec = nativeAgentSpawnCommand(binary, args, env);
    this.process = spawn(spec.command, spec.args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error("Claude stream frame exceeded the 16 MiB safety limit.")); return; }
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, boundary).trim();
        this.buffer = this.buffer.slice(boundary + 1);
        if (!line) continue;
        this.sequence = this.sequence.then(async () => {
          if (this.closed) return;
          const frame = record(JSON.parse(line));
          if (!frame || !string(frame.type)) throw new Error("Invalid Claude stream frame.");
          if (frame.type === "control_response") {
            const response = record(frame.response);
            const id = string(response?.request_id);
            const pending = id ? this.pending.get(id) : undefined;
            if (pending) {
              this.pending.delete(id!); clearTimeout(pending.timer);
              if (response?.subtype === "success") pending.resolve(record(response.response) ?? {});
              else pending.reject(new Error(safeMessage(response?.error ?? "Claude control request failed.")));
            }
            return;
          }
          await this.onFrame(frame);
        }).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
      }
    });
    this.process.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-4096); });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("error", (error) => this.fail(new Error(`Failed to start Claude: ${safeMessage(error)}. Check CLAUDE_BIN and the native installation.`)));
    this.process.on("close", (code, signal) => {
      // Deliver frames already received before the close notification.
      void this.sequence.finally(() => this.finish(code, signal, new Error(`Claude exited with code ${code}${this.stderr.trim() ? `: ${safeMessage(this.stderr.trim())}` : "."}`)));
    });
  }

  request(request: JsonObject): Promise<JsonObject> {
    if (this.closed) return Promise.reject(new Error("Claude process is closed."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Claude ${String(request.subtype)} control request timed out.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ type: "control_request", request_id: id, request }).catch((error: Error) => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  write(frame: JsonObject): Promise<void> {
    if (this.closed || this.process.stdin.destroyed) return Promise.reject(new Error("Claude input is closed."));
    return new Promise((resolve, reject) => { this.process.stdin.write(`${JSON.stringify(frame)}\n`, (error) => error ? reject(error) : resolve()); });
  }

  respond(id: string, response: JsonObject): Promise<void> {
    return this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }
  reject(id: string, error: string): Promise<void> {
    return this.write({ type: "control_response", response: { subtype: "error", request_id: id, error } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // EOF cancels unanswered approvals before the native process cleans up tools/hooks.
    this.process.stdin.end();
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => this.process.kill("SIGTERM"), 2000);
      const hard = setTimeout(() => { this.process.kill("SIGKILL"); resolve(); }, 5000);
      const done = () => { clearTimeout(kill); clearTimeout(hard); resolve(); };
      if (this.process.exitCode !== null || this.process.signalCode !== null) done();
      else this.process.once("close", done);
    });
  }

  private fail(error: Error): void {
    this.finish(null, null, error);
    this.process.stdin.destroy(); this.process.kill("SIGTERM");
    const timer = setTimeout(() => { if (this.process.exitCode === null) this.process.kill("SIGKILL"); }, 2000);
    timer.unref();
  }
  private finish(code: number | null, signal: string | null, error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onClose(code, signal, error);
  }
}

export function claudeVersion(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const spec = nativeAgentSpawnCommand(binary, ["--version"], env);
    const child = spawn(spec.command, spec.args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Claude --version timed out.")); }, 15_000);
    child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-4096); });
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`Unable to start Claude: ${safeMessage(error)}. Check CLAUDE_BIN.`)); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`Claude --version exited with code ${code}.`)); });
  });
}
