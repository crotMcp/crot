/* Native ABI stand-in, not a Windows security implementation. */
#include <stdint.h>
#include <stdlib.h>
typedef struct { void *value; } HANDLE_OUT;
typedef struct { uint32_t value; } DWORD_OUT;
typedef struct { void *Sid; uint32_t Attributes; } SID_ATTRIBUTES;
typedef struct { uint32_t read, write, exec, all; } MAPPING;
static int live = 0, fault = 0;
static void *alloc(int value) { int *p = malloc(sizeof(int)); *p = value; live++; return p; }
void SetFault(int value) { fault = value; }
int LiveAllocations(void) { return live; }
void *GetCurrentProcess(void) { return (void *)(intptr_t)-1; }
uint32_t GetLastError(void) { return 5; }
int CloseHandle(void *h) { if (!h) return 0; free(h); live--; return 1; }
void *LocalFree(void *p) { CloseHandle(p); return 0; }
int OpenProcessToken(void *p, uint32_t access, HANDLE_OUT *out) {
  if (fault == 1 || access != 10 || p != (void *)(intptr_t)-1) return 0;
  out->value = alloc(1); return 1;
}
int ConvertStringSidToSidW(uint16_t *sid, HANDLE_OUT *out) {
  if (fault == 2 || sid[0] != 'S') return 0;
  out->value = alloc(2); return 1;
}
int CreateRestrictedToken(void *src, uint32_t flags, uint32_t n1, void *p1, uint32_t n2, void *p2, uint32_t n3, SID_ATTRIBUTES *sid, HANDLE_OUT *out) {
  if (fault == 3 || !src || flags != 1 || n1 || p1 || n2 || p2 || n3 != 1 || !sid->Sid || sid->Attributes) return 0;
  out->value = alloc(3); return 1;
}
int IsTokenRestricted(void *token) { return fault == 4 ? 0 : (*(int *)token == 3); }
int DuplicateTokenEx(void *token, uint32_t access, void *attr, int level, int type, HANDLE_OUT *out) {
  if (fault == 5 || *(int *)token != 3 || access != 12 || attr || level != 2 || type != 2) return 0;
  out->value = alloc(4); return 1;
}
uint32_t GetNamedSecurityInfoW(uint16_t *file, int type, uint32_t info, void *o, void *g, void *d, void *s, HANDLE_OUT *out) {
  if (fault == 6 || type != 1 || info != 7 || o || g || d || s) return 5;
  int bits = 0;
  for (uint16_t *p = file; *p; p++) { if (*p == 'R') bits |= 1; if (*p == 'W') bits |= 2; }
  out->value = alloc(bits); return 0;
}
int AccessCheck(void *sd, void *token, uint32_t access, MAPPING *map, void *priv, DWORD_OUT *len, DWORD_OUT *granted, DWORD_OUT *allowed) {
  if (fault == 7 || *(int *)token != 4 || !priv || len->value != 4096 || map->read != 0x120089 || map->write != 0x120116) return 0;
  allowed->value = (*(int *)sd & access) == access;
  granted->value = allowed->value ? access : 0;
  if (fault == 8) { allowed->value = 1; granted->value = 0; }
  return 1;
}
