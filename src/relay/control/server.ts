import { timingSafeEqual } from "node:crypto";
import type { CapabilityDefinition } from "../capabilities/registry.ts";
import { noopLogger, type Logger } from "../../domain/logger.ts";

export interface ControlServerOptions {
  port: number;
  token: string;
  capabilities: CapabilityDefinition[];
  logger?: Logger;
}

export interface RunningControlServer {
  url: string;
  stop(): void;
}

export function startControlServer(options: ControlServerOptions): RunningControlServer {
  const logger = options.logger ?? noopLogger;
  const capabilities = new Map(options.capabilities.map((capability) => [capability.name, capability]));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: async (request) => {
      try {
        return await handleControlRequest(request, options.token, capabilities);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn("control.request_failed", { error: error instanceof Error ? error : new Error(detail) });
        return jsonResponse({ ok: false, error: detail }, 500);
      }
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  logger.info("control.started", { url, capability_count: capabilities.size });
  return {
    url,
    stop: () => {
      server.stop(true);
      logger.info("control.stopped");
    },
  };
}

async function handleControlRequest(
  request: Request,
  token: string,
  capabilities: Map<string, CapabilityDefinition>,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  if (!isAuthorized(request, token)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  const match = url.pathname.match(/^\/v1\/capabilities\/([^/]+)$/);
  if (!match) return jsonResponse({ ok: false, error: "not found" }, 404);
  const capability = capabilities.get(decodeURIComponent(match[1]!));
  if (!capability) return jsonResponse({ ok: false, error: "unknown capability" }, 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "invalid json" }, 400);
  }

  try {
    return jsonResponse(await capability.handle(body), 200);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return jsonResponse({ ok: false, error: detail }, 400);
  }
}

function isAuthorized(request: Request, token: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(header);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
