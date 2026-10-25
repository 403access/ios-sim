import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ClientConfig {
  url?: string;
  token?: string;
}

export const configDir = () =>
  process.env.IOS_SIM_CONFIG_DIR ?? join(homedir(), ".config", "ios-sim");
export const configPath = () => join(configDir(), "client.json");
export const hostTokenPath = () => join(configDir(), "token");

export function loadClientConfig(): ClientConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as ClientConfig;
  } catch {
    return {};
  }
}

export function saveClientConfig(config: ClientConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function resolveConnection(flags: { url?: string; token?: string } = {}): {
  url: string;
  token?: string;
  device: string;
} {
  const file = loadClientConfig();
  const url = flags.url ?? process.env.IOS_SIM_URL ?? file.url ?? "http://127.0.0.1:7777";
  const token =
    flags.token ?? process.env.IOS_SIM_TOKEN ?? file.token ?? readTokenFile(hostTokenPath());
  return {
    url: url.replace(/\/+$/, ""),
    token,
    device: process.env.IOS_SIM_DEVICE ?? "booted",
  };
}

function readTokenFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
