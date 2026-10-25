#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_PORT } from "@ios-sim/protocol";
import { createBackend } from "./backends.js";
import { defaultTokenPath, isLoopback, loadOrCreateToken, SERVICE_VERSION } from "./config.js";
import { buildServer } from "./server.js";

const HELP = `ios-sim-host — expose a macOS iOS Simulator to other machines

Usage: ios-sim-host [options]

Options:
  -p, --port <port>        Listen port (default: ${DEFAULT_PORT}, env IOS_SIM_PORT)
      --bind <address>     Bind address (default: 127.0.0.1, env IOS_SIM_BIND)
      --token <token>      Shared access token (default: env IOS_SIM_TOKEN or token file)
      --token-file <path>  Token file (default: ${defaultTokenPath()})
      --backend <name>     simctl (default on macOS) or mock (Linux demos/tests)
      --no-auth            Disable the token. Refused on non-loopback binds.
      --log                Enable request logging
  -h, --help               Show this help
  -v, --version            Print the version

The host must run on macOS with Xcode installed. The Linux client only needs Node.js.
`;

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p" },
      bind: { type: "string" },
      token: { type: "string" },
      "token-file": { type: "string" },
      backend: { type: "string" },
      "no-auth": { type: "boolean" },
      log: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${SERVICE_VERSION}\n`);
    return;
  }

  const port = Number.parseInt(values.port ?? process.env.IOS_SIM_PORT ?? "", 10) || DEFAULT_PORT;
  const bind = values.bind ?? process.env.IOS_SIM_BIND ?? "127.0.0.1";
  const backendName = (values.backend ?? process.env.IOS_SIM_BACKEND ?? "simctl") as
    | "simctl"
    | "mock";

  if (backendName !== "simctl" && backendName !== "mock") {
    throw new Error(`Unknown backend "${backendName}". Use simctl or mock.`);
  }

  let token: string | undefined;
  let tokenPath: string | undefined;
  let tokenFromFile = false;
  if (!values["no-auth"]) {
    token = values.token ?? process.env.IOS_SIM_TOKEN;
    if (!token) {
      const loaded = loadOrCreateToken(values["token-file"] ?? defaultTokenPath());
      token = loaded.token;
      tokenPath = loaded.path;
      tokenFromFile = true;
    }
  } else if (!isLoopback(bind)) {
    throw new Error("Refusing --no-auth on a non-loopback bind. Use a token or an SSH tunnel.");
  }

  const backend = await createBackend({ backend: backendName });
  const app = await buildServer({ backend, token, logger: values.log });
  await app.listen({ port, host: bind });

  const displayHost = isLoopback(bind) ? "127.0.0.1" : bind;
  process.stdout.write(
    [
      `ios-sim-host ${SERVICE_VERSION}`,
      `backend: ${backend.name} (input: ${backend.capabilities().input ? "ready" : "unavailable"})`,
      `listening: http://${displayHost}:${port}`,
      token ? `token: ${token}` : "auth: disabled (loopback only)",
      tokenFromFile && tokenPath ? `token file: ${tokenPath}` : "",
      "",
      "Linux client:",
      `  IOS_SIM_URL=http://${displayHost}:${port} IOS_SIM_TOKEN=${token ?? ""} ios-sim doctor`,
      "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  );

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`ios-sim-host: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
