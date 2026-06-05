/**
 * Copyright (c) 2020 Raspberry Pi (Trading) Ltd.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 */

 #include "pico/stdlib.h"
 #include "hardware/pio.h"
 #include "hardware/clocks.h"
 #include "ws2812.pio.h"

 #ifdef PICO_DEFAULT_WS2812_PIN
 #define WS2812_PIN PICO_DEFAULT_WS2812_PIN
 #else
 // default to pin 2 if the board doesn't have a default WS2812 pin defined
 #define WS2812_PIN 16
 #endif

 // Check the pin is compatible with the platform
 #if WS2812_PIN >= NUM_BANK0_GPIOS
 #error Attempting to use a pin>=32 on a platform that does not support it
 #endif


 extern bool use_rgb_mode;

 static inline void put_pixel(PIO pio, uint sm, uint32_t pixel_grb) {
     pio_sm_put_blocking(pio, sm, pixel_grb << 8u);
 }

 static inline uint32_t urgb_u32(uint8_t r, uint8_t g, uint8_t b) {
     return
             ((uint32_t) (r) << 8) |
             ((uint32_t) (g) << 16) |
             (uint32_t) (b);
 }

 PIO pio;
 uint sm;

 void setupOnboardRGB(){
    uint offset;

    // This will find a free pio and state machine for our program and load it for us
    // We use pio_claim_free_sm_and_add_program_for_gpio_range (for_gpio_range variant)
    // so we will get a PIO instance suitable for addressing gpios >= 32 if needed and supported by the hardware
    bool success = pio_claim_free_sm_and_add_program_for_gpio_range(&ws2812_program, &pio, &sm, &offset, WS2812_PIN, 1, true);
    hard_assert(success);

    ws2812_program_init(pio, sm, offset, WS2812_PIN, 800000, false);
 }

 void setRGB(uint8_t r, uint8_t g, uint8_t b){
    if (use_rgb_mode)
        put_pixel(pio, sm, urgb_u32(r, g, b));
    else
        put_pixel(pio, sm, urgb_u32(g, r, b));
 }
