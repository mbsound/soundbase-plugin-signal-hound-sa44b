/*
 * ftdi-bridge — serves the FTDI D2XX calls the Signal Hound SA API needs,
 * over TCP, on top of libftdi/libusb.
 *
 * Why: Signal Hound ships libsa_api.so for x86-64 Linux only, and it talks to
 * the SA44B through FTDI's D2XX library (FT_Open, FT_Read, FT_Write, ...).
 * On this Mac the x86-64 library runs inside a Linux VM under Rosetta, where
 * a shim libftd2xx.so (driver/shim/) forwards every D2XX call to this
 * program, which holds the real USB device on the host through libusb.
 * No USB passthrough, no vendor driver on macOS.
 *
 * Wire protocol (little-endian, one request at a time per connection):
 *   request : u32 len | u8 op | u32 handle | payload[len-5]
 *   response: u32 len | u32 ft_status | payload[len-4]
 * Ops and payloads are listed in driver/bridge/protocol.h.
 *
 * D2XX semantics reproduced here:
 *   - a device index enumerates each FT2232H *port* as its own device
 *     (serial "XXXXXXXXA"/"XXXXXXXXB", description "<product> A"/"<product> B"),
 *     exactly as D2XX does;
 *   - FT_Read blocks until the requested byte count is available or the read
 *     timeout set by FT_SetTimeouts elapses, then returns what it has;
 *   - FT_GetQueueStatus reports bytes received but not yet read;
 *   - FT_CyclePort resets the USB device; the handle is dead afterwards.
 * A reader thread per open port keeps draining the chip into a queue, which
 * is what makes the first two behave like the Windows driver.
 *
 * Build: scripts/build-bridge.sh (macOS: brew install libftdi)
 * Run:   ftdi-bridge [-p port] [-v] [-t tracefile]
 */

#include <arpa/inet.h>
#include <errno.h>
#include <libusb-1.0/libusb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <libftdi1/ftdi.h>

#include "protocol.h"

#define MAX_HANDLES 16
#define QUEUE_CAP (32u * 1024u * 1024u)
#define READ_CHUNK 65536

static int g_verbose = 0;
static FILE *g_trace = NULL;

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

static void logv(const char *fmt, ...) {
  if (!g_verbose) return;
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "[ftdi-bridge %.3f] ", now_ms() / 1000.0);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
}

static void trace_bytes(const char *dir, uint32_t handle, const uint8_t *p, size_t n) {
  if (!g_trace) return;
  fprintf(g_trace, "%.3f %s h%u %zu:", now_ms() / 1000.0, dir, handle, n);
  size_t show = n < 64 ? n : 64;
  for (size_t i = 0; i < show; i++) fprintf(g_trace, " %02x", p[i]);
  if (n > show) fprintf(g_trace, " ...");
  fputc('\n', g_trace);
  fflush(g_trace);
}

/* ------------------------------------------------------------------------ */
/* Enumeration: every FTDI port is a D2XX "device"                           */
/* ------------------------------------------------------------------------ */

typedef struct {
  libusb_device *dev;
  int port;              /* 0 = A, 1 = B */
  int ports;             /* ports on this chip */
  uint32_t type;         /* FT_DEVICE_* */
  uint32_t id;           /* VID<<16 | PID */
  uint32_t locid;
  char serial[16];
  char desc[64];
} port_info;

static libusb_context *g_usb = NULL;
static port_info g_ports[MAX_HANDLES * 2];
static int g_port_count = 0;
static libusb_device **g_devlist = NULL;

static void free_enumeration(void) {
  if (g_devlist) libusb_free_device_list(g_devlist, 1);
  g_devlist = NULL;
  g_port_count = 0;
}

static int chip_ports(uint16_t pid, uint16_t bcd, uint32_t *type) {
  /* bcdDevice identifies the FTDI family; see libftdi's ftdi_usb_open_dev */
  switch (bcd >> 8) {
    case 0x07: *type = FT_DEVICE_2232H; return 2;
    case 0x08: *type = FT_DEVICE_4232H; return 4;
    case 0x05: *type = FT_DEVICE_2232C; return 2;
    case 0x09: *type = FT_DEVICE_232H; return 1;
    case 0x06: *type = FT_DEVICE_232R; return 1;
    default: *type = pid == 0x6010 ? FT_DEVICE_2232H : FT_DEVICE_UNKNOWN; return pid == 0x6010 ? 2 : 1;
  }
}

static int enumerate(void) {
  free_enumeration();
  ssize_t n = libusb_get_device_list(g_usb, &g_devlist);
  if (n < 0) return -1;
  for (ssize_t i = 0; i < n && g_port_count < (int)(sizeof g_ports / sizeof g_ports[0]); i++) {
    struct libusb_device_descriptor d;
    if (libusb_get_device_descriptor(g_devlist[i], &d) != 0) continue;
    if (d.idVendor != 0x0403) continue;
    if (d.idProduct != 0x6010 && d.idProduct != 0x6011 && d.idProduct != 0x6001 &&
        d.idProduct != 0x6014)
      continue;
    uint32_t type;
    int ports = chip_ports(d.idProduct, d.bcdDevice, &type);
    char serial[32] = "", product[64] = "";
    libusb_device_handle *h = NULL;
    if (libusb_open(g_devlist[i], &h) == 0) {
      if (d.iSerialNumber)
        libusb_get_string_descriptor_ascii(h, d.iSerialNumber, (unsigned char *)serial, sizeof serial);
      if (d.iProduct)
        libusb_get_string_descriptor_ascii(h, d.iProduct, (unsigned char *)product, sizeof product);
      libusb_close(h);
    }
    uint32_t locid = ((uint32_t)libusb_get_bus_number(g_devlist[i]) << 16) |
                     ((uint32_t)libusb_get_port_number(g_devlist[i]) << 8);
    for (int p = 0; p < ports; p++) {
      port_info *pi = &g_ports[g_port_count++];
      pi->dev = g_devlist[i];
      pi->port = p;
      pi->ports = ports;
      pi->type = type;
      pi->id = ((uint32_t)d.idVendor << 16) | d.idProduct;
      pi->locid = locid | (uint32_t)(p + 1);
      if (ports > 1) {
        snprintf(pi->serial, sizeof pi->serial, "%.14s%c", serial, 'A' + p);
        snprintf(pi->desc, sizeof pi->desc, "%.61s %c", product, 'A' + p);
      } else {
        snprintf(pi->serial, sizeof pi->serial, "%.15s", serial);
        snprintf(pi->desc, sizeof pi->desc, "%.63s", product);
      }
      logv("enumerated %d: %s / %s (type %u)", g_port_count - 1, pi->serial, pi->desc, pi->type);
    }
  }
  return g_port_count;
}

/* ------------------------------------------------------------------------ */
/* Open ports                                                               */
/* ------------------------------------------------------------------------ */

typedef struct {
  bool used;
  int owner;               /* client fd that opened it */
  int inflight;            /* requests currently executing on it */
  struct ftdi_context *ftdi;
  port_info info;
  pthread_t reader;
  bool reader_run;
  /* purge handshake: the reader owns libftdi's read buffer, so it performs
   * RX flushes itself between transfers */
  pthread_mutex_t pmx;
  pthread_cond_t pcv;
  bool purge_pending;
  int purge_result;
  /* receive queue */
  pthread_mutex_t qmx;
  pthread_cond_t qcv;
  uint8_t *q;
  size_t qhead, qlen, qcap; /* ring buffer */
  uint32_t read_timeout_ms, write_timeout_ms;
  bool dead;
} port_handle;

static port_handle g_h[MAX_HANDLES];
/* guards the handle table and enumeration; never held across a blocking read */
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;

static int alloc_handle(void) {
  for (int i = 1; i < MAX_HANDLES; i++)
    if (!g_h[i].used) return i;
  return -1;
}

static port_handle *get_handle(uint32_t h) {
  if (h == 0 || h >= MAX_HANDLES || !g_h[h].used) return NULL;
  return &g_h[h];
}

static void queue_push(port_handle *ph, const uint8_t *p, size_t n) {
  pthread_mutex_lock(&ph->qmx);
  if (n > ph->qcap - ph->qlen) {
    /* overflow: drop the oldest, which is what the chip would do */
    size_t drop = n - (ph->qcap - ph->qlen);
    ph->qhead = (ph->qhead + drop) % ph->qcap;
    ph->qlen -= drop;
    logv("queue overflow, dropped %zu bytes", drop);
  }
  size_t tail = (ph->qhead + ph->qlen) % ph->qcap;
  size_t first = ph->qcap - tail;
  if (first > n) first = n;
  memcpy(ph->q + tail, p, first);
  if (n > first) memcpy(ph->q, p + first, n - first);
  ph->qlen += n;
  pthread_cond_broadcast(&ph->qcv);
  pthread_mutex_unlock(&ph->qmx);
}

static size_t queue_pop(port_handle *ph, uint8_t *out, size_t n) {
  /* caller holds qmx */
  if (n > ph->qlen) n = ph->qlen;
  size_t first = ph->qcap - ph->qhead;
  if (first > n) first = n;
  memcpy(out, ph->q + ph->qhead, first);
  if (n > first) memcpy(out + first, ph->q, n - first);
  ph->qhead = (ph->qhead + n) % ph->qcap;
  ph->qlen -= n;
  return n;
}

static void *reader_main(void *arg) {
  port_handle *ph = (port_handle *)arg;
  uint8_t *buf = malloc(READ_CHUNK);
  int errors = 0;
  while (ph->reader_run) {
    if (ph->purge_pending) {
      pthread_mutex_lock(&ph->pmx);
      ph->purge_result = ftdi_tciflush(ph->ftdi);
      pthread_mutex_lock(&ph->qmx);
      ph->qhead = 0;
      ph->qlen = 0;
      pthread_mutex_unlock(&ph->qmx);
      ph->purge_pending = false;
      pthread_cond_broadcast(&ph->pcv);
      pthread_mutex_unlock(&ph->pmx);
    }
    /* no lock here: bulk IN on its own endpoint is safe beside the control
     * transfers and bulk OUT the server thread issues, and holding a lock
     * across a 100 ms read would starve them */
    int n = ph->dead ? -1 : ftdi_read_data(ph->ftdi, buf, READ_CHUNK);
    if (n > 0) {
      errors = 0;
      trace_bytes("R", (uint32_t)(ph - g_h), buf, (size_t)n);
      queue_push(ph, buf, (size_t)n);
    } else if (n == LIBUSB_ERROR_TIMEOUT) {
      /* libftdi reports "nothing within usb_read_timeout" as an error; the
       * chip normally answers every latency-timer tick, so this only means
       * the port is quiet (e.g. right after a reset) */
      errors = 0;
    } else if (n < 0) {
      if (ph->dead) break;
      errors += 1;
      logv("reader h%ld: ftdi_read_data failed (%d: %s) [%d]", (long)(ph - g_h), n,
           ftdi_get_error_string(ph->ftdi), errors);
      if (n == LIBUSB_ERROR_NO_DEVICE || errors >= 20) {
        ph->dead = true;
        pthread_mutex_lock(&ph->qmx);
        pthread_cond_broadcast(&ph->qcv);
        pthread_mutex_unlock(&ph->qmx);
        break;
      }
      usleep(5000);
    } else {
      /* nothing but status bytes: the chip answers every latency-timer tick,
       * so this loop paces itself without sleeping */
    }
  }
  free(buf);
  return NULL;
}

static void do_close(port_handle *ph);

/* A port still open from a client that is gone (a killed worker) is taken
 * over: without this, one wedged worker would lock the device forever. */
static void steal_if_stale(port_info *pi, int fd) {
  for (int i = 1; i < MAX_HANDLES; i++) {
    port_handle *ph = &g_h[i];
    if (!ph->used || ph->info.dev != pi->dev || ph->info.port != pi->port) continue;
    if (ph->owner == fd) continue;
    logv("port %s is held by client %d; reclaiming it for client %d", pi->serial, ph->owner, fd);
    ph->dead = true;
    pthread_mutex_lock(&ph->qmx);
    pthread_cond_broadcast(&ph->qcv);
    pthread_mutex_unlock(&ph->qmx);
    for (int w = 0; w < 100 && ph->inflight > 0; w++) usleep(10000);
    do_close(ph);
  }
}

static uint32_t do_open(uint32_t index, int fd, uint32_t *out_handle) {
  if (g_port_count == 0) enumerate();
  if (index >= (uint32_t)g_port_count) return FT_DEVICE_NOT_FOUND;
  steal_if_stale(&g_ports[index], fd);
  int hi = alloc_handle();
  if (hi < 0) return FT_INSUFFICIENT_RESOURCES;
  port_handle *ph = &g_h[hi];
  memset(ph, 0, sizeof *ph);
  ph->info = g_ports[index];
  ph->ftdi = ftdi_new();
  if (!ph->ftdi) return FT_INSUFFICIENT_RESOURCES;
  ftdi_set_interface(ph->ftdi, ph->info.port == 0 ? INTERFACE_A : ph->info.port == 1 ? INTERFACE_B
                                                    : ph->info.port == 2 ? INTERFACE_C : INTERFACE_D);
  int r = ftdi_usb_open_dev(ph->ftdi, ph->info.dev);
  if (r < 0) {
    logv("open %u (%s): %s", index, ph->info.serial, ftdi_get_error_string(ph->ftdi));
    ftdi_free(ph->ftdi);
    ph->ftdi = NULL;
    return FT_DEVICE_NOT_OPENED;
  }
  /* D2XX defaults */
  ftdi_set_latency_timer(ph->ftdi, 16);
  ftdi_read_data_set_chunksize(ph->ftdi, READ_CHUNK);
  ph->ftdi->usb_read_timeout = 100;
  ph->ftdi->usb_write_timeout = 5000;
  ph->read_timeout_ms = 5000;
  ph->write_timeout_ms = 5000;
  ph->qcap = QUEUE_CAP;
  ph->q = malloc(ph->qcap);
  pthread_mutex_init(&ph->pmx, NULL);
  pthread_cond_init(&ph->pcv, NULL);
  pthread_mutex_init(&ph->qmx, NULL);
  pthread_cond_init(&ph->qcv, NULL);
  ph->used = true;
  ph->owner = fd;
  ph->reader_run = true;
  pthread_create(&ph->reader, NULL, reader_main, ph);
  *out_handle = (uint32_t)hi;
  logv("opened %u (%s) as handle %d", index, ph->info.serial, hi);
  return FT_OK;
}

static void do_close(port_handle *ph) {
  ph->reader_run = false;
  pthread_join(ph->reader, NULL);
  if (ph->ftdi) {
    ftdi_usb_close(ph->ftdi);
    ftdi_free(ph->ftdi);
  }
  free(ph->q);
  pthread_mutex_destroy(&ph->pmx);
  pthread_cond_destroy(&ph->pcv);
  pthread_mutex_destroy(&ph->qmx);
  pthread_cond_destroy(&ph->qcv);
  logv("closed handle %ld", (long)(ph - g_h));
  memset(ph, 0, sizeof *ph);
}

static uint32_t do_read(port_handle *ph, uint8_t *out, uint32_t want, uint32_t *got) {
  pthread_mutex_lock(&ph->qmx);
  if (ph->qlen < want && ph->read_timeout_ms != 0 && !ph->dead) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    uint64_t end_us = (uint64_t)tv.tv_sec * 1000000 + tv.tv_usec + (uint64_t)ph->read_timeout_ms * 1000;
    struct timespec ts = { (time_t)(end_us / 1000000), (long)((end_us % 1000000) * 1000) };
    while (ph->qlen < want && !ph->dead) {
      if (pthread_cond_timedwait(&ph->qcv, &ph->qmx, &ts) == ETIMEDOUT) break;
    }
  } else if (ph->read_timeout_ms == 0) {
    while (ph->qlen < want && !ph->dead) pthread_cond_wait(&ph->qcv, &ph->qmx);
  }
  *got = (uint32_t)queue_pop(ph, out, want);
  pthread_mutex_unlock(&ph->qmx);
  if (ph->dead && *got == 0) return FT_IO_ERROR;
  return FT_OK;
}

static uint32_t do_write(port_handle *ph, const uint8_t *p, uint32_t n, uint32_t *written) {
  uint32_t done = 0;
  while (done < n) {
    int r = ftdi_write_data(ph->ftdi, p + done, (int)(n - done));
    if (r < 0) {
      logv("write failed (%d: %s)", r, ftdi_get_error_string(ph->ftdi));
      *written = done;
      return FT_IO_ERROR;
    }
    done += (uint32_t)r;
  }
  trace_bytes("W", (uint32_t)(ph - g_h), p, n);
  *written = done;
  return FT_OK;
}

static uint32_t do_purge(port_handle *ph, uint32_t mask) {
  int r = 0;
  if (mask & FT_PURGE_TX) r = ftdi_tcoflush(ph->ftdi);
  if (mask & FT_PURGE_RX) {
    pthread_mutex_lock(&ph->pmx);
    ph->purge_pending = true;
    while (ph->purge_pending && !ph->dead) {
      struct timespec ts;
      clock_gettime(CLOCK_REALTIME, &ts);
      ts.tv_sec += 1;
      if (pthread_cond_timedwait(&ph->pcv, &ph->pmx, &ts) == ETIMEDOUT) break;
    }
    if (ph->purge_result < 0) r = ph->purge_result;
    pthread_mutex_unlock(&ph->pmx);
  }
  return r < 0 ? FT_IO_ERROR : FT_OK;
}

static uint32_t do_cycle_port(port_handle *ph) {
  /* D2XX re-enumerates the device; the handle is invalid afterwards and the
   * caller re-lists and re-opens. Reset the USB device and tear down. */
  ph->dead = true;
  ph->reader_run = false;
  pthread_join(ph->reader, NULL);
  int r = libusb_reset_device(ph->ftdi->usb_dev);
  logv("cycle port: libusb_reset_device -> %d", r);
  ph->used = false; /* do_close must not join the reader twice */
  ftdi_usb_close(ph->ftdi);
  ftdi_free(ph->ftdi);
  free(ph->q);
  pthread_mutex_destroy(&ph->pmx);
  pthread_cond_destroy(&ph->pcv);
  pthread_mutex_destroy(&ph->qmx);
  pthread_cond_destroy(&ph->qcv);
  memset(ph, 0, sizeof *ph);
  free_enumeration();
  usleep(500000);
  return FT_OK;
}

/* ------------------------------------------------------------------------ */
/* Framing                                                                  */
/* ------------------------------------------------------------------------ */

static bool read_exact(int fd, void *p, size_t n) {
  uint8_t *b = p;
  while (n) {
    ssize_t r = read(fd, b, n);
    if (r <= 0) {
      if (r < 0 && errno == EINTR) continue;
      return false;
    }
    b += r;
    n -= (size_t)r;
  }
  return true;
}

static bool write_exact(int fd, const void *p, size_t n) {
  const uint8_t *b = p;
  while (n) {
    ssize_t r = write(fd, b, n);
    if (r <= 0) {
      if (r < 0 && errno == EINTR) continue;
      return false;
    }
    b += r;
    n -= (size_t)r;
  }
  return true;
}

static bool respond(int fd, uint32_t status, const void *payload, uint32_t n) {
  uint32_t len = 4 + n;
  uint8_t hdr[8];
  memcpy(hdr, &len, 4);
  memcpy(hdr + 4, &status, 4);
  if (!write_exact(fd, hdr, 8)) return false;
  return n == 0 || write_exact(fd, payload, n);
}

static uint32_t rd32(const uint8_t *p) {
  uint32_t v;
  memcpy(&v, p, 4);
  return v;
}

static void serve(int fd) {
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  uint8_t *req = malloc(QUEUE_CAP);
  uint8_t *resp = malloc(QUEUE_CAP);
  for (;;) {
    uint32_t len;
    if (!read_exact(fd, &len, 4)) break;
    if (len < 5 || len > QUEUE_CAP) break;
    if (!read_exact(fd, req, len)) break;
    uint8_t op = req[0];
    uint32_t hidx = rd32(req + 1);
    const uint8_t *pl = req + 5;
    uint32_t pn = len - 5;
    pthread_mutex_lock(&g_lock);
    port_handle *ph = get_handle(hidx);
    if (ph && ph->owner != fd) ph = NULL; /* not yours */
    if (ph) ph->inflight++;
    bool table_op = op == OP_OPEN || op == OP_CLOSE || op == OP_CYCLE_PORT ||
                    op == OP_CREATE_DEVICE_INFO_LIST || op == OP_GET_DEVICE_INFO_DETAIL;
    if (!table_op) pthread_mutex_unlock(&g_lock);
    uint32_t st = FT_OK;

    switch (op) {
      case OP_CREATE_DEVICE_INFO_LIST: {
        uint32_t count = (uint32_t)(enumerate() < 0 ? 0 : g_port_count);
        logv("list -> %u", count);
        respond(fd, FT_OK, &count, 4);
        break;
      }
      case OP_GET_DEVICE_INFO_DETAIL: {
        uint32_t idx = pn >= 4 ? rd32(pl) : 0xffffffffu;
        if (g_port_count == 0) enumerate();
        if (idx >= (uint32_t)g_port_count) {
          respond(fd, FT_DEVICE_NOT_FOUND, NULL, 0);
          break;
        }
        port_info *pi = &g_ports[idx];
        bridge_device_info di;
        memset(&di, 0, sizeof di);
        di.flags = FT_FLAGS_HISPEED;
        for (int i = 1; i < MAX_HANDLES; i++)
          if (g_h[i].used && g_h[i].info.dev == pi->dev && g_h[i].info.port == pi->port) di.flags |= FT_FLAGS_OPENED;
        di.type = pi->type;
        di.id = pi->id;
        di.locid = pi->locid;
        memcpy(di.serial, pi->serial, 16);
        memcpy(di.desc, pi->desc, 64);
        respond(fd, FT_OK, &di, sizeof di);
        break;
      }
      case OP_OPEN: {
        uint32_t idx = pn >= 4 ? rd32(pl) : 0;
        uint32_t h = 0;
        st = do_open(idx, fd, &h);
        respond(fd, st, &h, 4);
        break;
      }
      case OP_CLOSE:
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        ph->inflight--;
        do_close(ph);
        ph = NULL;
        respond(fd, FT_OK, NULL, 0);
        break;
      case OP_SET_BAUD_RATE: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        uint32_t baud = pn >= 4 ? rd32(pl) : 9600;
        int r = ftdi_set_baudrate(ph->ftdi, (int)baud);
        logv("h%u set baud %u -> %d", hidx, baud, r);
        respond(fd, r < 0 ? FT_INVALID_BAUD_RATE : FT_OK, NULL, 0);
        break;
      }
      case OP_SET_LATENCY_TIMER: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        uint8_t ms = pn >= 1 ? pl[0] : 16;
        int r = ftdi_set_latency_timer(ph->ftdi, ms);
        logv("h%u set latency %u -> %d", hidx, ms, r);
        respond(fd, r < 0 ? FT_INVALID_PARAMETER : FT_OK, NULL, 0);
        break;
      }
      case OP_SET_TIMEOUTS: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        if (pn >= 8) {
          ph->read_timeout_ms = rd32(pl);
          ph->write_timeout_ms = rd32(pl + 4);
          ph->ftdi->usb_write_timeout = ph->write_timeout_ms ? (int)ph->write_timeout_ms : 5000;
        }
        logv("h%u timeouts rd %u wr %u", hidx, ph->read_timeout_ms, ph->write_timeout_ms);
        respond(fd, FT_OK, NULL, 0);
        break;
      }
      case OP_PURGE: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        uint32_t mask = pn >= 4 ? rd32(pl) : 3;
        st = do_purge(ph, mask);
        logv("h%u purge %u -> %u", hidx, mask, st);
        respond(fd, st, NULL, 0);
        break;
      }
      case OP_GET_QUEUE_STATUS: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        pthread_mutex_lock(&ph->qmx);
        uint32_t avail = (uint32_t)ph->qlen;
        pthread_mutex_unlock(&ph->qmx);
        respond(fd, ph->dead && avail == 0 ? FT_IO_ERROR : FT_OK, &avail, 4);
        break;
      }
      case OP_WRITE: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        uint32_t written = 0;
        st = do_write(ph, pl, pn, &written);
        respond(fd, st, &written, 4);
        break;
      }
      case OP_READ: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        uint32_t want = pn >= 4 ? rd32(pl) : 0;
        if (want > QUEUE_CAP) want = QUEUE_CAP;
        uint32_t got = 0;
        st = do_read(ph, resp, want, &got);
        respond(fd, st, resp, got);
        break;
      }
      case OP_CYCLE_PORT:
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        ph->inflight--;
        st = do_cycle_port(ph);
        ph = NULL;
        respond(fd, st, NULL, 0);
        break;
      case OP_GET_DEVICE_INFO: {
        if (!ph) { respond(fd, FT_INVALID_HANDLE, NULL, 0); break; }
        bridge_device_info di;
        memset(&di, 0, sizeof di);
        di.flags = FT_FLAGS_HISPEED | FT_FLAGS_OPENED;
        di.type = ph->info.type;
        di.id = ph->info.id;
        di.locid = ph->info.locid;
        memcpy(di.serial, ph->info.serial, 16);
        memcpy(di.desc, ph->info.desc, 64);
        respond(fd, FT_OK, &di, sizeof di);
        break;
      }
      case OP_PING: {
        uint32_t v = BRIDGE_PROTOCOL_VERSION;
        respond(fd, FT_OK, &v, 4);
        break;
      }
      default:
        logv("unknown op %u", op);
        respond(fd, FT_NOT_SUPPORTED, NULL, 0);
    }
    if (table_op) {
      pthread_mutex_unlock(&g_lock);
    } else if (ph) {
      pthread_mutex_lock(&g_lock);
      /* the handle may have been stolen and freed meanwhile; only touch it if
       * it is still ours */
      if (ph->used && ph->owner == fd) ph->inflight--;
      pthread_mutex_unlock(&g_lock);
    }
  }
  free(req);
  free(resp);
  /* release this client's ports so a restarted worker can open the device */
  pthread_mutex_lock(&g_lock);
  for (int i = 1; i < MAX_HANDLES; i++)
    if (g_h[i].used && g_h[i].owner == fd) do_close(&g_h[i]);
  pthread_mutex_unlock(&g_lock);
}

static void *client_main(void *arg) {
  int fd = (int)(intptr_t)arg;
  logv("client %d connected", fd);
  serve(fd);
  close(fd);
  logv("client %d disconnected", fd);
  return NULL;
}

int main(int argc, char **argv) {
  int port = BRIDGE_DEFAULT_PORT;
  const char *bind_addr = "0.0.0.0";
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "-p") == 0 && i + 1 < argc) port = atoi(argv[++i]);
    else if (strcmp(argv[i], "-b") == 0 && i + 1 < argc) bind_addr = argv[++i];
    else if (strcmp(argv[i], "-v") == 0) g_verbose = 1;
    else if (strcmp(argv[i], "-t") == 0 && i + 1 < argc) g_trace = fopen(argv[++i], "a");
  }
  signal(SIGPIPE, SIG_IGN);
  if (libusb_init(&g_usb) != 0) {
    fprintf(stderr, "libusb_init failed\n");
    return 1;
  }
  int n = enumerate();
  fprintf(stderr, "[ftdi-bridge] %d FTDI port(s) visible\n", n);
  for (int i = 0; i < g_port_count; i++)
    fprintf(stderr, "[ftdi-bridge]   %d: %s  %s\n", i, g_ports[i].serial, g_ports[i].desc);

  int ls = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons((uint16_t)port);
  sa.sin_addr.s_addr = inet_addr(bind_addr);
  if (bind(ls, (struct sockaddr *)&sa, sizeof sa) != 0 || listen(ls, 4) != 0) {
    fprintf(stderr, "[ftdi-bridge] cannot listen on %s:%d: %s\n", bind_addr, port, strerror(errno));
    return 1;
  }
  printf("FTDI_BRIDGE_READY %d\n", port);
  fflush(stdout);
  for (;;) {
    int fd = accept(ls, NULL, NULL);
    if (fd < 0) continue;
    pthread_t t;
    pthread_create(&t, NULL, client_main, (void *)(intptr_t)fd);
    pthread_detach(t);
  }
}
