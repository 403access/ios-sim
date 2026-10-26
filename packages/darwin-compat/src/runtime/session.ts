/**
 * Roles, sessions, and teardown contracts (THR-011).
 *
 * A session is the identity a job keeps across its lifetime: a stable id, a
 * role (foreground/background/daemon), a pid, and the ports/services it owns.
 * Teardown is a single idempotent operation that hands the session back to the
 * caller so the Mach task/ports can be destroyed in one place.
 *
 * This is a policy layer, not a kernel object: it does not allocate ports.
 */

export type SessionRole = "foreground" | "background" | "daemon";

export interface Session {
  readonly id: number;
  readonly name: string;
  readonly role: SessionRole;
  readonly pid: number;
  readonly ports: ReadonlySet<number>;
  readonly services: ReadonlySet<string>;
  readonly createdAt: number;
}

export interface SessionOptions {
  readonly name: string;
  readonly role: SessionRole;
  readonly pid: number;
  readonly services?: readonly string[];
  readonly now?: () => number;
  /** Called exactly once when the session is torn down. */
  readonly onTeardown?: (session: Session) => void;
}

export interface SessionManagerOptions {
  readonly now?: () => number;
}

export class SessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

const ROLES: ReadonlySet<string> = new Set(["foreground", "background", "daemon"]);

export class SessionManager {
  private readonly sessions = new Map<number, Session>();
  private readonly names = new Map<string, number>();
  private readonly ports = new Map<number, Set<number>>();
  private readonly services = new Map<number, Set<string>>();
  private readonly onTeardown: SessionOptions["onTeardown"];
  private readonly now: () => number;
  private nextId = 1;

  constructor(options: SessionManagerOptions & { onTeardown?: SessionOptions["onTeardown"] } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.onTeardown = options.onTeardown;
  }

  create(options: SessionOptions): Session {
    if (!ROLES.has(options.role)) {
      throw new SessionError("bad_role", `unknown session role ${options.role}`);
    }
    if (options.name.length === 0) {
      throw new SessionError("bad_name", "session name cannot be empty");
    }
    if (this.names.has(options.name)) {
      throw new SessionError("duplicate_name", `session ${options.name} already exists`);
    }
    if (
      options.role === "foreground" &&
      [...this.sessions.values()].some((session) => session.role === "foreground")
    ) {
      throw new SessionError("foreground_conflict", "only one foreground session is allowed");
    }
    const id = this.nextId++;
    const ports = new Set<number>();
    const services = new Set(options.services ?? []);
    this.ports.set(id, ports);
    this.services.set(id, services);
    this.names.set(options.name, id);
    const session: Session = {
      id,
      name: options.name,
      role: options.role,
      pid: options.pid,
      ports,
      services,
      createdAt: (options.now ?? this.now)(),
    };
    this.sessions.set(id, session);
    return session;
  }

  bindPort(sessionId: number, portId: number): void {
    this.require(sessionId);
    this.ports.get(sessionId)!.add(portId);
  }

  bindService(sessionId: number, service: string): void {
    this.require(sessionId);
    this.services.get(sessionId)!.add(service);
  }

  get(sessionId: number): Session | undefined {
    return this.sessions.get(sessionId);
  }

  find(name: string): Session | undefined {
    const id = this.names.get(name);
    return id === undefined ? undefined : this.sessions.get(id);
  }

  list(): readonly Session[] {
    return [...this.sessions.values()];
  }

  /** Idempotent teardown; the callback runs only on the first call. */
  teardown(sessionId: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    this.names.delete(session.name);
    this.ports.delete(sessionId);
    this.services.delete(sessionId);
    this.onTeardown?.(session);
    return true;
  }

  teardownAll(): number {
    let count = 0;
    for (const id of [...this.sessions.keys()]) if (this.teardown(id)) count += 1;
    return count;
  }

  private require(sessionId: number): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionError("unknown_session", `session ${sessionId} does not exist`);
    return session;
  }
}
