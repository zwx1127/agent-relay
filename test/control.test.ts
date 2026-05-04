import { afterEach, describe, expect, test } from "bun:test";
import { startControlServer, type RunningControlServer } from "../src/control/server.ts";

let servers: RunningControlServer[] = [];

afterEach(() => {
  for (const server of servers) server.stop();
  servers = [];
});

describe("control server", () => {
  test("dispatches authorized capability requests", async () => {
    const server = startControlServer({
      port: 0,
      token: "secret",
      capabilities: [{
        name: "send_image",
        handle: async (body) => ({ ok: true, message: `sent ${(body as { path?: string }).path}` }),
      }],
    });
    servers.push(server);

    const response = await fetch(`${server.url}/v1/capabilities/send_image`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ path: "/tmp/screen.png" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "sent /tmp/screen.png" });
  });

  test("rejects missing authorization", async () => {
    const server = startControlServer({
      port: 0,
      token: "secret",
      capabilities: [],
    });
    servers.push(server);

    const response = await fetch(`${server.url}/v1/capabilities/send_image`, {
      method: "POST",
      body: JSON.stringify({ path: "/tmp/screen.png" }),
    });

    expect(response.status).toBe(401);
  });

  test("returns not found for unknown capability", async () => {
    const server = startControlServer({
      port: 0,
      token: "secret",
      capabilities: [],
    });
    servers.push(server);

    const response = await fetch(`${server.url}/v1/capabilities/missing`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "unknown capability" });
  });
});
