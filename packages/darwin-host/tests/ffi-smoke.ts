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
  DH_NOTIFY_DEAD,
  DH_PORT_DISPOSITION_COPY_SEND,
  DH_PORT_DISPOSITION_MAKE_SEND_ONCE,
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

  const receive2 = host.createReceivePort(task, "ffi-second");
  const send2 = host.makeSend(task, host.namePortId(task, receive2));
  const set = host.createPortSet(task, [receive, receive2]);
  host.addPortToSet(task, set, receive2);
  host.sendOrThrow(task, send2, 0, 55, Uint32Array.from([1]));
  const setMessage = host.receive(task, set, 8, 100);
  assert.deepEqual(Array.from(setMessage.body), [1]);
  assert.equal(setMessage.messageId, 55);

  const notify = host.createReceivePort(task, "ffi-notify");
  const notifySend = host.makeSend(task, host.namePortId(task, notify));
  const dead = host.createReceivePort(task, "ffi-dead");
  const deadPort = host.namePortId(task, dead);
  host.registerDeadName(task, dead, notifySend);
  host.deallocateName(task, dead);
  const notification = host.receive(task, notify, 8, 100);
  assert.equal(notification.messageId, DH_NOTIFY_DEAD);
  assert.equal(notification.body[0], deadPort);

  const transferReceive = host.createReceivePort(task, "ffi-transfer");
  const transferPort = host.namePortId(task, receive);
  const transferSend = host.makeSend(task, transferPort);
  assert.equal(
    host.sendPort(
      task,
      send,
      0,
      66,
      Uint32Array.from([1]),
      transferSend,
      DH_PORT_DISPOSITION_COPY_SEND,
    ),
    0,
  );
  const copied = host.receivePort(task, receive, 8, 100);
  assert.notEqual(copied.transferName, 0);
  host.sendOrThrow(task, copied.transferName, 0, 67, Uint32Array.from([2]));
  assert.deepEqual(Array.from(host.receive(task, receive, 8, 100).body), [2]);

  assert.equal(
    host.sendPort(
      task,
      send,
      0,
      68,
      Uint32Array.from([1]),
      transferReceive,
      DH_PORT_DISPOSITION_MAKE_SEND_ONCE,
    ),
    0,
  );
  const once = host.receivePort(task, receive, 8, 100);
  assert.notEqual(once.transferName, 0);
  assert.equal(host.send(task, once.transferName, 0, 69, Uint32Array.from([3])), 0);
  assert.deepEqual(Array.from(host.receive(task, transferReceive, 8, 100).body), [3]);
  assert.equal(host.send(task, once.transferName, 0, 70, Uint32Array.from([4])), 3);

  assert.ok(host.trapCount() >= 6);
  assert.equal(host.trapNumber(0), -26);
  assert.equal(host.trapImplemented(0), true);
  assert.deepEqual(host.dispatchTrap(task, -28), { status: 0, value: 1 });
  assert.equal(host.dispatchTrap(task, -31).status, DHStatus.NotFound);
  let seed = 0x12345678;
  for (let index = 0; index < 10000; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    host.dispatchTrap(task, seed | 0);
  }

  const memory = host.createMemory(16);
  host.writeMemory(memory, 0, Uint8Array.from([1, 2, 3, 4]));
  const taskB = host.createTask(200);
  const mapA = host.mapMemory(task, memory);
  const mapB = host.mapMemory(taskB, memory);
  assert.notEqual(mapA, mapB);
  assert.deepEqual(Array.from(host.readMemoryAt(taskB, mapB, 4)), [1, 2, 3, 4]);
  host.writeMemoryAt(task, mapA, Uint8Array.from([9, 8]));
  assert.deepEqual(Array.from(host.readMemoryAt(taskB, mapB, 2)), [9, 8]);
  const clone = host.cloneMemory(memory);
  const cloneMap = host.mapMemory(task, clone);
  host.writeMemoryAt(task, cloneMap, Uint8Array.from([7]));
  assert.deepEqual(Array.from(host.readMemory(memory, 0, 1)), [9]);
  host.unmapMemory(task, mapA);
  host.unmapMemory(taskB, mapB);
  host.unmapMemory(task, cloneMap);
  host.destroyMemory(memory);
  host.destroyMemory(clone);
  host.destroyTask(taskB);

  const quotaTask = host.createTask(300);
  host.setQuotas(quotaTask, 2, 1, 0x1000);
  assert.deepEqual(host.usage(quotaTask), { ports: 1, messages: 0, memoryBytes: 0 });
  const quotaReceive = host.createReceivePort(quotaTask, "quota");
  assert.throws(() => host.createReceivePort(quotaTask, "quota2"), /dh_quota/);
  const quotaSend = host.makeSend(quotaTask, host.namePortId(quotaTask, quotaReceive));
  host.sendOrThrow(quotaTask, quotaSend, 0, 1, Uint32Array.from([1]));
  assert.equal(host.send(quotaTask, quotaSend, 0, 2, Uint32Array.from([2])), DHStatus.Quota);
  const quotaMemory = host.createMemory(0x2000);
  assert.throws(() => host.mapMemory(quotaTask, quotaMemory), /dh_quota/);
  host.destroyMemory(quotaMemory);
  host.destroyTask(quotaTask);

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
