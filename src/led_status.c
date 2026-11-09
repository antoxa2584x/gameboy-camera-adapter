#include "pico/stdlib.h"

#include "globals.h"
#include "led_status.h"

extern uint8_t base_r, base_g, base_b;
extern void setRGB(uint8_t r, uint8_t g, uint8_t b);

// How long a status keeps showing after its last activity
#define ACTIVITY_HOLD_US    MS(300)
#define ERROR_HOLD_US       SEC(3)

#define BLINK_FAST_US       MS(60)
#define BLINK_ERROR_US      MS(200)
#define WAVE_STEP_US        MS(150)

typedef struct { uint8_t r, g, b; } led_color_t;

// Fixed status colors, not user settable
static const led_color_t status_colors[LED_STATUS_COUNT] = {
    [LED_STATUS_RECEIVING] = {0x00, 0x30, 0xFF},
    [LED_STATUS_LIVE]      = {0x00, 0xC0, 0xC0},
    [LED_STATUS_PRINTING]  = {0xFF, 0x60, 0x00},
    [LED_STATUS_UPDATING]  = {0xA0, 0x00, 0xFF},
    [LED_STATUS_ERROR]     = {0xFF, 0x00, 0x00},
};

// Highest priority last
static const led_status_t priority[] = {
    LED_STATUS_RECEIVING, LED_STATUS_LIVE, LED_STATUS_PRINTING, LED_STATUS_UPDATING, LED_STATUS_ERROR
};

// 32-bit timestamps: written in IRQ context, so no torn reads
static volatile uint32_t last_activity[LED_STATUS_COUNT];
static volatile bool active[LED_STATUS_COUNT];
static volatile led_status_t held = LED_STATUS_IDLE;

#define WAVE_STEPS 13
static const float wave_levels[WAVE_STEPS] = {
    0.2f, 0.3f, 0.4f, 0.5f,
    0.65f, 0.8f, 1.0f,
    0.8f, 0.65f, 0.5f, 0.4f, 0.3f, 0.2f
};

void led_status_activity(led_status_t status) {
    if (status <= LED_STATUS_IDLE || status >= LED_STATUS_COUNT) return;
    last_activity[status] = time_us_32();
    active[status] = true;
}

void led_status_hold(led_status_t status) {
    held = status;
    led_status_service();
}

static led_status_t current_status(uint32_t now) {
    if (held != LED_STATUS_IDLE) return held;
    for (int i = (int)(sizeof(priority) / sizeof(priority[0])) - 1; i >= 0; i--) {
        led_status_t s = priority[i];
        if (!active[s]) continue;
        uint32_t hold = (s == LED_STATUS_ERROR) ? ERROR_HOLD_US : ACTIVITY_HOLD_US;
        if ((now - last_activity[s]) < hold) return s;
        active[s] = false;
    }
    return LED_STATUS_IDLE;
}

static void scaled(led_color_t c, float level, uint8_t *r, uint8_t *g, uint8_t *b) {
    *r = (uint8_t)(c.r * level);
    *g = (uint8_t)(c.g * level);
    *b = (uint8_t)(c.b * level);
}

void led_status_service(void) {
    static bool shown = false;
    static uint8_t shown_r, shown_g, shown_b;

    uint32_t now = time_us_32();
    led_status_t status = current_status(now);
    uint8_t r, g, b;

    switch (status) {
        case LED_STATUS_IDLE: {
            led_color_t base = {base_r, base_g, base_b};
            scaled(base, wave_levels[(now / WAVE_STEP_US) % WAVE_STEPS], &r, &g, &b);
            break;
        }
        case LED_STATUS_UPDATING:
            // downloading pulses; installing (held) stays solid, nothing runs to animate it
            scaled(status_colors[status], (held == LED_STATUS_UPDATING) ? 1.0f : wave_levels[(now / (WAVE_STEP_US / 2)) % WAVE_STEPS], &r, &g, &b);
            break;
        case LED_STATUS_ERROR:
            scaled(status_colors[status], ((now / BLINK_ERROR_US) & 1) ? 0.0f : 1.0f, &r, &g, &b);
            break;
        default:
            scaled(status_colors[status], ((now / BLINK_FAST_US) & 1) ? 0.1f : 1.0f, &r, &g, &b);
            break;
    }

    // Only talk to the LED on a change: each write blocks on the PIO FIFO
    if (shown && r == shown_r && g == shown_g && b == shown_b) return;
    setRGB(r, g, b);
    shown = true;
    shown_r = r, shown_g = g, shown_b = b;
}
