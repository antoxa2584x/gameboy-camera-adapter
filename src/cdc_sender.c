// cdc_sender.c
#include <string.h>
#include "tusb.h"
#include "pico/time.h"     // make_timeout_time_ms, absolute_time_diff_us
#include "hardware/sync.h" // optional; for tight_loop_contents()
#include "cdc_sender.h"
#include "datablocks.h"
#include "tusb_lwip_glue.h" // service_traffic()

#ifndef CDC_DEFAULT_TIMEOUT_MS
#define CDC_DEFAULT_TIMEOUT_MS 2000
#endif

// ---- internal helpers (not exported) ----
static inline bool is_cdc_ready(void) {
  // tud_ready() ensures device stack is configured; tud_cdc_connected() checks DTR
  return tud_ready() && tud_cdc_connected();
}

// Pump both stacks while blocked here. These sends run on the main loop, which is
// also the only place lwIP gets serviced -- pumping tud_task() alone would leave
// service_traffic() unrun for the whole transfer, so the received frame is never
// consumed (tud_network_recv_cb() starts NAKing) and the TCP timers stall. That
// is what made the web UI die while a photo was streaming over serial.
static inline void usb_net_pump(void) {
  tud_task();                    // keep USB stack alive
  service_traffic();             // keep lwIP (and so the HTTP server) alive
  tight_loop_contents();         // give core a hint (optional)
}

// pump TinyUSB while waiting for a condition
static bool wait_until_true_or_timeout(bool (*cond)(void), uint32_t timeout_ms) {
  absolute_time_t deadline = make_timeout_time_ms(timeout_ms);
  while (absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
    if (cond()) return true;
    usb_net_pump();
  }
  return cond();
}

#if CFG_TUD_CDC
bool cdc_send_bytes(const uint8_t* data, uint32_t len, uint32_t timeout_ms) {
    if (!data || !len) return true;
    if (timeout_ms == 0) timeout_ms = 2000;

    // wait until device configured and DTR set
    absolute_time_t deadline = make_timeout_time_ms(timeout_ms);
    while (!(tud_ready() && tud_cdc_connected())) {
        if (absolute_time_diff_us(get_absolute_time(), deadline) <= 0) return false;
        usb_net_pump();
    }

    uint32_t sent = 0;
    // progress timeout: if we make no progress for timeout_ms, abort
    absolute_time_t progress_deadline = make_timeout_time_ms(timeout_ms);

    while (sent < len) {
        usb_net_pump();

        uint32_t avail = tud_cdc_write_available();
        if (avail == 0) {
            if (absolute_time_diff_us(get_absolute_time(), progress_deadline) <= 0) {
                return false; // no progress for too long
            }
            continue;
        }

        uint32_t chunk = len - sent;
        if (chunk > avail) chunk = avail;
        if (chunk > 128)   chunk = 128;   // keep bursts small

        uint32_t n = tud_cdc_write(data + sent, chunk);
        tud_cdc_write_flush();

        if (n == 0) {
            if (absolute_time_diff_us(get_absolute_time(), progress_deadline) <= 0) {
                return false;
            }
            continue;
        }

        sent += n;
        // reset progress timer after successful write
        progress_deadline = make_timeout_time_ms(timeout_ms);
    }

    return true;
}
#endif

static uint32_t base64_encode(const uint8_t *in, uint32_t inlen,
                              char *out, uint32_t outmax)
{
    static const char b64[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    uint32_t outlen = 0;
    for (uint32_t i = 0; i < inlen; i += 3) {
        if (outlen + 4 > outmax) break;

        uint32_t v = in[i] << 16;
        if (i + 1 < inlen) v |= in[i+1] << 8;
        if (i + 2 < inlen) v |= in[i+2];

        out[outlen++] = b64[(v >> 18) & 0x3F];
        out[outlen++] = b64[(v >> 12) & 0x3F];
        out[outlen++] = (i+1 < inlen) ? b64[(v >> 6) & 0x3F] : '=';
        out[outlen++] = (i+2 < inlen) ? b64[v & 0x3F] : '=';
    }
    return outlen;
}

#if CFG_TUD_CDC
void send_base64_chunk(const uint8_t* data, uint32_t len) {
    // sized for one datablock: base64(512) = 684 chars + '\n'
    static char encoded[((DATABLOCK_SIZE + 2) / 3) * 4 + 2]; // static to save stack
    uint32_t out_len = base64_encode(data, len, encoded, sizeof(encoded));
    if (out_len + 1 <= sizeof(encoded)) {
        encoded[out_len] = '\n';
        cdc_send_bytes((const uint8_t*)encoded, out_len + 1, 5000);
    }
}

bool cdc_send_string(const char* str) {
    if (!str || !*str) return true;
    return cdc_send_bytes((const uint8_t*)str, strlen(str), 2000);
}
#endif
