/**
 * Bridge between guest threads and the Mach port model.
 *
 * A receive with no queued message parks the guest thread instead of faking a
 * timeout. A send to the same port wakes the waiter; the scheduler rewinds the
 * SVC and retries it. Deadlines are expired by the scheduler tick.
 *
 * This is the THR-003 integration for the TypeScript Mach model. The native
 * host has the same blocking primitive; wiring it into this bridge is the next
 * step after the semantics are proven.
 */

import {
  KERN_RECEIVE_TIMED_OUT,
  KERN_SUCCESS,
  type MachKernel,
  type MachTask,
  type ReceivedMessage,
} from "../mach/kernel.js";
import { decodeMachMessage, encodeMachMessage } from "../mach/message.js";
import type { GuestScheduler, GuestThread } from "./scheduler.js";

export const KERN_RECEIVE_INTERRUPTED = 0x1000_4005;

export interface BlockingReceiveResult {
  readonly status: number;
  readonly message?: ReceivedMessage;
  readonly blocked: boolean;
}

interface Waiter {
  readonly thread: GuestThread;
  readonly task: MachTask;
  readonly name: number;
  readonly deadline: number | null;
}

export class BlockingMachBridge {
  private readonly waiters = new Map<number, Waiter>();
  private readonly expired = new Set<number>();
  private readonly interrupted = new Set<number>();

  constructor(
    private readonly kernel: MachKernel,
    private readonly scheduler: GuestScheduler,
  ) {}

  receive(
    thread: GuestThread,
    task: MachTask,
    name: number,
    timeoutMs: number,
  ): BlockingReceiveResult {
    if (this.interrupted.has(thread.id)) {
      this.interrupted.delete(thread.id);
      return { status: KERN_RECEIVE_INTERRUPTED, blocked: false };
    }
    if (this.expired.has(thread.id)) {
      this.expired.delete(thread.id);
      return { status: KERN_RECEIVE_TIMED_OUT, blocked: false };
    }

    const existing = this.waiters.get(thread.id);
    if (existing !== undefined && existing.deadline !== null && Date.now() >= existing.deadline) {
      this.waiters.delete(thread.id);
      return { status: KERN_RECEIVE_TIMED_OUT, blocked: false };
    }

    const received = this.kernel.receive(task, name);
    if (received.result !== KERN_RECEIVE_TIMED_OUT) {
      this.waiters.delete(thread.id);
      return { status: received.result, message: received.message, blocked: false };
    }
    if (timeoutMs === 0) {
      return { status: KERN_RECEIVE_TIMED_OUT, blocked: false };
    }

    const deadline =
      existing?.deadline ?? (timeoutMs === 0xffff_ffff ? null : Date.now() + timeoutMs);
    this.waiters.set(thread.id, { thread, task, name, deadline });
    this.scheduler.block(thread, `mach-receive:${name}`);
    return { status: KERN_RECEIVE_TIMED_OUT, blocked: true };
  }

  send(task: MachTask, remote: number, local: number, messageId: number, body: Uint8Array): number {
    const destination = this.kernel.lookupRight(task, remote);
    const message = decodeMachMessage(
      encodeMachMessage(
        {
          bits: 0,
          size: body.length + 24,
          remotePort: remote,
          localPort: local,
          voucherPort: 0,
          id: messageId,
        },
        body,
      ),
    );
    const status = this.kernel.send(task, message);
    if (status === KERN_SUCCESS && destination) {
      this.wakePort(destination.portId);
    }
    return status;
  }

  /** Expire any waiter whose deadline has passed and make it runnable. */
  tick(now = Date.now()): void {
    for (const [threadId, waiter] of this.waiters) {
      if (waiter.deadline !== null && waiter.deadline <= now) {
        this.waiters.delete(threadId);
        this.expired.add(threadId);
        this.scheduler.unblock(waiter.thread);
      }
    }
  }

  /** Wake one waiter with an interrupted status. */
  interrupt(thread: GuestThread): void {
    if (!this.waiters.has(thread.id)) {
      this.interrupted.add(thread.id);
      return;
    }
    this.waiters.delete(thread.id);
    this.interrupted.add(thread.id);
    this.scheduler.unblock(thread);
  }

  get waiterCount(): number {
    return this.waiters.size;
  }

  private wakePort(portId: number): void {
    for (const [threadId, waiter] of this.waiters) {
      const right = this.kernel.lookupRight(waiter.task, waiter.name);
      if (right?.portId !== portId) continue;
      this.waiters.delete(threadId);
      this.scheduler.unblock(waiter.thread);
    }
  }
}
