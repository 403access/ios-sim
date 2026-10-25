import { timingSafeEqual } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import websocket from "@fastify/websocket";
import {
  createDeviceRequestSchema,
  DEFAULT_FPS,
  inputEventSchema,
  launchRequestSchema,
  MAX_FPS,
  screenshotFormatSchema,
  terminateRequestSchema,
} from "@ios-sim/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { x as extractTar } from "tar";
import type { WebSocket } from "ws";
import { ZodError } from "zod";
import type { HostBackend, LogOptions } from "./backends.js";
import { parseFps, SERVICE_VERSION } from "./config.js";
import { InputCommandError, InputUnavailableError } from "./idb.js";
import { SimctlError } from "./simctl.js";
import { webHtml } from "./web.js";

export interface ServerOptions {
  backend: HostBackend;
  token?: string;
  logger?: boolean;
  maxUploadBytes?: number;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_HEADER = "authorization";

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const { backend, token } = options;
  const startedAt = Date.now();
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: options.maxUploadBytes ?? 512 * 1024 * 1024,
  });

  await app.register(websocket);
  app.addContentTypeParser("application/gzip", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );

  const isAuthorized = (request: FastifyRequest) => {
    if (!token) return true;
    const header = request.headers[TOKEN_HEADER];
    const bearer = typeof header === "string" ? header.replace(/^Bearer\s+/i, "") : undefined;
    const query = request.query as { token?: string } | undefined;
    return safeEqual(bearer, token) || safeEqual(query?.token, token);
  };

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    if (!path.startsWith("/v1/") || path === "/v1/health") return;
    // WebSocket upgrades are authenticated in the socket handler so the client
    // receives a 1008 close code instead of an opaque HTTP 401.
    if (path.endsWith("/stream")) return;
    if (isAuthorized(request)) return;
    await reply
      .code(401)
      .type("application/json")
      .send({ error: { code: "unauthorized", message: "Missing or invalid access token." } });
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.statusCode >= 500) request.log.error({ error }, mapped.message);
    reply
      .code(mapped.statusCode)
      .type("application/json")
      .send({ error: { code: mapped.code, message: mapped.message } });
  });

  app.get("/", async (_request, reply) => {
    reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(webHtml);
  });

  app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());

  app.get("/v1/health", async () => {
    const capabilities = backend.capabilities();
    return {
      ok: true,
      service: "ios-sim-host" as const,
      version: SERVICE_VERSION,
      platform: process.platform,
      backend: backend.name,
      hostname: hostname(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      capabilities,
    };
  });

  app.get("/v1/runtimes", async () => backend.listRuntimes());

  app.get("/v1/devices", async () => ({ devices: await backend.listDevices() }));

  app.post("/v1/devices", async (request) => {
    const input = createDeviceRequestSchema.parse(request.body);
    return backend.createDevice(input);
  });

  const udidOf = (request: FastifyRequest) => {
    const { udid } = request.params as { udid?: string };
    if (!udid) throw new HttpError(400, "missing_udid", "Device UDID is required.");
    return udid;
  };

  app.post("/v1/devices/:udid/boot", async (request) => backend.bootDevice(udidOf(request)));

  app.post("/v1/devices/:udid/shutdown", async (request, reply) => {
    await backend.shutdownDevice(udidOf(request));
    return reply.code(204).send();
  });

  app.post("/v1/devices/:udid/erase", async (request, reply) => {
    await backend.eraseDevice(udidOf(request));
    return reply.code(204).send();
  });

  app.delete("/v1/devices/:udid", async (request, reply) => {
    await backend.deleteDevice(udidOf(request));
    return reply.code(204).send();
  });

  app.get("/v1/devices/:udid/apps", async (request) => ({
    apps: await backend.listApps(udidOf(request)),
  }));

  app.get("/v1/devices/:udid/display", async (request) => {
    const format = screenshotFormatSchema.parse(
      (request.query as { format?: string } | undefined)?.format,
    );
    return { ...(await backend.display(udidOf(request))), format };
  });

  app.get("/v1/devices/:udid/screenshot", async (request, reply) => {
    const format = screenshotFormatSchema.parse(
      (request.query as { format?: string } | undefined)?.format,
    );
    const image = await backend.screenshot(udidOf(request), format);
    return reply
      .header("cache-control", "no-store")
      .type(format === "png" ? "image/png" : "image/jpeg")
      .send(image);
  });

  app.post("/v1/devices/:udid/apps", async (request) => {
    const udid = udidOf(request);
    if (!Buffer.isBuffer(request.body)) {
      throw new HttpError(
        415,
        "unsupported_media_type",
        "Upload a .app directory as a gzip tarball.",
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "ios-sim-install-"));
    try {
      const archive = join(directory, "upload.tgz");
      await writeFile(archive, request.body);
      await extractTar({
        file: archive,
        cwd: directory,
        strict: true,
        filter: (path) => !path.startsWith("/") && !path.split("/").includes(".."),
      });
      const appPath = await findAppBundle(directory);
      if (!appPath) {
        throw new HttpError(
          400,
          "app_bundle_missing",
          "The archive does not contain a .app bundle.",
        );
      }
      await backend.installApp(udid, appPath);
      return { installed: basename(appPath) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  app.post("/v1/devices/:udid/launch", async (request) => {
    const input = launchRequestSchema.parse(request.body);
    return backend.launchApp(udidOf(request), input);
  });

  app.post("/v1/devices/:udid/terminate", async (request, reply) => {
    const input = terminateRequestSchema.parse(request.body);
    await backend.terminateApp(udidOf(request), input.bundleId);
    return reply.code(204).send();
  });

  app.post("/v1/devices/:udid/input", async (request, reply) => {
    const event = inputEventSchema.parse(request.body);
    await backend.sendInput(udidOf(request), event);
    return reply.code(204).send();
  });

  app.get("/v1/devices/:udid/logs", async (request, reply) => {
    const query = (request.query ?? {}) as LogOptions;
    const stream = backend.logs(udidOf(request), {
      level: sanitizeLogValue(query.level),
      predicate: sanitizeLogValue(query.predicate),
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const lines = createInterface({ input: stream });
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    let closed = false;
    lines.on("line", (line) => reply.raw.write(`data: ${line}\n\n`));
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      lines.close();
      stream.destroy();
      reply.raw.end();
    };
    lines.on("close", close);
    reply.raw.on("close", close);
    return reply;
  });

  app.get("/v1/devices/:udid/stream", { websocket: true }, (socket: WebSocket, request) => {
    if (!isAuthorized(request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    const query = (request.query ?? {}) as { fps?: string; format?: string };
    const fps = parseFps(query.fps, DEFAULT_FPS, MAX_FPS);
    const format = screenshotFormatSchema.parse(query.format);
    const udid = (request.params as { udid: string }).udid;
    let closed = false;
    let busy = false;
    let timer: NodeJS.Timeout | undefined;

    const stop = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      socket.removeAllListeners();
      socket.close();
    };

    socket.on("close", stop);
    socket.on("error", stop);

    void (async () => {
      try {
        const display = await backend.display(udid);
        if (closed) return;
        socket.send(JSON.stringify({ type: "config", display, fps, format }));
        const capture = async () => {
          if (closed || busy) return;
          busy = true;
          try {
            if (socket.bufferedAmount > 4 * 1024 * 1024) return;
            const frame = await backend.screenshot(udid, format);
            if (!closed) socket.send(frame);
          } catch (error) {
            if (!closed) {
              try {
                socket.send(
                  JSON.stringify({
                    type: "error",
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
              } catch {
                // The peer may have disconnected between the check and send.
              }
              socket.close(1011, "screen capture failed");
            }
          } finally {
            busy = false;
          }
        };
        await capture();
        timer = setInterval(() => void capture(), Math.round(1000 / fps));
      } catch (error) {
        if (!closed) {
          socket.send(JSON.stringify({ type: "error", message: mapError(error).message }));
          socket.close(1011, "stream setup failed");
        }
      }
    })();
  });

  app.setNotFoundHandler((_request, reply) => {
    reply
      .code(404)
      .type("application/json")
      .send({ error: { code: "not_found", message: "No such endpoint." } });
  });

  return app;
}

function sanitizeLogValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 1000);
}

function safeEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function mapError(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof HttpError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message };
  }
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: "invalid_request",
      message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    };
  }
  if (error instanceof InputUnavailableError) {
    return { statusCode: 501, code: "input_unavailable", message: error.message };
  }
  if (error instanceof InputCommandError) {
    return { statusCode: 502, code: "input_failed", message: error.message };
  }
  if (error instanceof SimctlError) {
    const detail = error.stderr.trim() || error.message;
    return { statusCode: 502, code: "simctl_failed", message: detail };
  }
  if (error instanceof Error) {
    return { statusCode: 500, code: "internal_error", message: error.message };
  }
  return { statusCode: 500, code: "internal_error", message: "Unknown error." };
}

async function findAppBundle(root: string, depth = 3): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name.endsWith(".app")) return path;
    const nested = await findAppBundle(path, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}
