/**
 * Bun FFI smoke test for the native kernel boundary.
 *
 * Run with `bun packages/darwin-host/tests/ffi-smoke.ts` after building the C
 * library. It exercises task/port rights, send/receive, timeouts, bootstrap
 * services, blocking, interruption, and queue limits through the real C host.
 */

import assert from "node:assert/strict";
import {
  DH_MAX_QUEUE_DEPTH,
  DH_THREAD_RUNNABLE,
  DH_TIMEOUT_FOREVER,
  DHStatus,
  NativeHost,
} from "../src/index.js";

const host = new NativeHost();
try {
  assert.equal(host.abiVersion(), 1);
  host.reset();

  const task = host.createTask(100);
  const receive = host.createReceivePort(task, "ffi-service");
  const reply = host.replyPort(task);
  const send = host.makeSend(task, host.namePortId(task, receive));

  host.sendOrThrow(task, send, reply, 42, Uint32Array.from([0xfeed, 0xbeef]));
  const message = host.receive(task, receive, 16, 100);
  assert.equal(message.status, DHStatus.OK);
  assert.deepEqual(Array.from(message.body), [0xfeed, 0xbeef]);
  assert.equal(message.messageId, 42);
  assert.ok(message.replyName > 0);

  host.sendOrThrow(task, message.replyName, 0, 43, Uint32Array.from([9]));
  const replyMessage = host.receive(task, reply, 16, 100);
  assert.deepEqual(Array.from(replyMessage.body), [9]);
  assert.equal(replyMessage.messageId, 43);

  const timeout = host.receive(task, receive, 16, 5);
  assert.equal(timeout.status, DHStatus.Timeout);

  host.registerService(task, "com.example.ffi", receive);
  const lookedUp = host.lookupService(task, "com.example.ffi");
  host.sendOrThrow(task, lookedUp, 0, 44, Uint32Array.from([7]));
  assert.deepEqual(Array.from(host.receive(task, receive, 16, 100).body), [7]);

  for (let index = 0; index < DH_MAX_QUEUE_DEPTH; index += 1) {
    assert.equal(host.send(task, send, 0, index, Uint32Array.from([index])), DHStatus.OK);
  }
  assert.equal(host.send(task, send, 0, 999, Uint32Array.from([0])), DHStatus.QueueFull);
  for (let index = 0; index < DH_MAX_QUEUE_DEPTH; index += 1) {
    assert.equal(host.receive(task, receive, 16, 0).status, DHStatus.OK);
  }

  host.selftestBlocking();
  host.selftestInterrupt();
  host.selftestThreads();

  const threadOne = host.createThread(task);
  const threadTwo = host.createThread(task);
  assert.notEqual(threadOne.thread, threadTwo.thread);
  assert.notEqual(threadOne.portName, threadTwo.portName);
  assert.equal(host.threadState(task, threadOne.thread), DH_THREAD_RUNNABLE);
  host.terminateThread(task, threadOne.thread);
  assert.equal(host.joinThread(task, threadOne.thread, 0), 0);
  assert.equal(host.joinThread(task, threadTwo.thread, 0), 7);

  const stats = host.stats();
  assert.ok(stats.tasks >= 1 && stats.ports >= 1 && stats.messages === 0);
  host.destroyTask(task);

  const blocked = host.receive(123_456, receive, 16, DH_TIMEOUT_FOREVER);
  assert.equal(blocked.status, DHStatus.InvalidTask);

  console.log("darwin-host: Bun FFI smoke passed");
} finally {
  host.close();
}
