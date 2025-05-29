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

#include "hardware/flash.h"
#include "hardware/sync.h"

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

extern void setRGB(uint8_t r, uint8_t g, uint8_t b);

void receive_data_reset(void) {
    if (!allocated_file) return;
    last_file_len = allocated_file->size;
    if (push_file(allocated_file)) picture_count++;
    allocated_file = NULL;
}

bool double_init = false;
void receive_data_init(void) {
    if (double_init) receive_data_reset();
    double_init = true;
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
        block = allocate_block();
        if (!block) return;
        allocated_file->last->next = block;
        allocated_file->last = block;
    }
    block->data[block->size++] = b;
    allocated_file->size++;
}

void receive_data_commit(uint8_t cmd) {
    if (cmd == CAM_COMMAND_TRANSFER) receive_data_reset();
}

// link cable
bool link_cable_data_received = false;
void link_cable_ISR(void) {
    linkcable_send(protocol_data_process(linkcable_receive()));
    link_cable_data_received = true;
}

int64_t link_cable_watchdog(alarm_id_t id, void *user_data) {
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

void save_color_to_flash(uint8_t r, uint8_t g, uint8_t b, bool rgb_mode) {
    uint8_t buffer[FLASH_PAGE_SIZE] = {0};
    buffer[0] = r;
    buffer[1] = g;
    buffer[2] = b;
    buffer[3] = 0xA5; // valid marker
    buffer[4] = rgb_mode ? 0x01 : 0x00; // actual mode

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
    } else {
        base_r = 0x00;
        base_g = 0xFF;
        base_b = 0x00;
        use_rgb_mode = true;
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
    }

    save_color_to_flash(base_r, base_g, base_b, use_rgb_mode);

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

        if (use_rgb_mode)
            setRGB(r, g, b);
        else
            setRGB(g, r, b);

        wave_index = (wave_index + 1) % WAVE_STEPS;
        last_blink = now;
    }
}

/* Add to CGI handler list */
static const tCGI cgi_handlers[] = {
    { "/download", cgi_download },
    { "/update", cgi_update },
    { "/set_color", cgi_set_color },
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
        file->len   = snprintf(file_buffer, sizeof(file_buffer),
                               "{\"result\":\"ok\"," \
                               "\"options\":{\"debug\":\"%s\"}," \
                               "\"status\":{\"last_size\":%d,\"total_files\":%d},"\
                               "\"system\":{\"fast\":%s}}",
                               on_off[debug_enable],
                               last_file_len, picture_count,
                               true_false[speed_240_MHz]);
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
            "{\"r\":%d,\"g\":%d,\"b\":%d,\"use_rgb\":%s}",
            base_r, base_g, base_b, use_rgb_mode ? "true" : "false");
        file->index = file->len;
        return 1;
    }
    return 0;
}

void fs_close_custom(struct fs_file *file) {
    (void)(file);
}

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

    // RGB LED

    load_color_from_flash();

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
