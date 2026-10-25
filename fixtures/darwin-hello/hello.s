// Minimal arm64 Darwin program for the Option A smoke test.
//
// It uses raw BSD syscalls, so it needs no libSystem and no Apple frameworks.
// Build with scripts/build-native-fixtures.sh. The resulting Mach-O is generated
// locally and is not committed.

.globl _start
.p2align 2
_start:
    mov x0, #1              // fd 1
    adrp x1, message@PAGE
    add x1, x1, message@PAGEOFF
    mov x2, #message_len
    mov x16, #4             // SYS_write
    svc #0x80
    mov x0, #0              // exit status
    mov x16, #1             // SYS_exit
    svc #0x80

.data
message:
    .ascii "hello from a real Mach-O\n"
message_end:
.set message_len, message_end - message
