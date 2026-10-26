/**
 * User-space Mach port model.
 *
 * This is a *semantic* implementation of the parts of Mach IPC the simulator
 * needs: task-local port names, send/receive/send-once rights, message queues,
 * reply ports, bootstrap service registration, and MIG-like dispatch. It does
 * not implement Mach's kernel ABI, port sets, memory descriptors, or
 * notifications; those are listed as gaps in the native track documentation.
 */

import { MachError } from "../errors.js";

export const MACH_PORT_NULL = 0;
export const MACH_PORT_DEAD = 0xffff_ffff;
export const TASK_SELF_PORT_NAME = 1;
export const BOOTSTRAP_PORT_NAME = 2;

export const MACH_MSG_TYPE_COPY_SEND = 19;
export const MACH_MSG_TYPE_MAKE_SEND = 20;
export const MACH_MSG_TYPE_MAKE_SEND_ONCE = 21;

export const MACH_MSGH_BITS_REMOTE_MASK = 0x0000_00ff;
export const MACH_MSGH_BITS_LOCAL_MASK = 0x0000_ff00;
export const MACH_MSGH_BITS_DESCRIPTOR_MASK = 0x8000_0000;

export function MACH_MSGH_BITS(remote: number, local: number): number {
  return (remote & 0xff) | ((local & 0xff) << 8);
}

export const MACH_SEND_MSG = 0x0000_0001;
export const MACH_RCV_MSG = 0x0000_0002;
export const MACH_SEND_TIMEOUT = 0x0000_0010;
export const MACH_SEND_INTERRUPT = 0x0000_0040;
export const MACH_RCV_TIMEOUT = 0x0000_0100;
export const MACH_RCV_INTERRUPT = 0x0000_1000;
export const MACH_RCV_LARGE = 0x0000_0400;

export const KERN_SUCCESS = 0;
export const KERN_INVALID_ARGUMENT = 0x1000_0004;
export const KERN_INVALID_NAME = 0x1000_000f;
export const KERN_INVALID_RIGHT = 0x1000_0012;
export const KERN_INVALID_DESTINATION = 0x1000_0011;
export const KERN_NO_SPACE = 0x1000_0005;
export const KERN_RESOURCE_SHORTAGE = 0x1000_000d;
export const KERN_RECEIVE_TIMED_OUT = 0x1000_4002;
export const KERN_MESSAGE_TOO_LARGE = 0x1000_4003;
export const KERN_ALREADY_EXISTS = 0x1000_4004;

export const MACH_PORT_RIGHT_SEND = 1;
export const MACH_PORT_RIGHT_RECEIVE = 2;
export const MACH_PORT_RIGHT_SEND_ONCE = 4;

export interface MachMessageHeader {
  readonly bits: number;
  readonly size: number;
  readonly remotePort: number;
  readonly localPort: number;
  readonly voucherPort: number;
  readonly id: number;
}

export interface MachMessage {
  readonly header: MachMessageHeader;
  readonly body: Uint8Array;
  /** Present for in-process port handlers; absent for queued messages. */
  readonly senderTask?: MachTask;
}

export type PortRightKind = "send" | "receive" | "send-once";

interface NameEntry {
  readonly portId: number;
  readonly kinds: Set<PortRightKind>;
}

export interface MachTask {
  readonly pid: number;
  readonly names: Map<number, NameEntry>;
  nextName: number;
}

export interface ReplyFunction {
  (body: Uint8Array, options?: { id?: number }): void;
}

export type PortHandler = (message: MachMessage, reply: ReplyFunction) => void;

interface Envelope {
  readonly id: number;
  readonly body: Uint8Array;
  readonly sender: MachTask;
  readonly senderTaskName: number;
  readonly replyPortId: number | null;
}

interface MachPort {
  readonly id: number;
  label: string;
  receiveOwner: number | null;
  handler: PortHandler | null;
  readonly queue: Envelope[];
  queueLimit: number;
}

export interface ReceivedMessage extends MachMessage {
  /** Name the receiver can use to send a reply, or 0 when no reply port was supplied. */
  readonly replyPortName: number;
}

export interface MachKernelOptions {
  readonly maxMessageBytes?: number;
  readonly maxQueueDepth?: number;
}

const MAX_NAME = 0x00ff_ffff;
const DEFAULT_MAX_MESSAGE = 64 * 1024;
const DEFAULT_QUEUE_DEPTH = 1024;

export class MachKernel {
  private readonly tasks = new Map<number, MachTask>();
  private readonly ports = new Map<number, MachPort>();
  private readonly services = new Map<string, number>();
  private nextPortId = 1;
  private readonly maxMessageBytes: number;
  private readonly maxQueueDepth: number;
  readonly bootstrapPort: number;
  readonly hostPort: number;
  private readonly hostNames = new Map<number, number>();

  constructor(options: MachKernelOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE;
    this.maxQueueDepth = options.maxQueueDepth ?? DEFAULT_QUEUE_DEPTH;
    this.hostPort = this.createPort("host", null).id;
    this.bootstrapPort = this.createPort("bootstrap", null).id;
  }

  createTask(pid: number): MachTask {
    if (this.tasks.has(pid))
      throw new MachError("duplicate_task", `task pid ${pid} already exists`);
    const task: MachTask = { pid, names: new Map(), nextName: 1 };
    this.tasks.set(pid, task);

    // A task port with receive and send rights, mirroring the special ports a
    // real process gets from the kernel before libSystem starts.
    const taskPort = this.createPort(`task:${pid}`, pid);
    const taskName = this.allocateName(task, taskPort.id, ["receive", "send"]);
    if (taskName !== TASK_SELF_PORT_NAME) {
      throw new MachError(
        "special_port_conflict",
        `task port name ${taskName} is not reserved name ${TASK_SELF_PORT_NAME}`,
      );
    }
    const bootstrapName = this.allocateName(task, this.bootstrapPort, ["send"]);
    if (bootstrapName !== BOOTSTRAP_PORT_NAME) {
      throw new MachError(
        "special_port_conflict",
        `bootstrap name ${bootstrapName} is not reserved name ${BOOTSTRAP_PORT_NAME}`,
      );
    }
    return task;
  }

  /** Object counts for leak checks and diagnostics. */
  stats(): {
    tasks: number;
    ports: number;
    queuedMessages: number;
    services: number;
    hostNames: number;
  } {
    let queuedMessages = 0;
    for (const port of this.ports.values()) queuedMessages += port.queue.length;
    return {
      tasks: this.tasks.size,
      ports: this.ports.size,
      queuedMessages,
      services: this.services.size,
      hostNames: this.hostNames.size,
    };
  }

  destroyTask(task: MachTask): void {
    for (const [name, entry] of task.names) {
      this.dropRight(task, name, entry);
    }
    task.names.clear();
    this.tasks.delete(task.pid);
    this.hostNames.delete(task.pid);
  }

  task(pid: number): MachTask | undefined {
    return this.tasks.get(pid);
  }

  private createPort(label: string, owner: number | null): MachPort {
    const port: MachPort = {
      id: this.nextPortId++,
      label,
      receiveOwner: owner,
      handler: null,
      queue: [],
      queueLimit: this.maxQueueDepth,
    };
    this.ports.set(port.id, port);
    return port;
  }

  private port(id: number): MachPort {
    const port = this.ports.get(id);
    if (!port) throw new MachError("unknown_port", `port ${id} does not exist`);
    return port;
  }

  private allocateName(task: MachTask, portId: number, kinds: PortRightKind[]): number {
    while (task.names.has(task.nextName)) task.nextName += 1;
    if (task.nextName > MAX_NAME)
      throw new MachError("name_space_exhausted", `task ${task.pid} exhausted its port name space`);
    const name = task.nextName++;
    task.names.set(name, { portId, kinds: new Set(kinds) });
    if (kinds.includes("receive")) {
      const port = this.port(portId);
      port.receiveOwner = task.pid;
    }
    return name;
  }

  insertSendRight(task: MachTask, portId: number): number {
    this.port(portId);
    return this.allocateName(task, portId, ["send"]);
  }

  insertReceiveRight(task: MachTask, label: string): { name: number; portId: number } {
    const port = this.createPort(label, task.pid);
    const name = this.allocateName(task, port.id, ["receive"]);
    return { name, portId: port.id };
  }

  /** Create a reply port: a receive right plus a send right under one name. */
  machReplyPort(task: MachTask): number {
    const port = this.createPort(`reply:${task.pid}`, task.pid);
    return this.allocateName(task, port.id, ["receive", "send"]);
  }

  taskSelf(task: MachTask): number {
    return TASK_SELF_PORT_NAME;
  }

  threadSelf(task: MachTask): number {
    // One thread per task in this prototype; the task port doubles as the
    // thread port. The value is stable and non-zero.
    return TASK_SELF_PORT_NAME;
  }

  hostSelf(task: MachTask): number {
    const existing = this.hostNames.get(task.pid);
    if (existing !== undefined) return existing;
    const name = this.insertSendRight(task, this.hostPort);
    this.hostNames.set(task.pid, name);
    return name;
  }

  lookupRight(task: MachTask, name: number): { portId: number; kinds: Set<PortRightKind> } | null {
    const entry = task.names.get(name);
    if (!entry) return null;
    return { portId: entry.portId, kinds: entry.kinds };
  }

  /**
   * Send a raw message. `message.size` must include the 24-byte header. The
   * destination is the remote-port name in the sender's namespace.
   */
  send(task: MachTask, message: MachMessage): number {
    const header = message.header;
    if (header.size < 24 || header.size > this.maxMessageBytes) {
      return KERN_MESSAGE_TOO_LARGE;
    }
    if (header.size !== message.body.length + 24) return KERN_INVALID_ARGUMENT;
    const destination = task.names.get(header.remotePort);
    if (!destination) return KERN_INVALID_DESTINATION;
    if (!destination.kinds.has("send") && !destination.kinds.has("send-once")) {
      return KERN_INVALID_RIGHT;
    }

    let replyPortId: number | null = null;
    if (header.localPort !== MACH_PORT_NULL) {
      const reply = task.names.get(header.localPort);
      if (!reply || (!reply.kinds.has("send") && !reply.kinds.has("send-once"))) {
        return KERN_INVALID_RIGHT;
      }
      replyPortId = reply.portId;
    }

    if (destination.kinds.has("send-once")) {
      this.dropRight(task, header.remotePort, destination);
      task.names.delete(header.remotePort);
    }

    const envelope: Envelope = {
      id: header.id,
      body: message.body.slice(),
      sender: task,
      senderTaskName: header.localPort,
      replyPortId,
    };
    const port = this.port(destination.portId);

    if (port.handler) {
      const received: MachMessage = {
        header: {
          bits: 0,
          size: header.size,
          remotePort: header.remotePort,
          localPort: header.localPort,
          voucherPort: 0,
          id: header.id,
        },
        body: envelope.body,
        senderTask: task,
      };
      port.handler(received, (body, options) => {
        if (!replyPortId) return;
        this.enqueueReply(task, replyPortId, options?.id ?? header.id, body);
      });
      return KERN_SUCCESS;
    }

    if (port.queue.length >= port.queueLimit) return KERN_RESOURCE_SHORTAGE;
    port.queue.push(envelope);
    return KERN_SUCCESS;
  }

  private enqueueReply(
    serverTask: MachTask,
    replyPortId: number,
    id: number,
    body: Uint8Array,
  ): void {
    const port = this.port(replyPortId);
    if (port.queue.length >= port.queueLimit) {
      throw new MachError("queue_full", `reply port ${replyPortId} is full`);
    }
    port.queue.push({
      id,
      body: body.slice(),
      sender: serverTask,
      senderTaskName: MACH_PORT_NULL,
      replyPortId: null,
    });
  }

  /**
   * Dequeue one message. No blocking: a thread model is out of scope, so an
   * empty queue maps to `KERN_RECEIVE_TIMED_OUT` even for an infinite timeout.
   */
  receive(task: MachTask, name: number): { result: number; message?: ReceivedMessage } {
    const entry = task.names.get(name);
    if (!entry) return { result: KERN_INVALID_NAME };
    if (!entry.kinds.has("receive")) return { result: KERN_INVALID_RIGHT };
    const port = this.port(entry.portId);
    const envelope = port.queue.shift();
    if (!envelope) return { result: KERN_RECEIVE_TIMED_OUT };
    let replyPortName = 0;
    if (envelope.replyPortId !== null) {
      replyPortName = this.insertSendRight(task, envelope.replyPortId);
    }
    return {
      result: KERN_SUCCESS,
      message: {
        header: {
          bits: 0,
          size: envelope.body.length + 24,
          remotePort: name,
          localPort: replyPortName,
          voucherPort: 0,
          id: envelope.id,
        },
        body: envelope.body,
        replyPortName,
        senderTask: envelope.sender,
      },
    };
  }

  setPortHandler(task: MachTask, name: number, handler: PortHandler): void {
    const entry = task.names.get(name);
    if (!entry || !entry.kinds.has("receive")) {
      throw new MachError("invalid_port", `task ${task.pid} has no receive right named ${name}`);
    }
    this.port(entry.portId).handler = handler;
  }

  setPortHandlerById(portId: number, handler: PortHandler): void {
    this.port(portId).handler = handler;
  }

  portLabel(portId: number): string {
    return this.port(portId).label;
  }

  registerService(name: string, portId: number): void {
    if (!isServiceName(name))
      throw new MachError("invalid_service_name", `service name ${name} is not valid`);
    this.port(portId);
    if (this.services.has(name))
      throw new MachError("duplicate_service", `service ${name} is already registered`);
    this.services.set(name, portId);
  }

  unregisterService(name: string): boolean {
    return this.services.delete(name);
  }

  lookupService(task: MachTask, name: string): number {
    const portId = this.services.get(name);
    if (portId === undefined) return MACH_PORT_NULL;
    return this.insertSendRight(task, portId);
  }

  listServices(): readonly string[] {
    return [...this.services.keys()].sort();
  }

  portQueueDepth(portId: number): number {
    return this.port(portId).queue.length;
  }

  private dropRight(task: MachTask, _name: number, entry: NameEntry): void {
    if (!entry.kinds.has("receive")) return;
    const port = this.port(entry.portId);
    if (port.receiveOwner === task.pid) {
      port.receiveOwner = null;
      port.handler = null;
      port.queue.length = 0;
      for (const [service, portId] of this.services) {
        if (portId === entry.portId) this.services.delete(service);
      }
      // A receive port has no owner once the task dies. Removing it prevents
      // unbounded growth across task create/destroy cycles (QA-006).
      this.ports.delete(entry.portId);
    }
  }
}

export function isServiceName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name) && !name.includes("..");
}
