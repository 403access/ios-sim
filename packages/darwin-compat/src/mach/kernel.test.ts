import { describe, expect, it } from "vitest";
import {
  KERN_INVALID_RIGHT,
  KERN_RECEIVE_TIMED_OUT,
  KERN_RESOURCE_SHORTAGE,
  KERN_SUCCESS,
  MACH_MSG_TYPE_COPY_SEND,
  MACH_MSGH_BITS,
  MACH_PORT_NULL,
  MachKernel,
  isServiceName,
} from "./kernel.js";
import {
  encodeMachMessage,
  decodeMachMessage,
  MigClient,
  MigReader,
  MigServer,
  MigWriter,
} from "./index.js";
import { BootstrapClient, BootstrapServer } from "./bootstrap.js";

function send(
  kernel: MachKernel,
  task: ReturnType<MachKernel["createTask"]>,
  remote: number,
  local: number,
  body: number[],
  id = 1,
) {
  const bytes = encodeMachMessage(
    {
      bits: MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_COPY_SEND),
      size: body.length + 24,
      remotePort: remote,
      localPort: local,
      voucherPort: 0,
      id,
    },
    Uint8Array.from(body),
  );
  return kernel.send(task, decodeMachMessage(bytes));
}

describe("Mach port kernel", () => {
  it("creates special ports and routes a reply", () => {
    const kernel = new MachKernel();
    const client = kernel.createTask(100);
    const server = kernel.createTask(200);
    const { name: serviceName, portId } = kernel.insertReceiveRight(server, "test-service");
    kernel.registerService("com.example.service", portId);
    const service = kernel.lookupService(client, "com.example.service");
    expect(service).not.toBe(MACH_PORT_NULL);
    const reply = kernel.machReplyPort(client);

    expect(send(kernel, client, service, reply, [0xaa, 0xbb])).toBe(KERN_SUCCESS);
    const received = kernel.receive(server, serviceName);
    expect(received.result).toBe(KERN_SUCCESS);
    expect(received.message?.body).toEqual(Uint8Array.from([0xaa, 0xbb]));
    expect(received.message?.replyPortName).not.toBe(MACH_PORT_NULL);

    expect(send(kernel, server, received.message!.replyPortName, MACH_PORT_NULL, [0xcc], 2)).toBe(
      KERN_SUCCESS,
    );
    const response = kernel.receive(client, reply);
    expect(response.result).toBe(KERN_SUCCESS);
    expect(response.message?.body).toEqual(Uint8Array.from([0xcc]));
  });

  it("rejects receive rights on send-only names", () => {
    const kernel = new MachKernel();
    const client = kernel.createTask(1);
    const server = kernel.createTask(2);
    const { name } = kernel.insertReceiveRight(server, "recv");
    const sendName = kernel.insertSendRight(client, kernel.lookupRight(server, name)!.portId);
    expect(kernel.receive(client, sendName).result).toBe(KERN_INVALID_RIGHT);
  });

  it("times out on an empty receive queue", () => {
    const kernel = new MachKernel();
    const task = kernel.createTask(1);
    const reply = kernel.machReplyPort(task);
    expect(kernel.receive(task, reply).result).toBe(KERN_RECEIVE_TIMED_OUT);
  });

  it("enforces the queue depth", () => {
    const kernel = new MachKernel({ maxQueueDepth: 1 });
    const client = kernel.createTask(1);
    const server = kernel.createTask(2);
    const { name } = kernel.insertReceiveRight(server, "queue");
    const portId = kernel.lookupRight(server, name)!.portId;
    const destination = kernel.insertSendRight(client, portId);
    expect(send(kernel, client, destination, MACH_PORT_NULL, [1])).toBe(KERN_SUCCESS);
    expect(send(kernel, client, destination, MACH_PORT_NULL, [2])).toBe(KERN_RESOURCE_SHORTAGE);
  });

  it("delivers a message to a handler and queues its reply", () => {
    const kernel = new MachKernel();
    const client = kernel.createTask(1);
    let handled = 0;
    kernel.setPortHandlerById(kernel.bootstrapPort, (message, reply) => {
      handled += 1;
      reply(Uint8Array.from([...message.body].reverse()));
    });
    const reply = kernel.machReplyPort(client);
    expect(send(kernel, client, 2, reply, [1, 2, 3], 9)).toBe(KERN_SUCCESS);
    expect(handled).toBe(1);
    const response = kernel.receive(client, reply);
    expect(response.message?.body).toEqual(Uint8Array.from([3, 2, 1]));
    expect(response.message?.header.id).toBe(9);
  });

  it("validates service names and rejects duplicates", () => {
    const kernel = new MachKernel();
    const task = kernel.createTask(1);
    const { portId } = kernel.insertReceiveRight(task, "service");
    kernel.registerService("com.example.one", portId);
    expect(() => kernel.registerService("com.example.one", portId)).toThrow(/already registered/);
    expect(() => kernel.registerService("../bad", portId)).toThrow(/not valid/);
    expect(isServiceName("a.b-c_d")).toBe(true);
    expect(isServiceName("a..b")).toBe(false);
    expect(kernel.listServices()).toEqual(["com.example.one"]);
  });

  it("round-trips a MIG call", () => {
    const kernel = new MachKernel();
    const server = kernel.createTask(1);
    const client = kernel.createTask(2);
    const { name, portId } = kernel.insertReceiveRight(server, "mig");
    const port = kernel.insertSendRight(client, portId);
    new MigServer(kernel, server, name, 0x4441_1000)
      .register(7, (reader) => {
        const left = reader.u32();
        const right = reader.u64();
        return new MigWriter()
          .u32(left + 1)
          .u64(right + 1n)
          .toUint8Array();
      })
      .listen();

    const request = new MigWriter().u32(41).u64(0x1_0000_0000n).toUint8Array();
    const result = new MigClient(kernel, client, 0x4441_1000).call(port, 7, request);
    expect(result.status).toBe(0);
    const reader = new MigReader(result.body);
    expect(reader.u32()).toBe(42);
    expect(reader.u64()).toBe(0x1_0000_0001n);
  });

  it("looks up and registers bootstrap services through MIG", () => {
    const kernel = new MachKernel();
    const serviceTask = kernel.createTask(1);
    const consumer = kernel.createTask(2);
    const { name, portId } = kernel.insertReceiveRight(serviceTask, "service");
    new BootstrapServer(kernel).listen();
    const owner = new BootstrapClient(kernel, serviceTask);
    expect(owner.register("com.example.boot", name)).toBe(0);
    expect(owner.list()).toEqual(["com.example.boot"]);
    const client = new BootstrapClient(kernel, consumer);
    const lookup = client.lookup("com.example.boot");
    expect(lookup.status).toBe(0);
    expect(lookup.portName).not.toBe(0);
    expect(send(kernel, consumer, lookup.portName, 0, [9])).toBe(0);
    expect(kernel.receive(serviceTask, name).message?.body).toEqual(Uint8Array.from([9]));
    expect(client.lookup("missing").portName).toBe(0);
    expect(portId).toBeGreaterThan(0);
  });

  it("reports an unknown MIG routine", () => {
    const kernel = new MachKernel();
    const server = kernel.createTask(1);
    const client = kernel.createTask(2);
    const { name, portId } = kernel.insertReceiveRight(server, "mig");
    const port = kernel.insertSendRight(client, portId);
    new MigServer(kernel, server, name, 0x4441_1000).listen();
    const result = new MigClient(kernel, client, 0x4441_1000).call(port, 99);
    expect(result.status).toBe(0x1000_0004);
  });
});
