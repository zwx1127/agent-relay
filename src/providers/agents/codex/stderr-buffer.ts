const MAX_RECENT_STDERR_LINES = 20;
const MAX_RECENT_STDERR_CHARS = 8 * 1024;

export class RecentStderrBuffer {
  private readonly lines: string[] = [];

  clear(): void {
    this.lines.length = 0;
  }

  push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_RECENT_STDERR_LINES) {
      this.lines.splice(0, this.lines.length - MAX_RECENT_STDERR_LINES);
    }
    let totalChars = this.lines.reduce((total, value) => total + value.length + 1, 0);
    while (totalChars > MAX_RECENT_STDERR_CHARS && this.lines.length > 1) {
      const removed = this.lines.shift();
      totalChars -= (removed?.length ?? 0) + 1;
    }
  }

  text(): string {
    return this.lines.join("\n").trim();
  }
}
