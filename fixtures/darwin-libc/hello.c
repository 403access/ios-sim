/* Freestanding C fixture for the Option A guest-libc shims (RT-010).
 *
 * It deliberately links no Apple libSystem: malloc/memcpy/strlen/memset and
 * write/exit go through the custom SYS_LIBC_* / Darwin traps implemented by
 * the compatibility kernel. This proves C code can run through the loader and
 * heap, not that Apple's libSystem ABI is complete.
 */

typedef unsigned long size_t;

static inline long sys3(long number, long a, long b, long c) {
  register long x16 __asm__("x16") = number;
  register long x0 __asm__("x0") = a;
  register long x1 __asm__("x1") = b;
  register long x2 __asm__("x2") = c;
  __asm__ volatile("svc #0x80" : "+r"(x0) : "r"(x16), "r"(x1), "r"(x2) : "memory");
  return x0;
}

void *malloc(size_t size) { return (void *)sys3(0x200, (long)size, 0, 0); }
void free(void *pointer) { sys3(0x201, (long)pointer, 0, 0); }
void *memcpy(void *destination, const void *source, size_t count) {
  return (void *)sys3(0x202, (long)destination, (long)source, (long)count);
}
size_t strlen(const char *text) { return (size_t)sys3(0x203, (long)text, 0, 0); }
void *memset(void *destination, int value, size_t count) {
  return (void *)sys3(0x204, (long)destination, value, (long)count);
}
void *realloc(void *pointer, size_t size) {
  return (void *)sys3(0x205, (long)pointer, (long)size, 0);
}
void *calloc(size_t count, size_t size) {
  return (void *)sys3(0x206, (long)count, (long)size, 0);
}

static long write_stdout(const char *text) {
  return sys3(4, 1, (long)text, (long)strlen(text));
}

void _start(void) {
  const char *message = "hello from a freestanding C fixture\n";
  char *copy = (char *)malloc(strlen(message) + 1);
  if (copy == 0) {
    write_stdout("malloc failed\n");
    sys3(1, 1, 0, 0);
    return;
  }
  memcpy(copy, message, strlen(message) + 1);
  write_stdout(copy);
  free(copy);
  sys3(1, 0, 0, 0);
}
