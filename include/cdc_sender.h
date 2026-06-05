#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "datablocks.h"

// Send raw bytes (splits into chunks and flushes).
bool cdc_send_bytes(const uint8_t* data, uint32_t len, uint32_t timeout_ms);

// Send string
bool cdc_send_string(const char* str);

void send_base64_chunk(const uint8_t* data, uint32_t len);