/* Wire protocol shared by driver/bridge/ftdi-bridge.c (macOS, serves the USB
 * device) and driver/shim/ftd2xx-shim.c (Linux, pretends to be libftd2xx.so).
 *
 *   request : u32 len | u8 op | u32 handle | payload[len-5]
 *   response: u32 len | u32 ft_status | payload[len-4]
 *
 * All integers little-endian. One outstanding request per connection.
 */
#ifndef FTDI_BRIDGE_PROTOCOL_H
#define FTDI_BRIDGE_PROTOCOL_H

#include <stdint.h>

#define BRIDGE_DEFAULT_PORT 7788
#define BRIDGE_PROTOCOL_VERSION 1

enum bridge_op {
  OP_PING = 0,                   /* -> u32 protocol version */
  OP_CREATE_DEVICE_INFO_LIST = 1, /* -> u32 count */
  OP_GET_DEVICE_INFO_DETAIL = 2,  /* u32 index -> bridge_device_info */
  OP_OPEN = 3,                    /* u32 index -> u32 handle */
  OP_CLOSE = 4,                   /* handle */
  OP_SET_BAUD_RATE = 5,           /* handle, u32 baud */
  OP_SET_LATENCY_TIMER = 6,       /* handle, u8 ms */
  OP_SET_TIMEOUTS = 7,            /* handle, u32 read ms, u32 write ms */
  OP_PURGE = 8,                   /* handle, u32 mask (1 rx, 2 tx) */
  OP_GET_QUEUE_STATUS = 9,        /* handle -> u32 bytes available */
  OP_WRITE = 10,                  /* handle, bytes -> u32 written */
  OP_READ = 11,                   /* handle, u32 want -> bytes */
  OP_CYCLE_PORT = 12,             /* handle */
  OP_GET_DEVICE_INFO = 13,        /* handle -> bridge_device_info */
};

typedef struct {
  uint32_t flags;
  uint32_t type;
  uint32_t id;
  uint32_t locid;
  char serial[16];
  char desc[64];
} bridge_device_info; /* 96 bytes, no padding */

/* FT_STATUS values from FTDI's ftd2xx.h */
enum {
  FT_OK = 0,
  FT_INVALID_HANDLE = 1,
  FT_DEVICE_NOT_FOUND = 2,
  FT_DEVICE_NOT_OPENED = 3,
  FT_IO_ERROR = 4,
  FT_INSUFFICIENT_RESOURCES = 5,
  FT_INVALID_PARAMETER = 6,
  FT_INVALID_BAUD_RATE = 7,
  FT_NOT_SUPPORTED = 17,
  FT_OTHER_ERROR = 18,
};

/* FT_DEVICE values */
enum {
  FT_DEVICE_BM = 0,
  FT_DEVICE_AM = 1,
  FT_DEVICE_100AX = 2,
  FT_DEVICE_UNKNOWN = 3,
  FT_DEVICE_2232C = 4,
  FT_DEVICE_232R = 5,
  FT_DEVICE_2232H = 6,
  FT_DEVICE_4232H = 7,
  FT_DEVICE_232H = 8,
};

#define FT_FLAGS_OPENED 1
#define FT_FLAGS_HISPEED 2
#define FT_PURGE_RX 1
#define FT_PURGE_TX 2

#endif
