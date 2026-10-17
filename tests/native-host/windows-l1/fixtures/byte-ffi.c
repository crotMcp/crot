/* Actual pointer/struct ABI stand-in. NOT Windows isolation evidence. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
typedef struct { void *value; } HANDLE_OUT;
typedef struct { uint32_t length; void *descriptor; int inherit; } SECURITY;
typedef struct { uintptr_t internal, high; uint32_t offset, offsetHigh; void *event; } OVERLAPPED;
static uint32_t error = 0;
static int live = 0, invalid = 0;
static OVERLAPPED *pending = 0;
static uint8_t *target = 0;
static uint32_t length = 0;
static int cancelled = 0;
static void *last_event = 0, *failed_event = 0;
static void *last_server = 0, *last_child = 0, *last_descriptor = 0;
static int fail_setup = 0, fail_descriptor = 0;
void FailLastEventClose(int fails) { failed_event = fails ? last_event : 0; }
void FailByteSetup(int fails) { fail_setup = fails; }
void FailByteDescriptorFree(int fails) { fail_descriptor = fails; }
static void *handle(void) { live++; return malloc(8); }
int LiveByteHandles(void) { return live; }
int InvalidByteAbi(void) { return invalid; }
uint32_t GetLastError(void) { return error; }
int CloseHandle(void *h) { if (h && (h == failed_event || (fail_setup && (h == last_server || h == last_child)))) { error = 5; return 0; } if (!h || h == (void *)(intptr_t)-1) { invalid++; return 0; } free(h); live--; return 1; }
void *LocalFree(void *h) { if (h && h == last_descriptor && (fail_setup || fail_descriptor)) { error = 5; return h; } CloseHandle(h); return 0; }
int ConvertStringSecurityDescriptorToSecurityDescriptorW(uint16_t *text, uint32_t revision, HANDLE_OUT *out, void *size) {
  if (!text || text[0] != 'D' || revision != 1 || size) { invalid++; return 0; }
  out->value = last_descriptor = handle(); return 1;
}
void *CreateNamedPipeW(uint16_t *name, uint32_t access, uint32_t mode, uint32_t instances, uint32_t out, uint32_t in, uint32_t timeout, SECURITY *security) {
  if (!name || (access != 0x40080001 && access != 0x40080002) || mode != 8 || instances != 1 || out != 65536 || in != 65536 || timeout || security->length != 24 || !security->descriptor || security->inherit) { invalid++; return (void *)(intptr_t)-1; }
  last_child = 0; last_server = handle(); return last_server;
}
void *CreateFileW(uint16_t *name, uint32_t access, uint32_t share, void *security, uint32_t creation, uint32_t flags, void *template) {
  if (!name || (access != 0x80000000 && access != 0x40000000) || share || security || creation != 3 || flags || template) { invalid++; return (void *)(intptr_t)-1; }
  last_child = handle(); return last_child;
}
int SetHandleInformation(void *h, uint32_t mask, uint32_t flags) { if (!h || mask != 1 || flags) { invalid++; return 0; } if (fail_setup && h == last_child) { error = 5; return 0; } return 1; }
void *CreateEventW(void *security, int manual, int initial, uint16_t *name) { if (security || manual != 1 || initial || name) { invalid++; return 0; } last_event = handle(); return last_event; }
int ConnectNamedPipe(void *h, OVERLAPPED *overlap) { if (!h || !overlap->event || sizeof(OVERLAPPED) != 32) { invalid++; return 0; } pending = overlap; target = 0; length = 0; cancelled = 0; error = 997; return 0; }
int ReadFile(void *h, uint8_t *buffer, uint32_t size, void *count, OVERLAPPED *overlap) {
  if (!h || !buffer || !size || count || !overlap->event) { invalid++; error = 87; return 0; }
  pending = overlap; target = buffer; length = size; cancelled = 0; error = 997; return 0;
}
int WriteFile(void *h, uint8_t *buffer, uint32_t size, void *count, OVERLAPPED *overlap) {
  int r = ReadFile(h, buffer, size, count, overlap); target = 0; return r;
}
int GetOverlappedResult(void *h, OVERLAPPED *overlap, uint32_t *count, int wait) {
  if (!h || overlap != pending || !overlap->event || wait) { invalid++; error = 87; return 0; }
  if (cancelled) { error = 995; return 0; }
  if (target) memset(target, 0xa5, length);
  *count = length; return 1;
}
int CancelIoEx(void *h, OVERLAPPED *overlap) { if (!h || overlap != pending) { invalid++; error = 1168; return 0; } cancelled = 1; return 1; }
