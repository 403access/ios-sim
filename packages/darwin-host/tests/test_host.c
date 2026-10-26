#include "darwin_host.h"

#include <stdio.h>
#include <string.h>

static int failures = 0;

#define CHECK(condition, message)                                                               \
  do {                                                                                          \
    if (!(condition)) {                                                                         \
      fprintf(stderr, "FAIL: %s (%s:%d)\n", message, __FILE__, __LINE__);                       \
      failures += 1;                                                                            \
    }                                                                                           \
  } while (0)

int main(void) {
  CHECK(dh_abi_version() == DH_ABI_VERSION, "abi version");

  CHECK(dh_kernel_reset() == DH_OK, "reset");
  uint32_t task = 0;
  CHECK(dh_task_create(100, &task) == DH_OK, "create task");
  uint32_t receive = 0;
  CHECK(dh_port_create_receive(task, "test", &receive) == DH_OK, "create receive");
  uint32_t reply = 0;
  CHECK(dh_reply_port(task, &reply) == DH_OK, "create reply");
  uint32_t receive_port = 0;
  CHECK(dh_name_port_id(task, receive, &receive_port) == DH_OK, "name port id");
  uint32_t send = 0;
  CHECK(dh_port_make_send(task, receive_port, &send) == DH_OK, "make send");

  uint32_t body[3] = {1, 2, 3};
  CHECK(dh_send(task, send, reply, 42, body, 3) == DH_OK, "send");
  uint32_t words[8] = {0};
  uint32_t count = 0;
  uint32_t remote = 0;
  uint32_t local = 0;
  int32_t message_id = 0;
  CHECK(dh_receive(task, receive, words, 8, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_OK,
        "receive");
  CHECK(count == 3 && words[0] == 1 && words[2] == 3, "body copy");
  CHECK(message_id == 42 && local != 0, "reply name and id");
  CHECK(dh_receive(task, receive, words, 8, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_ERR_TIMEOUT,
        "timeout");

  uint32_t small[1] = {0};
  CHECK(dh_send(task, send, reply, 1, body, 3) == DH_OK, "send large");
  CHECK(dh_receive(task, receive, small, 1, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_ERR_MESSAGE_TOO_LARGE,
        "small receive keeps message");
  CHECK(dh_receive(task, receive, words, 8, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_OK,
        "retry receive");

  uint32_t send_name = 0;
  CHECK(dh_port_make_send(task, 0, &send_name) == DH_ERR_INVALID_NAME, "invalid port");
  CHECK(dh_service_register(task, "com.example.test", receive) == DH_OK, "register service");
  CHECK(dh_service_register(task, "com.example.test", receive) == DH_ERR_DUPLICATE_SERVICE,
        "duplicate service");
  uint32_t looked_up = 0;
  CHECK(dh_service_lookup(task, "com.example.test", &looked_up) == DH_OK, "lookup service");
  CHECK(dh_send(task, looked_up, 0, 7, body, 1) == DH_OK, "send to looked-up service");
  CHECK(dh_receive(task, receive, words, 8, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_OK,
        "service receive");

  uint32_t second_receive = 0;
  CHECK(dh_port_create_receive(task, "second", &second_receive) == DH_OK, "second receive");
  uint32_t second_port = 0;
  CHECK(dh_name_port_id(task, second_receive, &second_port) == DH_OK, "second port id");
  uint32_t second_send = 0;
  CHECK(dh_port_make_send(task, second_port, &second_send) == DH_OK, "second send");
  uint32_t set_name = 0;
  uint32_t members[2] = {receive, second_receive};
  CHECK(dh_port_set_create(task, members, 2, &set_name) == DH_OK, "create port set");
  CHECK(dh_port_set_add(task, set_name, second_receive) == DH_OK, "add duplicate member");
  CHECK(dh_port_set_remove(task, set_name, second_receive) == DH_OK, "remove member");
  CHECK(dh_port_set_add(task, set_name, second_receive) == DH_OK, "re-add member");
  CHECK(dh_send(task, second_send, 0, 55, body, 1) == DH_OK, "send to set member");
  CHECK(dh_receive(task, set_name, words, 8, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_OK,
        "receive from set");
  CHECK(remote == set_name && message_id == 55 && words[0] == 1, "set receive metadata");

  uint32_t notify_receive = 0;
  CHECK(dh_port_create_receive(task, "notify", &notify_receive) == DH_OK, "notify receive");
  uint32_t notify_port = 0;
  CHECK(dh_name_port_id(task, notify_receive, &notify_port) == DH_OK, "notify port id");
  uint32_t notify_send = 0;
  CHECK(dh_port_make_send(task, notify_port, &notify_send) == DH_OK, "notify send");
  uint32_t dead_receive = 0;
  CHECK(dh_port_create_receive(task, "dead", &dead_receive) == DH_OK, "dead receive");
  uint32_t dead_port = 0;
  CHECK(dh_name_port_id(task, dead_receive, &dead_port) == DH_OK, "dead port id");
  CHECK(dh_port_register_dead_name(task, dead_receive, notify_send) == DH_OK, "register dead name");
  CHECK(dh_name_deallocate(task, dead_receive) == DH_OK, "deallocate dead receive");
  CHECK(dh_receive(task, notify_receive, words, 8, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_OK,
        "dead notification delivered");
  CHECK(message_id == (int32_t)DH_NOTIFY_DEAD && words[0] == dead_port, "dead notification body");

  uint32_t transfer_receive = 0;
  CHECK(dh_port_create_receive(task, "transfer", &transfer_receive) == DH_OK, "transfer receive");
  uint32_t transfer_port = 0;
  CHECK(dh_name_port_id(task, receive, &transfer_port) == DH_OK, "transfer port id");
  uint32_t transfer_send = 0;
  CHECK(dh_port_make_send(task, transfer_port, &transfer_send) == DH_OK, "transfer send");
  uint32_t transfer_box = receive;
  uint32_t moved = 0;
  CHECK(dh_send_port(task, second_send, 0, 66, body, 1, transfer_send,
                     DH_PORT_DISPOSITION_COPY_SEND) == DH_OK,
        "send COPY_SEND descriptor");
  CHECK(dh_receive_port(task, second_receive, words, 8, &count, &remote, &local, &message_id,
                        DH_TIMEOUT_NONE, &moved) == DH_OK,
        "receive COPY_SEND descriptor");
  CHECK(moved != 0, "COPY_SEND produced a name");
  CHECK(dh_send(task, moved, 0, 67, body, 1) == DH_OK, "use COPY_SEND right");
  CHECK(dh_receive(task, receive, words, 8, &count, &remote, &local, &message_id,
                   DH_TIMEOUT_NONE) == DH_OK,
        "receive on copied port");

  uint32_t once = 0;
  CHECK(dh_send_port(task, second_send, 0, 68, body, 1, transfer_receive,
                     DH_PORT_DISPOSITION_MAKE_SEND_ONCE) == DH_OK,
        "send MAKE_SEND_ONCE descriptor");
  CHECK(dh_receive_port(task, second_receive, words, 8, &count, &remote, &local, &message_id,
                        DH_TIMEOUT_NONE, &once) == DH_OK,
        "receive MAKE_SEND_ONCE descriptor");
  CHECK(once != 0, "MAKE_SEND_ONCE produced a name");
  CHECK(dh_send(task, once, 0, 69, body, 1) == DH_OK, "use send-once right");
  CHECK(dh_send(task, once, 0, 70, body, 1) == DH_ERR_INVALID_NAME, "send-once consumed");
  (void)transfer_box;

  uint32_t quota_task = 0;
  CHECK(dh_task_create(300, &quota_task) == DH_OK, "quota task");
  CHECK(dh_task_set_quotas(quota_task, 2, 1, 0x1000) == DH_OK, "set quotas");
  uint32_t quota_ports = 0, quota_messages = 0, quota_memory = 0;
  CHECK(dh_task_get_usage(quota_task, &quota_ports, &quota_messages, &quota_memory) == DH_OK,
        "quota usage");
  CHECK(quota_ports == 1 && quota_messages == 0 && quota_memory == 0, "initial quota usage");
  uint32_t quota_receive = 0;
  CHECK(dh_port_create_receive(quota_task, "quota", &quota_receive) == DH_OK, "quota receive");
  uint32_t quota_receive2 = 0;
  CHECK(dh_port_create_receive(quota_task, "quota2", &quota_receive2) == DH_ERR_QUOTA,
        "port quota enforced");
  uint32_t quota_port_id = 0;
  CHECK(dh_name_port_id(quota_task, quota_receive, &quota_port_id) == DH_OK, "quota port id");
  uint32_t quota_send = 0;
  CHECK(dh_port_make_send(quota_task, quota_port_id, &quota_send) == DH_OK, "quota send");
  CHECK(dh_send(quota_task, quota_send, 0, 1, body, 1) == DH_OK, "quota first message");
  CHECK(dh_send(quota_task, quota_send, 0, 2, body, 1) == DH_ERR_QUOTA, "message quota");
  uint32_t quota_memory_id = 0;
  CHECK(dh_memory_create(0x2000, &quota_memory_id) == DH_OK, "quota memory object");
  uint32_t quota_map = 0;
  CHECK(dh_memory_map(quota_task, quota_memory_id, 0, &quota_map) == DH_ERR_QUOTA,
        "memory quota enforced");
  CHECK(dh_memory_destroy(quota_memory_id) == DH_OK, "destroy quota memory");
  CHECK(dh_task_destroy(quota_task) == DH_OK, "destroy quota task");

  CHECK(dh_trap_count() >= 6, "trap table size");
  CHECK(dh_trap_number(0) == -26 && dh_trap_implemented(0) == 1, "reply-port trap");
  uint32_t trap_value = 0;
  CHECK(dh_trap_dispatch(task, -28, &trap_value) == DH_OK && trap_value == 1, "task self trap");
  CHECK(dh_trap_dispatch(task, -31, &trap_value) == DH_ERR_NOT_FOUND, "unsupported mach_msg trap");
  CHECK(dh_trap_dispatch(task, 123456, &trap_value) == DH_ERR_NOT_FOUND, "unknown trap");
  uint32_t seed = 0x12345678u;
  for (int index = 0; index < 100000; ++index) {
    seed = seed * 1664525u + 1013904223u;
    CHECK(dh_trap_dispatch(task, (int32_t)seed, &trap_value) != DH_OK ||
              trap_value == 1 || trap_value != 0,
          "trap fuzz response");
  }

  CHECK(dh_selftest_blocking() == 0, "blocking self-test");
  CHECK(dh_selftest_interrupt() == 0, "interrupt self-test");
  CHECK(dh_selftest_threads() == 0, "thread self-test");

  CHECK(dh_task_create(101, &task) == DH_OK, "second task");
  uint32_t tasks = 0;
  uint32_t ports = 0;
  uint32_t messages = 0;
  CHECK(dh_kernel_stats(&tasks, &ports, &messages) == DH_OK, "stats");
  CHECK(tasks >= 1 && ports >= 1, "stats nonzero");

  CHECK(dh_task_destroy(task) == DH_OK, "destroy task");
  CHECK(dh_task_create(102, &task) == DH_OK, "create after destroy");
  CHECK(dh_task_destroy(task) == DH_OK, "destroy second task");

  printf("darwin-host: %d unit test(s) failed\n", failures);
  return failures == 0 ? 0 : 1;
}
