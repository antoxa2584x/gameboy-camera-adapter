#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "datablocks.h"

// Send raw bytes (splits into chunks and flushes).
bool cdc_send_bytes(const uint8_t* data, uint32_t len, uint32_t timeout_ms);

// Send string
bool cdc_send_string(const char* str);

// Send an image (or any blob) with a tiny "GBPR" + length (LE) header.
bool cdc_send_file_framed(const datafile_t* f, uint32_t timeout_ms);

void send_base64_chunk(const uint8_t* data, uint32_t len);