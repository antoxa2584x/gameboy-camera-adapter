#ifndef _GLOBALS_H_INCLUDE_
#define _GLOBALS_H_INCLUDE_

#include <stdint.h>
#include <stdbool.h>

#define FIRMWARE_VERSION        "1.4.9"
#define ENABLE_DEBUG            false
#define BUFFER_SIZE_KB          128
#define FILE_BUFFER_SIZE        16384

// Mobile compatibility modes
#define MODE_ANDROID        1  // Both (CDC + Network)
#define MODE_IOS            2  // Server only (Network)

extern uint8_t mobile_compatibility;

// Function declarations to avoid implicit declarations
void save_color_to_flash(uint8_t r, uint8_t g, uint8_t b, bool rgb_mode, uint8_t mode);
void setupOnboardRGB(void);

// LED pin, undefine to disable
#define LED_PIN                 25
#ifdef LED_PIN
    #define LED_SET(A)          (gpio_put(LED_PIN, (A)))
    #define LED_ON              LED_SET(true)
    #define LED_OFF             LED_SET(false)
    #define LED_TOGGLE          (gpio_put(LED_PIN, !gpio_get(LED_PIN)))
#else
    #define LED_ON
    #define LED_OFF
    #define LED_TOGGLE
#endif

// "Tear" button pin, undefine to disable
#define PIN_KEY                 23

// time intervals
#define MKS(A)                  (A)
#define MS(A)                   ((A) * 1000)
#define SEC(A)                  ((A) * 1000 * 1000)

#endif
