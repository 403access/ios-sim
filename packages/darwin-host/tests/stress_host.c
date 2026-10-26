#include "darwin_host.h"

#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>

#define STRESS_THREADS 16u
#define STRESS_MESSAGES 1000000u

typedef struct {
  uint32_t task;
  uint32_t send_name;
  uint32_t count;
  atomic_uint *sent;
  atomic_int *failed;
} SenderArgs;

typedef struct {
  uint32_t task;
  uint32_t receive_name;
  atomic_uint *received;
  atomic_int *failed;
} ReceiverArgs;

static void *sender(void *raw) {
  SenderArgs *args = raw;
  uint32_t body = args->task;
  for (uint32_t index = 0; index < args->count; ++index) {
    for (;;) {
      int status = dh_send(args->task, args->send_name, 0, (int32_t)index, &body, 1);
      if (status == DH_OK) {
        atomic_fetch_add(args->sent, 1u);
        break;
      }
      if (status == DH_ERR_QUEUE_FULL || status == DH_ERR_QUOTA) {
        sched_yield();
        continue;
      }
      atomic_store(args->failed, 1);
      return NULL;
    }
  }
  return NULL;
}

static void *receiver(void *raw) {
  ReceiverArgs *args = raw;
  uint32_t words[4];
  while (atomic_load(args->received) < STRESS_MESSAGES) {
    uint32_t count = 0;
    uint32_t remote = 0;
    uint32_t local = 0;
    int32_t message_id = 0;
    int status = dh_receive(args->task, args->receive_name, words, 4, &count, &remote, &local,
                            &message_id, 1000);
    if (status == DH_OK) {
      atomic_fetch_add(args->received, 1u);
    } else if (status == DH_ERR_TIMEOUT) {
      continue;
    } else {
      atomic_store(args->failed, 1);
      return NULL;
    }
  }
  return NULL;
}

int main(void) {
  if (dh_kernel_reset() != DH_OK) return 1;
  uint32_t task = 0;
  if (dh_task_create(500, &task) != DH_OK) return 2;
  uint32_t receive = 0;
  if (dh_port_create_receive(task, "stress", &receive) != DH_OK) return 3;
  uint32_t port_id = 0;
  if (dh_name_port_id(task, receive, &port_id) != DH_OK) return 4;
  uint32_t send = 0;
  if (dh_port_make_send(task, port_id, &send) != DH_OK) return 5;

  atomic_uint sent = 0;
  atomic_uint received = 0;
  atomic_int failed = 0;
  pthread_t receiver_thread;
  ReceiverArgs receiver_args = {.task = task, .receive_name = receive, .received = &received,
                                .failed = &failed};
  if (pthread_create(&receiver_thread, NULL, receiver, &receiver_args) != 0) return 6;

  pthread_t senders[STRESS_THREADS];
  SenderArgs sender_args[STRESS_THREADS];
  uint32_t base = STRESS_MESSAGES / STRESS_THREADS;
  uint32_t remainder = STRESS_MESSAGES % STRESS_THREADS;
  for (uint32_t index = 0; index < STRESS_THREADS; ++index) {
    sender_args[index] = (SenderArgs){.task = task,
                                      .send_name = send,
                                      .count = base + (index < remainder ? 1u : 0u),
                                      .sent = &sent,
                                      .failed = &failed};
    if (pthread_create(&senders[index], NULL, sender, &sender_args[index]) != 0) return 7;
  }
  for (uint32_t index = 0; index < STRESS_THREADS; ++index) pthread_join(senders[index], NULL);
  pthread_join(receiver_thread, NULL);

  uint32_t tasks = 0;
  uint32_t ports = 0;
  uint32_t messages = 0;
  if (dh_kernel_stats(&tasks, &ports, &messages) != DH_OK) return 8;
  if (atomic_load(&failed) != 0 || atomic_load(&sent) != STRESS_MESSAGES ||
      atomic_load(&received) != STRESS_MESSAGES || messages != 0) {
    fprintf(stderr, "stress failed: failed=%d sent=%u received=%u messages=%u\n",
            atomic_load(&failed), atomic_load(&sent), atomic_load(&received), messages);
    return 9;
  }
  if (dh_task_destroy(task) != DH_OK) return 10;
  printf("darwin-host: stress passed (%u threads, %u messages)\n", STRESS_THREADS,
         STRESS_MESSAGES);
  return 0;
}
