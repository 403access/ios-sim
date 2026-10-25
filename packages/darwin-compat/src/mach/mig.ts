/**
 * A tiny MIG-style client/server built on {@link MachKernel}.
 *
 * Replies carry a 32-bit status word followed by routine-specific payload.
 * This keeps error handling explicit and avoids inventing Apple's generated
 * MIG layout, which this layer does not claim to be wire-compatible with.
 */

import { MachError } from "../errors.js";
import {
  KERN_INVALID_ARGUMENT,
  KERN_RECEIVE_TIMED_OUT,
  KERN_SUCCESS,
  MACH_MSG_TYPE_COPY_SEND,
  MACH_MSGH_BITS,
  MACH_PORT_NULL,
  MACH_RCV_MSG,
  MACH_SEND_MSG,
  type MachKernel,
  type MachMessage,
  type MachTask,
} from "./kernel.js";
import { decodeMachMessage, encodeMachMessage, MigReader, MigWriter } from "./message.js";

export interface MigCallResult {
  readonly status: number;
  readonly body: Uint8Array;
}

export type MigHandler = (reader: MigReader, message: MachMessage) => Uint8Array | void;

export class MigServer {
  private readonly handlers = new Map<number, MigHandler>();

  constructor(
    private readonly kernel: MachKernel,
    private readonly task: MachTask,
    private readonly portName: number,
    readonly subsystem: number,
  ) {}

  register(routine: number, handler: MigHandler): this {
    if (routine < 0 || routine > 0xffff)
      throw new MachError("bad_mig_routine", `routine ${routine} is outside 0..65535`);
    if (this.handlers.has(routine))
      throw new MachError("duplicate_mig_routine", `routine ${routine} is already registered`);
    this.handlers.set(routine, handler);
    return this;
  }

  listen(): this {
    this.kernel.setPortHandler(this.task, this.portName, (message, reply) => {
      const routine = message.header.id - this.subsystem;
      const writer = new MigWriter();
      const handler = this.handlers.get(routine);
      if (!handler) {
        writer.u32(KERN_INVALID_ARGUMENT);
        reply(writer.toUint8Array(), { id: message.header.id });
        return;
      }
      try {
        const body = handler(new MigReader(message.body), message) ?? new Uint8Array();
        const response = new MigWriter();
        response.u32(KERN_SUCCESS);
        response.raw(body);
        reply(response.toUint8Array(), { id: message.header.id });
      } catch {
        const response = new MigWriter();
        response.u32(KERN_INVALID_ARGUMENT);
        reply(response.toUint8Array(), { id: message.header.id });
      }
    });
    return this;
  }
}

export class MigClient {
  constructor(
    private readonly kernel: MachKernel,
    private readonly task: MachTask,
    readonly subsystem: number,
  ) {}

  call(portName: number, routine: number, body: Uint8Array = new Uint8Array()): MigCallResult {
    if (portName === MACH_PORT_NULL)
      throw new MachError("invalid_port", "cannot call a MACH_PORT_NULL service");
    const replyPort = this.kernel.machReplyPort(this.task);
    const request = encodeMachMessage(
      {
        bits: MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_COPY_SEND),
        size: body.length + 24,
        remotePort: portName,
        localPort: replyPort,
        voucherPort: 0,
        id: this.subsystem + routine,
      },
      body,
    );
    const message = decodeMachMessage(request);
    let sent = this.kernel.send(this.task, message);
    if (sent !== KERN_SUCCESS) return { status: sent, body: new Uint8Array() };

    const received = this.kernel.receive(this.task, replyPort);
    if (received.result !== KERN_SUCCESS || !received.message) {
      return { status: received.result || KERN_RECEIVE_TIMED_OUT, body: new Uint8Array() };
    }
    const reader = new MigReader(received.message.body);
    const status = reader.u32();
    return { status, body: received.message.body.subarray(reader.position) };
  }

  sendOneWay(portName: number, routine: number, body: Uint8Array = new Uint8Array()): number {
    const request = encodeMachMessage(
      {
        bits: MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_PORT_NULL),
        size: body.length + 24,
        remotePort: portName,
        localPort: 0,
        voucherPort: 0,
        id: this.subsystem + routine,
      },
      body,
    );
    return this.kernel.send(this.task, decodeMachMessage(request));
  }
}

export const MIG_OPTIONS = MACH_SEND_MSG | MACH_RCV_MSG;
