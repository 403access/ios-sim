#include "darwin_host.h"

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct {
  uint32_t port_id;
  uint32_t set_id;
  uint32_t rights;
} DHName;

typedef struct {
  uint32_t used;
  uint32_t id;
  uint32_t owner;
  uint32_t members[DH_MAX_SET_MEMBERS];
  uint32_t count;
} DHSet;

typedef struct DHMessage {
  struct DHMessage *next;
  int32_t message_id;
  uint32_t sender_task;
  uint32_t reply_port;
  uint32_t transfer_port;
  uint32_t transfer_disposition;
  uint32_t count;
  uint32_t words[];
} DHMessage;

typedef struct {
  uint32_t used;
  uint32_t id;
  char label[DH_LABEL_MAX];
  uint32_t receive_owner;
  uint32_t dead_notify_port;
  DHMessage *first;
  DHMessage *last;
  uint32_t count;
} DHMessagePort;

typedef struct {
  uint32_t used;
  uint32_t id;
  uint32_t pid;
  uint32_t interrupted;
  uint32_t next_name;
  DHName names[DH_MAX_NAMES_PER_TASK];
} DHTask;

typedef struct {
  uint32_t used;
  uint32_t id;
  uint32_t task_id;
  uint32_t port_id;
  uint32_t state;
} DHThread;

typedef struct {
  uint32_t used;
  char name[DH_SERVICE_MAX];
  uint32_t port_id;
} DHService;

typedef struct {
  uint32_t used;
  uint32_t id;
  uint32_t size;
  uint8_t *data;
} DHMemory;

typedef struct {
  uint32_t used;
  uint32_t task_id;
  uint32_t memory_id;
  uint64_t address;
  uint32_t size;
} DHMapping;

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t g_cond = PTHREAD_COND_INITIALIZER;
static DHTask g_tasks[DH_MAX_TASKS];
static DHMessagePort g_ports[DH_MAX_PORTS];
static DHService g_services[DH_MAX_SERVICES];
static DHThread g_threads[DH_MAX_THREADS];
static DHSet g_sets[DH_MAX_PORT_SETS];
static DHMemory g_memory[DH_MAX_MEMORY_OBJECTS];
static DHMapping g_mappings[DH_MAX_MAPPINGS];
static uint64_t g_next_mapping_address = 0x10000000ull;
static uint32_t g_next_task_id = 1;
static uint32_t g_next_thread_id = 1;
static uint32_t g_boot_port_id = 0;
static uint32_t g_message_count = 0;

static DHTask *task_locked(uint32_t task_id) {
  for (size_t index = 0; index < DH_MAX_TASKS; ++index) {
    if (g_tasks[index].used && g_tasks[index].id == task_id) return &g_tasks[index];
  }
  return NULL;
}

static DHThread *thread_locked(uint32_t task_id, uint32_t thread_id) {
  for (size_t index = 0; index < DH_MAX_THREADS; ++index) {
    if (g_threads[index].used && g_threads[index].task_id == task_id &&
        g_threads[index].id == thread_id) {
      return &g_threads[index];
    }
  }
  return NULL;
}

static DHSet *set_locked(uint32_t set_id) {
  for (size_t index = 0; index < DH_MAX_PORT_SETS; ++index) {
    if (g_sets[index].used && g_sets[index].id == set_id) return &g_sets[index];
  }
  return NULL;
}

static DHMessagePort *port_locked(uint32_t port_id) {
  for (size_t index = 0; index < DH_MAX_PORTS; ++index) {
    if (g_ports[index].used && g_ports[index].id == port_id) return &g_ports[index];
  }
  return NULL;
}

static DHMessagePort *alloc_port_locked(const char *label, uint32_t owner) {
  for (size_t index = 0; index < DH_MAX_PORTS; ++index) {
    if (!g_ports[index].used) {
      DHMessagePort *port = &g_ports[index];
      memset(port, 0, sizeof(*port));
      port->used = 1;
      port->id = (uint32_t)index + 1;
      port->receive_owner = owner;
      if (label != NULL) {
        snprintf(port->label, sizeof(port->label), "%s", label);
      }
      return port;
    }
  }
  return NULL;
}

static void free_messages_locked(DHMessagePort *port) {
  DHMessage *message = port->first;
  while (message != NULL) {
    DHMessage *next = message->next;
    free(message);
    if (g_message_count > 0) g_message_count -= 1;
    message = next;
  }
  port->first = NULL;
  port->last = NULL;
  port->count = 0;
}

static void enqueue_notification_locked(uint32_t notify_port_id, uint32_t dead_port_id) {
  DHMessagePort *notify = port_locked(notify_port_id);
  if (notify == NULL || notify->count >= DH_MAX_QUEUE_DEPTH) return;
  DHMessage *message = malloc(sizeof(DHMessage) + sizeof(uint32_t));
  if (message == NULL) return;
  message->next = NULL;
  message->message_id = (int32_t)DH_NOTIFY_DEAD;
  message->sender_task = 0;
  message->reply_port = 0;
  message->transfer_port = 0;
  message->transfer_disposition = 0;
  message->count = 1;
  message->words[0] = dead_port_id;
  if (notify->last == NULL) notify->first = message;
  else notify->last->next = message;
  notify->last = message;
  notify->count += 1;
  g_message_count += 1;
  pthread_cond_broadcast(&g_cond);
}

static void destroy_port_locked(DHMessagePort *port) {
  uint32_t notify = port->dead_notify_port;
  uint32_t dead_id = port->id;
  free_messages_locked(port);
  for (size_t index = 0; index < DH_MAX_SERVICES; ++index) {
    if (g_services[index].used && g_services[index].port_id == port->id) {
      g_services[index].used = 0;
    }
  }
  memset(port, 0, sizeof(*port));
  if (notify != 0 && notify != dead_id) enqueue_notification_locked(notify, dead_id);
}

static DHName *name_locked(DHTask *task, uint32_t name) {
  if (name == 0 || name > DH_MAX_NAMES_PER_TASK) return NULL;
  DHName *entry = &task->names[name - 1];
  return entry->port_id == 0 && entry->set_id == 0 ? NULL : entry;
}

static int alloc_name_locked(DHTask *task, uint32_t port_id, uint32_t rights, uint32_t *out_name) {
  for (uint32_t offset = 0; offset < DH_MAX_NAMES_PER_TASK; ++offset) {
    uint32_t index = (task->next_name + offset) % DH_MAX_NAMES_PER_TASK;
    if (task->names[index].port_id == 0) {
      task->names[index].port_id = port_id;
      task->names[index].set_id = 0;
      task->names[index].rights = rights;
      task->next_name = (index + 1) % DH_MAX_NAMES_PER_TASK;
      if (out_name != NULL) *out_name = index + 1;
      return DH_OK;
    }
  }
  return DH_ERR_NO_SPACE;
}

static int alloc_set_name_locked(DHTask *task, uint32_t set_id, uint32_t *out_name) {
  for (uint32_t offset = 0; offset < DH_MAX_NAMES_PER_TASK; ++offset) {
    uint32_t index = (task->next_name + offset) % DH_MAX_NAMES_PER_TASK;
    if (task->names[index].port_id == 0 && task->names[index].set_id == 0) {
      task->names[index].set_id = set_id;
      task->names[index].rights = DH_RIGHT_RECEIVE | DH_RIGHT_PORT_SET;
      task->next_name = (index + 1) % DH_MAX_NAMES_PER_TASK;
      if (out_name != NULL) *out_name = index + 1;
      return DH_OK;
    }
  }
  return DH_ERR_NO_SPACE;
}

static DHMessagePort *set_ready_port_locked(DHSet *set) {
  if (set == NULL) return NULL;
  for (uint32_t index = 0; index < set->count; ++index) {
    DHMessagePort *port = port_locked(set->members[index]);
    if (port != NULL && port->count > 0) return port;
  }
  return NULL;
}

static void remove_name_locked(DHTask *task, uint32_t name) {
  if (name == 0 || name > DH_MAX_NAMES_PER_TASK) return;
  memset(&task->names[name - 1], 0, sizeof(DHName));
}

static int copy_string(char *destination, size_t capacity, const char *source) {
  if (destination == NULL || capacity == 0 || source == NULL) return DH_ERR_INVALID_ARGUMENT;
  size_t length = strlen(source);
  if (length >= capacity) return DH_ERR_INVALID_ARGUMENT;
  memcpy(destination, source, length + 1);
  return DH_OK;
}

uint32_t dh_abi_version(void) { return DH_ABI_VERSION; }

static void kernel_reset_locked(void) {
  for (size_t index = 0; index < DH_MAX_PORTS; ++index) {
    if (g_ports[index].used) free_messages_locked(&g_ports[index]);
  }
  memset(g_tasks, 0, sizeof(g_tasks));
  memset(g_ports, 0, sizeof(g_ports));
  memset(g_services, 0, sizeof(g_services));
  memset(g_threads, 0, sizeof(g_threads));
  memset(g_sets, 0, sizeof(g_sets));
  for (size_t index = 0; index < DH_MAX_MEMORY_OBJECTS; ++index) {
    free(g_memory[index].data);
  }
  memset(g_memory, 0, sizeof(g_memory));
  memset(g_mappings, 0, sizeof(g_mappings));
  g_next_mapping_address = 0x10000000ull;
  g_next_task_id = 1;
  g_next_thread_id = 1;
  g_message_count = 0;
  DHMessagePort *boot = alloc_port_locked("bootstrap", 0);
  g_boot_port_id = boot == NULL ? 0 : boot->id;
}

int dh_kernel_reset(void) {
  pthread_mutex_lock(&g_lock);
  kernel_reset_locked();
  pthread_cond_broadcast(&g_cond);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_task_create(uint32_t pid, uint32_t *out_task) {
  if (out_task == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  if (g_boot_port_id == 0) kernel_reset_locked();
  DHTask *task = NULL;
  for (size_t index = 0; index < DH_MAX_TASKS; ++index) {
    if (!g_tasks[index].used) {
      task = &g_tasks[index];
      memset(task, 0, sizeof(*task));
      task->used = 1;
      task->id = g_next_task_id++;
      task->pid = pid;
      break;
    }
  }
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  DHMessagePort *task_port = alloc_port_locked("task", task->id);
  if (task_port == NULL) {
    task->used = 0;
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  uint32_t name = 0;
  int status = alloc_name_locked(task, task_port->id, DH_RIGHT_RECEIVE | DH_RIGHT_SEND, &name);
  if (status != DH_OK || name != 1) {
    destroy_port_locked(task_port);
    task->used = 0;
    pthread_mutex_unlock(&g_lock);
    return status == DH_OK ? DH_ERR_STATE : status;
  }
  status = alloc_name_locked(task, g_boot_port_id, DH_RIGHT_SEND, &name);
  if (status != DH_OK || name != 2) {
    task->used = 0;
    pthread_mutex_unlock(&g_lock);
    return status == DH_OK ? DH_ERR_STATE : status;
  }
  *out_task = task->id;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_task_destroy(uint32_t task_id) {
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  for (uint32_t name = 1; name <= DH_MAX_NAMES_PER_TASK; ++name) {
    DHName *entry = name_locked(task, name);
    if (entry == NULL) continue;
    if (entry->set_id != 0) {
      DHSet *set = set_locked(entry->set_id);
      if (set != NULL && set->owner == task->id) memset(set, 0, sizeof(*set));
    } else if ((entry->rights & DH_RIGHT_RECEIVE) != 0) {
      DHMessagePort *port = port_locked(entry->port_id);
      if (port != NULL && port->receive_owner == task->id) destroy_port_locked(port);
    }
    remove_name_locked(task, name);
  }
  for (size_t index = 0; index < DH_MAX_MAPPINGS; ++index) {
    if (g_mappings[index].used && g_mappings[index].task_id == task->id) {
      g_mappings[index].used = 0;
    }
  }
  for (size_t index = 0; index < DH_MAX_THREADS; ++index) {
    if (g_threads[index].used && g_threads[index].task_id == task->id) {
      g_threads[index].state = DH_THREAD_TERMINATED;
      DHMessagePort *thread_port = port_locked(g_threads[index].port_id);
      if (thread_port != NULL) destroy_port_locked(thread_port);
      memset(&g_threads[index], 0, sizeof(g_threads[index]));
    }
  }
  task->used = 0;
  task->interrupted = 0;
  pthread_cond_broadcast(&g_cond);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_task_interrupt(uint32_t task_id) {
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  task->interrupted = 1;
  pthread_cond_broadcast(&g_cond);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_port_create_receive(uint32_t task_id, const char *label, uint32_t *out_name) {
  if (out_name == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHMessagePort *port = alloc_port_locked(label, task_id);
  if (port == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  int status = alloc_name_locked(task, port->id, DH_RIGHT_RECEIVE, out_name);
  if (status != DH_OK) destroy_port_locked(port);
  pthread_mutex_unlock(&g_lock);
  return status;
}

int dh_reply_port(uint32_t task_id, uint32_t *out_name) {
  if (out_name == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHMessagePort *port = alloc_port_locked("reply", task_id);
  if (port == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  int status = alloc_name_locked(task, port->id, DH_RIGHT_RECEIVE | DH_RIGHT_SEND, out_name);
  if (status != DH_OK) destroy_port_locked(port);
  pthread_mutex_unlock(&g_lock);
  return status;
}

int dh_port_make_send(uint32_t task_id, uint32_t port_id, uint32_t *out_name) {
  if (out_name == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  if (port_locked(port_id) == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  int status = alloc_name_locked(task, port_id, DH_RIGHT_SEND, out_name);
  pthread_mutex_unlock(&g_lock);
  return status;
}

int dh_name_port_id(uint32_t task_id, uint32_t name, uint32_t *out_port_id) {
  if (out_port_id == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *entry = name_locked(task, name);
  if (entry == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  *out_port_id = entry->port_id;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_name_deallocate(uint32_t task_id, uint32_t name) {
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *entry = name_locked(task, name);
  if (entry == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if (entry->set_id != 0) {
    DHSet *set = set_locked(entry->set_id);
    if (set != NULL && set->owner == task->id) memset(set, 0, sizeof(*set));
  } else if ((entry->rights & DH_RIGHT_RECEIVE) != 0) {
    DHMessagePort *port = port_locked(entry->port_id);
    if (port != NULL && port->receive_owner == task->id) destroy_port_locked(port);
  }
  remove_name_locked(task, name);
  pthread_cond_broadcast(&g_cond);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_thread_create(uint32_t task_id, uint32_t *out_thread, uint32_t *out_port_name) {
  if (out_thread == NULL || out_port_name == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHThread *thread = NULL;
  for (size_t index = 0; index < DH_MAX_THREADS; ++index) {
    if (!g_threads[index].used) {
      thread = &g_threads[index];
      break;
    }
  }
  if (thread == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  DHMessagePort *port = alloc_port_locked("thread", task->id);
  if (port == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  uint32_t name = 0;
  int status = alloc_name_locked(task, port->id, DH_RIGHT_RECEIVE | DH_RIGHT_SEND, &name);
  if (status != DH_OK) {
    destroy_port_locked(port);
    pthread_mutex_unlock(&g_lock);
    return status;
  }
  memset(thread, 0, sizeof(*thread));
  thread->used = 1;
  thread->id = g_next_thread_id++;
  thread->task_id = task_id;
  thread->port_id = port->id;
  thread->state = DH_THREAD_RUNNABLE;
  *out_thread = thread->id;
  *out_port_name = name;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_thread_terminate(uint32_t task_id, uint32_t thread_id) {
  pthread_mutex_lock(&g_lock);
  DHThread *thread = thread_locked(task_id, thread_id);
  if (thread == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  thread->state = DH_THREAD_TERMINATED;
  pthread_cond_broadcast(&g_cond);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_thread_join(uint32_t task_id, uint32_t thread_id, uint32_t timeout_ms) {
  pthread_mutex_lock(&g_lock);
  DHThread *thread = thread_locked(task_id, thread_id);
  if (thread == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  struct timespec deadline;
  if (timeout_ms != DH_TIMEOUT_NONE && timeout_ms != DH_TIMEOUT_FOREVER) {
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += (time_t)(timeout_ms / 1000u);
    deadline.tv_nsec += (long)(timeout_ms % 1000u) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
      deadline.tv_sec += 1;
      deadline.tv_nsec -= 1000000000L;
    }
  }
  while (thread->state != DH_THREAD_TERMINATED) {
    if (timeout_ms == DH_TIMEOUT_NONE) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_TIMEOUT;
    }
    int wait_status = timeout_ms == DH_TIMEOUT_FOREVER
                          ? pthread_cond_wait(&g_cond, &g_lock)
                          : pthread_cond_timedwait(&g_cond, &g_lock, &deadline);
    thread = thread_locked(task_id, thread_id);
    if (thread == NULL) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_NAME;
    }
    if (wait_status == ETIMEDOUT && thread->state != DH_THREAD_TERMINATED) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_TIMEOUT;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_thread_state(uint32_t task_id, uint32_t thread_id, uint32_t *out_state) {
  if (out_state == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHThread *thread = thread_locked(task_id, thread_id);
  if (thread == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  *out_state = thread->state;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_port_set_create(uint32_t task_id, const uint32_t *ports, uint32_t count, uint32_t *out_name) {
  if (out_name == NULL || (count > 0 && ports == NULL) || count > DH_MAX_SET_MEMBERS) {
    return DH_ERR_INVALID_ARGUMENT;
  }
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHSet *set = NULL;
  for (size_t index = 0; index < DH_MAX_PORT_SETS; ++index) {
    if (!g_sets[index].used) {
      set = &g_sets[index];
      break;
    }
  }
  if (set == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  memset(set, 0, sizeof(*set));
  for (uint32_t index = 0; index < count; ++index) {
    DHName *entry = name_locked(task, ports[index]);
    if (entry == NULL || entry->set_id != 0 || (entry->rights & DH_RIGHT_RECEIVE) == 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_RIGHT;
    }
    set->members[set->count++] = entry->port_id;
  }
  set->used = 1;
  set->id = (uint32_t)(set - g_sets) + 1;
  set->owner = task_id;
  int status = alloc_set_name_locked(task, set->id, out_name);
  if (status != DH_OK) memset(set, 0, sizeof(*set));
  pthread_mutex_unlock(&g_lock);
  return status;
}

int dh_port_set_add(uint32_t task_id, uint32_t set_name, uint32_t port_name) {
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *set_entry = name_locked(task, set_name);
  if (set_entry == NULL || set_entry->set_id == 0) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  DHName *port_entry = name_locked(task, port_name);
  if (port_entry == NULL || port_entry->set_id != 0 || (port_entry->rights & DH_RIGHT_RECEIVE) == 0) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_RIGHT;
  }
  DHSet *set = set_locked(set_entry->set_id);
  if (set == NULL || set->count >= DH_MAX_SET_MEMBERS) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  for (uint32_t index = 0; index < set->count; ++index) {
    if (set->members[index] == port_entry->port_id) {
      pthread_mutex_unlock(&g_lock);
      return DH_OK;
    }
  }
  set->members[set->count++] = port_entry->port_id;
  pthread_cond_broadcast(&g_cond);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_port_set_remove(uint32_t task_id, uint32_t set_name, uint32_t port_name) {
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *set_entry = name_locked(task, set_name);
  DHName *port_entry = name_locked(task, port_name);
  if (set_entry == NULL || set_entry->set_id == 0 || port_entry == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  DHSet *set = set_locked(set_entry->set_id);
  if (set == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  for (uint32_t index = 0; index < set->count; ++index) {
    if (set->members[index] == port_entry->port_id) {
      set->members[index] = set->members[set->count - 1];
      set->count -= 1;
      pthread_mutex_unlock(&g_lock);
      return DH_OK;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return DH_ERR_NOT_FOUND;
}

int dh_port_register_dead_name(uint32_t task_id, uint32_t port_name, uint32_t notify_name) {
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *port_entry = name_locked(task, port_name);
  DHName *notify_entry = name_locked(task, notify_name);
  if (port_entry == NULL || port_entry->set_id != 0 || (port_entry->rights & DH_RIGHT_RECEIVE) == 0 ||
      notify_entry == NULL || notify_entry->set_id != 0 ||
      (notify_entry->rights & (DH_RIGHT_SEND | DH_RIGHT_SEND_ONCE)) == 0) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_RIGHT;
  }
  DHMessagePort *port = port_locked(port_entry->port_id);
  if (port == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  port->dead_notify_port = notify_entry->port_id;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

static DHMemory *memory_locked(uint32_t id) {
  for (size_t index = 0; index < DH_MAX_MEMORY_OBJECTS; ++index) {
    if (g_memory[index].used && g_memory[index].id == id) return &g_memory[index];
  }
  return NULL;
}

int dh_memory_create(uint32_t size, uint32_t *out_id) {
  if (out_id == NULL || size == 0 || size > 16u * 1024u * 1024u) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  for (size_t index = 0; index < DH_MAX_MEMORY_OBJECTS; ++index) {
    if (!g_memory[index].used) {
      uint8_t *data = calloc(1, size);
      if (data == NULL) {
        pthread_mutex_unlock(&g_lock);
        return DH_ERR_NO_SPACE;
      }
      g_memory[index].used = 1;
      g_memory[index].id = (uint32_t)index + 1;
      g_memory[index].size = size;
      g_memory[index].data = data;
      *out_id = g_memory[index].id;
      pthread_mutex_unlock(&g_lock);
      return DH_OK;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return DH_ERR_NO_SPACE;
}

int dh_memory_destroy(uint32_t id) {
  pthread_mutex_lock(&g_lock);
  DHMemory *memory = memory_locked(id);
  if (memory == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  for (size_t index = 0; index < DH_MAX_MAPPINGS; ++index) {
    if (g_mappings[index].used && g_mappings[index].memory_id == id) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_STATE;
    }
  }
  free(memory->data);
  memset(memory, 0, sizeof(*memory));
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_memory_size(uint32_t id, uint32_t *out_size) {
  if (out_size == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHMemory *memory = memory_locked(id);
  if (memory == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  *out_size = memory->size;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_memory_write(uint32_t id, uint32_t offset, const uint8_t *data, uint32_t length) {
  if (length > 0 && data == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHMemory *memory = memory_locked(id);
  if (memory == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if (offset > memory->size || length > memory->size - offset) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_ARGUMENT;
  }
  if (length > 0) memcpy(memory->data + offset, data, length);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_memory_read(uint32_t id, uint32_t offset, uint8_t *data, uint32_t capacity, uint32_t *out_length) {
  if (out_length == NULL || (capacity > 0 && data == NULL)) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHMemory *memory = memory_locked(id);
  if (memory == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if (offset > memory->size) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_ARGUMENT;
  }
  uint32_t length = memory->size - offset;
  if (length > capacity) length = capacity;
  if (length > 0) memcpy(data, memory->data + offset, length);
  *out_length = length;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_memory_clone(uint32_t id, uint32_t *out_id) {
  if (out_id == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHMemory *source = memory_locked(id);
  if (source == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  for (size_t index = 0; index < DH_MAX_MEMORY_OBJECTS; ++index) {
    if (!g_memory[index].used) {
      uint8_t *data = malloc(source->size);
      if (data == NULL) {
        pthread_mutex_unlock(&g_lock);
        return DH_ERR_NO_SPACE;
      }
      memcpy(data, source->data, source->size);
      g_memory[index].used = 1;
      g_memory[index].id = (uint32_t)index + 1;
      g_memory[index].size = source->size;
      g_memory[index].data = data;
      *out_id = g_memory[index].id;
      pthread_mutex_unlock(&g_lock);
      return DH_OK;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return DH_ERR_NO_SPACE;
}

int dh_memory_map(uint32_t task_id, uint32_t id, uint64_t address, uint32_t *out_address) {
  if (out_address == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  DHMemory *memory = memory_locked(id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  if (memory == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  DHMapping *slot = NULL;
  for (size_t index = 0; index < DH_MAX_MAPPINGS; ++index) {
    if (!g_mappings[index].used) {
      slot = &g_mappings[index];
      break;
    }
  }
  if (slot == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  if (address == 0) {
    address = (g_next_mapping_address + 0xfffull) & ~0xfffull;
  }
  for (size_t index = 0; index < DH_MAX_MAPPINGS; ++index) {
    DHMapping *other = &g_mappings[index];
    if (other->used && other->task_id == task_id && address < other->address + other->size &&
        address + memory->size > other->address) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_STATE;
    }
  }
  slot->used = 1;
  slot->task_id = task_id;
  slot->memory_id = id;
  slot->address = address;
  slot->size = memory->size;
  g_next_mapping_address = address + memory->size;
  *out_address = address;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

static DHMapping *mapping_locked(uint32_t task_id, uint64_t address) {
  for (size_t index = 0; index < DH_MAX_MAPPINGS; ++index) {
    DHMapping *mapping = &g_mappings[index];
    if (mapping->used && mapping->task_id == task_id && address >= mapping->address &&
        address < mapping->address + mapping->size) {
      return mapping;
    }
  }
  return NULL;
}

int dh_memory_unmap(uint32_t task_id, uint64_t address) {
  pthread_mutex_lock(&g_lock);
  DHMapping *mapping = mapping_locked(task_id, address);
  if (mapping == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  mapping->used = 0;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_memory_write_at(uint32_t task_id, uint64_t address, const uint8_t *data, uint32_t length) {
  if (length > 0 && data == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHMapping *mapping = mapping_locked(task_id, address);
  if (mapping == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  uint32_t offset = (uint32_t)(address - mapping->address);
  DHMemory *memory = memory_locked(mapping->memory_id);
  if (memory == NULL || length > memory->size - offset) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_ARGUMENT;
  }
  if (length > 0) memcpy(memory->data + offset, data, length);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_memory_read_at(uint32_t task_id, uint64_t address, uint8_t *data, uint32_t capacity, uint32_t *out_length) {
  if (out_length == NULL || (capacity > 0 && data == NULL)) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHMapping *mapping = mapping_locked(task_id, address);
  if (mapping == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  uint32_t offset = (uint32_t)(address - mapping->address);
  DHMemory *memory = memory_locked(mapping->memory_id);
  if (memory == NULL || offset > memory->size) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_ARGUMENT;
  }
  uint32_t length = memory->size - offset;
  if (length > capacity) length = capacity;
  if (length > 0) memcpy(data, memory->data + offset, length);
  *out_length = length;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_service_register(uint32_t task_id, const char *service, uint32_t name) {
  if (service == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *entry = name_locked(task, name);
  if (entry == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if ((entry->rights & DH_RIGHT_RECEIVE) == 0) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_RIGHT;
  }
  for (size_t index = 0; index < DH_MAX_SERVICES; ++index) {
    if (g_services[index].used && strcmp(g_services[index].name, service) == 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_DUPLICATE_SERVICE;
    }
  }
  for (size_t index = 0; index < DH_MAX_SERVICES; ++index) {
    if (!g_services[index].used) {
      if (copy_string(g_services[index].name, sizeof(g_services[index].name), service) != DH_OK) {
        pthread_mutex_unlock(&g_lock);
        return DH_ERR_INVALID_ARGUMENT;
      }
      g_services[index].used = 1;
      g_services[index].port_id = entry->port_id;
      pthread_mutex_unlock(&g_lock);
      return DH_OK;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return DH_ERR_NO_SPACE;
}

int dh_service_lookup(uint32_t task_id, const char *service, uint32_t *out_name) {
  if (service == NULL || out_name == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  for (size_t index = 0; index < DH_MAX_SERVICES; ++index) {
    if (g_services[index].used && strcmp(g_services[index].name, service) == 0) {
      int status = alloc_name_locked(task, g_services[index].port_id, DH_RIGHT_SEND, out_name);
      pthread_mutex_unlock(&g_lock);
      return status;
    }
  }
  pthread_mutex_unlock(&g_lock);
  return DH_ERR_NOT_FOUND;
}

static int send_impl(uint32_t task_id, uint32_t remote, uint32_t local, int32_t message_id,
                     const uint32_t *words, uint32_t count, uint32_t transfer_name,
                     uint32_t disposition) {
  if (count > DH_MAX_MESSAGE_WORDS || (count > 0 && words == NULL)) return DH_ERR_INVALID_ARGUMENT;
  if (transfer_name != 0 && disposition != DH_PORT_DISPOSITION_COPY_SEND &&
      disposition != DH_PORT_DISPOSITION_MAKE_SEND &&
      disposition != DH_PORT_DISPOSITION_MAKE_SEND_ONCE) {
    return DH_ERR_INVALID_ARGUMENT;
  }
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *destination = name_locked(task, remote);
  if (destination == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if ((destination->rights & (DH_RIGHT_SEND | DH_RIGHT_SEND_ONCE)) == 0) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_RIGHT;
  }
  uint32_t reply_port = 0;
  if (local != 0) {
    DHName *reply = name_locked(task, local);
    if (reply == NULL || (reply->rights & (DH_RIGHT_SEND | DH_RIGHT_SEND_ONCE)) == 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_RIGHT;
    }
    reply_port = reply->port_id;
  }
  uint32_t transfer_port = 0;
  if (transfer_name != 0) {
    DHName *transfer = name_locked(task, transfer_name);
    if (transfer == NULL || transfer->set_id != 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_NAME;
    }
    if (disposition == DH_PORT_DISPOSITION_COPY_SEND &&
        (transfer->rights & DH_RIGHT_SEND) == 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_RIGHT;
    }
    if (disposition == DH_PORT_DISPOSITION_MAKE_SEND &&
        (transfer->rights & DH_RIGHT_RECEIVE) == 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_RIGHT;
    }
    if (disposition == DH_PORT_DISPOSITION_MAKE_SEND_ONCE &&
        (transfer->rights & (DH_RIGHT_SEND | DH_RIGHT_RECEIVE)) == 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_RIGHT;
    }
    transfer_port = transfer->port_id;
  }
  DHMessagePort *port = port_locked(destination->port_id);
  if (port == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if (port->count >= DH_MAX_QUEUE_DEPTH) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_QUEUE_FULL;
  }

  size_t size = sizeof(DHMessage) + (size_t)count * sizeof(uint32_t);
  DHMessage *message = malloc(size);
  if (message == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_NO_SPACE;
  }
  message->next = NULL;
  message->message_id = message_id;
  message->sender_task = task->id;
  message->reply_port = reply_port;
  message->transfer_port = transfer_port;
  message->transfer_disposition = transfer_port != 0 ? disposition : 0;
  message->count = count;
  if (count > 0) memcpy(message->words, words, (size_t)count * sizeof(uint32_t));
  if (port->last == NULL) {
    port->first = message;
  } else {
    port->last->next = message;
  }
  port->last = message;
  port->count += 1;
  g_message_count += 1;
  if ((destination->rights & DH_RIGHT_SEND_ONCE) != 0) remove_name_locked(task, remote);
  pthread_cond_broadcast(&g_cond);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_send(uint32_t task_id, uint32_t remote, uint32_t local, int32_t message_id,
            const uint32_t *words, uint32_t count) {
  return send_impl(task_id, remote, local, message_id, words, count, 0, 0);
}

int dh_send_port(uint32_t task_id, uint32_t remote, uint32_t local, int32_t message_id,
                 const uint32_t *words, uint32_t count, uint32_t transfer_name,
                 uint32_t disposition) {
  return send_impl(task_id, remote, local, message_id, words, count, transfer_name, disposition);
}

static int receive_impl(uint32_t task_id, uint32_t name, uint32_t *out_words, uint32_t out_capacity,
                        uint32_t *out_count, uint32_t *out_remote, uint32_t *out_local,
                        int32_t *out_message_id, uint32_t timeout_ms, uint32_t *out_transfer_name) {
  if (out_count == NULL || out_remote == NULL || out_local == NULL || out_message_id == NULL ||
      (out_capacity > 0 && out_words == NULL)) {
    return DH_ERR_INVALID_ARGUMENT;
  }
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  if (task == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_TASK;
  }
  DHName *entry = name_locked(task, name);
  if (entry == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if ((entry->rights & DH_RIGHT_RECEIVE) == 0) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_RIGHT;
  }
  DHSet *set = entry->set_id != 0 ? set_locked(entry->set_id) : NULL;
  DHMessagePort *port = entry->set_id == 0 ? port_locked(entry->port_id) : NULL;
  if (entry->set_id != 0 && set == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if (entry->set_id == 0 && port == NULL) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INVALID_NAME;
  }
  if (task->interrupted) {
    task->interrupted = 0;
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_INTERRUPTED;
  }

  struct timespec deadline;
  if (timeout_ms != DH_TIMEOUT_NONE && timeout_ms != DH_TIMEOUT_FOREVER) {
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += (time_t)(timeout_ms / 1000u);
    deadline.tv_nsec += (long)(timeout_ms % 1000u) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
      deadline.tv_sec += 1;
      deadline.tv_nsec -= 1000000000L;
    }
  }

  while (1) {
    if (entry->set_id != 0) {
      port = set_ready_port_locked(set);
      if (port != NULL) break;
    } else if (port != NULL && port->count > 0) {
      break;
    }
    if (timeout_ms == DH_TIMEOUT_NONE) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_TIMEOUT;
    }
    int wait_status = timeout_ms == DH_TIMEOUT_FOREVER
                          ? pthread_cond_wait(&g_cond, &g_lock)
                          : pthread_cond_timedwait(&g_cond, &g_lock, &deadline);
    task = task_locked(task_id);
    if (task == NULL) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_TASK;
    }
    entry = name_locked(task, name);
    if (entry == NULL || (entry->rights & DH_RIGHT_RECEIVE) == 0) {
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INVALID_NAME;
    }
    if (entry->set_id != 0) {
      set = set_locked(entry->set_id);
      port = NULL;
      if (set == NULL) {
        pthread_mutex_unlock(&g_lock);
        return DH_ERR_INVALID_NAME;
      }
    } else {
      port = port_locked(entry->port_id);
      set = NULL;
      if (port == NULL) {
        pthread_mutex_unlock(&g_lock);
        return DH_ERR_INVALID_NAME;
      }
    }
    if (task->interrupted) {
      task->interrupted = 0;
      pthread_mutex_unlock(&g_lock);
      return DH_ERR_INTERRUPTED;
    }
    if (wait_status == ETIMEDOUT) {
      DHMessagePort *ready = set != NULL ? set_ready_port_locked(set) : (port->count > 0 ? port : NULL);
      if (ready == NULL) {
        pthread_mutex_unlock(&g_lock);
        return DH_ERR_TIMEOUT;
      }
    }
  }

  DHMessage *message = port->first;
  if (out_capacity < message->count) {
    pthread_mutex_unlock(&g_lock);
    return DH_ERR_MESSAGE_TOO_LARGE;
  }
  port->first = message->next;
  if (port->first == NULL) port->last = NULL;
  port->count -= 1;
  if (g_message_count > 0) g_message_count -= 1;

  *out_count = message->count;
  *out_remote = name;
  *out_message_id = message->message_id;
  *out_local = 0;
  if (message->count > 0) memcpy(out_words, message->words, (size_t)message->count * sizeof(uint32_t));
  if (message->reply_port != 0) {
    uint32_t reply_name = 0;
    if (alloc_name_locked(task, message->reply_port, DH_RIGHT_SEND, &reply_name) == DH_OK) {
      *out_local = reply_name;
    }
  }
  if (out_transfer_name != NULL) {
    *out_transfer_name = 0;
    if (message->transfer_port != 0) {
      uint32_t rights = message->transfer_disposition == DH_PORT_DISPOSITION_MAKE_SEND_ONCE
                            ? DH_RIGHT_SEND_ONCE
                            : DH_RIGHT_SEND;
      uint32_t transferred = 0;
      if (alloc_name_locked(task, message->transfer_port, rights, &transferred) == DH_OK) {
        *out_transfer_name = transferred;
      }
    }
  }
  free(message);
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

int dh_receive(uint32_t task_id, uint32_t name, uint32_t *out_words, uint32_t out_capacity,
               uint32_t *out_count, uint32_t *out_remote, uint32_t *out_local,
               int32_t *out_message_id, uint32_t timeout_ms) {
  return receive_impl(task_id, name, out_words, out_capacity, out_count, out_remote, out_local,
                      out_message_id, timeout_ms, NULL);
}

int dh_receive_port(uint32_t task_id, uint32_t name, uint32_t *out_words, uint32_t out_capacity,
                    uint32_t *out_count, uint32_t *out_remote, uint32_t *out_local,
                    int32_t *out_message_id, uint32_t timeout_ms, uint32_t *out_transfer_name) {
  return receive_impl(task_id, name, out_words, out_capacity, out_count, out_remote, out_local,
                      out_message_id, timeout_ms, out_transfer_name);
}

int dh_kernel_stats(uint32_t *out_tasks, uint32_t *out_ports, uint32_t *out_messages) {
  if (out_tasks == NULL || out_ports == NULL || out_messages == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  uint32_t tasks = 0;
  uint32_t ports = 0;
  for (size_t index = 0; index < DH_MAX_TASKS; ++index) {
    if (g_tasks[index].used) tasks += 1;
  }
  for (size_t index = 0; index < DH_MAX_PORTS; ++index) {
    if (g_ports[index].used) ports += 1;
  }
  *out_tasks = tasks;
  *out_ports = ports;
  *out_messages = g_message_count;
  pthread_mutex_unlock(&g_lock);
  return DH_OK;
}

typedef struct {
  uint32_t task;
  uint32_t port;
  uint32_t reply;
  uint32_t interrupt_only;
  int result;
} SelfTestArgs;

static void *selftest_thread(void *raw) {
  SelfTestArgs *args = (SelfTestArgs *)raw;
  struct timespec delay = {0, 20 * 1000 * 1000};
  nanosleep(&delay, NULL);
  if (args->interrupt_only) {
    args->result = dh_task_interrupt(args->task);
    return NULL;
  }
  uint32_t words[2] = {0xfeed, 0xbeef};
  args->result = dh_send(args->task, args->port, args->reply, 77, words, 2);
  return NULL;
}

static int run_selftest(int interrupt_only) {
  uint32_t task = 0;
  if (dh_task_create(42, &task) != DH_OK) return 2;
  uint32_t receive_name = 0;
  if (dh_port_create_receive(task, "selftest", &receive_name) != DH_OK) return 3;
  uint32_t reply_name = 0;
  if (dh_reply_port(task, &reply_name) != DH_OK) return 4;
  uint32_t receive_port = 0;
  if (dh_name_port_id(task, receive_name, &receive_port) != DH_OK) return 10;
  uint32_t send_name = 0;
  if (dh_port_make_send(task, receive_port, &send_name) != DH_OK) return 11;

  SelfTestArgs args = {.task = task, .port = send_name, .reply = reply_name,
                       .interrupt_only = interrupt_only, .result = -1};
  pthread_t thread;
  if (pthread_create(&thread, NULL, selftest_thread, &args) != 0) return 5;

  uint32_t words[4] = {0};
  uint32_t count = 0;
  uint32_t remote = 0;
  uint32_t local = 0;
  int32_t message_id = 0;
  int status = dh_receive(task, receive_name, words, 4, &count, &remote, &local, &message_id,
                          DH_TIMEOUT_FOREVER);
  pthread_join(thread, NULL);
  if (args.result != DH_OK) return 6;
  if (interrupt_only) {
    if (status != DH_ERR_INTERRUPTED) return 7;
  } else {
    if (status != DH_OK || count != 2 || words[0] != 0xfeed || words[1] != 0xbeef) return 8;
    if (message_id != 77 || local == 0) return 9;
  }
  dh_task_destroy(task);
  return 0;
}

typedef struct {
  int32_t number;
  const char *name;
  int implemented;
} DHTrapEntry;

static const DHTrapEntry g_traps[] = {
    {-26, "mach_reply_port", 1},
    {-27, "thread_self_trap", 1},
    {-28, "task_self_trap", 1},
    {-29, "host_self_trap", 0},
    {-31, "mach_msg_trap", 0},
    {-32, "mach_msg_overwrite_trap", 0},
};

uint32_t dh_trap_count(void) { return (uint32_t)(sizeof(g_traps) / sizeof(g_traps[0])); }

int32_t dh_trap_number(uint32_t index) {
  return index < dh_trap_count() ? g_traps[index].number : 0;
}

int dh_trap_implemented(uint32_t index) {
  return index < dh_trap_count() ? g_traps[index].implemented : 0;
}

int dh_trap_dispatch(uint32_t task_id, int32_t trap, uint32_t *out_value) {
  if (out_value == NULL) return DH_ERR_INVALID_ARGUMENT;
  pthread_mutex_lock(&g_lock);
  DHTask *task = task_locked(task_id);
  pthread_mutex_unlock(&g_lock);
  if (task == NULL) return DH_ERR_INVALID_TASK;
  if (trap == -26) {
    return dh_reply_port(task_id, out_value);
  }
  if (trap == -27 || trap == -28) {
    *out_value = 1;
    return DH_OK;
  }
  for (uint32_t index = 0; index < dh_trap_count(); ++index) {
    if (g_traps[index].number == trap) return DH_ERR_NOT_FOUND;
  }
  return DH_ERR_NOT_FOUND;
}

int dh_selftest_blocking(void) { return run_selftest(0); }
int dh_selftest_interrupt(void) { return run_selftest(1); }

int dh_selftest_threads(void) {
  uint32_t task = 0;
  if (dh_task_create(43, &task) != DH_OK) return 1;
  uint32_t threads[8] = {0};
  uint32_t ports[8] = {0};
  for (int index = 0; index < 8; ++index) {
    if (dh_thread_create(task, &threads[index], &ports[index]) != DH_OK) return 2;
    if (ports[index] == 0) return 3;
  }
  for (int index = 0; index < 4; ++index) {
    if (dh_thread_terminate(task, threads[index]) != DH_OK) return 4;
    if (dh_thread_join(task, threads[index], DH_TIMEOUT_NONE) != DH_OK) return 5;
  }
  for (int index = 4; index < 8; ++index) {
    uint32_t state = 0;
    if (dh_thread_state(task, threads[index], &state) != DH_OK) return 6;
    if (state != DH_THREAD_RUNNABLE) return 7;
  }
  dh_task_destroy(task);
  return 0;
}
