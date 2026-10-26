import { describe, expect, it } from "vitest";
import { addImm, adrp, ldrUnsigned, movz, strUnsigned, svc, words } from "../arm64/assembler.js";
import { VirtualMemory } from "../dyld/vm.js";
import { GuestScheduler } from "./scheduler.js";
import {
  GUEST_SIGACTION,
  GUEST_SIGNAL_RAISE,
  GUEST_SIGPROCMASK,
  GUEST_SIGRETURN,
  SIG_IGN,
  SIGTERM,
  SIGUSR1,
  SignalDispatcher,
  signalBit,
} from "./signals.js";

const CODE = 0n;
const HANDLER = 0x2000n;
const DATA = 0x3000n;

function handlerProgram(): Uint8Array {
  return words(
    movz(0, 42),
    adrp(9, Number(DATA), Number(HANDLER)),
    addImm(9, 9, Number(DATA) & 0xfff),
    strUnsigned(0, 9, 0, 2),
    movz(16, GUEST_SIGRETURN),
    svc(0x80),
  );
}

function mainProgram(options: {
  block: boolean;
  ignore: boolean;
  installHandler: boolean;
  signal: number;
}): Uint8Array {
  if (options.ignore) {
    return words(
      movz(0, options.signal),
      movz(1, 1), // SIG_IGN
      movz(16, GUEST_SIGACTION),
      svc(0x80),
      movz(0, options.signal),
      movz(16, GUEST_SIGNAL_RAISE),
      svc(0x80),
      movz(0, 7),
      movz(16, 1),
      svc(0x80),
    );
  }
  const instructions: number[] = [];
  if (options.installHandler) {
    instructions.push(
      movz(0, options.signal),
      movz(1, Number(HANDLER)),
      movz(16, GUEST_SIGACTION),
      svc(0x80),
    );
  }
  if (options.block) {
    instructions.push(
      movz(0, 0x2000, 16), // 1 << (SIGUSR1 - 1) = 0x20000000
      movz(16, GUEST_SIGPROCMASK),
      svc(0x80),
    );
  }
  instructions.push(movz(0, options.signal), movz(16, GUEST_SIGNAL_RAISE), svc(0x80));
  if (options.block) {
    instructions.push(movz(0, 0), movz(16, GUEST_SIGPROCMASK), svc(0x80));
  }
  instructions.push(
    adrp(9, Number(DATA), instructions.length * 4),
    addImm(9, 9, Number(DATA) & 0xfff),
    ldrUnsigned(0, 9, 0, 2),
    movz(16, 1),
    svc(0x80),
  );
  return words(...instructions);
}

function setup(options: {
  block?: boolean;
  ignore?: boolean;
  installHandler?: boolean;
  signal?: number;
}) {
  const memory = new VirtualMemory();
  memory.mapFixed(CODE, 0x1000, {
    bytes: mainProgram({
      block: options.block ?? false,
      ignore: options.ignore ?? false,
      installHandler: options.installHandler ?? true,
      signal: options.signal ?? SIGUSR1,
    }),
    tag: "text",
    protection: 7,
  });
  memory.mapFixed(HANDLER, 0x1000, { bytes: handlerProgram(), tag: "handler", protection: 7 });
  memory.mapFixed(DATA, 0x1000, { tag: "data", protection: 3 });
  const scheduler = new GuestScheduler(memory, { quantum: 4096 });
  const signals = new SignalDispatcher(scheduler);
  const stack = memory.allocate(0x2000, { tag: "stack" });
  const thread = scheduler.createThread({ entry: CODE, stackPointer: stack + 0x1ff0n });
  return { memory, scheduler, signals, thread };
}

function run(setupResult: ReturnType<typeof setup>) {
  return setupResult.scheduler.run({
    maxInstructions: 10_000,
    syscallHandler: (thread, number, cpu) => {
      if (number === GUEST_SIGACTION) {
        setupResult.signals.sigaction(thread, Number(cpu.readRegister(0)), cpu.readRegister(1));
        return { value: 0 };
      }
      if (number === GUEST_SIGNAL_RAISE) {
        setupResult.signals.raise(thread, Number(cpu.readRegister(0)));
        return { value: 0 };
      }
      if (number === GUEST_SIGPROCMASK) {
        setupResult.signals.sigprocmask(thread, Number(cpu.readRegister(0)));
        return { value: 0 };
      }
      if (number === GUEST_SIGRETURN) {
        setupResult.signals.sigreturn(thread);
        return { value: 0 };
      }
      if (number === 1) {
        thread.cpu.exitStatus = Number(cpu.readRegister(0)) & 0xff;
        return { value: 0, halt: true };
      }
      return { value: 0 };
    },
  });
}

describe("SignalDispatcher", () => {
  it("invokes a guest handler and restores the interrupted context", () => {
    const fixture = setup({});
    const result = run(fixture);
    expect(result.terminated).toBe(1);
    expect(fixture.thread.exitStatus).toBe(42);
    expect(fixture.memory.read(DATA, 4)).toBe(42n);
    expect(fixture.signals.pendingSignals(fixture.thread)).toEqual([]);
  });

  it("queues a blocked signal until the mask is cleared", () => {
    const fixture = setup({ block: true });
    const result = run(fixture);
    expect(result.terminated).toBe(1);
    expect(fixture.thread.exitStatus).toBe(42);
    expect(fixture.signals.blockedMask(fixture.thread)).toBe(0);
  });

  it("ignores a signal with SIG_IGN", () => {
    const fixture = setup({ ignore: true });
    const result = run(fixture);
    expect(result.terminated).toBe(1);
    expect(fixture.thread.exitStatus).toBe(7);
  });

  it("terminates the thread on a default-fatal signal", () => {
    const fixture = setup({ signal: SIGTERM, installHandler: false });
    const result = run(fixture);
    expect(result.terminated).toBe(1);
    expect(fixture.thread.exitStatus).toBe(128 + SIGTERM);
  });

  it("models SIGCHLD as pending and default-ignored", () => {
    const fixture = setup({});
    fixture.signals.sigprocmask(fixture.thread, signalBit(20));
    fixture.signals.notifyChildExit(fixture.thread);
    expect(fixture.signals.pendingSignals(fixture.thread)).toEqual([20]);
    fixture.signals.sigprocmask(fixture.thread, 0);
    expect(fixture.signals.pendingSignals(fixture.thread)).toEqual([]);
    expect(fixture.thread.state).toBe("runnable");
  });
});
