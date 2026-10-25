import { describe, expect, it } from "vitest";
import { createXpcService, XpcConnection, XpcServer } from "./connection.js";
import { decodeXpcEnvelope, encodeXpcEnvelope } from "./connection.js";
import { decodeXpcValue, encodeXpcValue, type XpcValue } from "./codec.js";
import { MachKernel } from "../mach/kernel.js";

describe("XPC codec", () => {
  it("round-trips scalars, data, dates, UUIDs, arrays, and dictionaries", () => {
    const value: XpcValue = {
      name: "hello",
      count: 42,
      big: 0x40_0000_0000_0000n,
      ratio: 1.5,
      active: true,
      nothing: null,
      data: Uint8Array.from([1, 2, 3]),
      date: new Date("2026-10-25T12:00:00.000Z"),
      uuid: { uuid: "00112233-4455-6677-8899-aabbccddeeff" },
      list: [1, "two", false, { nested: [3] }],
    };
    const decoded = decodeXpcValue(encodeXpcValue(value));
    expect(decoded).toEqual(value);
  });

  it("rejects unsafe keys and malformed input", () => {
    const unsafe: Record<string, XpcValue> = {};
    Object.defineProperty(unsafe, "__proto__", { value: 1, enumerable: true });
    expect(() => encodeXpcValue(unsafe)).toThrow(/not allowed/);
    expect(() => decodeXpcValue(Uint8Array.from([0xff]))).toThrow(/unknown XPC type/);
    const encoded = encodeXpcValue({ ok: true });
    expect(() => decodeXpcValue(encoded.subarray(0, encoded.length - 1))).toThrow();
    expect(() => decodeXpcValue(new Uint8Array([...encoded, 0]))).toThrow(/trailing/);
  });

  it("envelopes requests and replies", () => {
    const envelope = { version: 1, id: 7, kind: "request" as const, payload: { ping: true } };
    expect(decodeXpcEnvelope(encodeXpcEnvelope(envelope))).toEqual(envelope);
    const bad = encodeXpcEnvelope(envelope);
    bad[0] = 0;
    expect(() => decodeXpcEnvelope(bad)).toThrow(/magic/);
  });
});

describe("XPC connection", () => {
  it("performs a request/reply against a service", () => {
    const kernel = new MachKernel();
    const serverTask = kernel.createTask(10);
    const clientTask = kernel.createTask(20);
    const service = createXpcService(kernel, serverTask, "com.example.echo");
    service.server.onRequest((payload) => {
      if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
        return { ...payload, echoed: true };
      }
      return payload;
    });
    const port = kernel.lookupService(clientTask, "com.example.echo");
    const client = new XpcConnection(kernel, clientTask, port);
    expect(client.call({ hello: "world" })).toEqual({ hello: "world", echoed: true });
    expect(client.call([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("turns a handler exception into an error payload", () => {
    const kernel = new MachKernel();
    const serverTask = kernel.createTask(10);
    const clientTask = kernel.createTask(20);
    const service = createXpcService(kernel, serverTask, "com.example.fail");
    service.server.onRequest(() => {
      throw new Error("boom");
    });
    const client = new XpcConnection(
      kernel,
      clientTask,
      kernel.lookupService(clientTask, "com.example.fail"),
    );
    expect(client.call(null)).toEqual({ $error: "boom" });
  });

  it("times out when no handler is installed", () => {
    const kernel = new MachKernel();
    const serverTask = kernel.createTask(10);
    const clientTask = kernel.createTask(20);
    createXpcService(kernel, serverTask, "com.example.silent");
    const client = new XpcConnection(
      kernel,
      clientTask,
      kernel.lookupService(clientTask, "com.example.silent"),
    );
    expect(() => client.call("hi")).toThrow(/did not reply/);
  });

  it("errors on a null service port", () => {
    const kernel = new MachKernel();
    const clientTask = kernel.createTask(20);
    const client = new XpcConnection(kernel, clientTask, 0);
    expect(() => client.call(null)).toThrow(/null/);
  });
});
