/*
 * The MIT License (MIT)
 *
 * Copyright (c) 2019 Ha Thach (tinyusb.org)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

#include "globals.h"
#include "tusb.h"
#include "pico/unique_id.h"

/* A combination of interfaces must have a unique product id, since PC will save device driver after the first plug.
 * Same VID/PID with different interface e.g MSC (first), then CDC (later) will possibly cause system error on PC.
 *
 * Auto ProductID layout's Bitmap:
 *   [MSB]       NET | VENDOR | MIDI | HID | MSC | CDC          [LSB]
 */
#define _PID_MAP(itf, n)  ((itf) << (n))

uint16_t get_usb_pid(void) {
    uint8_t cdc_en = (mobile_compatibility == MODE_ANDROID);
    uint8_t net_en = true; // Always enable network
    return 0x4000 | _PID_MAP(cdc_en, 0) | _PID_MAP(net_en, 5);
}

// String Descriptor Index
enum {
    STRID_LANGID = 0,
    STRID_MANUFACTURER,
    STRID_PRODUCT,
    STRID_SERIAL,
    STRID_INTERFACE,
    STRID_MAC
};

enum {
#if CFG_TUD_NET_ENABLED
    ITF_NUM_NET = 0,
    ITF_NUM_NET_DATA,
#endif

#if CFG_TUD_CDC
    ITF_NUM_CDC_ACM,
    ITF_NUM_CDC_ACM_DATA,
#endif

    ITF_NUM_TOTAL
};

enum {
#if CFG_TUD_ECM_RNDIS
    CONFIG_ID_RNDIS = 0,
    CONFIG_ID_ECM   = 1,
#else
    CONFIG_ID_NCM   = 0,
#endif
    CONFIG_ID_COUNT
};


//--------------------------------------------------------------------+
// Device Descriptors
//--------------------------------------------------------------------+
// Invoked when received GET DEVICE DESCRIPTOR
// Application return pointer to descriptor
uint8_t const * tud_descriptor_device_cb(void) {
    static tusb_desc_device_t desc = {
        .bLength            = sizeof(tusb_desc_device_t),
        .bDescriptorType    = TUSB_DESC_DEVICE,
        .bcdUSB             = 0x0200,

        // Use Interface Association Descriptor (IAD) device class
        .bDeviceClass       = TUSB_CLASS_MISC,
        .bDeviceSubClass    = MISC_SUBCLASS_COMMON,
        .bDeviceProtocol    = MISC_PROTOCOL_IAD,

        .bMaxPacketSize0    = CFG_TUD_ENDPOINT0_SIZE,

        .idVendor           = 0xCafe,
        .idProduct          = 0,
        .bcdDevice          = 0x0101,

        .iManufacturer      = STRID_MANUFACTURER,
        .iProduct           = STRID_PRODUCT,
        .iSerialNumber      = STRID_SERIAL,

        .bNumConfigurations = 0
    };
    desc.idProduct = get_usb_pid();
    desc.bNumConfigurations = (mobile_compatibility == MODE_ANDROID) ? 1 : 2;
    return (uint8_t const *) &desc;
}

//--------------------------------------------------------------------+
// Configuration Descriptor
//--------------------------------------------------------------------+
#define CONFIG_TOTAL_LEN_IOS     (TUD_CONFIG_DESC_LEN + TUD_RNDIS_DESC_LEN)
#define CONFIG_TOTAL_LEN_ECM     (TUD_CONFIG_DESC_LEN + TUD_CDC_ECM_DESC_LEN)
#define CONFIG_TOTAL_LEN_ANDROID (TUD_CONFIG_DESC_LEN + TUD_RNDIS_DESC_LEN + TUD_CDC_DESC_LEN)

static uint8_t const ios_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, 2, 0, CONFIG_TOTAL_LEN_IOS, 0, 100),
    TUD_RNDIS_DESCRIPTOR(0, STRID_INTERFACE, EPNUM_NET_NOTIF, 8, EPNUM_NET_OUT, EPNUM_NET_IN, 64),
};

static uint8_t const ecm_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(2, 2, 0, CONFIG_TOTAL_LEN_ECM, 0, 100),
    TUD_CDC_ECM_DESCRIPTOR(0, STRID_INTERFACE, STRID_MAC, EPNUM_NET_NOTIF, 64, EPNUM_NET_OUT, EPNUM_NET_IN, 64, CFG_TUD_NET_MTU),
};

static uint8_t const android_configuration[] = {
    TUD_CONFIG_DESCRIPTOR(1, 4, 0, CONFIG_TOTAL_LEN_ANDROID, 0, 100),
    TUD_RNDIS_DESCRIPTOR(0, STRID_INTERFACE, EPNUM_NET_NOTIF, 8, EPNUM_NET_OUT, EPNUM_NET_IN, 64),
    TUD_CDC_DESCRIPTOR(2, 0, EPNUM_CDC_NOTIF, 8, EPNUM_CDC_OUT, EPNUM_CDC_IN, 64),
};

// Invoked when received GET CONFIGURATION DESCRIPTOR
// Application return pointer to descriptor
uint8_t const * tud_descriptor_configuration_cb(uint8_t index) {
    if (mobile_compatibility == MODE_ANDROID) return android_configuration;
    
    // For IOS mode, we provide two configurations: RNDIS and ECM
    // Windows/iOS might pick one
    if (index == 0) return ios_configuration;
    if (index == 1) return ecm_configuration;
    
    return NULL;
}

//--------------------------------------------------------------------+
// String Descriptors
//--------------------------------------------------------------------+

// array of pointer to string descriptors
static char const* string_desc_arr [] = {
    [STRID_LANGID]       = (const char[]) { 0x09, 0x04 }, // supported language is English (0x0409)
    [STRID_MANUFACTURER] = "RetroGaming UA",               // Manufacturer
    [STRID_PRODUCT]      = "GameBoy Camera Adapter [" FIRMWARE_VERSION "]",   // Product
    [STRID_SERIAL]       = "GBCA1.4.8",                                        // Serial
    [STRID_INTERFACE]    = "GameBoy Camera Adapter USB Network Interface",    // Interface Description
    [STRID_MAC]          = "0002846A9600"                                      // MAC
};

static uint16_t _desc_str[32];

// Invoked when received GET STRING DESCRIPTOR request
// Application return pointer to descriptor, whose contents must exist long enough for transfer to complete
uint16_t const* tud_descriptor_string_cb(uint8_t index, uint16_t langid) {
    (void) langid;

    unsigned int chr_count = 0;

    if (STRID_LANGID == index) {
        memcpy(&_desc_str[1], string_desc_arr[STRID_LANGID], 2);
        chr_count = 1;
    } else {
        // Note: the 0xEE index string is a Microsoft OS 1.0 Descriptors.
        // https://docs.microsoft.com/en-us/windows-hardware/drivers/usbcon/microsoft-defined-usb-descriptors

        if (!(index < sizeof(string_desc_arr)/sizeof(string_desc_arr[0]))) return NULL;

        const char* str = string_desc_arr[index];

        // Cap at max char
        chr_count = strlen(str);
        if (chr_count > (TU_ARRAY_SIZE(_desc_str) - 1)) chr_count = TU_ARRAY_SIZE(_desc_str) - 1;

        // Convert ASCII string into UTF-16
        for (unsigned int i = 0; i < chr_count; i++) {
            _desc_str[1 + i] = str[i];
        }
    }

    // first byte is length (including header), second byte is string type
    _desc_str[0] = (TUSB_DESC_STRING << 8 ) | ((chr_count + 1) << 1);

    return _desc_str;
}
