import { describe, expect, it } from "vitest";
import { buildExitProgram } from "../testing/fixtures.js";
import { VirtualMemory } from "../dyld/vm.js";
import { GuestScheduler, type SchedulerRunOptions } from "./scheduler.js";
import { ProcessTable } from "./process-table.js";
import { SIGTERM } from "./signals.js";

function makeParent(table: ProcessTable, status = 42) {
  const memory = new VirtualMemory();
  const scheduler = new GuestScheduler(memory);
  const parent = table.spawn(memory, scheduler);
  table.exec(parent.pid, { bytes: buildExitProgram(status).bytes, path: "/exit" });
  return parent;
}

function exitHandler(): SchedulerRunOptions["syscallHandler"] {
  return (thread, number, cpu) => {
    if (number === 1) {
      thread.cpu.exitStatus = Number(cpu.readRegister(0)) & 0xff;
      return { value: 0, halt: true };
    }
    return { value: 0 };
  };
}

describe("ProcessTable", () => {
  it("forks an address space and reaps the child status", () => {
    const table = new ProcessTable();
    const parent = makeParent(table, 42);
    parent.memory.mapFixed(0x5000n, 0x1000, { tag: "data", protection: 3 });
    parent.memory.write(0x5000n, 4, 7n);

    const child = table.fork(parent.pid);
    expect(child.pid).not.toBe(parent.pid);
    expect(child.ppid).toBe(parent.pid);
    expect(child.pgid).toBe(parent.pgid);
    expect(child.memory.read(0x5000n, 4)).toBe(7n);

    child.memory.write(0x5000n, 4, 9n);
    expect(parent.memory.read(0x5000n, 4)).toBe(7n);

    const run = table.run(child.pid, { maxInstructions: 10_000, syscallHandler: exitHandler() });
    expect(run.status).toBe(42);
    expect(table.get(child.pid)?.state).toBe("exited");
    expect(table.waitpid(parent.pid, child.pid)).toEqual({ pid: child.pid, status: 42 });
    expect(table.get(child.pid)).toBeUndefined();
  });

  it("blocks a waitpid caller and wakes it on child exit", () => {
    const table = new ProcessTable();
    const parent = makeParent(table, 0);
    const child = table.fork(parent.pid);
    const parentThread = parent.scheduler.listThreads()[0]!;

    expect(table.waitpid(parent.pid, child.pid, parentThread)).toBeNull();
    expect(parentThread.state).toBe("blocked");

    table.exit(child.pid, 5);
    expect(parentThread.state).toBe("runnable");
    expect(table.waitpid(parent.pid, child.pid)).toEqual({ pid: child.pid, status: 5 });
  });

  it("execs a replacement image in an existing process", () => {
    const table = new ProcessTable();
    const parent = makeParent(table, 42);
    table.exec(parent.pid, { bytes: buildExitProgram(7).bytes, path: "/replacement" });
    const result = table.run(parent.pid, {
      maxInstructions: 10_000,
      syscallHandler: exitHandler(),
    });
    expect(result.status).toBe(7);
  });

  it("kills a process group", () => {
    const table = new ProcessTable();
    const parent = makeParent(table, 0);
    const child = table.fork(parent.pid);
    table.setpgid(child.pid, parent.pgid);
    expect(table.getpgid(child.pid)).toBe(parent.pgid);

    expect(table.kill(-parent.pgid, SIGTERM)).toBeGreaterThan(0);
    expect(table.get(child.pid)?.state).toBe("exited");
    expect(table.get(child.pid)?.exitStatus).toBe(128 + SIGTERM);
  });
});
