/**
 * Request/reply XPC-style connection over Mach messages.
 *
 * The transport is synchronous by design: the Mach kernel prototype has no
 * scheduler, so a server handler runs while the client sends and its reply is
 * queued immediately. That is enough to test the contract and keeps the layer
 * deterministic.
 */

import { XpcError } from "../errors.js";
import {
  KERN_RECEIVE_TIMED_OUT,
  KERN_SUCCESS,
  MACH_MSG_TYPE_COPY_SEND,
  MACH_MSGH_BITS,
  MACH_PORT_NULL,
  type MachKernel,
  type MachTask,
} from "../mach/kernel.js";
import { decodeMachMessage, encodeMachMessage } from "../mach/message.js";
import { decodeXpcValue, encodeXpcValue, type XpcValue, XPC_VERSION } from "./codec.js";

export const XPC_ENVELOPE_MAGIC = 0x5845_4e31; // "XEN1"
export const XPC_MESSAGE_ID = 0x5844_5001; // "XDP\x01"

export type XpcMessageKind = "request" | "reply" | "event";

export interface XpcEnvelope {
  readonly version: number;
  readonly id: number;
  readonly kind: XpcMessageKind;
  readonly payload: XpcValue;
}

export interface XpcRequestContext {
  readonly id: number;
  readonly senderPid: number | null;
}

export type XpcHandler = (payload: XpcValue, context: XpcRequestContext) => XpcValue | undefined;

const KINDS: Record<XpcMessageKind, number> = { request: 0, reply: 1, event: 2 };

export function encodeXpcEnvelope(envelope: XpcEnvelope): Uint8Array {
  const payload = encodeXpcValue(envelope.payload);
  const bytes = new Uint8Array(20 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, XPC_ENVELOPE_MAGIC, true);
  view.setUint16(4, envelope.version, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, envelope.id, true);
  view.setUint8(12, KINDS[envelope.kind]);
  view.setUint8(13, 0);
  view.setUint16(14, 0, true);
  view.setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

export function decodeXpcEnvelope(bytes: Uint8Array): XpcEnvelope {
  if (bytes.length < 20)
    throw new XpcError("xpc_truncated", "XPC envelope is shorter than its header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== XPC_ENVELOPE_MAGIC)
    throw new XpcError("xpc_bad_magic", "XPC envelope magic is wrong");
  const version = view.getUint16(4, true);
  if (version !== XPC_VERSION)
    throw new XpcError("xpc_bad_version", `unsupported XPC version ${version}`);
  const id = view.getUint32(8, true);
  const kindCode = view.getUint8(12);
  const kind = (Object.entries(KINDS) as Array<[XpcMessageKind, number]>).find(
    ([, code]) => code === kindCode,
  )?.[0];
  if (!kind) throw new XpcError("xpc_bad_kind", `unknown XPC message kind ${kindCode}`);
  const length = view.getUint32(16, true);
  if (20 + length !== bytes.length) {
    throw new XpcError(
      "xpc_bad_length",
      `XPC payload length ${length} does not match envelope ${bytes.length - 20}`,
    );
  }
  return { version, id, kind, payload: decodeXpcValue(bytes.subarray(20)) };
}

export class XpcServer {
  private handler: XpcHandler | null = null;

  constructor(
    private readonly kernel: MachKernel,
    private readonly task: MachTask,
    private readonly portName: number,
  ) {}

  onRequest(handler: XpcHandler): this {
    this.handler = handler;
    this.kernel.setPortHandler(this.task, this.portName, (message, reply) => {
      if (message.header.id !== XPC_MESSAGE_ID) return;
      if (!this.handler) return;
      let envelope: XpcEnvelope;
      try {
        envelope = decodeXpcEnvelope(message.body);
      } catch {
        return;
      }
      if (envelope.kind !== "request") return;
      let payload: XpcValue | undefined;
      try {
        payload = this.handler(envelope.payload, {
          id: envelope.id,
          senderPid: message.senderTask?.pid ?? null,
        });
      } catch (error) {
        payload = { $error: error instanceof Error ? error.message : String(error) };
      }
      if (payload === undefined || message.header.localPort === MACH_PORT_NULL) return;
      reply(encodeXpcEnvelope({ version: XPC_VERSION, id: envelope.id, kind: "reply", payload }), {
        id: XPC_MESSAGE_ID,
      });
    });
    return this;
  }
}

export class XpcConnection {
  private nextId = 1;

  constructor(
    private readonly kernel: MachKernel,
    private readonly task: MachTask,
    private readonly portName: number,
  ) {}

  call(payload: XpcValue): XpcValue {
    if (this.portName === MACH_PORT_NULL)
      throw new XpcError("xpc_no_service", "XPC service port is null");
    const id = this.nextId++;
    const replyPort = this.kernel.machReplyPort(this.task);
    const body = encodeXpcEnvelope({ version: XPC_VERSION, id, kind: "request", payload });
    const message = decodeMachMessage(
      encodeMachMessage(
        {
          bits: MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_COPY_SEND),
          size: body.length + 24,
          remotePort: this.portName,
          localPort: replyPort,
          voucherPort: 0,
          id: XPC_MESSAGE_ID,
        },
        body,
      ),
    );
    const sent = this.kernel.send(this.task, message);
    if (sent !== KERN_SUCCESS)
      throw new XpcError("xpc_send_failed", `XPC send failed with 0x${sent.toString(16)}`);
    const received = this.kernel.receive(this.task, replyPort);
    if (received.result === KERN_RECEIVE_TIMED_OUT || !received.message) {
      throw new XpcError("xpc_timeout", "XPC service did not reply");
    }
    if (received.result !== KERN_SUCCESS) {
      throw new XpcError(
        "xpc_receive_failed",
        `XPC receive failed with 0x${received.result.toString(16)}`,
      );
    }
    const envelope = decodeXpcEnvelope(received.message.body);
    if (envelope.id !== id)
      throw new XpcError("xpc_id_mismatch", `reply id ${envelope.id} does not match ${id}`);
    if (envelope.kind !== "reply")
      throw new XpcError("xpc_bad_reply", `expected reply, got ${envelope.kind}`);
    return envelope.payload;
  }

  sendOneWay(payload: XpcValue): number {
    const body = encodeXpcEnvelope({
      version: XPC_VERSION,
      id: this.nextId++,
      kind: "event",
      payload,
    });
    return this.kernel.send(
      this.task,
      decodeMachMessage(
        encodeMachMessage(
          {
            bits: MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_PORT_NULL),
            size: body.length + 24,
            remotePort: this.portName,
            localPort: 0,
            voucherPort: 0,
            id: XPC_MESSAGE_ID,
          },
          body,
        ),
      ),
    );
  }
}

/** Create a named XPC service owned by `task` and register it with bootstrap. */
export function createXpcService(
  kernel: MachKernel,
  task: MachTask,
  name: string,
): { portName: number; portId: number; server: XpcServer } {
  const { name: portName, portId } = kernel.insertReceiveRight(task, `service:${name}`);
  kernel.registerService(name, portId);
  return { portName, portId, server: new XpcServer(kernel, task, portName) };
}
