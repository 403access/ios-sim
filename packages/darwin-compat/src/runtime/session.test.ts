import { describe, expect, it } from "vitest";
import { SessionError, SessionManager } from "./session.js";

describe("sessions and roles", () => {
  it("creates identities with ports/services and tears them down once", () => {
    const torn: number[] = [];
    const sessions = new SessionManager({ onTeardown: (session) => torn.push(session.id) });
    const foreground = sessions.create({ name: "app", role: "foreground", pid: 10 });
    const daemon = sessions.create({ name: "sync", role: "daemon", pid: 11, services: ["sync"] });
    sessions.bindPort(foreground.id, 100);
    sessions.bindService(daemon.id, "extra");
    expect(foreground.ports.has(100)).toBe(true);
    expect(daemon.services.has("sync")).toBe(true);
    expect(daemon.services.has("extra")).toBe(true);
    expect(sessions.find("sync")?.pid).toBe(11);

    expect(sessions.teardown(foreground.id)).toBe(true);
    expect(sessions.teardown(foreground.id)).toBe(false);
    expect(torn).toEqual([foreground.id]);
    expect(sessions.teardownAll()).toBe(1);
    expect(sessions.list()).toEqual([]);
  });

  it("enforces one foreground session and unique names", () => {
    const sessions = new SessionManager();
    sessions.create({ name: "app", role: "foreground", pid: 1 });
    expect(() => sessions.create({ name: "other", role: "foreground", pid: 2 })).toThrow(
      /one foreground/,
    );
    expect(() => sessions.create({ name: "app", role: "background", pid: 3 })).toThrow(
      /already exists/,
    );
    expect(() => sessions.create({ name: "", role: "daemon", pid: 4 })).toThrow(/empty/);
    expect(() => sessions.create({ name: "bad", role: "driver" as never, pid: 5 })).toThrow(
      SessionError,
    );
  });

  it("rejects ports on an unknown session", () => {
    const sessions = new SessionManager();
    expect(() => sessions.bindPort(99, 1)).toThrow(/does not exist/);
  });
});
