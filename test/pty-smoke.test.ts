import { describe, expect, test } from "bun:test";

describe("bun pty smoke", () => {
  test("writes to and reads from /bin/cat", async () => {
    let output = "";
    const proc = Bun.spawn(["/bin/cat"], {
      terminal: {
        cols: 80,
        rows: 24,
        data: (_terminal, data) => {
          output += new TextDecoder().decode(data);
        },
      },
    });
    expect(proc.terminal).toBeDefined();
    proc.terminal?.write("hello\n");
    await Bun.sleep(50);
    proc.terminal?.write("\x04");
    await Promise.race([proc.exited, Bun.sleep(1000)]);
    proc.terminal?.close();
    expect(output).toContain("hello");
  });
});
