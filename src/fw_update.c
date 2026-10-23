#include <string.h>

#include "pico/stdlib.h"
#include "hardware/flash.h"
#include "hardware/sync.h"
#include "hardware/structs/psm.h"
#include "hardware/structs/watchdog.h"

#include "fw_update.h"

// Staging area: the upper half of flash, minus the settings sector at the very end
// (see save_color_to_flash). An image may be at most as big as the staging area,
// which is also below FW_STAGE_OFFSET, so copying it down never reads a sector it
// has already overwritten.
#define FW_STAGE_OFFSET     (PICO_FLASH_SIZE_BYTES / 2)
#define FW_MAX_SIZE         (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE - FW_STAGE_OFFSET)

// Vector table of a flash image sits right after the 256-byte boot2
#define FW_VECTORS_OFFSET   0x100

// End of the running program image in flash, provided by the SDK linker script
extern char __flash_binary_end;

static uint8_t sector_buf[FLASH_SECTOR_SIZE];   // staging write buffer, reused by the final copy
static uint32_t fw_size = 0;
static uint32_t fw_crc = 0;
static uint32_t fw_received = 0;                // bytes accepted so far
static uint32_t fw_staged = 0;                  // bytes already programmed into the staging area
static bool fw_open = false;
static bool fw_applying = false;                // copy scheduled: the staging area is no longer ours
static const char *fw_err = "";

static uint32_t crc32_update(uint32_t crc, const uint8_t *p, uint32_t len) {
    crc = ~crc;
    while (len--) {
        crc ^= *p++;
        for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1));
    }
    return ~crc;
}

static void fw_fail(const char *reason) {
    fw_open = false;
    fw_err = reason;
}

// Program the buffered sector into the staging area
static void fw_stage_sector(void) {
    uint32_t ints = save_and_disable_interrupts();
    flash_range_erase(FW_STAGE_OFFSET + fw_staged, FLASH_SECTOR_SIZE);
    flash_range_program(FW_STAGE_OFFSET + fw_staged, sector_buf, FLASH_SECTOR_SIZE);
    restore_interrupts(ints);
    fw_staged += FLASH_SECTOR_SIZE;
}

bool fw_update_begin(uint32_t size, uint32_t crc) {
    if (fw_applying) {
        fw_err = "busy";
        return false;
    }
    fw_open = false;
    fw_received = fw_staged = 0;
    fw_err = "";

    // The running image must stay clear of the staging area
    if (((uint32_t)&__flash_binary_end - XIP_BASE) > FW_STAGE_OFFSET) {
        fw_fail("layout");
        return false;
    }
    if (size <= FW_VECTORS_OFFSET + 8 || size > FW_MAX_SIZE) {
        fw_fail("size");
        return false;
    }

    fw_size = size;
    fw_crc = crc;
    fw_open = true;
    return true;
}

bool fw_update_write(const uint8_t *data, uint32_t len) {
    if (!fw_open) {
        if (!*fw_err) fw_err = "state";
        return false;
    }
    if (len > fw_size - fw_received) {
        fw_fail("size");
        return false;
    }
    while (len) {
        uint32_t fill = fw_received - fw_staged;
        uint32_t n = MIN(len, FLASH_SECTOR_SIZE - fill);
        memcpy(sector_buf + fill, data, n);
        fw_received += n;
        data += n;
        len -= n;
        if (fw_received - fw_staged == FLASH_SECTOR_SIZE) fw_stage_sector();
    }
    return true;
}

// Copy one sector of the staged image over the running firmware. RAM only: the
// code it overwrites may be its own caller's.
static void __no_inline_not_in_flash_func(fw_copy_sector)(uint32_t offset) {
    // volatile, so the loop is not turned into a memcpy() call that lives in flash
    const volatile uint32_t *src = (const volatile uint32_t *)(XIP_BASE + FW_STAGE_OFFSET + offset);
    uint32_t *dst = (uint32_t *)sector_buf;
    for (uint32_t i = 0; i < FLASH_SECTOR_SIZE / 4; i++) dst[i] = src[i];
    flash_range_erase(offset, FLASH_SECTOR_SIZE);
    flash_range_program(offset, sector_buf, FLASH_SECTOR_SIZE);
}

// Replace the running firmware with the staged image and reset. RAM only, with
// interrupts off, and it never returns: from the first erase on, nothing in flash
// is the code it used to be.
static void __no_inline_not_in_flash_func(fw_apply)(uint32_t size) {
    uint32_t sectors = (size + FLASH_SECTOR_SIZE - 1) / FLASH_SECTOR_SIZE;
    // boot2 goes first: without a valid boot2 the boot ROM falls back to its USB
    // bootloader, so a power cut anywhere below is recoverable by dropping the
    // .uf2 onto the RPI-RP2 drive
    flash_range_erase(0, FLASH_SECTOR_SIZE);
    for (uint32_t s = 1; s < sectors; s++) fw_copy_sector(s * FLASH_SECTOR_SIZE);
    fw_copy_sector(0);
    watchdog_hw->ctrl = WATCHDOG_CTRL_TRIGGER_BITS;
    while (true) tight_loop_contents();
}

static int64_t fw_apply_alarm(alarm_id_t id, void *user_data) {
    (void)id;
    (void)user_data;
    save_and_disable_interrupts();
    // Plain watchdog reset of everything but the oscillators, and no "jump to
    // this PC" request left over in scratch[4] for the boot ROM
    hw_clear_bits(&watchdog_hw->ctrl, WATCHDOG_CTRL_ENABLE_BITS);
    watchdog_hw->scratch[4] = 0;
    psm_hw->wdsel = PSM_WDSEL_BITS & ~(PSM_WDSEL_ROSC_BITS | PSM_WDSEL_XOSC_BITS);
    fw_apply(fw_size);
    return 0;
}

bool fw_update_finish(uint32_t delay_ms) {
    if (!fw_open) {
        if (!*fw_err) fw_err = "state";
        return false;
    }
    if (fw_received != fw_size) {
        fw_fail("size");
        return false;
    }
    // Last, partial sector: pad with erased-flash bytes
    uint32_t fill = fw_received - fw_staged;
    if (fill) {
        memset(sector_buf + fill, 0xFF, FLASH_SECTOR_SIZE - fill);
        fw_stage_sector();
    }

    const uint8_t *image = (const uint8_t *)(XIP_BASE + FW_STAGE_OFFSET);
    if (crc32_update(0, image, fw_size) != fw_crc) {
        fw_fail("crc");
        return false;
    }

    // Catch the wrong file (a .uf2, another board's image) before it replaces us:
    // the initial stack pointer must be in RAM and the reset handler in the image
    const uint32_t *vectors = (const uint32_t *)(image + FW_VECTORS_OFFSET);
    uint32_t sp = vectors[0], reset = vectors[1] & ~1u;
    if (sp <= SRAM_BASE || sp > SRAM_END || reset < XIP_BASE + FW_VECTORS_OFFSET || reset >= XIP_BASE + fw_size) {
        fw_fail("image");
        return false;
    }

    fw_open = false;
    fw_applying = true;
    fw_err = "";
    add_alarm_in_ms(delay_ms, fw_apply_alarm, NULL, false);
    return true;
}

uint32_t fw_update_received(void) {
    return fw_received;
}

const char *fw_update_error(void) {
    return fw_err;
}
