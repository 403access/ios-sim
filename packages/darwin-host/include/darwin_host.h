#ifndef DARWIN_HOST_H
#define DARWIN_HOST_H

/*
 * DarwinHost — native kernel-boundary spike for the Option A track.
 *
 * This is a small C11 user-space kernel with tasks, port rights, bounded
 * message queues, blocking receive, timeouts, interruption, and a bootstrap
 * service registry. It is loaded from Bun through FFI (no second protocol).
 *
 * It is NOT a Mach kernel and does not claim Apple ABI compatibility yet. The
 * ABI is versioned and intentionally narrow.
 */

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DH_ABI_VERSION 1u
#define DH_TIMEOUT_NONE 0u
#define DH_TIMEOUT_FOREVER UINT32_MAX
#define DH_MAX_MESSAGE_WORDS 1024u
#define DH_MAX_QUEUE_DEPTH 256u
#define DH_MAX_TASKS 256u
#define DH_MAX_PORTS 1024u
#define DH_MAX_NAMES_PER_TASK 256u
#define DH_MAX_SERVICES 256u
#define DH_MAX_THREADS 1024u
#define DH_MAX_PORT_SETS 256u
#define DH_MAX_SET_MEMBERS 64u
#define DH_LABEL_MAX 64u
#define DH_SERVICE_MAX 256u

/* Port right bits. */
#define DH_RIGHT_SEND 1u
#define DH_RIGHT_RECEIVE 2u
#define DH_RIGHT_SEND_ONCE 4u
#define DH_RIGHT_PORT_SET 8u
#define DH_NOTIFY_DEAD 0x0ead0001u

/* Thread states. */
#define DH_THREAD_RUNNABLE 1u
#define DH_THREAD_RUNNING 2u
#define DH_THREAD_BLOCKED 3u
#define DH_THREAD_TERMINATED 4u

/* Machine-readable status; stable within DH_ABI_VERSION. */
typedef enum {
  DH_OK = 0,
  DH_ERR_INVALID_ARGUMENT = 1,
  DH_ERR_INVALID_TASK = 2,
  DH_ERR_INVALID_NAME = 3,
  DH_ERR_INVALID_RIGHT = 4,
  DH_ERR_QUEUE_FULL = 5,
  DH_ERR_MESSAGE_TOO_LARGE = 6,
  DH_ERR_TIMEOUT = 7,
  DH_ERR_INTERRUPTED = 8,
  DH_ERR_NO_SPACE = 9,
  DH_ERR_DUPLICATE_SERVICE = 10,
  DH_ERR_NOT_FOUND = 11,
  DH_ERR_STATE = 12
} DHStatus;

uint32_t dh_abi_version(void);

/* Reset all tasks, ports, messages, and services. */
int dh_kernel_reset(void);

int dh_task_create(uint32_t pid, uint32_t *out_task);
int dh_task_destroy(uint32_t task);
int dh_task_interrupt(uint32_t task);

/* Thread lifecycle objects. Execution/scheduling is layered above this ABI. */
int dh_thread_create(uint32_t task, uint32_t *out_thread, uint32_t *out_port_name);
int dh_thread_terminate(uint32_t task, uint32_t thread);
int dh_thread_join(uint32_t task, uint32_t thread, uint32_t timeout_ms);
int dh_thread_state(uint32_t task, uint32_t thread, uint32_t *out_state);

/* Create a receive right with a label. */
int dh_port_create_receive(uint32_t task, const char *label, uint32_t *out_name);

/* Create a single name carrying receive + send (a reply port). */
int dh_reply_port(uint32_t task, uint32_t *out_name);

/* Add a send right to an existing port id. Intended for bootstrap lookup. */
int dh_port_make_send(uint32_t task, uint32_t port_id, uint32_t *out_name);

/* Resolve a name to its port id (for constructing a send right). */
int dh_name_port_id(uint32_t task, uint32_t name, uint32_t *out_port_id);

int dh_name_deallocate(uint32_t task, uint32_t name);

/* Port sets: receive from any member; members must have receive rights. */
int dh_port_set_create(uint32_t task, const uint32_t *ports, uint32_t count, uint32_t *out_name);
int dh_port_set_add(uint32_t task, uint32_t set_name, uint32_t port_name);
int dh_port_set_remove(uint32_t task, uint32_t set_name, uint32_t port_name);

/* Register a send port for a one-shot dead-name notification. */
int dh_port_register_dead_name(uint32_t task, uint32_t port_name, uint32_t notify_name);

int dh_service_register(uint32_t task, const char *service, uint32_t name);
int dh_service_lookup(uint32_t task, const char *service, uint32_t *out_name);

/**
 * Send a word message. `local` is an optional reply-port name in the sender.
 * `words` may be NULL only when count is 0.
 */
int dh_send(uint32_t task, uint32_t remote, uint32_t local, int32_t message_id,
            const uint32_t *words, uint32_t count);

/**
 * Receive one message. When `out_capacity` is too small, returns
 * DH_ERR_MESSAGE_TOO_LARGE without consuming the message.
 */
int dh_receive(uint32_t task, uint32_t name, uint32_t *out_words, uint32_t out_capacity,
               uint32_t *out_count, uint32_t *out_remote, uint32_t *out_local,
               int32_t *out_message_id, uint32_t timeout_ms);

int dh_kernel_stats(uint32_t *out_tasks, uint32_t *out_ports, uint32_t *out_messages);

/* Self-tests used by the C test and the Bun FFI smoke test. */
int dh_selftest_blocking(void);
int dh_selftest_interrupt(void);
int dh_selftest_threads(void);

#ifdef __cplusplus
}
#endif

#endif
