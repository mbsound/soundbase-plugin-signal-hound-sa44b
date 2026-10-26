/*
 * ftd2xx-shim — a libftd2xx.so that forwards every call to ftdi-bridge.
 *
 * Signal Hound's Linux libsa_api.so.3.0.11 links against libftd2xx.so and
 * uses thirteen of its functions. This library exports those (and a few
 * harmless extras) with FTDI's signatures and relays each one over TCP to
 * driver/bridge/ftdi-bridge.c running on the Mac that owns the USB device.
 *
 * Built as an x86-64 Linux shared object (see scripts/build-shim.sh) and
 * placed where the dynamic loader finds it instead of FTDI's library.
 *
 * Environment:
 *   FTDI_BRIDGE_HOST  default "host.lima.internal" (Lima's host alias)
 *   FTDI_BRIDGE_PORT  default 7788
 *   FTDI_SHIM_VERBOSE set to log every call to stderr
 */

#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "../bridge/protocol.h"

/* FTDI's types, as its Linux WinTypes.h defines them */
typedef uint32_t DWORD;
typedef uint32_t ULONG;
typedef uint16_t USHORT;
typedef uint8_t UCHAR;
typedef int BOOL;
typedef void *PVOID;
typedef void *LPVOID;
typedef DWORD *LPDWORD;
typedef char *PCHAR;
typedef ULONG FT_STATUS;
typedef PVOID FT_HANDLE;
typedef ULONG FT_DEVICE;

#define EXPORT __attribute__((visibility("default")))

static int g_fd = -1;
static pthread_mutex_t g_mx = PTHREAD_MUTEX_INITIALIZER;
static int g_verbose = -1;

static FILE *g_log = NULL;

static double now_s(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void logv(const char *fmt, ...) {
  if (g_verbose < 0) {
    g_verbose = getenv("FTDI_SHIM_VERBOSE") != NULL;
    const char *path = getenv("FTDI_SHIM_LOG"); /* a file instead of stderr */
    g_log = (path && *path) ? fopen(path, "a") : NULL;
    if (!g_log) g_log = stderr;
  }
  if (!g_verbose) return;
  va_list ap;
  va_start(ap, fmt);
  fprintf(g_log, "[ftd2xx-shim %.3f] ", now_s());
  vfprintf(g_log, fmt, ap);
  fputc('\n', g_log);
  fflush(g_log);
  va_end(ap);
}

static int connect_bridge(void) {
  if (g_fd >= 0) return 0;
  const char *host = getenv("FTDI_BRIDGE_HOST");
  const char *port = getenv("FTDI_BRIDGE_PORT");
  if (!host || !*host) host = "host.lima.internal";
  if (!port || !*port) port = "7788";
  struct addrinfo hints, *res = NULL;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  int r = getaddrinfo(host, port, &hints, &res);
  if (r != 0) {
    logv("cannot resolve %s: %s", host, gai_strerror(r));
    return -1;
  }
  int fd = -1;
  for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
    fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) {
    logv("cannot connect to ftdi-bridge at %s:%s: %s", host, port, strerror(errno));
    return -1;
  }
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  g_fd = fd;
  logv("connected to ftdi-bridge at %s:%s", host, port);
  return 0;
}

static int io_exact(int fd, void *p, size_t n, int writing) {
  uint8_t *b = p;
  while (n) {
    ssize_t r = writing ? write(fd, b, n) : read(fd, b, n);
    if (r <= 0) {
      if (r < 0 && errno == EINTR) continue;
      return -1;
    }
    b += r;
    n -= (size_t)r;
  }
  return 0;
}

/* Send one request, receive the response. `out` receives up to `outcap`
 * payload bytes; *outn gets the payload length. Returns the FT_STATUS. */
static FT_STATUS rpc(uint8_t op, uint32_t handle, const void *payload, uint32_t pn, void *out,
                     uint32_t outcap, uint32_t *outn) {
  pthread_mutex_lock(&g_mx);
  if (connect_bridge() != 0) {
    pthread_mutex_unlock(&g_mx);
    return FT_DEVICE_NOT_FOUND;
  }
  uint32_t len = 5 + pn;
  uint8_t hdr[9];
  memcpy(hdr, &len, 4);
  hdr[4] = op;
  memcpy(hdr + 5, &handle, 4);
  FT_STATUS st = FT_IO_ERROR;
  uint32_t rlen = 0;
  if (io_exact(g_fd, hdr, 9, 1) != 0) goto dead;
  if (pn && io_exact(g_fd, (void *)payload, pn, 1) != 0) goto dead;
  if (io_exact(g_fd, &rlen, 4, 0) != 0) goto dead;
  if (rlen < 4) goto dead;
  if (io_exact(g_fd, &st, 4, 0) != 0) goto dead;
  rlen -= 4;
  {
    uint32_t take = rlen < outcap ? rlen : outcap;
    if (take && io_exact(g_fd, out, take, 0) != 0) goto dead;
    uint32_t skip = rlen - take;
    uint8_t sink[4096];
    while (skip) {
      uint32_t s = skip < sizeof sink ? skip : sizeof sink;
      if (io_exact(g_fd, sink, s, 0) != 0) goto dead;
      skip -= s;
    }
    if (outn) *outn = take;
  }
  pthread_mutex_unlock(&g_mx);
  return st;
dead:
  logv("bridge connection lost");
  close(g_fd);
  g_fd = -1;
  pthread_mutex_unlock(&g_mx);
  return FT_IO_ERROR;
}

static uint32_t h32(FT_HANDLE h) { return (uint32_t)(uintptr_t)h; }

/* ------------------------------------------------------------------------ */
/* The D2XX surface libsa_api.so uses                                       */
/* ------------------------------------------------------------------------ */

EXPORT FT_STATUS FT_CreateDeviceInfoList(LPDWORD lpdwNumDevs) {
  uint32_t n = 0, got = 0;
  FT_STATUS st = rpc(OP_CREATE_DEVICE_INFO_LIST, 0, NULL, 0, &n, 4, &got);
  if (lpdwNumDevs) *lpdwNumDevs = n;
  logv("FT_CreateDeviceInfoList -> %u (st %u)", n, st);
  return st;
}

EXPORT FT_STATUS FT_GetDeviceInfoDetail(DWORD dwIndex, LPDWORD lpdwFlags, LPDWORD lpdwType,
                                        LPDWORD lpdwID, LPDWORD lpdwLocId, LPVOID lpSerialNumber,
                                        LPVOID lpDescription, FT_HANDLE *pftHandle) {
  bridge_device_info di;
  uint32_t got = 0;
  FT_STATUS st = rpc(OP_GET_DEVICE_INFO_DETAIL, 0, &dwIndex, 4, &di, sizeof di, &got);
  if (st == FT_OK && got == sizeof di) {
    if (lpdwFlags) *lpdwFlags = di.flags;
    if (lpdwType) *lpdwType = di.type;
    if (lpdwID) *lpdwID = di.id;
    if (lpdwLocId) *lpdwLocId = di.locid;
    if (lpSerialNumber) memcpy(lpSerialNumber, di.serial, 16);
    if (lpDescription) memcpy(lpDescription, di.desc, 64);
    if (pftHandle) *pftHandle = NULL;
  }
  logv("FT_GetDeviceInfoDetail(%u) -> %s / %s (st %u)", dwIndex, st == FT_OK ? di.serial : "?",
       st == FT_OK ? di.desc : "?", st);
  return st;
}

EXPORT FT_STATUS FT_Open(int deviceNumber, FT_HANDLE *pHandle) {
  uint32_t idx = (uint32_t)deviceNumber, h = 0, got = 0;
  FT_STATUS st = rpc(OP_OPEN, 0, &idx, 4, &h, 4, &got);
  if (pHandle) *pHandle = st == FT_OK ? (FT_HANDLE)(uintptr_t)h : NULL;
  logv("FT_Open(%d) -> handle %u (st %u)", deviceNumber, h, st);
  return st;
}

EXPORT FT_STATUS FT_Close(FT_HANDLE ftHandle) {
  FT_STATUS st = rpc(OP_CLOSE, h32(ftHandle), NULL, 0, NULL, 0, NULL);
  logv("FT_Close(%u) -> %u", h32(ftHandle), st);
  return st;
}

EXPORT FT_STATUS FT_SetBaudRate(FT_HANDLE ftHandle, ULONG BaudRate) {
  uint32_t b = BaudRate;
  FT_STATUS st = rpc(OP_SET_BAUD_RATE, h32(ftHandle), &b, 4, NULL, 0, NULL);
  logv("FT_SetBaudRate(%u, %u) -> %u", h32(ftHandle), b, st);
  return st;
}

EXPORT FT_STATUS FT_SetLatencyTimer(FT_HANDLE ftHandle, UCHAR ucLatency) {
  FT_STATUS st = rpc(OP_SET_LATENCY_TIMER, h32(ftHandle), &ucLatency, 1, NULL, 0, NULL);
  logv("FT_SetLatencyTimer(%u, %u) -> %u", h32(ftHandle), ucLatency, st);
  return st;
}

EXPORT FT_STATUS FT_SetTimeouts(FT_HANDLE ftHandle, ULONG ReadTimeout, ULONG WriteTimeout) {
  uint32_t p[2] = { ReadTimeout, WriteTimeout };
  FT_STATUS st = rpc(OP_SET_TIMEOUTS, h32(ftHandle), p, 8, NULL, 0, NULL);
  logv("FT_SetTimeouts(%u, %u, %u) -> %u", h32(ftHandle), ReadTimeout, WriteTimeout, st);
  return st;
}

EXPORT FT_STATUS FT_Purge(FT_HANDLE ftHandle, ULONG Mask) {
  uint32_t m = Mask;
  FT_STATUS st = rpc(OP_PURGE, h32(ftHandle), &m, 4, NULL, 0, NULL);
  logv("FT_Purge(%u, %u) -> %u", h32(ftHandle), m, st);
  return st;
}

EXPORT FT_STATUS FT_GetQueueStatus(FT_HANDLE ftHandle, DWORD *dwRxBytes) {
  uint32_t n = 0, got = 0;
  FT_STATUS st = rpc(OP_GET_QUEUE_STATUS, h32(ftHandle), NULL, 0, &n, 4, &got);
  if (dwRxBytes) *dwRxBytes = n;
  return st;
}

EXPORT FT_STATUS FT_Write(FT_HANDLE ftHandle, LPVOID lpBuffer, DWORD dwBytesToWrite,
                          LPDWORD lpBytesWritten) {
  uint32_t w = 0, got = 0;
  FT_STATUS st = rpc(OP_WRITE, h32(ftHandle), lpBuffer, dwBytesToWrite, &w, 4, &got);
  if (lpBytesWritten) *lpBytesWritten = w;
  logv("FT_Write(%u, %u) -> %u (st %u)", h32(ftHandle), dwBytesToWrite, w, st);
  return st;
}

EXPORT FT_STATUS FT_Read(FT_HANDLE ftHandle, LPVOID lpBuffer, DWORD dwBytesToRead,
                         LPDWORD lpBytesReturned) {
  uint32_t want = dwBytesToRead, got = 0;
  FT_STATUS st = rpc(OP_READ, h32(ftHandle), &want, 4, lpBuffer, dwBytesToRead, &got);
  if (lpBytesReturned) *lpBytesReturned = got;
  logv("FT_Read(%u, %u) -> %u (st %u)", h32(ftHandle), dwBytesToRead, got, st);
  return st;
}

EXPORT FT_STATUS FT_CyclePort(FT_HANDLE ftHandle) {
  FT_STATUS st = rpc(OP_CYCLE_PORT, h32(ftHandle), NULL, 0, NULL, 0, NULL);
  logv("FT_CyclePort(%u) -> %u", h32(ftHandle), st);
  return st;
}

EXPORT FT_STATUS FT_GetDeviceInfo(FT_HANDLE ftHandle, FT_DEVICE *lpftDevice, LPDWORD lpdwID,
                                  PCHAR SerialNumber, PCHAR Description, LPVOID Dummy) {
  (void)Dummy;
  bridge_device_info di;
  uint32_t got = 0;
  FT_STATUS st = rpc(OP_GET_DEVICE_INFO, h32(ftHandle), NULL, 0, &di, sizeof di, &got);
  if (st == FT_OK && got == sizeof di) {
    if (lpftDevice) *lpftDevice = di.type;
    if (lpdwID) *lpdwID = di.id;
    if (SerialNumber) memcpy(SerialNumber, di.serial, 16);
    if (Description) memcpy(Description, di.desc, 64);
  }
  logv("FT_GetDeviceInfo(%u) -> %s (st %u)", h32(ftHandle), st == FT_OK ? di.serial : "?", st);
  return st;
}

/* ------------------------------------------------------------------------ */
/* Extras some callers probe for; harmless no-ops                           */
/* ------------------------------------------------------------------------ */

EXPORT FT_STATUS FT_SetVIDPID(DWORD dwVID, DWORD dwPID) { (void)dwVID; (void)dwPID; return FT_OK; }
EXPORT FT_STATUS FT_GetVIDPID(DWORD *pdwVID, DWORD *pdwPID) {
  if (pdwVID) *pdwVID = 0x0403;
  if (pdwPID) *pdwPID = 0x6010;
  return FT_OK;
}
EXPORT FT_STATUS FT_ResetDevice(FT_HANDLE h) { return FT_Purge(h, FT_PURGE_RX | FT_PURGE_TX); }
EXPORT FT_STATUS FT_SetUSBParameters(FT_HANDLE h, ULONG in, ULONG out) { (void)h; (void)in; (void)out; return FT_OK; }
EXPORT FT_STATUS FT_SetFlowControl(FT_HANDLE h, USHORT fc, UCHAR xon, UCHAR xoff) { (void)h; (void)fc; (void)xon; (void)xoff; return FT_OK; }
EXPORT FT_STATUS FT_SetDataCharacteristics(FT_HANDLE h, UCHAR w, UCHAR s, UCHAR p) { (void)h; (void)w; (void)s; (void)p; return FT_OK; }
EXPORT FT_STATUS FT_SetChars(FT_HANDLE h, UCHAR a, UCHAR b, UCHAR c, UCHAR d) { (void)h; (void)a; (void)b; (void)c; (void)d; return FT_OK; }
EXPORT FT_STATUS FT_GetLibraryVersion(LPDWORD v) { if (v) *v = 0x010430; return FT_OK; }
EXPORT FT_STATUS FT_GetDriverVersion(FT_HANDLE h, LPDWORD v) { (void)h; if (v) *v = 0x010430; return FT_OK; }
EXPORT FT_STATUS FT_GetStatus(FT_HANDLE h, DWORD *rx, DWORD *tx, DWORD *ev) {
  if (tx) *tx = 0;
  if (ev) *ev = 0;
  return FT_GetQueueStatus(h, rx);
}
