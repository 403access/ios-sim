import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_VERSION = "0.1.0";

export const configDir = () =>
  process.env.IOS_SIM_CONFIG_DIR ?? join(homedir(), ".config", "ios-sim");

export const defaultTokenPath = () => join(configDir(), "token");
export const clientConfigPath = () => join(configDir(), "client.json");

export function readToken(path = defaultTokenPath()): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function loadOrCreateToken(path = defaultTokenPath()): { token: string; path: string } {
  const existing = readToken(path);
  if (existing) return { token: existing, path };
  const token = randomBytes(24).toString("base64url");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return { token, path };
}

export function isLoopback(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

export function parseFps(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
