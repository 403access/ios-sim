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
