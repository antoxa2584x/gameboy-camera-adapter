#include "pico/stdlib.h"
#include "time.h"
#include "pico/bootrom.h"
#include "hardware/timer.h"
#include "hardware/clocks.h"
#include "hardware/gpio.h"
#include "hardware/irq.h"
#include "hardware/resets.h"
#include "hardware/pio.h"

#include "globals.h"

#include "lwip/apps/fs.h"
#include "tusb_lwip_glue.h"
#include "gb_printer.h"
#include "linkcable.h"
#include "datablocks.h"

#include "ws2812.pio.h"

#include <string.h>
#include <stdlib.h>

#include "hardware/flash.h"
#include "hardware/sync.h"
#include "hardware/watchdog.h"

#include "cdc_sender.h"

// GameBoy Printer status
#define PRINTER_STATUS_OK           0x00
#define PRINTER_STATUS_FULL         0x04
#define PRINTER_STATUS_BUSY         0x02
#define PRINTER_STATUS_CHECKSUM     0x01
#define PRINTER_STATUS_DISCONNECTED 0xFF

bool debug_enable = ENABLE_DEBUG;
bool speed_240_MHz = false;

uint8_t file_buffer[FILE_BUFFER_SIZE];              // buffer for rendering of status json

datafile_t * allocated_file = NULL;
uint32_t last_file_len = 0;
uint32_t picture_count = 0;

uint8_t base_r = 0, base_g = 255, base_b = 0; // default green
uint8_t wave_index = 0;
uint8_t led_mode = 0; // 0 = wave, 1 = static

uint8_t saved_color[3] = {0};
bool use_rgb_mode = true; // default mode string

uint8_t mobile_compatibility = MODE_IOS;

extern void setRGB(uint8_t r, uint8_t g, uint8_t b);

// --- CDC line parser state ---
#define CDC_RX_MAX 256
static char cdc_line[CDC_RX_MAX];
static uint32_t cdc_len = 0;

static inline void cdc_reset_line(void) { cdc_len = 0; cdc_line[0] = 0; }

// Trim trailing CR
static void cdc_finish_line(void) {
  while (cdc_len && (cdc_line[cdc_len-1] == '\r' || cdc_line[cdc_len-1] == '\n')) {
    cdc_len--;
  }
  cdc_line[cdc_len] = '\0';
}

// Simple helpers to parse query params like ?r=..&g=..&b=..&use_rgb=..
static bool query_get_int(const char* qs, const char* key, int* out) {
  // find key=
  const char* p = strstr(qs, key);
  if (!p) return false;
  p += strlen(key);
  if (*p != '=') return false;
  p++;
  *out = atoi(p);
  return true;
}

static bool query_get_bool(const char* qs, const char* key, bool* out) {
  const char* p = strstr(qs, key);
  if (!p) return false;
  p += strlen(key);
  if (*p != '=') return false;
  p++;
  // accept true/false/1/0
  if      (strncmp(p, "true", 4) == 0)  { *out = true;  return true; }
  else if (strncmp(p, "false", 5) == 0) { *out = false; return true; }
  else if (*p == '1')                   { *out = true;  return true; }
  else if (*p == '0')                   { *out = false; return true; }
  return false;
}

// Forward declarations
int64_t soft_restart(alarm_id_t id, void *user_data);
int64_t reboot_callback(alarm_id_t id, void *user_data);

// Handle one complete CDC line
static void cdc_handle_line(const char* line) {
  // Ignore empty lines
  if (!line || !*line) return;

  // Photo-transfer markers already handled elsewhere (keep your existing logic).
  // Here we focus on the simple GET routes coming from Android.
  if (strncmp(line, "GET ", 4) == 0) {
    const char* path = line + 4;

    if (strncmp(path, "/reset_mode", 11) == 0) {
      mobile_compatibility = MODE_IOS;
      save_color_to_flash(base_r, base_g, base_b, use_rgb_mode, mobile_compatibility);
      cdc_send_string("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK - Mode Reset to IOS. Rebooting...\r\n");
      add_alarm_in_ms(300, soft_restart, NULL, false);
      return;
    }

    if (strncmp(path, "/set_mode_android", 17) == 0) {
      mobile_compatibility = MODE_ANDROID;
      save_color_to_flash(base_r, base_g, base_b, use_rgb_mode, mobile_compatibility);
      cdc_send_string("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK - Mode set to Android (Both). Rebooting...\r\n");
      add_alarm_in_ms(300, soft_restart, NULL, false);
      return;
    }

    if (strncmp(path, "/set_mode_ios", 13) == 0) {
      mobile_compatibility = MODE_IOS;
      save_color_to_flash(base_r, base_g, base_b, use_rgb_mode, mobile_compatibility);
      cdc_send_string("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK - Mode set to iOS (Web only). Rebooting...\r\n");
      add_alarm_in_ms(300, soft_restart, NULL, false);
      return;
    }

    if (strncmp(path, "/update", 7) == 0) {
      cdc_send_string("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nOK - Entering Bootloader...\r\n");
      add_alarm_in_ms(300, reboot_callback, NULL, false);
      return;
    }

    // e.g. "/led_status" or "/set_color?...". Find end of path/qs (space or end)
    const char* end = strchr(path, ' ');
    size_t len = end ? (size_t)(end - path) : strlen(path);

    // Make a small copy to work with
    char req[192];
    if (len >= sizeof(req)) len = sizeof(req) - 1;
    memcpy(req, path, len);
    req[len] = '\0';

    // Split on '?' for query
    char* qs = strchr(req, '?');
    if (qs) { *qs++ = '\0'; } // now req = path, qs = query string

    if (strcmp(req, "/led_status") == 0) {
      // Build exactly one JSON line like your Android expects
      // {"r":int,"g":int,"b":int,"use_rgb":bool}\n
      char json[128];
      int n = snprintf(json, sizeof(json),
                       "{\"r\":%u,\"g\":%u,\"b\":%u,\"use_rgb\":%s}\n",
                       base_r, base_g, base_b, use_rgb_mode ? "true" : "false");
      cdc_send_bytes((const uint8_t*)json, (uint32_t)n, 2000);
      return;
    }

    if (strcmp(req, "/set_color") == 0) {
      int r = base_r, g = base_g, b = base_b;
      bool rgb = use_rgb_mode;

      if (qs) {
        query_get_int(qs, "r", &r);
        query_get_int(qs, "g", &g);
        query_get_int(qs, "b", &b);
        query_get_bool(qs, "use_rgb", &rgb);
      }

      // clamp
      if (r < 0) r = 0; if (r > 255) r = 255;
      if (g < 0) g = 0; if (g > 255) g = 255;
      if (b < 0) b = 0; if (b > 255) b = 255;

      base_r = (uint8_t)r;
      base_g = (uint8_t)g;
      base_b = (uint8_t)b;
      use_rgb_mode = rgb;

      // apply immediately (no reboot), persist to flash like your web path does
      save_color_to_flash(base_r, base_g, base_b, use_rgb_mode, mobile_compatibility);
      setRGB(base_r, base_g, base_b);

      // small ACK line so Android can readLine() without timing out
      static const char ok[] = "OK\n";
#if CFG_TUD_CDC
      cdc_send_bytes((const uint8_t*)ok, sizeof(ok)-1, 1000);
#endif
      return;
    }
  }

  // For anything else (or if you still want echo for debugging):
#if CFG_TUD_CDC
  tud_cdc_write_str("UNKNOWN\n");
  tud_cdc_write_flush();
#endif
}


static inline void flush_tail_and_done(void) {
#if CFG_TUD_CDC
    // flush the last partial block, if any
    if (allocated_file && allocated_file->last) {
        datablock_t *last = allocated_file->last;
        if (last->size > 0 && last->size < DATABLOCK_SIZE) {
            (void) send_base64_chunk(last->data, last->size);
        }
    }
    // send trailer so host knows stream is complete
    static const char done[] = "DONE\n";
    (void) cdc_send_bytes((const uint8_t*)done, sizeof(done)-1, 2000);
#endif
}

void receive_data_reset(void) {
    if (!allocated_file) return;
    last_file_len = allocated_file->size;

#if CFG_TUD_CDC
    if (tud_cdc_connected()) {
        flush_tail_and_done();
    }
#endif
    
    if (push_file(allocated_file)) picture_count++;
    allocated_file = NULL;
}

bool double_init = false;
void receive_data_init(void) {
    if (double_init) receive_data_reset();
    double_init = true;
    
#if CFG_TUD_CDC
    if (tud_cdc_connected()) {
        static const char init[] = "GBCA_PHOTO_TRANSFER\n";
        (void) cdc_send_bytes((const uint8_t*)init, sizeof(init)-1, 500);
    }
#endif
}

void receive_data_write(uint8_t b) {
    double_init = false;
    datablock_t * block;

    if (!allocated_file) {
        allocated_file = allocate_file();
        if (!allocated_file) return;
    }

    block = allocated_file->last;
    if (!block) {
        block = allocate_block();
        if (!block) return;
        allocated_file->first = allocated_file->last = block;
    }

    if (block->size >= DATABLOCK_SIZE) {
        datablock_t *nb = allocate_block();
        if (!nb) return;
        allocated_file->last->next = nb;
        allocated_file->last = nb;
        block = nb;
    }

    block->data[block->size++] = b;
    allocated_file->size++;

#if CFG_TUD_CDC
    if (tud_cdc_connected()) {
        // Send only when the current block just became full
        if (block->size == DATABLOCK_SIZE) {
            (void) send_base64_chunk(block->data, DATABLOCK_SIZE);
        }
    }
#endif
}

void receive_data_commit(uint8_t cmd) {
    if (cmd == CAM_COMMAND_TRANSFER) receive_data_reset();
}

// link cableD
bool link_cable_data_received = false;
volatile bool printing_active = false;
void link_cable_ISR(void) {
    linkcable_send(protocol_data_process(linkcable_receive()));
    link_cable_data_received = true;
}

int64_t link_cable_watchdog(alarm_id_t id, void *user_data) {
    if (printing_active) return MS(300); // Don't touch PIO/pins during printing
    if (!link_cable_data_received) {
        linkcable_reset();
        protocol_reset();
        receive_data_reset();
    } else link_cable_data_received = false;
    return MS(300);
}

// key button
#ifdef PIN_KEY
static void key_callback(uint gpio, uint32_t events) {
    linkcable_reset();
    protocol_reset();
    receive_data_reset();
    LED_OFF;
}
#endif

// Webserver dynamic handling
#define ROOT_PAGE   "/index.html"
#define IMAGE_FILE  "/image.bin"
#define STATUS_FILE "/status.json"
#define LIST_FILE   "/list.json"

static const char *cgi_options(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    for (int i = 0; i < iNumParams; i++) {
        if (!strcmp(pcParam[i], "debug")) debug_enable = (!strcmp(pcValue[i], "on"));
    }
    return STATUS_FILE;
}

static const char *cgi_download(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    return IMAGE_FILE;
}

static const char *cgi_list(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    return LIST_FILE;
}

static const char *cgi_reset(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    receive_data_reset();
    protocol_reset();
    return STATUS_FILE;
}

// Callback that runs later (outside of CGI handler)
int64_t reboot_callback(alarm_id_t id, void *user_data) {
    reset_usb_boot(0, 0);
    return 0; // 0 = don’t repeat
}

const char* cgi_update(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    // Schedule reboot in 300ms, which gives time for browser to receive response
    add_alarm_in_ms(300, reboot_callback, NULL, false);

    return "/updating.html";
}

static const char *cgi_reset_usb_boot(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    if (debug_enable) reset_usb_boot(0, 0);
    return ROOT_PAGE;
}

#define FLASH_TARGET_OFFSET (256 * 1024) // adjust as needed (sector-aligned)

void save_color_to_flash(uint8_t r, uint8_t g, uint8_t b, bool rgb_mode, uint8_t mode) {
    uint8_t buffer[FLASH_PAGE_SIZE] = {0};
    buffer[0] = r;
    buffer[1] = g;
    buffer[2] = b;
    buffer[3] = 0xA5; // valid marker
    buffer[4] = rgb_mode ? 0x01 : 0x00; // actual mode
    buffer[5] = mode;

    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(FLASH_TARGET_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(FLASH_TARGET_OFFSET, buffer, FLASH_PAGE_SIZE);
    restore_interrupts(ints);
}


void load_color_from_flash() {
    const uint8_t *flash_data = (const uint8_t *)(XIP_BASE + FLASH_TARGET_OFFSET);

    bool is_valid = (flash_data[3] == 0xA5); // magic byte check

    if (is_valid) {
        base_r = flash_data[0];
        base_g = flash_data[1];
        base_b = flash_data[2];
        use_rgb_mode = (flash_data[4] == 0x01);
        mobile_compatibility = flash_data[5];
        if (mobile_compatibility == 0) { // Legacy MODE_AUTO
            mobile_compatibility = MODE_IOS;
        }
    } else {
        base_r = 0x00;
        base_g = 0xFF;
        base_b = 0x00;
        use_rgb_mode = true;
        mobile_compatibility = MODE_IOS;
    }
}


#define WAVE_STEPS 13
float wave_levels[WAVE_STEPS] = {
    0.2f, 0.3f, 0.4f, 0.5f,
    0.65f, 0.8f, 1.0f,
    0.8f, 0.65f, 0.5f, 0.4f, 0.3f, 0.2f
};

int64_t soft_restart(alarm_id_t id, void *user_data) {
    watchdog_enable(1, 1); // short timeout
    while (1);             // wait for reset
    return 0;
}

static const char *cgi_set_color(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    for (int i = 0; i < iNumParams; i++) {
        if (strcmp(pcParam[i], "r") == 0) base_r = atoi(pcValue[i]);
        else if (strcmp(pcParam[i], "g") == 0) base_g = atoi(pcValue[i]);
        else if (strcmp(pcParam[i], "b") == 0) base_b = atoi(pcValue[i]);
        else if (strcmp(pcParam[i], "use_rgb") == 0) use_rgb_mode = (strcmp(pcValue[i], "true") == 0);
        else if (strcmp(pcParam[i], "mode") == 0) mobile_compatibility = atoi(pcValue[i]);
    }

    save_color_to_flash(base_r, base_g, base_b, use_rgb_mode, mobile_compatibility);

    // Schedule soft reboot after 300ms
    add_alarm_in_ms(300, soft_restart, NULL, false);

    return "/index.html";
}

void startGreenWave() {
    led_mode = 0;
}

/* Example loop (call from main): */
uint64_t last_blink = 0;
const uint32_t interval = 150000; // 200ms

void update_led_wave() {
    uint64_t now = time_us_64();
    if (led_mode == 0 && now - last_blink >= interval) {
        float scale = wave_levels[wave_index];
        uint8_t r = (uint8_t)(base_r * scale);
        uint8_t g = (uint8_t)(base_g * scale);
        uint8_t b = (uint8_t)(base_b * scale);

        setRGB(r, g, b);

        wave_index = (wave_index + 1) % WAVE_STEPS;
        last_blink = now;
    }
}

#define PIN_SCK    2  // CLK: from Pico to printer
#define PIN_SOUT   3  // SIN: from Pico to printer
#define PIN_SIN    0  // SOUT: from printer to Pico

const int halfDelay = 62; // microseconds (~8kHz, matches Game Boy serial speed)

uint8_t current_printer_status = PRINTER_STATUS_DISCONNECTED;

// Packet queue: buffer all packets, send in one burst
#define PKT_QUEUE_SIZE 8192
#define PKT_MAX_PACKETS 64
static uint8_t pkt_queue_buf[PKT_QUEUE_SIZE];
static int pkt_queue_offsets[PKT_MAX_PACKETS]; // start offset of each packet
static int pkt_queue_lengths[PKT_MAX_PACKETS]; // length of each packet
static int pkt_queue_count = 0;
static int pkt_queue_used = 0;

// Debug: store raw responses from last packet
#define DBG_MAX 32
uint8_t dbg_responses[DBG_MAX];
int dbg_count = 0;

uint8_t get_printer_status() {
    return current_printer_status;
}

uint8_t printer_send_byte(uint8_t byteToSend) {
    uint8_t gbReply = 0;
    for (int i = 0; i < 8; i++) {
        gpio_put(PIN_SOUT, (byteToSend >> (7 - i)) & 1);
        gpio_put(PIN_SCK, 0);
        sleep_us(halfDelay);
        bool readBit = gpio_get(PIN_SIN);
        gbReply = (gbReply << 1) | (readBit ? 1 : 0);
        gpio_put(PIN_SCK, 1);
        sleep_us(halfDelay);
    }
    gpio_put(PIN_SOUT, 0);
    sleep_us(halfDelay);
    return gbReply;
}

void printer_send_packet(const uint8_t* packet, int length) {
    // First call: disable PIO and configure GPIO (subsequent calls reuse same pin config)
    if (!printing_active) {
        pio_sm_set_enabled(LINKCABLE_PIO, LINKCABLE_SM, false);
        pio_set_irq0_source_enabled(LINKCABLE_PIO, pis_interrupt0, false);
        printing_active = true;

        gpio_init(PIN_SCK);
        gpio_set_dir(PIN_SCK, GPIO_OUT);
        gpio_put(PIN_SCK, 0);

        gpio_init(PIN_SOUT);
        gpio_set_dir(PIN_SOUT, GPIO_OUT);
        gpio_put(PIN_SOUT, 0);

        gpio_init(PIN_SIN);
        gpio_set_dir(PIN_SIN, GPIO_IN);
        gpio_disable_pulls(PIN_SIN);
    }

    uint8_t last_response = 0x00;
    uint8_t status_byte = 0x00;
    bool has_response = false;
    bool sync_received = false;
    dbg_count = 0;
    for (int i = 0; i < length; i++) {
        uint8_t response = printer_send_byte(packet[i]);
        if (dbg_count < DBG_MAX) dbg_responses[dbg_count++] = response;
        
        if (sync_received) {
            status_byte = response;
            sync_received = false; // We got the status after sync
            has_response = true;
        } else if (response == 0x81) {
            sync_received = true;
            has_response = true;
        } else if (response != 0x00 && response != 0xFF) {
            // Backup in case we missed sync but got something else
            last_response = response;
            has_response = true;
        }
        
        sleep_us(10);
    }

    if (has_response) {
        if (status_byte != 0x00) {
            current_printer_status = status_byte;
        } else if (last_response != 0x81 && last_response != 0xFF && last_response != 0x00) {
            current_printer_status = last_response;
        } else {
            // If we only got 0x81 or 0x00 as last response, it might be OK
            // but usually status follows 0x81.
            // If status_byte is 0x00, it means the printer is likely OK.
            current_printer_status = status_byte; 
        }
    } else {
        current_printer_status = PRINTER_STATUS_DISCONNECTED;
    }

    sleep_us(200);
    // Leave SCK HIGH (as printer_send_byte left it) — do NOT pull LOW or re-enable PIO.
    // A spurious falling edge would desync the printer.
    // PIO re-enabled only when JS sends done=1.
}

// Web interface endpoint: buffer packets, then send all at once on done=1
const char *cgi_print_chunk(int iIndex, int iNumParams, char *pcParam[], char *pcValue[]) {
    int is_done = 0;
    const char *payload = NULL;

    for (int i = 0; i < iNumParams; i++) {
        if (strcmp(pcParam[i], "data") == 0) {
            payload = pcValue[i];
        } else if (strcmp(pcParam[i], "done") == 0) {
            is_done = atoi(pcValue[i]);
        }
    }

    if (payload && !is_done) {
        // Buffer the packet (don't send yet)
        size_t hex_len = strlen(payload);
        if (hex_len > 2048) return "/index.html";
        size_t byte_len = hex_len / 2;

        if (pkt_queue_count < PKT_MAX_PACKETS && pkt_queue_used + byte_len <= PKT_QUEUE_SIZE) {
            pkt_queue_offsets[pkt_queue_count] = pkt_queue_used;
            pkt_queue_lengths[pkt_queue_count] = byte_len;
            for (size_t i = 0; i < byte_len; i++) {
                char byte_str[3] = { payload[i*2], payload[i*2 + 1], 0 };
                pkt_queue_buf[pkt_queue_used + i] = (uint8_t)strtol(byte_str, NULL, 16);
            }
            pkt_queue_used += byte_len;
            pkt_queue_count++;
        }
    }

    if (is_done) {
        // Send ALL buffered packets in one burst (like hello_usb.c)
        for (int p = 0; p < pkt_queue_count; p++) {
            printer_send_packet(
                &pkt_queue_buf[pkt_queue_offsets[p]],
                pkt_queue_lengths[p]
            );
        }
        // Reset queue
        pkt_queue_count = 0;
        pkt_queue_used = 0;
        // Restore link cable
        printing_active = false;
        linkcable_init(link_cable_ISR);
    }

    return "/index.html";
}

/* Add to CGI handler list */
static const tCGI cgi_handlers[] = {
    { "/download", cgi_download },
    { "/update", cgi_update },
    { "/set_color", cgi_set_color },
    { "/print_chunk", cgi_print_chunk },
};

int fs_open_custom(struct fs_file *file, const char *name) {
    static const char *on_off[]     = {"off", "on"};
    static const char *true_false[] = {"false", "true"};
    if (!strcmp(name, IMAGE_FILE)) {
        datafile_t * datafile = pop_last_file();
        if (!datafile) return 0;
        picture_count--;
        datablock_t * data = datafile->first;
        if (!data) {
            free_file(datafile);
            return 0;
        }
        uint32_t ofs = 0, max_len = sizeof(file_buffer);
        for (uint32_t len; (data); data = data->next) {
            len = MIN(data->size, max_len);
            if (!len) break;
            memcpy(file_buffer + ofs, data->data, len);
            max_len -= len;
            ofs += len;
        }
        free_file(datafile);
        // initialize fs_file correctly
        memset(file, 0, sizeof(struct fs_file));
        file->data  = file_buffer;
        file->len   = ofs;
        file->index = ofs;
        return 1;
    } else if (!strcmp(name, STATUS_FILE)) {
        memset(file, 0, sizeof(struct fs_file));
        file->data  = file_buffer;
        // Build debug response hex string
        char dbg_hex[DBG_MAX * 3 + 1];
        int dpos = 0;
        for (int i = 0; i < dbg_count && dpos < (int)sizeof(dbg_hex) - 3; i++) {
            if (i > 0) dbg_hex[dpos++] = ' ';
            dpos += snprintf(dbg_hex + dpos, sizeof(dbg_hex) - dpos, "%02x", dbg_responses[i]);
        }
        dbg_hex[dpos] = '\0';
        file->len   = snprintf(file_buffer, sizeof(file_buffer),
                               "{\"result\":\"ok\"," \
                               "\"options\":{\"debug\":\"%s\"}," \
                               "\"status\":{\"last_size\":%d,\"total_files\":%d},"\
                               "\"system\":{\"fast\":%s,\"version\":\"%s\"}," \
                               "\"printer\":%u," \
                               "\"dbg\":\"%s\"}",
                               on_off[debug_enable],
                               last_file_len, picture_count,
                               true_false[speed_240_MHz], FIRMWARE_VERSION,
                               (unsigned int)get_printer_status(),
                               dbg_hex);
        file->index = file->len;
        return 1;
    } else if (!strcmp(name, LIST_FILE)) {
        memset(file, 0, sizeof(struct fs_file));
        file->data  = file_buffer;
        file->len   = snprintf(file_buffer, sizeof(file_buffer),
                               "{\"dumps\": [%s]}",
                               ((picture_count) ? "\"/image.bin\"" : ""));
        file->index = file->len;
        return 1;
    } else if (!strcmp(name, "/led_status")) {
        memset(file, 0, sizeof(struct fs_file));
        file->data  = file_buffer;
        file->len = snprintf(file_buffer, sizeof(file_buffer),
            "{\"r\":%d,\"g\":%d,\"b\":%d,\"use_rgb\":%s,\"mode\":%d}",
            base_r, base_g, base_b, use_rgb_mode ? "true" : "false", mobile_compatibility);
        file->index = file->len;
        return 1;
    }

    return 0;
}

void fs_close_custom(struct fs_file *file) {
    (void)(file);
}

#if CFG_TUD_CDC
void tud_cdc_rx_cb(uint8_t itf) {
  (void) itf;
  uint8_t buf[64];
  uint32_t n = tud_cdc_read(buf, sizeof(buf));

  for (uint32_t i = 0; i < n; i++) {
    char ch = (char)buf[i];

    if (ch == '\n') {
      // complete line
      cdc_finish_line();
      cdc_handle_line(cdc_line);
      cdc_reset_line();
    } else {
      if (cdc_len + 1 < CDC_RX_MAX) {
        cdc_line[cdc_len++] = ch;
      } else {
        // overflow: reset line to avoid garbage
        cdc_reset_line();
      }
    }
  }
}
#endif


// main loop
int main(void) {
    speed_240_MHz = set_sys_clock_khz(240000, false);

    // For toggle_led
#ifdef LED_PIN
    gpio_init(LED_PIN);
    gpio_set_dir(LED_PIN, GPIO_OUT);
#endif
    LED_ON;

    // reset file and block allocation
    reset_data_blocks();

#ifdef PIN_KEY
    // set up key
    gpio_init(PIN_KEY);
    gpio_set_dir(PIN_KEY, GPIO_IN);
    gpio_set_irq_enabled_with_callback(PIN_KEY, GPIO_IRQ_EDGE_RISE, true, &key_callback);
#endif

    // RGB LED
    load_color_from_flash();

    // Initialize tinyusb, lwip, dhcpd, dnsd and httpd
    init_lwip();

    wait_for_netif_is_up();
    dhcpd_init();
    dns_init();
    httpd_init();
    http_set_cgi_handlers(cgi_handlers, LWIP_ARRAYSIZE(cgi_handlers));

    linkcable_init(link_cable_ISR);

    add_alarm_in_us(MS(300), link_cable_watchdog, NULL, true);

    LED_OFF;

    setupOnboardRGB();

    while (true) {
        // setRGB(0, 0, 0);
        // process USB
        tud_task();
        // process WEB
        service_traffic();
        uint64_t now = time_us_64();
        update_led_wave();
    }

    return 0;
}
