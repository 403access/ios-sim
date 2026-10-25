/**
 * Bootstrap service registry over MIG-lite.
 *
 * The protocol is a small, documented subset of `bootstrap_look_up` semantics:
 * lookup returns a send right name in the caller's namespace; register accepts
 * a port name the caller already owns with receive rights; list enumerates
 * names. It is not Apple's MIG bootstrap protocol, but it exercises the same
 * capability flow (request → right transfer → reply).
 */

import { MachError } from "../errors.js";
import {
  KERN_INVALID_ARGUMENT,
  KERN_INVALID_RIGHT,
  KERN_SUCCESS,
  MACH_PORT_NULL,
  type MachKernel,
} from "./kernel.js";
import {
  MigReader,
  MigWriter,
  MIG_BOOTSTRAP_LIST,
  MIG_BOOTSTRAP_LOOKUP,
  MIG_BOOTSTRAP_REGISTER,
  MIG_BOOTSTRAP_SUBSYSTEM,
} from "./message.js";
import { MigClient } from "./mig.js";
import type { MachTask } from "./kernel.js";

export const BOOTSTRAP_SUBSYSTEM = MIG_BOOTSTRAP_SUBSYSTEM;
export const BOOTSTRAP_LOOKUP = MIG_BOOTSTRAP_LOOKUP;
export const BOOTSTRAP_REGISTER = MIG_BOOTSTRAP_REGISTER;
export const BOOTSTRAP_LIST = MIG_BOOTSTRAP_LIST;

export interface BootstrapLookupResult {
  readonly status: number;
  readonly portName: number;
}

export class BootstrapServer {
  constructor(private readonly kernel: MachKernel) {}

  listen(): this {
    this.kernel.setPortHandlerById(this.kernel.bootstrapPort, (message, reply) => {
      const routine = message.header.id - BOOTSTRAP_SUBSYSTEM;
      const writer = new MigWriter();
      try {
        if (!message.senderTask)
          throw new MachError("no_sender", "bootstrap request has no sender task");
        if (routine === BOOTSTRAP_LOOKUP) {
          const service = new MigReader(message.body).string();
          const name = this.kernel.lookupService(message.senderTask, service);
          writer.u32(KERN_SUCCESS).u32(name);
        } else if (routine === BOOTSTRAP_REGISTER) {
          const reader = new MigReader(message.body);
          const service = reader.string();
          const portName = reader.u32();
          const right = this.kernel.lookupRight(message.senderTask, portName);
          if (!right || !right.kinds.has("receive")) {
            writer.u32(KERN_INVALID_RIGHT);
          } else {
            this.kernel.registerService(service, right.portId);
            writer.u32(KERN_SUCCESS);
          }
        } else if (routine === BOOTSTRAP_LIST) {
          const names = this.kernel.listServices();
          writer.u32(KERN_SUCCESS).u32(names.length);
          for (const name of names) writer.string(name);
        } else {
          writer.u32(KERN_INVALID_ARGUMENT);
        }
      } catch {
        writer.u32(KERN_INVALID_ARGUMENT);
      }
      reply(writer.toUint8Array(), { id: message.header.id });
    });
    return this;
  }
}

export class BootstrapClient {
  private readonly mig: MigClient;

  constructor(
    kernel: MachKernel,
    private readonly task: MachTask,
  ) {
    this.mig = new MigClient(kernel, task, BOOTSTRAP_SUBSYSTEM);
  }

  lookup(service: string): BootstrapLookupResult {
    const result = this.mig.call(
      2,
      BOOTSTRAP_LOOKUP,
      new MigWriter().string(service).toUint8Array(),
    );
    if (result.status !== KERN_SUCCESS || result.body.length < 4) {
      return { status: result.status, portName: MACH_PORT_NULL };
    }
    const reader = new MigReader(result.body);
    return { status: KERN_SUCCESS, portName: reader.u32() };
  }

  register(service: string, portName: number): number {
    const body = new MigWriter().string(service).u32(portName).toUint8Array();
    return this.mig.call(2, BOOTSTRAP_REGISTER, body).status;
  }

  list(): string[] {
    const result = this.mig.call(2, BOOTSTRAP_LIST);
    if (result.status !== KERN_SUCCESS) return [];
    const reader = new MigReader(result.body);
    const count = reader.u32();
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) names.push(reader.string());
    return names;
  }
}
