// cdc_sender.c
#include <string.h>
#include "tusb.h"
#include "pico/time.h"     // make_timeout_time_ms, absolute_time_diff_us
#include "hardware/sync.h" // optional; for tight_loop_contents()
#include "cdc_sender.h"
#include "datablocks.h"

#ifndef CDC_DEFAULT_TIMEOUT_MS
#define CDC_DEFAULT_TIMEOUT_MS 2000
#endif

// ---- internal helpers (not exported) ----
static inline bool is_cdc_ready(void) {
  // tud_ready() ensures device stack is configured; tud_cdc_connected() checks DTR
  return tud_ready() && tud_cdc_connected();
}

// pump TinyUSB while waiting for a condition
static bool wait_until_true_or_timeout(bool (*cond)(void), uint32_t timeout_ms) {
  absolute_time_t deadline = make_timeout_time_ms(timeout_ms);
  while (absolute_time_diff_us(get_absolute_time(), deadline) > 0) {
    if (cond()) return true;
    tud_task();                  // keep USB stack alive
    tight_loop_contents();       // give core a hint (optional)
  }
  return cond();
}

bool cdc_send_bytes(const uint8_t* data, uint32_t len, uint32_t timeout_ms) {
    if (!data || !len) return true;
    if (timeout_ms == 0) timeout_ms = 2000;

    // wait until device configured and DTR set
    absolute_time_t deadline = make_timeout_time_ms(timeout_ms);
    while (!(tud_ready() && tud_cdc_connected())) {
        if (absolute_time_diff_us(get_absolute_time(), deadline) <= 0) return false;
        tud_task();
        tight_loop_contents();
    }

    uint32_t sent = 0;
    // progress timeout: if we make no progress for timeout_ms, abort
    absolute_time_t progress_deadline = make_timeout_time_ms(timeout_ms);

    while (sent < len) {
        tud_task();

        uint32_t avail = tud_cdc_write_available();
        if (avail == 0) {
            if (absolute_time_diff_us(get_absolute_time(), progress_deadline) <= 0) {
                return false; // no progress for too long
            }
            tight_loop_contents();
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
            tight_loop_contents();
            continue;
        }

        sent += n;
        // reset progress timer after successful write
        progress_deadline = make_timeout_time_ms(timeout_ms);
    }

    return true;
}

static uint32_t base64_encode(const uint8_t *in, uint32_t inlen,
                              char *out, uint32_t outmax)
{
    static const char b64[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    uint32_t outlen = 0;
    for (uint32_t i = 0; i < inlen; i += 3) {
        uint32_t v = in[i] << 16;
        if (i + 1 < inlen) v |= in[i+1] << 8;
        if (i + 2 < inlen) v |= in[i+2];

        if (outlen + 4 > outmax) break;

        out[outlen++] = b64[(v >> 18) & 0x3F];
        out[outlen++] = b64[(v >> 12) & 0x3F];
        out[outlen++] = (i+1 < inlen) ? b64[(v >> 6) & 0x3F] : '=';
        out[outlen++] = (i+2 < inlen) ? b64[v & 0x3F] : '=';
    }
    return outlen;
}

void send_base64_chunk(const uint8_t* data, uint32_t len) {
    char encoded[2048]; // enough to hold 1024 bytes encoded (~1368 chars)
    uint32_t out_len = base64_encode(data, len, encoded, sizeof(encoded));
    encoded[out_len] = '\n';
    cdc_send_bytes((const uint8_t*)encoded, out_len + 1, 5000);
}

bool cdc_send_file_framed(const datafile_t* f, uint32_t timeout_ms) {
    if (!f) return false;

    static const char init[] = "GBCA_PHOTO_TRANSFER_BASE64\n";
    (void) cdc_send_bytes((const uint8_t*)init, sizeof(init)-1, 500);

    for (const datablock_t* b = f->first; b; b = b->next) {
        uint32_t remain = b->size;
        uint32_t off = 0;
        while (remain) {
            uint32_t slice = remain > 1024 ? 1024 : remain;
            send_base64_chunk(b->data + off, slice);
            off    += slice;
            remain -= slice;
        }
    }

    static const char done[] = "DONE\n";
    (void) cdc_send_bytes((const uint8_t*)done, sizeof(done)-1, 5000);

    return true;
}
