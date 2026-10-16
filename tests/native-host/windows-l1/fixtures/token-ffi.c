/* Native ABI stand-in, not a Windows security implementation. */
#include <stdint.h>
#include <stdlib.h>
typedef struct { void *value; } HANDLE_OUT;
typedef struct { uint32_t value; } DWORD_OUT;
typedef struct { void *Sid; uint32_t Attributes; } SID_ATTRIBUTES;
typedef struct { uint32_t read, write, exec, all; } MAPPING;
static int live = 0, fault = 0, last_restrict_count = 1;
static void *alloc(int value) { int *p = malloc(sizeof(int)); *p = value; live++; return p; }
void SetFault(int value) { fault = value; }
int LiveAllocations(void) { return live; }
void *GetCurrentProcess(void) { return (void *)(intptr_t)-1; }
uint32_t GetLastError(void) { return 5; }
static int close_counts[10] = {0};
void ResetCloseCounters(void) { for (int i = 0; i < 10; i++) close_counts[i] = 0; }
int CloseCount(int kind) { return kind >= 0 && kind < 10 ? close_counts[kind] : -1; }
int CloseHandle(void *h) {
  if (!h) return 0;
  int kind = *(int *)h;
  if (kind >= 0 && kind < 10) close_counts[kind]++;
  if ((fault == 21 && kind == 3) || (fault == 22 && kind == 4) ||
      (fault == 23 && (kind == 3 || kind == 4)) ||
      (fault == 24 && kind == 3) || (fault == 25 && kind == 1) ||
      (fault == 26 && kind == 2) || (fault == 27 && kind == 9)) return 0;
  free(h); live--; return 1;
}
void *LocalFree(void *p) { return CloseHandle(p) ? 0 : p; }
int OpenProcessToken(void *p, uint32_t access, HANDLE_OUT *out) {
  if (fault == 1 || access != 262283 || p != (void *)(intptr_t)-1) return 0;
  out->value = alloc(1); return 1;
}
int ConvertStringSidToSidW(uint16_t *sid, HANDLE_OUT *out) {
  if (fault == 2 || sid[0] != 'S') return 0;
  out->value = alloc(2); return 1;
}
int CreateRestrictedToken(void *src, uint32_t flags, uint32_t n1, void *p1, uint32_t n2, void *p2, uint32_t n3, SID_ATTRIBUTES *sid, HANDLE_OUT *out) {
  if (fault == 3 || !src || (flags != 1 && flags != 9) || n1 || p1 || n2 || p2 || (n3 != 0 && n3 != 1 && n3 != 4 && n3 != 5)) return 0;
  if (n3 == 0 && (flags != 1 || sid != NULL)) return 0;
  last_restrict_count = n3;
  for (uint32_t i = 0; i < n3; i++) if (!sid[i].Sid || sid[i].Attributes) return 0;
  out->value = alloc(3); return 1;
}
int IsTokenRestricted(void *token) { return fault == 4 ? 0 : (*(int *)token == 3 && last_restrict_count > 0); }
int DuplicateTokenEx(void *token, uint32_t access, void *attr, int level, int type, HANDLE_OUT *out) {
  if (fault == 5 || fault == 24 || *(int *)token != 3 || access != 12 || attr || level != 2 || type != 2) return 0;
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

/* Process ABI stand-in. Keeps order counters; executes no OS process. */
typedef struct {
  uint32_t cb; void *reserved, *desktop, *title;
  uint32_t x, y, xs, ys, xc, yc, fill, flags;
  uint16_t show, reserved2; void *pReserved2, *in, *out, *err;
} STARTUP;
typedef struct { void *process, *thread; uint32_t pid, tid; } PROCESS_INFORMATION;
static int creates = 0, resumes = 0, kills = 0, phase = 0, assigned = 0, suspend_queries = 0;
void ResetProcessCounters(void) { creates = resumes = kills = phase = assigned = suspend_queries = 0; }
void MarkJobAssigned(void) { assigned = 1; }
int ResumeCount(void) { return resumes; }
int KillCount(void) { return kills; }
int CreateCount(void) { return creates; }
int CreateProcessAsUserW(void *token, uint16_t *app, uint16_t *cmd, void *pa, void *ta, int inherit, uint32_t flags, uint16_t *env, uint16_t *cwd, STARTUP *si, PROCESS_INFORMATION *out) {
  creates++;
  if (fault == 9 || *(int *)token != 3 || !app || !cmd || pa || ta || inherit || flags != 0x08000404 || !env || !cwd || si->cb != sizeof(STARTUP) || si->flags || si->in || si->out || si->err) return 0;
  out->process = alloc(5); out->thread = alloc(6); out->pid = fault == 10 ? 0 : 42; out->tid = 43; phase = 0; return 1;
}
uint32_t ResumeThread(void *thread) {
  resumes++;
  if (fault == 11 || *(int *)thread != 6 || !assigned) return 0xffffffff;
  if (fault == 30) return 0;
  if (fault == 31) return 2;
  if (fault == 32 && suspend_queries < 3) return 2;
  phase = 1; return 1;
}
int TerminateProcess(void *process, uint32_t code) { kills++; if (fault == 19 || fault == 20) return 0; phase = 2; return *(int *)process == 5 && code == 1; }
uint32_t WaitForSingleObject(void *handle, uint32_t ms) { (void)handle; if (fault == 19 && ms == 5000) phase = 2; return phase == 2 ? 0 : 258; }
int CheckRemoteDebuggerPresent(void *process, DWORD_OUT *out) {
  if (*(int *)process != 5 || fault == 28) return 0;
  out->value = fault == 29 ? 2 : 1; return 1;
}
int32_t NtQueryInformationThread(void *thread, uint32_t kind, DWORD_OUT *out, uint32_t size, DWORD_OUT *returned) {
  suspend_queries++;
  if (*(int *)thread != 6 || kind != 35 || size != 4 || fault == 33) return (int32_t)0xc0000003;
  out->value = (fault == 32 && suspend_queries < 3) || fault == 36 ? 2 : fault == 34 ? 0 : fault == 37 ? 0xffffffff : 1;
  returned->value = fault == 35 ? 0 : 4;
  return 0;
}
int GetExitCodeProcess(void *process, DWORD_OUT *out) { if (*(int *)process != 5) return 0; out->value = 1; return 1; }

int ConvertStringSecurityDescriptorToSecurityDescriptorW(uint16_t *text, uint32_t revision, HANDLE_OUT *out, void *len) {
  if (fault == 12 || (text[0] != 'D' && text[0] != 'S') || revision != 1 || len) return 0;
  out->value = alloc(9); return 1;
}
int GetSecurityDescriptorDacl(void *sd, DWORD_OUT *present, HANDLE_OUT *acl, DWORD_OUT *defaulted) {
  if (fault == 13 || *(int *)sd != 9) return 0;
  present->value = 1; acl->value = sd; defaulted->value = 0; return 1;
}
int SetTokenInformation(void *token, int kind, HANDLE_OUT *dacl, uint32_t length) {
  if (*(int *)token != 3) return 0;
  if (kind == 25) {
    SID_ATTRIBUTES *label = (SID_ATTRIBUTES *)dacl;
    return fault != 16 && length == sizeof(SID_ATTRIBUTES) + 68 && label->Attributes == 0x20 && *(int *)label->Sid == 2;
  }
  return fault != 14 && kind == 6 && length == sizeof(void *) && *(int *)dacl->value == 9;
}

int SetKernelObjectSecurity(void *object, uint32_t info, void *sd) {
  return fault != 15 && *(int *)object == 3 && info == 4 && *(int *)sd == 9;
}

int GetSecurityDescriptorSacl(void *sd, DWORD_OUT *present, HANDLE_OUT *acl, DWORD_OUT *defaulted) {
  if (fault == 17 || *(int *)sd != 9) return 0;
  present->value = 1; acl->value = sd; defaulted->value = 0; return 1;
}
uint32_t SetNamedSecurityInfoW(uint16_t *path, int type, uint32_t info, void *owner, void *group, void *dacl, void *sacl) {
  if (fault == 18 || !path || type != 1 || info != 0x10 || owner || group || dacl || *(int *)sacl != 9) return 5;
  return 0;
}

/* Trusted factory seam ABI; no OS process is executed. */
int CreateFactoryProcess(PROCESS_INFORMATION *out){
 creates++;out->process=alloc(5);out->thread=alloc(6);out->pid=42;out->tid=43;phase=0;return 1;
}
