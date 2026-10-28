/*
 * vsock-agent — runs inside the Linux guest and hands the host a worker.
 *
 * Listens on an AF_VSOCK port. For every connection it forks a child whose
 * stdin and stdout are that connection and execs the command given on its
 * own command line (the sa44b-worker), so the plugin on the host talks JSON
 * lines to the worker exactly as it would over a child process's stdio. The
 * worker's stderr stays on the guest console, which the launcher forwards.
 *
 * When the host closes its end — including when the plugin SIGKILLs a wedged
 * worker by dropping the connection — the agent sees the hang-up and kills
 * the child with SIGKILL, which is the stale-worker cleanup: no worker ever
 * outlives the connection that started it.
 *
 *   vsock-agent <port> [-C dir] -- <command> [args...]
 *
 * Built as an x86-64 Linux binary together with the worker (it runs under
 * Rosetta like everything else on the x86-64 side), see scripts/build-x86.sh.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
#ifndef VMADDR_CID_ANY
#define VMADDR_CID_ANY ((unsigned int)-1)
#endif
#ifndef POLLRDHUP
#define POLLRDHUP 0x2000
#endif

/* <linux/vm_sockets.h> is not in every sysroot; the layout is fixed ABI */
struct sockaddr_vm_compat {
  unsigned short svm_family;
  unsigned short svm_reserved1;
  unsigned int svm_port;
  unsigned int svm_cid;
  unsigned char svm_zero[sizeof(struct sockaddr) - sizeof(unsigned short) - sizeof(unsigned short) -
                         sizeof(unsigned int) - sizeof(unsigned int)];
};

#define MAX_CONNS 16

/* no atoi/strtol: under _GNU_SOURCE they bind to glibc 2.38 symbols on newer
 * toolchains, and the guest ships Debian bookworm's glibc 2.36 */
static int parse_int(const char *s) {
  int v = 0;
  while (s && *s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
  return v;
}

typedef struct {
  int fd;
  pid_t pid;
} conn;

static conn g_conns[MAX_CONNS];
static int g_nconns = 0;

static void drop(int i) {
  close(g_conns[i].fd);
  g_conns[i] = g_conns[--g_nconns];
}

static void reap(void) {
  int status;
  pid_t pid;
  while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
    for (int i = 0; i < g_nconns; i++) {
      if (g_conns[i].pid == pid) {
        fprintf(stderr, "vsock-agent: worker %d exited (%s %d)\n", (int)pid,
                WIFSIGNALED(status) ? "signal" : "code",
                WIFSIGNALED(status) ? WTERMSIG(status) : WEXITSTATUS(status));
        drop(i);
        break;
      }
    }
  }
}

int main(int argc, char **argv) {
  const char *dir = NULL;
  int port = 0, cmd_at = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { cmd_at = i + 1; break; }
    if (strcmp(argv[i], "-C") == 0 && i + 1 < argc) dir = argv[++i];
    else if (!port) port = parse_int(argv[i]);
  }
  if (!port || !cmd_at || cmd_at >= argc) {
    fprintf(stderr, "usage: vsock-agent <port> [-C dir] -- <command> [args...]\n");
    return 2;
  }
  signal(SIGPIPE, SIG_IGN);

  int ls = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (ls < 0) {
    fprintf(stderr, "vsock-agent: socket(AF_VSOCK): %s\n", strerror(errno));
    return 1;
  }
  struct sockaddr_vm_compat sa;
  memset(&sa, 0, sizeof sa);
  sa.svm_family = AF_VSOCK;
  sa.svm_port = (unsigned int)port;
  sa.svm_cid = VMADDR_CID_ANY;
  if (bind(ls, (struct sockaddr *)&sa, sizeof sa) != 0 || listen(ls, 4) != 0) {
    fprintf(stderr, "vsock-agent: cannot listen on vsock port %d: %s\n", port, strerror(errno));
    return 1;
  }
  /* the launcher watches the console for this line */
  fprintf(stderr, "vsock-agent: listening on vsock port %d\n", port);
  fflush(stderr);

  for (;;) {
    struct pollfd pfd[MAX_CONNS + 1];
    pfd[0].fd = ls;
    pfd[0].events = POLLIN;
    for (int i = 0; i < g_nconns; i++) {
      pfd[i + 1].fd = g_conns[i].fd;
      /* no POLLIN: the child owns the bytes; we only want the hang-up */
      pfd[i + 1].events = POLLRDHUP;
    }
    int r = poll(pfd, g_nconns + 1, 500);
    if (r < 0 && errno != EINTR) {
      fprintf(stderr, "vsock-agent: poll: %s\n", strerror(errno));
      return 1;
    }
    reap();
    for (int i = g_nconns - 1; i >= 0; i--) {
      if (pfd[i + 1].revents & (POLLRDHUP | POLLHUP | POLLERR | POLLNVAL)) {
        fprintf(stderr, "vsock-agent: host closed the connection, killing worker %d\n", (int)g_conns[i].pid);
        kill(g_conns[i].pid, SIGKILL);
        drop(i);
      }
    }
    if (pfd[0].revents & POLLIN) {
      int fd = accept(ls, NULL, NULL);
      if (fd < 0) continue;
      if (g_nconns >= MAX_CONNS) {
        fprintf(stderr, "vsock-agent: too many connections, refusing\n");
        close(fd);
        continue;
      }
      pid_t pid = fork();
      if (pid == 0) {
        dup2(fd, 0);
        dup2(fd, 1);
        close(fd);
        close(ls);
        if (dir && chdir(dir) != 0) fprintf(stderr, "vsock-agent: chdir %s: %s\n", dir, strerror(errno));
        execv(argv[cmd_at], argv + cmd_at);
        fprintf(stderr, "vsock-agent: exec %s: %s\n", argv[cmd_at], strerror(errno));
        _exit(127);
      }
      if (pid < 0) {
        fprintf(stderr, "vsock-agent: fork: %s\n", strerror(errno));
        close(fd);
        continue;
      }
      fprintf(stderr, "vsock-agent: connection -> worker %d\n", (int)pid);
      g_conns[g_nconns].fd = fd;
      g_conns[g_nconns].pid = pid;
      g_nconns++;
    }
  }
}
