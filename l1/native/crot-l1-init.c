/*
 * crot-l1-init: PID 1 of every CROT L1 sandbox (ARCHITECTURE.md §27 AD-20 point 10).
 *
 * crot-bwrap starts it as the first process of the sandbox (--as-pid-1). It
 * talks to the CROT service over its own stdin/stdout only, the private
 * channel: no confined process inherits these descriptors (every command gets
 * fresh pipes, fds 0-2 are replaced and every other fd is closed before exec).
 *
 * Each command runs under its own shepherd, a child subreaper
 * (PR_SET_CHILD_SUBREAPER). Descendants that fork twice or call setsid() are
 * reparented to their shepherd, so the whole tree of one command is found
 * through /proc PPid links and ended by termination, process.manage stop and
 * the service's timeouts. When the service goes away (EOF on stdin, or
 * crot-bwrap's --die-with-parent), this process exits and the kernel ends
 * every process of the PID namespace.
 *
 * No policy lives here: what runs is decided by the service after the
 * PermissionEngine authorized it. This program starts, streams, signals and
 * reaps, and runs the boundary self-test probes (AD-20 point 12).
 *
 * Frame: type u8 | id u32 BE | len u32 BE | payload.
 *   service -> init: 1 START, 2 STDIN (len 0 = EOF), 3 SIGNAL ("T" or "K"),
 *                    4 SELFTEST, 5 PING
 *   init -> service: 10 HELLO (own AppArmor label), 11 STARTED (pid),
 *                    12 START_FAILED ("errno:N"), 13 STDOUT, 14 STDERR (len 0 = EOF),
 *                    15 EXIT ("code:N" or "signal:N"), 16 GONE (whole tree ended),
 *                    17 SELFTEST_RESULT, 18 PONG, 19 ERROR
 * START payload (NUL-terminated strings): cwd, argc, argv..., envc, env..., stdin ("1"/"0").
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_CMDS 256
#define MAX_FRAME (64u * 1024u * 1024u)
#define MAX_PARTS 65536

enum { F_START = 1, F_STDIN = 2, F_SIGNAL = 3, F_SELFTEST = 4, F_PING = 5 };
enum {
  F_HELLO = 10, F_STARTED = 11, F_START_FAILED = 12, F_STDOUT = 13, F_STDERR = 14,
  F_EXIT = 15, F_GONE = 16, F_SELFTEST_RESULT = 17, F_PONG = 18, F_ERROR = 19
};

struct cmd {
  int used;
  uint32_t id;
  pid_t shepherd;
  int shepherd_done;
  int out, err, in, status; /* parent ends; -1 once closed */
  char *inbuf;
  size_t inlen, incap;
  int in_eof;
  char statusbuf[128];
  size_t statuslen;
};
static struct cmd cmds[MAX_CMDS];
static void end_all(void);

static void write_all(int fd, const void *buf, size_t len) {
  const char *p = buf;
  while (len > 0) {
    ssize_t n = write(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      end_all();
      _exit(3); /* the service is gone */
    }
    p += n;
    len -= (size_t)n;
  }
}

static void frame(uint8_t type, uint32_t id, const void *data, uint32_t len) {
  unsigned char h[9];
  h[0] = type;
  h[1] = (unsigned char)(id >> 24); h[2] = (unsigned char)(id >> 16);
  h[3] = (unsigned char)(id >> 8);  h[4] = (unsigned char)id;
  h[5] = (unsigned char)(len >> 24); h[6] = (unsigned char)(len >> 16);
  h[7] = (unsigned char)(len >> 8);  h[8] = (unsigned char)len;
  write_all(1, h, 9);
  if (len) write_all(1, data, len);
}

static void frame_str(uint8_t type, uint32_t id, const char *s) { frame(type, id, s, (uint32_t)strlen(s)); }

static int read_full(int fd, void *buf, size_t len) {
  char *p = buf;
  while (len > 0) {
    ssize_t n = read(fd, p, len);
    if (n == 0) return 0;
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    p += n;
    len -= (size_t)n;
  }
  return 1;
}

static struct cmd *find_cmd(uint32_t id) {
  for (int i = 0; i < MAX_CMDS; i++)
    if (cmds[i].used && cmds[i].id == id) return &cmds[i];
  return NULL;
}

static struct cmd *find_shepherd(pid_t pid) {
  for (int i = 0; i < MAX_CMDS; i++)
    if (cmds[i].used && cmds[i].shepherd == pid) return &cmds[i];
  return NULL;
}

static pid_t ppid_of(pid_t pid) {
  char path[64], line[256];
  snprintf(path, sizeof path, "/proc/%d/status", (int)pid);
  FILE *f = fopen(path, "re");
  if (!f) return -1;
  int pp = -1;
  while (fgets(line, sizeof line, f))
    if (sscanf(line, "PPid: %d", &pp) == 1) break;
  fclose(f);
  return (pid_t)pp;
}

/* Whether `pid` descends from `ancestor` through PPid links. */
static int descends(pid_t pid, pid_t ancestor) {
  for (int depth = 0; depth < 4096 && pid > 1; depth++) {
    pid_t pp = ppid_of(pid);
    if (pp == ancestor) return 1;
    if (pp <= 1) return 0;
    pid = pp;
  }
  return 0;
}

/* Signal every descendant of a shepherd (never the shepherd). Returns how many were signalled. */
static int signal_tree(pid_t shepherd, int sig) {
  DIR *d = opendir("/proc");
  if (!d) return 0;
  int found = 0;
  struct dirent *e;
  while ((e = readdir(d))) {
    char *end;
    long v = strtol(e->d_name, &end, 10);
    if (*end || v <= 1 || (pid_t)v == shepherd || (pid_t)v == getpid()) continue;
    if (descends((pid_t)v, shepherd) && kill((pid_t)v, sig) == 0) found++;
  }
  closedir(d);
  return found;
}

/*
 * End every command tree before this process exits. As PID 1 of the sandbox
 * the kernel ends the PID namespace anyway; this also holds when the init is
 * run without a PID namespace (tests) and does not rely on it.
 */
static void end_all(void) {
  for (int i = 0; i < MAX_CMDS; i++) {
    if (!cmds[i].used || cmds[i].shepherd <= 0) continue;
    signal_tree(cmds[i].shepherd, SIGKILL);
    kill(cmds[i].shepherd, SIGKILL);
  }
}

static void set_nonblock(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }

static void close_fd(int *fd) {
  if (*fd >= 0) close(*fd);
  *fd = -1;
}

/* NUL-separated strings of a payload. */
static int split(char *buf, uint32_t len, char **out, int max) {
  int n = 0;
  uint32_t start = 0;
  for (uint32_t i = 0; i < len && n < max; i++)
    if (buf[i] == '\0') {
      out[n++] = buf + start;
      start = i + 1;
    }
  return n;
}

static void status_line(int fd, char kind, int value) {
  char line[32];
  int n = snprintf(line, sizeof line, "%c%d\n", kind, value);
  if (write(fd, line, (size_t)n) < 0) { /* the service side is gone; nothing to report to */ }
}

/* The shepherd: subreaper of one command. Never returns. */
static void shepherd_main(char **argv, char **envp, const char *cwd, int in_r, int out_w, int err_w, int status_w) {
  prctl(PR_SET_CHILD_SUBREAPER, 1);
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
  signal(SIGPIPE, SIG_DFL);
  int errpipe[2];
  if (pipe2(errpipe, O_CLOEXEC) < 0) { status_line(status_w, 'E', errno); _exit(1); }
  pid_t child = fork();
  if (child < 0) { status_line(status_w, 'E', errno); _exit(1); }
  if (child == 0) {
    setsid(); /* own session and process group; no controlling terminal */
    int in_fd = in_r >= 0 ? in_r : open("/dev/null", O_RDONLY);
    if (in_fd < 0 || dup2(in_fd, 0) < 0 || dup2(out_w, 1) < 0 || dup2(err_w, 2) < 0) {
      int e = errno;
      if (write(errpipe[1], &e, sizeof e) < 0) {}
      _exit(127);
    }
    for (int fd = 3; fd < 65536; fd++)
      if (fd != errpipe[1]) close(fd);
    if (chdir(cwd) < 0) {
      int e = errno;
      if (write(errpipe[1], &e, sizeof e) < 0) {}
      _exit(127);
    }
    execve(argv[0], argv, envp);
    int e = errno;
    if (write(errpipe[1], &e, sizeof e) < 0) {}
    _exit(127);
  }
  close(errpipe[1]);
  if (in_r >= 0) close(in_r);
  close(out_w);
  close(err_w);
  int e = 0;
  if (read_full(errpipe[0], &e, sizeof e) == 1) {
    waitpid(child, NULL, 0);
    status_line(status_w, 'E', e);
    _exit(1);
  }
  close(errpipe[0]);
  status_line(status_w, 'P', (int)child);
  /* Reap the direct child and every adopted descendant; report the direct child's status. */
  for (;;) {
    int st;
    pid_t w = waitpid(-1, &st, 0);
    if (w < 0) {
      if (errno == EINTR) continue;
      break; /* ECHILD: the whole tree has ended */
    }
    if (w == child) {
      if (WIFEXITED(st)) status_line(status_w, 'X', WEXITSTATUS(st));
      else if (WIFSIGNALED(st)) status_line(status_w, 'S', WTERMSIG(st));
    }
  }
  _exit(0);
}

static void start_cmd(uint32_t id, char *payload, uint32_t len) {
  static char *parts[MAX_PARTS];
  int n = split(payload, len, parts, MAX_PARTS);
  if (n < 4) { frame_str(F_START_FAILED, id, "errno:22"); return; }
  const char *cwd = parts[0];
  int argc = atoi(parts[1]);
  if (argc < 1 || 2 + argc >= n) { frame_str(F_START_FAILED, id, "errno:22"); return; }
  int envc = atoi(parts[2 + argc]);
  if (envc < 0 || 3 + argc + envc > n) { frame_str(F_START_FAILED, id, "errno:22"); return; }
  int want_stdin = (3 + argc + envc < n) && parts[3 + argc + envc][0] == '1';
  if (find_cmd(id)) { frame_str(F_START_FAILED, id, "errno:17"); return; }
  struct cmd *c = NULL;
  for (int i = 0; i < MAX_CMDS; i++)
    if (!cmds[i].used) { c = &cmds[i]; break; }
  if (!c) { frame_str(F_START_FAILED, id, "errno:11"); return; }

  char **argv = calloc((size_t)argc + 1, sizeof *argv);
  char **envp = calloc((size_t)envc + 1, sizeof *envp);
  if (!argv || !envp) { free(argv); free(envp); frame_str(F_START_FAILED, id, "errno:12"); return; }
  for (int i = 0; i < argc; i++) argv[i] = parts[2 + i];
  for (int i = 0; i < envc; i++) envp[i] = parts[3 + argc + i];

  int o[2] = {-1, -1}, e[2] = {-1, -1}, s[2] = {-1, -1}, in[2] = {-1, -1};
  if (pipe2(o, O_CLOEXEC) || pipe2(e, O_CLOEXEC) || pipe2(s, O_CLOEXEC) || (want_stdin && pipe2(in, O_CLOEXEC))) {
    char msg[32];
    snprintf(msg, sizeof msg, "errno:%d", errno);
    for (int i = 0; i < 2; i++) { if (o[i] >= 0) close(o[i]); if (e[i] >= 0) close(e[i]); if (s[i] >= 0) close(s[i]); if (in[i] >= 0) close(in[i]); }
    free(argv); free(envp);
    frame_str(F_START_FAILED, id, msg);
    return;
  }
  pid_t sh = fork();
  if (sh < 0) {
    char msg[32];
    snprintf(msg, sizeof msg, "errno:%d", errno);
    for (int i = 0; i < 2; i++) { close(o[i]); close(e[i]); close(s[i]); if (in[i] >= 0) close(in[i]); }
    free(argv); free(envp);
    frame_str(F_START_FAILED, id, msg);
    return;
  }
  if (sh == 0) {
    /* The private channel never reaches a confined command. */
    int null_fd = open("/dev/null", O_RDWR);
    if (null_fd < 0) _exit(1);
    dup2(null_fd, 0);
    dup2(null_fd, 1);
    if (null_fd > 2) close(null_fd);
    close(o[0]); close(e[0]); close(s[0]);
    if (in[1] >= 0) close(in[1]);
    for (int i = 0; i < MAX_CMDS; i++)
      if (cmds[i].used) { close_fd(&cmds[i].out); close_fd(&cmds[i].err); close_fd(&cmds[i].status); close_fd(&cmds[i].in); }
    shepherd_main(argv, envp, cwd, in[0], o[1], e[1], s[1]);
  }
  close(o[1]); close(e[1]); close(s[1]);
  if (in[0] >= 0) close(in[0]);
  free(argv);
  free(envp);
  memset(c, 0, sizeof *c);
  c->used = 1;
  c->id = id;
  c->shepherd = sh;
  c->out = o[0];
  c->err = e[0];
  c->status = s[0];
  c->in = in[1];
  set_nonblock(c->out);
  set_nonblock(c->err);
  set_nonblock(c->status);
  if (c->in >= 0) set_nonblock(c->in);
}

static void flush_stdin(struct cmd *c) {
  while (c->in >= 0 && c->inlen > 0) {
    ssize_t n = write(c->in, c->inbuf, c->inlen);
    if (n < 0) {
      if (errno == EAGAIN || errno == EINTR) return;
      close_fd(&c->in); /* EPIPE: the command closed its stdin */
      c->inlen = 0;
      return;
    }
    memmove(c->inbuf, c->inbuf + n, c->inlen - (size_t)n);
    c->inlen -= (size_t)n;
  }
  if (c->in >= 0 && c->in_eof && c->inlen == 0) close_fd(&c->in);
}

static void queue_stdin(struct cmd *c, const char *data, uint32_t len) {
  if (len == 0) { c->in_eof = 1; flush_stdin(c); return; }
  if (c->in < 0) return;
  if (c->inlen + len > c->incap) {
    size_t cap = c->incap ? c->incap : 65536;
    while (cap < c->inlen + len) cap *= 2;
    char *p = realloc(c->inbuf, cap);
    if (!p) { close_fd(&c->in); c->inlen = 0; return; }
    c->inbuf = p;
    c->incap = cap;
  }
  memcpy(c->inbuf + c->inlen, data, len);
  c->inlen += len;
  flush_stdin(c);
}

static void handle_status(struct cmd *c) {
  for (;;) {
    ssize_t n = read(c->status, c->statusbuf + c->statuslen, sizeof c->statusbuf - 1 - c->statuslen);
    if (n < 0) {
      if (errno == EAGAIN || errno == EINTR) return;
      close_fd(&c->status);
      return;
    }
    if (n == 0) { close_fd(&c->status); return; }
    c->statuslen += (size_t)n;
    c->statusbuf[c->statuslen] = '\0';
    char *nl;
    while ((nl = strchr(c->statusbuf, '\n'))) {
      *nl = '\0';
      char kind = c->statusbuf[0];
      int value = atoi(c->statusbuf + 1);
      char msg[48];
      switch (kind) {
        case 'P': snprintf(msg, sizeof msg, "%d", value); frame_str(F_STARTED, c->id, msg); break;
        case 'E': snprintf(msg, sizeof msg, "errno:%d", value); frame_str(F_START_FAILED, c->id, msg); break;
        case 'X': snprintf(msg, sizeof msg, "code:%d", value); frame_str(F_EXIT, c->id, msg); break;
        case 'S': snprintf(msg, sizeof msg, "signal:%d", value); frame_str(F_EXIT, c->id, msg); break;
        default: break;
      }
      size_t used = (size_t)(nl - c->statusbuf) + 1;
      memmove(c->statusbuf, nl + 1, c->statuslen - used + 1);
      c->statuslen -= used;
    }
  }
}

static void pump_output(struct cmd *c, int *fd, uint8_t type) {
  char buf[65536];
  for (int rounds = 0; rounds < 16; rounds++) {
    ssize_t n = read(*fd, buf, sizeof buf);
    if (n < 0) {
      if (errno == EAGAIN || errno == EINTR) return;
      n = 0;
    }
    if (n == 0) {
      close_fd(fd);
      frame(type, c->id, NULL, 0);
      return;
    }
    frame(type, c->id, buf, (uint32_t)n);
  }
}

/* A command slot is released when its shepherd was reaped and every pipe is drained. */
static void maybe_release(struct cmd *c) {
  if (!c->used || !c->shepherd_done || c->out >= 0 || c->err >= 0 || c->status >= 0) return;
  close_fd(&c->in);
  frame(F_GONE, c->id, NULL, 0);
  free(c->inbuf);
  memset(c, 0, sizeof *c);
}

static void signal_cmd(struct cmd *c, const char *how, uint32_t len) {
  if (!c || c->shepherd_done) return;
  int sig = (len > 0 && how[0] == 'K') ? SIGKILL : SIGTERM;
  if (sig == SIGTERM) {
    signal_tree(c->shepherd, SIGTERM);
    return;
  }
  /* Forced: repeat until no descendant is left (new children may appear while we walk /proc). */
  for (int round = 0; round < 100; round++) {
    if (signal_tree(c->shepherd, SIGKILL) == 0) break;
    usleep(5000);
  }
}

static int read_label(char *out, size_t size) {
  const char *paths[] = {"/proc/self/attr/apparmor/current", "/proc/self/attr/current"};
  for (int i = 0; i < 2; i++) {
    int fd = open(paths[i], O_RDONLY | O_CLOEXEC);
    if (fd < 0) continue;
    ssize_t n = read(fd, out, size - 1);
    close(fd);
    if (n <= 0) continue;
    out[n] = '\0';
    char *nl = strchr(out, '\n');
    if (nl) *nl = '\0';
    char *mode = strstr(out, " (");
    if (mode) *mode = '\0';
    return 0;
  }
  snprintf(out, size, "none");
  return -1;
}

/* Boundary self-test probes (AD-20 point 12). The service decides; this only reports. */
static void selftest(uint32_t id, char *payload, uint32_t len) {
  static char *parts[1024];
  int n = split(payload, len, parts, 1024);
  size_t cap = 65536, used = 0;
  char *out = calloc(1, cap);
  if (!out) { frame_str(F_ERROR, id, "selftest: out of memory"); return; }
  for (int i = 0; i < n; i++) {
    char *op = parts[i];
    char *arg = strchr(op, ':');
    if (!arg) continue;
    *arg++ = '\0';
    int ok = 0, err = 0;
    if (!strcmp(op, "read-deny") || !strcmp(op, "read-allow")) {
      int fd = open(arg, O_RDONLY | O_CLOEXEC);
      int readable = 0;
      if (fd >= 0) {
        struct stat st;
        char b[1];
        if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) {
          DIR *d = fdopendir(fd);
          readable = d && readdir(d) != NULL;
          if (d) closedir(d); else close(fd);
        } else {
          readable = read(fd, b, 1) >= 0;
          close(fd);
        }
      }
      err = errno;
      ok = !strcmp(op, "read-allow") ? readable : !readable;
    } else if (!strcmp(op, "write-allow") || !strcmp(op, "write-deny")) {
      char file[4096];
      snprintf(file, sizeof file, "%s/.crot-l1-selftest-%d", arg, (int)getpid());
      int fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
      int wrote = 0;
      if (fd >= 0) {
        wrote = write(fd, "x", 1) == 1;
        close(fd);
        unlink(file);
      }
      err = errno;
      ok = !strcmp(op, "write-allow") ? wrote : !wrote;
    } else if (!strcmp(op, "abstract-deny")) {
      int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
      struct sockaddr_un a;
      memset(&a, 0, sizeof a);
      a.sun_family = AF_UNIX;
      size_t l = strlen(arg);
      if (l > sizeof a.sun_path - 1) l = sizeof a.sun_path - 1;
      memcpy(a.sun_path + 1, arg, l);
      int r = s >= 0 ? connect(s, (struct sockaddr *)&a, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + l)) : -1;
      err = errno;
      if (s >= 0) close(s);
      ok = r != 0;
    } else if (!strcmp(op, "signal-deny")) {
      int r = kill((pid_t)atoi(arg), 0);
      err = errno;
      ok = r != 0;
    } else if (!strcmp(op, "label")) {
      char label[512];
      read_label(label, sizeof label);
      ok = !strcmp(label, arg);
    } else {
      continue;
    }
    char line[4352];
    int m = snprintf(line, sizeof line, "%s %s %s%s%d\n", ok ? "ok" : "FAIL", op, arg, ok ? " " : " errno=", ok ? 0 : err);
    if (m < 0) continue;
    if (used + (size_t)m >= cap) break;
    memcpy(out + used, line, (size_t)m);
    used += (size_t)m;
  }
  frame(F_SELFTEST_RESULT, id, out, (uint32_t)used);
  free(out);
}

static void handle_frame(uint8_t type, uint32_t id, char *payload, uint32_t len) {
  switch (type) {
    case F_START: start_cmd(id, payload, len); break;
    case F_STDIN: { struct cmd *c = find_cmd(id); if (c) queue_stdin(c, payload, len); break; }
    case F_SIGNAL: signal_cmd(find_cmd(id), payload, len); break;
    case F_SELFTEST: selftest(id, payload, len); break;
    case F_PING: frame(F_PONG, id, NULL, 0); break;
    default: frame_str(F_ERROR, id, "unknown frame"); break;
  }
}

/* Service channel input, buffered: whole frames are dispatched. */
static unsigned char *inbuf;
static size_t in_len, in_cap;

static int read_service(void) {
  if (in_cap - in_len < 65536) {
    size_t cap = in_cap ? in_cap * 2 : 131072;
    unsigned char *p = realloc(inbuf, cap);
    if (!p) return -1;
    inbuf = p;
    in_cap = cap;
  }
  ssize_t n = read(0, inbuf + in_len, in_cap - in_len);
  if (n < 0) return (errno == EAGAIN || errno == EINTR) ? 0 : -1;
  if (n == 0) return -1;
  in_len += (size_t)n;
  size_t off = 0;
  while (in_len - off >= 9) {
    unsigned char *h = inbuf + off;
    uint32_t id = ((uint32_t)h[1] << 24) | ((uint32_t)h[2] << 16) | ((uint32_t)h[3] << 8) | h[4];
    uint32_t len = ((uint32_t)h[5] << 24) | ((uint32_t)h[6] << 16) | ((uint32_t)h[7] << 8) | h[8];
    if (len > MAX_FRAME) return -1;
    if (in_len - off - 9 < len) {
      if (in_cap < (size_t)len + 9 + 65536) {
        memmove(inbuf, inbuf + off, in_len - off);
        in_len -= off;
        off = 0;
        unsigned char *p = realloc(inbuf, (size_t)len + 9 + 65536);
        if (!p) return -1;
        inbuf = p;
        in_cap = (size_t)len + 9 + 65536;
      }
      break;
    }
    /* START and SELFTEST payloads are NUL-terminated string lists: copy so they can be modified. */
    char *payload = malloc((size_t)len + 1);
    if (!payload) return -1;
    memcpy(payload, h + 9, len);
    payload[len] = '\0';
    handle_frame(h[0], id, payload, len);
    free(payload);
    off += 9 + (size_t)len;
  }
  memmove(inbuf, inbuf + off, in_len - off);
  in_len -= off;
  return 0;
}

static void reap(void) {
  for (;;) {
    int st;
    pid_t w = waitpid(-1, &st, WNOHANG);
    if (w <= 0) return;
    struct cmd *c = find_shepherd(w);
    if (c) {
      c->shepherd_done = 1;
      maybe_release(c);
    }
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  sigset_t mask;
  sigemptyset(&mask);
  sigaddset(&mask, SIGCHLD);
  sigaddset(&mask, SIGTERM);
  sigaddset(&mask, SIGINT);
  sigaddset(&mask, SIGHUP);
  sigprocmask(SIG_BLOCK, &mask, NULL);
  int sfd = signalfd(-1, &mask, SFD_CLOEXEC | SFD_NONBLOCK);
  if (sfd < 0) return 2;
  fcntl(0, F_SETFD, FD_CLOEXEC);
  fcntl(1, F_SETFD, FD_CLOEXEC);
  int devnull = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (devnull >= 0) { dup2(devnull, 2); close(devnull); }
  set_nonblock(0);

  char label[512];
  read_label(label, sizeof label);
  frame_str(F_HELLO, 0, label);

  static struct pollfd fds[2 + MAX_CMDS * 4];
  static struct { struct cmd *c; int which; } map[2 + MAX_CMDS * 4];
  for (;;) {
    int n = 0;
    fds[n].fd = 0; fds[n].events = POLLIN; n++;
    fds[n].fd = sfd; fds[n].events = POLLIN; n++;
    for (int i = 0; i < MAX_CMDS; i++) {
      struct cmd *c = &cmds[i];
      if (!c->used) continue;
      if (c->out >= 0) { map[n].c = c; map[n].which = 0; fds[n].fd = c->out; fds[n].events = POLLIN; n++; }
      if (c->err >= 0) { map[n].c = c; map[n].which = 1; fds[n].fd = c->err; fds[n].events = POLLIN; n++; }
      if (c->status >= 0) { map[n].c = c; map[n].which = 2; fds[n].fd = c->status; fds[n].events = POLLIN; n++; }
      if (c->in >= 0 && c->inlen > 0) { map[n].c = c; map[n].which = 3; fds[n].fd = c->in; fds[n].events = POLLOUT; n++; }
    }
    int r = poll(fds, (nfds_t)n, -1);
    if (r < 0) {
      if (errno == EINTR) continue;
      return 2;
    }
    if (fds[1].revents) {
      struct signalfd_siginfo si;
      while (read(sfd, &si, sizeof si) == (ssize_t)sizeof si) {
        if (si.ssi_signo != SIGCHLD) { end_all(); return 0; } /* asked to end: the namespace ends with us */
      }
    }
    for (int i = 2; i < n; i++) {
      if (!fds[i].revents) continue;
      struct cmd *c = map[i].c;
      if (!c->used) continue;
      switch (map[i].which) {
        case 0: pump_output(c, &c->out, F_STDOUT); break;
        case 1: pump_output(c, &c->err, F_STDERR); break;
        case 2: handle_status(c); break;
        case 3:
          if (fds[i].revents & (POLLERR | POLLHUP)) { close_fd(&c->in); c->inlen = 0; }
          else flush_stdin(c);
          break;
      }
    }
    reap();
    for (int i = 0; i < MAX_CMDS; i++) maybe_release(&cmds[i]);
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      if (read_service() < 0) { end_all(); return 0; } /* the service has gone: end the sandbox */
    }
  }
}
