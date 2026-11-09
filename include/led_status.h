#ifndef _LED_STATUS_H_INCLUDE_
#define _LED_STATUS_H_INCLUDE_

#include <stdint.h>
#include <stdbool.h>

// What the RGB LED shows. Idle breathes in the user's chosen color; every other
// status has a fixed color, so it reads the same on every adapter:
//   receiving a photo   blue, fast blink
//   gb-photo live view  cyan, fast blink
//   printing            orange, fast blink
//   firmware update     purple, pulsing while it downloads, solid while it installs
//   error               red, blinking (a failed print or firmware update)
typedef enum {
    LED_STATUS_IDLE = 0,
    LED_STATUS_RECEIVING,
    LED_STATUS_LIVE,
    LED_STATUS_PRINTING,
    LED_STATUS_UPDATING,
    LED_STATUS_ERROR,
    LED_STATUS_COUNT
} led_status_t;

// Mark `status` as happening right now; it shows until it has been quiet for a
// moment (an error shows for a few seconds). Safe from IRQ context.
void led_status_activity(led_status_t status);

// Show `status` until the next reboot: entering the bootloader, installing firmware
void led_status_hold(led_status_t status);

// Drive the LED. Main loop only, and from long blocking jobs (a print burst).
void led_status_service(void);

#endif
