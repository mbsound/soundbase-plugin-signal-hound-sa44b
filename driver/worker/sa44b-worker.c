/*
 * sa44b-worker — a tiny child process that owns the Signal Hound SA API.
 *
 * Why a separate process: the vendor library is a blocking C library that
 * owns a USB device and has no timeouts. If it wedges, the plugin must be able
 * to SIGKILL it and carry on. See docs/native-runtimes.md.
 *
 * Protocol: one JSON object per line on stdin, one JSON object per line on
 * stdout. Every request carries an integer "id" and a string "op"; every
 * response echoes the id and carries "ok": true|false. All request fields are
 * flat (no nested objects), which keeps the parser below trivial.
 *
 *   {"id":1,"op":"ping"}
 *   {"id":2,"op":"list"}
 *   {"id":3,"op":"open","serial":21235737}
 *   {"id":4,"op":"config","startHz":470e6,"stopHz":616e6,"pointCount":451,
 *            "rbwHz":10000,"vbwHz":10000,"refLevelDbm":-20,"atten":-1,
 *            "gain":-1,"preamp":false,"detector":"minmax","imageReject":true,
 *            "rbwShape":"flattop","procUnits":"log","timebase":"internal",
 *            "minTrace":false}
 *   {"id":5,"op":"sweep"}
 *   {"id":6,"op":"abort"}
 *   {"id":7,"op":"close"}
 *
 * The library is loaded at runtime (LoadLibrary / dlopen), so the worker
 * starts — and can report a clear error — even when sa_api.dll is missing.
 * `--mock` (or SB_SA44B_MOCK=1) replaces the library with a synthetic
 * spectrum so the whole plugin can be exercised with no hardware and on
 * platforms Signal Hound does not support.
 *
 * Build: scripts/build-worker.sh
 */

#include <math.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <dlfcn.h>
#include <unistd.h>
#endif

#define WORKER_VERSION "0.1.0"

/* ------------------------------------------------------------------------ */
/* SA API surface we use (from sa_api.h, SA API 3.x)                        */
/* ------------------------------------------------------------------------ */

typedef int saStatus;
typedef int saDeviceType;

#define SA_SWEEPING 0
#define SA_MIN_MAX 0
#define SA_AVERAGE 1
#define SA_LOG_SCALE 0
#define SA_RBW_SHAPE_FLATTOP 1
#define SA_RBW_SHAPE_CISPR 2
#define SA_LOG_UNITS 0
#define SA_VOLT_UNITS 1
#define SA_POWER_UNITS 2
#define SA_BYPASS 3
#define SA_REF_INTERNAL_OUT 1
#define SA_REF_EXTERNAL_IN 2
#define SA_MAX_DEVICES 8

#define saNoError 0
#define saUSBCommErr (-11)
#define saExternalReferenceNotFound (-89)
#define saDeviceNotFoundErr (-8)
#define saDeviceNotOpenErr (-3)
#define saInvalidDeviceErr (-2)

typedef saStatus (*fn_saGetSerialNumberList)(int serials[8], int *count);
typedef saStatus (*fn_saOpenDeviceBySerialNumber)(int *device, int serial);
typedef saStatus (*fn_saOpenDevice)(int *device);
typedef saStatus (*fn_saCloseDevice)(int device);
typedef saStatus (*fn_saAbort)(int device);
typedef saStatus (*fn_saGetSerialNumber)(int device, int *serial);
typedef saStatus (*fn_saGetFirmwareString)(int device, char fw[16]);
typedef saStatus (*fn_saGetDeviceType)(int device, saDeviceType *type);
typedef saStatus (*fn_saConfigAcquisition)(int device, int detector, int scale);
typedef saStatus (*fn_saConfigCenterSpan)(int device, double center, double span);
typedef saStatus (*fn_saConfigLevel)(int device, double ref);
typedef saStatus (*fn_saConfigGainAtten)(int device, int atten, int gain, bool preAmp);
typedef saStatus (*fn_saConfigSweepCoupling)(int device, double rbw, double vbw, bool reject);
typedef saStatus (*fn_saConfigRBWShape)(int device, int shape);
typedef saStatus (*fn_saConfigProcUnits)(int device, int units);
typedef saStatus (*fn_saSetTimebase)(int device, int timebase);
typedef saStatus (*fn_saInitiate)(int device, int mode, int flag);
typedef saStatus (*fn_saQuerySweepInfo)(int device, int *len, double *start, double *bin);
typedef saStatus (*fn_saGetSweep_32f)(int device, float *min, float *max);
typedef saStatus (*fn_saQueryTemperature)(int device, float *temp);
typedef saStatus (*fn_saSetCalFilePath)(const char *path);
typedef const char *(*fn_saGetAPIVersion)(void);
typedef const char *(*fn_saGetErrorString)(saStatus code);

static struct {
  fn_saGetSerialNumberList GetSerialNumberList;
  fn_saOpenDeviceBySerialNumber OpenDeviceBySerialNumber;
  fn_saOpenDevice OpenDevice;
  fn_saCloseDevice CloseDevice;
  fn_saAbort Abort;
  fn_saGetSerialNumber GetSerialNumber;
  fn_saGetFirmwareString GetFirmwareString;
  fn_saGetDeviceType GetDeviceType;
  fn_saConfigAcquisition ConfigAcquisition;
  fn_saConfigCenterSpan ConfigCenterSpan;
  fn_saConfigLevel ConfigLevel;
  fn_saConfigGainAtten ConfigGainAtten;
  fn_saConfigSweepCoupling ConfigSweepCoupling;
  fn_saConfigRBWShape ConfigRBWShape;
  fn_saConfigProcUnits ConfigProcUnits;
  fn_saSetTimebase SetTimebase;
  fn_saInitiate Initiate;
  fn_saQuerySweepInfo QuerySweepInfo;
  fn_saGetSweep_32f GetSweep_32f;
  fn_saQueryTemperature QueryTemperature;
  fn_saSetCalFilePath SetCalFilePath;
  fn_saGetAPIVersion GetAPIVersion;
  fn_saGetErrorString GetErrorString;
} sa;

/* ------------------------------------------------------------------------ */
/* State                                                                    */
/* ------------------------------------------------------------------------ */

static bool g_mock = false;
static bool g_lib_loaded = false;
static char g_lib_error[2048] = "";
static char g_lib_path[1536] = "";

static int g_handle = -1;
static bool g_open = false;
static bool g_initiated = false;
static int g_serial = 0;
static saDeviceType g_type = 0;
static char g_firmware[32] = "";

/* effective sweep geometry after config */
static int g_sweep_len = 0;
static double g_start_hz = 0;
static double g_bin_hz = 0;
static int g_point_count = 0;
static float *g_min = NULL;
static float *g_max = NULL;
static double *g_out = NULL;
static double *g_out_min = NULL;
static bool g_min_trace = false;
static int g_timebase_applied = 0; /* 0 internal, SA_REF_* once set */

/* mock-only */
static double g_mock_rbw = 10000;
static int g_mock_detector = SA_MIN_MAX;
static unsigned g_mock_sweeps = 0;

/* ------------------------------------------------------------------------ */
/* Utilities                                                                */
/* ------------------------------------------------------------------------ */

static double now_ms(void) {
#ifdef _WIN32
  return (double)GetTickCount64();
#else
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
#endif
}

static void sleep_ms(int ms) {
#ifdef _WIN32
  Sleep(ms);
#else
  usleep((useconds_t)ms * 1000);
#endif
}

static void logf_(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  fputs("[sa44b-worker] ", stderr);
  vfprintf(stderr, fmt, ap);
  fputc('\n', stderr);
  va_end(ap);
  fflush(stderr);
}

/* Minimal JSON helpers for flat objects. Keys are matched as `"key"` followed
 * by optional whitespace and a colon. Good enough for the lines the driver
 * sends, which it builds with JSON.stringify and never nests. */
static const char *json_find(const char *line, const char *key) {
  char needle[128];
  snprintf(needle, sizeof needle, "\"%s\"", key);
  const char *p = line;
  size_t nlen = strlen(needle);
  while ((p = strstr(p, needle)) != NULL) {
    const char *q = p + nlen;
    while (*q == ' ' || *q == '\t') q++;
    if (*q == ':') {
      q++;
      while (*q == ' ' || *q == '\t') q++;
      return q;
    }
    p += nlen;
  }
  return NULL;
}

static bool json_number(const char *line, const char *key, double *out) {
  const char *v = json_find(line, key);
  if (!v) return false;
  if (strncmp(v, "null", 4) == 0) return false;
  char *end;
  double d = strtod(v, &end);
  if (end == v) return false;
  *out = d;
  return true;
}

static bool json_bool(const char *line, const char *key, bool *out) {
  const char *v = json_find(line, key);
  if (!v) return false;
  if (strncmp(v, "true", 4) == 0) {
    *out = true;
    return true;
  }
  if (strncmp(v, "false", 5) == 0) {
    *out = false;
    return true;
  }
  return false;
}

static bool json_string(const char *line, const char *key, char *buf, size_t cap) {
  const char *v = json_find(line, key);
  if (!v || *v != '"') return false;
  v++;
  size_t n = 0;
  while (*v && *v != '"' && n + 1 < cap) {
    if (*v == '\\' && v[1]) v++;
    buf[n++] = *v++;
  }
  buf[n] = 0;
  return true;
}

/* JSON-escape a string into a fixed buffer */
static void json_escape(const char *in, char *out, size_t cap) {
  size_t n = 0;
  for (; *in && n + 2 < cap; in++) {
    unsigned char c = (unsigned char)*in;
    if (c == '"' || c == '\\') {
      out[n++] = '\\';
      out[n++] = (char)c;
    } else if (c < 0x20) {
      out[n++] = ' ';
    } else {
      out[n++] = (char)c;
    }
  }
  out[n] = 0;
}

static void reply_error(long id, const char *code, bool fatal, const char *fmt, ...) {
  char msg[512], esc[1100];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(msg, sizeof msg, fmt, ap);
  va_end(ap);
  json_escape(msg, esc, sizeof esc);
  printf("{\"id\":%ld,\"ok\":false,\"code\":\"%s\",\"fatal\":%s,\"error\":\"%s\"}\n", id, code,
         fatal ? "true" : "false", esc);
  fflush(stdout);
}

static const char *sa_error_string(saStatus st) {
  if (g_mock) return st == 0 ? "no error" : "mock error";
  if (sa.GetErrorString) {
    const char *s = sa.GetErrorString(st);
    if (s) return s;
  }
  return "unknown SA API status";
}

static bool sa_is_fatal(saStatus st) {
  return st == saUSBCommErr || st == saDeviceNotFoundErr || st == saDeviceNotOpenErr ||
         st == saInvalidDeviceErr;
}

/* ------------------------------------------------------------------------ */
/* Library loading                                                          */
/* ------------------------------------------------------------------------ */

#ifdef _WIN32
#define LIB_NAME "sa_api.dll"
#elif defined(__APPLE__)
#define LIB_NAME "libsa_api.dylib"
#else
#define LIB_NAME "libsa_api.so"
#endif

static void *lib_open(const char *dir) {
  char path[1200];
  if (dir && *dir && strlen(dir) < 1024) {
    size_t n = strlen(dir);
    const char *sep = (dir[n - 1] == '/' || dir[n - 1] == '\\') ? "" : "/";
    snprintf(path, sizeof path, "%s%s%s", dir, sep, LIB_NAME);
  } else {
    snprintf(path, sizeof path, "%s", LIB_NAME);
  }
#ifdef _WIN32
  /* sa_api.dll loads ftd2xx.dll from beside itself; make that directory
   * part of the search path for this process. */
  if (dir && *dir) SetDllDirectoryA(dir);
  HMODULE h = LoadLibraryA(path);
  if (h) snprintf(g_lib_path, sizeof g_lib_path, "%s", path);
  return (void *)h;
#else
  void *h = dlopen(path, RTLD_NOW);
  if (h) snprintf(g_lib_path, sizeof g_lib_path, "%s", path);
  return h;
#endif
}

static void *lib_sym(void *h, const char *name) {
#ifdef _WIN32
  return (void *)GetProcAddress((HMODULE)h, name);
#else
  return dlsym(h, name);
#endif
}

static bool load_library(const char *explicit_dir, const char *exe_dir) {
  const char *candidates[6];
  int n = 0;
  if (explicit_dir && *explicit_dir) candidates[n++] = explicit_dir;
  const char *env = getenv("SB_SA44B_SDK_DIR");
  if (env && *env) candidates[n++] = env;
  if (exe_dir && *exe_dir) candidates[n++] = exe_dir;
#ifdef _WIN32
  candidates[n++] = "C:\\Program Files\\Signal Hound\\Spike";
  candidates[n++] = "C:\\Program Files (x86)\\Signal Hound\\Spike";
#endif
  candidates[n++] = ""; /* default loader search */

  void *h = NULL;
  for (int i = 0; i < n && !h; i++) h = lib_open(candidates[i]);
  if (!h) {
    snprintf(g_lib_error, sizeof g_lib_error,
             "%s not found. Install Spike from signalhound.com, or point the plugin's "
             "\"SDK folder\" setting (or SB_SA44B_SDK_DIR) at a folder containing %s and ftd2xx.dll.",
             LIB_NAME, LIB_NAME);
    return false;
  }

#define LOAD(name)                                                              \
  do {                                                                          \
    sa.name = (fn_sa##name)lib_sym(h, "sa" #name);                              \
    if (!sa.name) {                                                             \
      snprintf(g_lib_error, sizeof g_lib_error, "%s is missing sa" #name, g_lib_path); \
      return false;                                                             \
    }                                                                           \
  } while (0)

  LOAD(GetSerialNumberList);
  LOAD(OpenDeviceBySerialNumber);
  LOAD(OpenDevice);
  LOAD(CloseDevice);
  LOAD(Abort);
  LOAD(GetSerialNumber);
  LOAD(GetFirmwareString);
  LOAD(GetDeviceType);
  LOAD(ConfigAcquisition);
  LOAD(ConfigCenterSpan);
  LOAD(ConfigLevel);
  LOAD(ConfigGainAtten);
  LOAD(ConfigSweepCoupling);
  LOAD(ConfigRBWShape);
  LOAD(ConfigProcUnits);
  LOAD(SetTimebase);
  LOAD(Initiate);
  LOAD(QuerySweepInfo);
  LOAD(GetSweep_32f);
  LOAD(QueryTemperature);
  LOAD(GetAPIVersion);
  LOAD(GetErrorString);
  /* optional */
  sa.SetCalFilePath = (fn_saSetCalFilePath)lib_sym(h, "saSetCalFilePath");
#undef LOAD
  return true;
}

static const char *device_type_name(saDeviceType t) {
  switch (t) {
    case 1: return "SA44";
    case 2: return "SA44B";
    case 3: return "SA124A";
    case 4: return "SA124B";
    default: return "unknown";
  }
}

/* ------------------------------------------------------------------------ */
/* Mock device                                                              */
/* ------------------------------------------------------------------------ */

#define MOCK_SERIAL 12345678

static double frand(void) { return rand() / (double)RAND_MAX; }

static double bump(double f, double center, double width, double height) {
  double x = (f - center) / width;
  return height * exp(-x * x);
}

/* A noise floor with two carriers at 33% and 66% of the span and a transient
 * at 50% on one sweep in seven — the same spectrum the template's synthetic
 * source produces, so the contract tests keep their meaning. */
static void mock_sweep(void) {
  double span = g_bin_hz * (g_sweep_len - 1);
  double peak_a = g_start_hz + span * 0.33;
  double peak_b = g_start_hz + span * 0.66;
  double transient = g_start_hz + span * 0.5;
  g_mock_sweeps++;
  bool with_transient = (g_mock_sweeps % 7) == 0;
  for (int i = 0; i < g_sweep_len; i++) {
    double f = g_start_hz + i * g_bin_hz;
    double amp = -100.0 + (frand() * 4.0 - 2.0);
    amp += bump(f, peak_a, span * 0.01, 45);
    amp += bump(f, peak_b, span * 0.006, 30);
    if (with_transient) amp += bump(f, transient, span * 0.003, 50);
    g_max[i] = (float)amp;
    g_min[i] = (float)(amp - (g_mock_detector == SA_MIN_MAX ? 1.5 : 0.0));
  }
  /* a real SA44B sweeps at a finite rate; approximate it so timing paths run */
  int ms = 20 + g_sweep_len / 2000;
  if (ms > 400) ms = 400;
  sleep_ms(ms);
}

/* ------------------------------------------------------------------------ */
/* Resampling                                                               */
/* ------------------------------------------------------------------------ */

/* Resample a device sweep (`src`, g_sweep_len bins from g_start_hz at
 * g_bin_hz) onto g_point_count points spanning the same range. Where several
 * bins fall into one output point the maximum (or, for the min trace, the
 * minimum) is kept so a narrow carrier never disappears between points; where
 * output points are denser than bins, values are linearly interpolated. */
static void resample(const float *src, double *out, bool keep_min) {
  int n = g_point_count;
  int len = g_sweep_len;
  if (n <= 0 || len <= 0) return;
  if (len == 1) {
    for (int j = 0; j < n; j++) out[j] = src[0];
    return;
  }
  double stop = g_start_hz + g_bin_hz * (len - 1);
  double step = (n > 1) ? (stop - g_start_hz) / (n - 1) : 0;
  if (step >= g_bin_hz) {
    for (int j = 0; j < n; j++) {
      double p = g_start_hz + j * step;
      double lo = (p - step / 2 - g_start_hz) / g_bin_hz;
      double hi = (p + step / 2 - g_start_hz) / g_bin_hz;
      int a = (int)ceil(lo - 1e-9);
      int b = (int)floor(hi + 1e-9);
      if (a < 0) a = 0;
      if (b > len - 1) b = len - 1;
      if (a > b) {
        int k = (int)floor((p - g_start_hz) / g_bin_hz + 0.5);
        if (k < 0) k = 0;
        if (k > len - 1) k = len - 1;
        a = b = k;
      }
      float m = src[a];
      for (int k = a + 1; k <= b; k++)
        if (keep_min ? src[k] < m : src[k] > m) m = src[k];
      out[j] = m;
    }
  } else {
    for (int j = 0; j < n; j++) {
      double pos = (j * step) / g_bin_hz;
      int k = (int)floor(pos);
      if (k >= len - 1) {
        out[j] = src[len - 1];
        continue;
      }
      double t = pos - k;
      out[j] = src[k] * (1 - t) + src[k + 1] * t;
    }
  }
}

static bool ensure_buffers(int sweep_len, int point_count) {
  float *mn = (float *)realloc(g_min, sizeof(float) * (size_t)sweep_len);
  float *mx = (float *)realloc(g_max, sizeof(float) * (size_t)sweep_len);
  double *out = (double *)realloc(g_out, sizeof(double) * (size_t)point_count);
  double *outmin = (double *)realloc(g_out_min, sizeof(double) * (size_t)point_count);
  if (!mn || !mx || !out || !outmin) return false;
  g_min = mn;
  g_max = mx;
  g_out = out;
  g_out_min = outmin;
  return true;
}

/* ------------------------------------------------------------------------ */
/* Ops                                                                      */
/* ------------------------------------------------------------------------ */

static void op_ping(long id) {
  const char *api = g_mock ? "mock" : (g_lib_loaded ? sa.GetAPIVersion() : "unavailable");
  char esc[256], lib[3100], err[4200];
  json_escape(api ? api : "", esc, sizeof esc);
  json_escape(g_lib_path, lib, sizeof lib);
  json_escape(g_lib_error, err, sizeof err);
  printf("{\"id\":%ld,\"ok\":true,\"worker\":\"%s\",\"mock\":%s,\"libraryLoaded\":%s,"
         "\"apiVersion\":\"%s\",\"libraryPath\":\"%s\",\"libraryError\":\"%s\"}\n",
         id, WORKER_VERSION, g_mock ? "true" : "false", g_lib_loaded ? "true" : "false", esc,
         lib, err);
  fflush(stdout);
}

static void op_list(long id) {
  int serials[SA_MAX_DEVICES] = {0};
  int count = 0;
  if (g_mock) {
    serials[0] = MOCK_SERIAL;
    count = 1;
  } else {
    if (!g_lib_loaded) {
      reply_error(id, "library_unavailable", false, "%s", g_lib_error);
      return;
    }
    saStatus st = sa.GetSerialNumberList(serials, &count);
    if (st < 0) {
      reply_error(id, "sa_error", false, "saGetSerialNumberList: %s", sa_error_string(st));
      return;
    }
    if (count < 0) count = 0;
    if (count > SA_MAX_DEVICES) count = SA_MAX_DEVICES;
  }
  printf("{\"id\":%ld,\"ok\":true,\"serials\":[", id);
  for (int i = 0; i < count; i++) printf("%s%d", i ? "," : "", serials[i]);
  printf("]}\n");
  fflush(stdout);
}

static void op_open(long id, const char *line) {
  double serial_d = 0;
  bool has_serial = json_number(line, "serial", &serial_d);
  int serial = has_serial ? (int)serial_d : 0;

  if (g_open) {
    reply_error(id, "already_open", false, "device %d is already open in this worker", g_serial);
    return;
  }

  if (g_mock) {
    if (has_serial && serial != MOCK_SERIAL) {
      reply_error(id, "device_not_found", true, "no SA device with serial %d", serial);
      return;
    }
    g_handle = 1;
    g_serial = MOCK_SERIAL;
    g_type = 2;
    snprintf(g_firmware, sizeof g_firmware, "mock");
  } else {
    if (!g_lib_loaded) {
      reply_error(id, "library_unavailable", true, "%s", g_lib_error);
      return;
    }
    double t0 = now_ms();
    saStatus st = has_serial ? sa.OpenDeviceBySerialNumber(&g_handle, serial)
                             : sa.OpenDevice(&g_handle);
    if (st < 0) {
      reply_error(id, "sa_error", true, "saOpenDevice: %s (%d)", sa_error_string(st), st);
      return;
    }
    logf_("opened device in %.0f ms (status %d%s%s)", now_ms() - t0, st,
          st > 0 ? ": " : "", st > 0 ? sa_error_string(st) : "");
    sa.GetSerialNumber(g_handle, &g_serial);
    sa.GetDeviceType(g_handle, &g_type);
    char fw[16] = {0};
    if (sa.GetFirmwareString(g_handle, fw) == saNoError) {
      memcpy(g_firmware, fw, 16);
      g_firmware[16] = 0;
    } else {
      g_firmware[0] = 0;
    }
  }
  g_open = true;
  g_initiated = false;
  char fw_esc[80];
  json_escape(g_firmware, fw_esc, sizeof fw_esc);
  printf("{\"id\":%ld,\"ok\":true,\"serial\":%d,\"typeId\":%d,\"type\":\"%s\",\"firmware\":\"%s\"}\n",
         id, g_serial, (int)g_type, device_type_name(g_type), fw_esc);
  fflush(stdout);
}

static void op_config(long id, const char *line) {
  if (!g_open) {
    reply_error(id, "not_open", false, "open a device first");
    return;
  }
  double start = 470e6, stop = 616e6, points = 451, rbw = 10e3, vbw = -1, ref = -20;
  double atten = -1, gain = -1;
  bool preamp = false, reject = true;
  char detector[32] = "minmax", shape[32] = "flattop", units[32] = "log", timebase[32] = "internal";
  bool min_trace = false;
  json_number(line, "startHz", &start);
  json_number(line, "stopHz", &stop);
  json_number(line, "pointCount", &points);
  json_number(line, "rbwHz", &rbw);
  json_number(line, "vbwHz", &vbw);
  json_number(line, "refLevelDbm", &ref);
  json_number(line, "atten", &atten);
  json_number(line, "gain", &gain);
  json_bool(line, "preamp", &preamp);
  json_bool(line, "imageReject", &reject);
  json_string(line, "detector", detector, sizeof detector);
  json_string(line, "rbwShape", shape, sizeof shape);
  json_string(line, "procUnits", units, sizeof units);
  json_string(line, "timebase", timebase, sizeof timebase);
  json_bool(line, "minTrace", &min_trace);
  if (vbw <= 0) vbw = rbw;
  if (vbw > rbw) vbw = rbw;
  if (stop <= start) stop = start + 1;
  int point_count = (int)(points + 0.5);
  if (point_count < 2) point_count = 2;
  if (point_count > 100000) point_count = 100000;
  int det = (strcmp(detector, "average") == 0) ? SA_AVERAGE : SA_MIN_MAX;
  int rbw_shape = (strcmp(shape, "cispr") == 0) ? SA_RBW_SHAPE_CISPR : SA_RBW_SHAPE_FLATTOP;
  int proc_units = strcmp(units, "volt") == 0 ? SA_VOLT_UNITS
                   : strcmp(units, "power") == 0 ? SA_POWER_UNITS
                   : strcmp(units, "bypass") == 0 ? SA_BYPASS : SA_LOG_UNITS;
  int tb_wanted = strcmp(timebase, "external") == 0 ? SA_REF_EXTERNAL_IN
                  : strcmp(timebase, "internal-out") == 0 ? SA_REF_INTERNAL_OUT : 0;
  g_min_trace = min_trace;
  const char *tb_effective = "internal";

  double center = (start + stop) / 2;
  double span = stop - start;
  int warnings = 0;
  char warn_text[256] = "";

  if (g_mock) {
    g_timebase_applied = tb_wanted;
    g_mock_rbw = rbw;
    g_mock_detector = det;
    double bin = rbw / 2.0;
    double len_d = floor(span / bin) + 1;
    if (len_d > 2000000) {
      bin = span / 1999999.0;
      len_d = 2000000;
    }
    g_sweep_len = (int)len_d;
    g_start_hz = start;
    g_bin_hz = bin;
  } else {
    saStatus st;
    sa.Abort(g_handle);
    g_initiated = false;
#define CHECK(call, name)                                                                 \
    do {                                                                                  \
      st = (call);                                                                        \
      if (st < 0) {                                                                       \
        reply_error(id, "sa_error", sa_is_fatal(st), name ": %s (%d)", sa_error_string(st), st); \
        return;                                                                           \
      }                                                                                   \
      if (st > 0) {                                                                       \
        warnings++;                                                                       \
        if (!warn_text[0]) snprintf(warn_text, sizeof warn_text, name ": %s", sa_error_string(st)); \
      }                                                                                   \
    } while (0)
    CHECK(sa.ConfigCenterSpan(g_handle, center, span), "saConfigCenterSpan");
    CHECK(sa.ConfigLevel(g_handle, ref), "saConfigLevel");
    CHECK(sa.ConfigGainAtten(g_handle, (int)atten, (int)gain, preamp), "saConfigGainAtten");
    CHECK(sa.ConfigSweepCoupling(g_handle, rbw, vbw, reject), "saConfigSweepCoupling");
    CHECK(sa.ConfigRBWShape(g_handle, rbw_shape), "saConfigRBWShape");
    CHECK(sa.ConfigProcUnits(g_handle, proc_units), "saConfigProcUnits");
    CHECK(sa.ConfigAcquisition(g_handle, det, SA_LOG_SCALE), "saConfigAcquisition");
    /* The reference port: only sent when it changes. A missing external
     * reference is not an error for the sweep; the device stays on its
     * internal clock and the echo says so. Once on an external reference the
     * API keeps it until the device is closed. */
    if (tb_wanted != g_timebase_applied) {
      if (tb_wanted == 0 && g_timebase_applied == SA_REF_EXTERNAL_IN) {
        warnings++;
        snprintf(warn_text, sizeof warn_text,
                 "saSetTimebase: an external reference stays selected until the device is reopened");
      } else if (tb_wanted != 0) {
        st = sa.SetTimebase(g_handle, tb_wanted);
        if (st == saExternalReferenceNotFound) {
          warnings++;
          snprintf(warn_text, sizeof warn_text, "saSetTimebase: no 10 MHz reference found on the BNC port");
        } else if (st < 0) {
          reply_error(id, "sa_error", sa_is_fatal(st), "saSetTimebase: %s (%d)", sa_error_string(st), st);
          return;
        } else {
          g_timebase_applied = tb_wanted;
        }
      } else {
        g_timebase_applied = 0; /* internal-out -> internal: nothing to send */
      }
    }
    CHECK(sa.Initiate(g_handle, SA_SWEEPING, 0), "saInitiate");
    g_initiated = true;
    int len = 0;
    double sf = 0, bs = 0;
    CHECK(sa.QuerySweepInfo(g_handle, &len, &sf, &bs), "saQuerySweepInfo");
#undef CHECK
    if (len < 1 || bs <= 0) {
      reply_error(id, "sa_error", false, "saQuerySweepInfo returned an empty sweep");
      return;
    }
    g_sweep_len = len;
    g_start_hz = sf;
    g_bin_hz = bs;
  }

  g_point_count = point_count;
  if (!ensure_buffers(g_sweep_len, g_point_count)) {
    reply_error(id, "out_of_memory", true, "could not allocate %d sweep bins", g_sweep_len);
    return;
  }
  double eff_stop = g_start_hz + g_bin_hz * (g_sweep_len - 1);
  tb_effective = g_timebase_applied == SA_REF_EXTERNAL_IN ? "external"
                 : g_timebase_applied == SA_REF_INTERNAL_OUT ? "internal-out" : "internal";
  char warn_esc[600];
  json_escape(warn_text, warn_esc, sizeof warn_esc);
  printf("{\"id\":%ld,\"ok\":true,\"startHz\":%.3f,\"stopHz\":%.3f,\"pointCount\":%d,"
         "\"sweepLength\":%d,\"binSizeHz\":%.6f,\"rbwHz\":%.3f,\"vbwHz\":%.3f,\"refLevelDbm\":%.2f,"
         "\"atten\":%d,\"gain\":%d,\"preamp\":%s,\"imageReject\":%s,\"detector\":\"%s\","
         "\"rbwShape\":\"%s\",\"procUnits\":\"%s\",\"timebase\":\"%s\",\"minTrace\":%s,"
         "\"warnings\":%d,\"warning\":\"%s\"}\n",
         id, g_start_hz, eff_stop, g_point_count, g_sweep_len, g_bin_hz, rbw, vbw, ref, (int)atten,
         (int)gain, preamp ? "true" : "false", reject ? "true" : "false",
         det == SA_AVERAGE ? "average" : "minmax", rbw_shape == SA_RBW_SHAPE_CISPR ? "cispr" : "flattop",
         proc_units == SA_VOLT_UNITS ? "volt" : proc_units == SA_POWER_UNITS ? "power"
                                                                           : proc_units == SA_BYPASS ? "bypass" : "log",
         tb_effective, min_trace ? "true" : "false", warnings, warn_esc);
  fflush(stdout);
}

static void op_sweep(long id) {
  if (!g_open) {
    reply_error(id, "not_open", false, "open a device first");
    return;
  }
  if (g_sweep_len <= 0 || (!g_mock && !g_initiated)) {
    reply_error(id, "not_configured", false, "configure the sweep first");
    return;
  }
  double t0 = now_ms();
  if (g_mock) {
    mock_sweep();
  } else {
    saStatus st = sa.GetSweep_32f(g_handle, g_min, g_max);
    if (st < 0) {
      reply_error(id, "sa_error", sa_is_fatal(st), "saGetSweep_32f: %s (%d)", sa_error_string(st), st);
      return;
    }
  }
  double ms = now_ms() - t0;
  resample(g_max, g_out, false);
  if (g_min_trace) resample(g_min, g_out_min, true);

  /* one line: {"id":N,"ok":true,"sweepMs":123,"amps":[...],"mins":[...]} */
  size_t cap = 2 * 24 * (size_t)g_point_count + 160;
  char *buf = (char *)malloc(cap);
  if (!buf) {
    reply_error(id, "out_of_memory", true, "could not allocate the trace buffer");
    return;
  }
  size_t n = (size_t)snprintf(buf, cap, "{\"id\":%ld,\"ok\":true,\"sweepMs\":%.0f,\"amps\":[", id, ms);
  for (int j = 0; j < g_point_count; j++) {
    double v = g_out[j];
    if (!(v == v) || v < -200 || v > 200) v = -200; /* NaN or nonsense */
    n += (size_t)snprintf(buf + n, cap - n, "%s%.1f", j ? "," : "", v);
  }
  n += (size_t)snprintf(buf + n, cap - n, "]");
  if (g_min_trace) {
    n += (size_t)snprintf(buf + n, cap - n, ",\"mins\":[");
    for (int j = 0; j < g_point_count; j++) {
      double v = g_out_min[j];
      if (!(v == v) || v < -200 || v > 200) v = -200;
      n += (size_t)snprintf(buf + n, cap - n, "%s%.1f", j ? "," : "", v);
    }
    n += (size_t)snprintf(buf + n, cap - n, "]");
  }
  n += (size_t)snprintf(buf + n, cap - n, "}\n");
  fwrite(buf, 1, n, stdout);
  fflush(stdout);
  free(buf);
}

static void op_abort(long id) {
  if (g_open && !g_mock && g_initiated) sa.Abort(g_handle);
  g_initiated = false;
  printf("{\"id\":%ld,\"ok\":true}\n", id);
  fflush(stdout);
}

static void op_close(long id) {
  if (g_open && !g_mock) {
    sa.Abort(g_handle);
    sa.CloseDevice(g_handle);
  }
  g_open = false;
  g_initiated = false;
  g_sweep_len = 0;
  g_timebase_applied = 0;
  printf("{\"id\":%ld,\"ok\":true}\n", id);
  fflush(stdout);
}

static void op_temperature(long id) {
  float temp = 0;
  if (!g_open) {
    reply_error(id, "not_open", false, "open a device first");
    return;
  }
  if (g_mock) {
    temp = 36.5f;
  } else {
    saStatus st = sa.QueryTemperature(g_handle, &temp);
    if (st < 0) {
      reply_error(id, "sa_error", sa_is_fatal(st), "saQueryTemperature: %s", sa_error_string(st));
      return;
    }
  }
  printf("{\"id\":%ld,\"ok\":true,\"celsius\":%.1f}\n", id, temp);
  fflush(stdout);
}

/* ------------------------------------------------------------------------ */
/* Main loop                                                                */
/* ------------------------------------------------------------------------ */

static void exe_dir(const char *argv0, char *out, size_t cap) {
  out[0] = 0;
  (void)argv0;
  (void)cap;
#ifdef _WIN32
  char path[MAX_PATH];
  DWORD n = GetModuleFileNameA(NULL, path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return;
  char *slash = strrchr(path, '\\');
  if (slash) *slash = 0;
  snprintf(out, cap, "%s", path);
#endif
}

int main(int argc, char **argv) {
  const char *sdk_dir = NULL;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--mock") == 0) g_mock = true;
    else if (strcmp(argv[i], "--sdk") == 0 && i + 1 < argc) sdk_dir = argv[++i];
    else if (strcmp(argv[i], "--version") == 0) {
      printf("sa44b-worker %s\n", WORKER_VERSION);
      return 0;
    }
  }
  const char *mock_env = getenv("SB_SA44B_MOCK");
  if (mock_env && *mock_env && strcmp(mock_env, "0") != 0) g_mock = true;

  setvbuf(stdout, NULL, _IOFBF, 1 << 16);
  srand((unsigned)time(NULL));

  if (!g_mock) {
    char dir[1024];
    exe_dir(argv[0], dir, sizeof dir);
    g_lib_loaded = load_library(sdk_dir, dir);
    if (g_lib_loaded) logf_("loaded %s (SA API %s)", g_lib_path, sa.GetAPIVersion());
    else logf_("%s", g_lib_error);
  } else {
    logf_("mock mode: no hardware, synthetic spectrum");
  }

  /* lines can be long only in theory (flat objects); 64 KB is generous */
  static char line[65536];
  while (fgets(line, sizeof line, stdin)) {
    double id_d = -1;
    char op[32] = "";
    json_number(line, "id", &id_d);
    long id = (long)id_d;
    if (!json_string(line, "op", op, sizeof op)) {
      reply_error(id, "bad_request", false, "missing op");
      continue;
    }
    if (strcmp(op, "ping") == 0) op_ping(id);
    else if (strcmp(op, "list") == 0) op_list(id);
    else if (strcmp(op, "open") == 0) op_open(id, line);
    else if (strcmp(op, "config") == 0) op_config(id, line);
    else if (strcmp(op, "sweep") == 0) op_sweep(id);
    else if (strcmp(op, "abort") == 0) op_abort(id);
    else if (strcmp(op, "temperature") == 0) op_temperature(id);
    else if (strcmp(op, "close") == 0) op_close(id);
    else if (strcmp(op, "exit") == 0) {
      op_close(id);
      break;
    } else reply_error(id, "bad_request", false, "unknown op \"%s\"", op);
  }
  if (g_open && !g_mock) {
    sa.Abort(g_handle);
    sa.CloseDevice(g_handle);
  }
  return 0;
}
