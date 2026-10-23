#ifndef _FW_UPDATE_H_INCLUDE_
#define _FW_UPDATE_H_INCLUDE_

#include <stdint.h>
#include <stdbool.h>

// One-click firmware update. A new image (update.bin, the raw flash image of a
// release, boot2 included) is received over HTTP or USB serial into a staging
// area in the upper half of flash, checked, and only then copied over the running
// firmware by a routine running from RAM. Sector 0 (boot2) is erased first and
// written last, so a power cut during the copy always leaves the chip in its ROM
// USB bootloader (RPI-RP2 drive) instead of half-booting a mixed image.

// Start a new upload of `size` bytes whose CRC-32 (zlib/IEEE) is `crc`.
// Drops any upload in progress. Returns false if the size cannot fit.
bool fw_update_begin(uint32_t size, uint32_t crc);

// Append the next part of the image. Returns false on overflow or when no upload
// is open; the upload is then aborted.
bool fw_update_write(const uint8_t *data, uint32_t len);

// Check the whole staged image (size, CRC, vector table). On success, the copy
// over the running firmware and the reboot are scheduled `delay_ms` later, so the
// reply to the host still goes out. Returns false and leaves the firmware alone
// otherwise.
bool fw_update_finish(uint32_t delay_ms);

// Bytes received in the current upload
uint32_t fw_update_received(void);

// Short reason for the last failure ("size", "crc", "image", ...), "" when none
const char *fw_update_error(void);

#endif
