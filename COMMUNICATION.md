### Game Boy Camera Adapter Communication Documentation

This document describes the communication protocols used between the adapter firmware (Pico), the Game Boy, the Web-App, and external clients.

---

#### 1. Hardware Communication Layer (Link Cable)
The firmware interacts with the Game Boy or a Game Boy Printer using a standard Link Cable.
- **Interface**: Bit-banging via GPIO (Pico SDK).
- **Clock Frequency**: ~2.5kHz (200µs per half-cycle).
- **Inter-byte Delay**: 10µs to ensure reliable processing.
- **Signal Logic**:
  - **SCK (Serial Clock)**: Driven by the Pico (as Master) or by the Game Boy (as Slave).
  - **SIN (Serial In)**: Data received by the Pico.
  - **SOUT (Serial Out)**: Data sent by the Pico.
  - **Pull-ups**: Enabled on `PIN_SIN` to detect disconnected state (returns `0xFF`).

---

#### 2. Binary Protocol (Game Boy Printer Style)
The Game Boy Printer protocol is the core of the communication. The firmware acts as a Printer (when receiving from a Game Boy) or as a Game Boy (when printing to a real printer).

##### Packet Structure
Every packet follows a mandatory 10-byte header/footer structure plus a variable-length data payload.

| Offset | Length | Name | Value / Description |
| :--- | :--- | :--- | :--- |
| 0x00 | 2 | Magic Bytes | `0x88`, `0x33` |
| 0x02 | 1 | Command | See Commands table below |
| 0x03 | 1 | Compression | `0x00` (None), `0x01` (RLE - used by original GB) |
| 0x04 | 2 | Length (L) | Data length (Little Endian: LSB first) |
| 0x06 | L | Data | Payload bytes |
| 0x06+L | 2 | Checksum | Sum of Command + Compression + Length + Data (16-bit) |
| 0x08+L | 2 | Device ID / Status | See Status decoding below |

##### Commands
| Value | Name | Description |
| :--- | :--- | :--- |
| `0x01` | `INIT` | Resets the printer state. |
| `0x02` | `PRINT` | Initiates printing. Payload: `[sheets, margins, palette, exposure]`. |
| `0x04` | `DATA` | Carries tile data (usually 640 bytes for 2.5 rows of tiles). |
| `0x08` | `BREAK` | Cancels current operation. |
| `0x0F` | `STATUS` | Requests printer status. |
| `0x10` | `TRANSFER` | High-speed transfer used by PXLR-Studio-next and [gb-photo](https://github.com/untoxa/gb-photo): one raw 128x112 camera image (3584 bytes, 16x14 tiles), checksum ignored. |
| `0x20` | `META` | Extended metadata (custom). |

##### Status Byte Decoding
The printer returns a status byte (following a `0x81` sync byte) as part of the packet response.

| Bit | Name | Description |
| :--- | :--- | :--- |
| 7 | Low Battery | Printer battery is low. |
| 6 | Other Error | General error. |
| 5 | Paper Jam | Paper is stuck. |
| 4 | Packet Error | Checksum or packet framing error. |
| 3 | Unprocessed | Data remains in buffer. |
| 2 | Image Full | Buffer is full. |
| 1 | Printer Busy | Printing in progress. |
| 0 | Checksum Err | Received packet checksum was incorrect. |

---

#### 3. Image Processing & Grayscale
The Game Boy Printer uses 2-bit (4-level) grayscale. 
- **Grayscale Conversion**: `Gray = 0.299*R + 0.587*G + 0.114*B`.
- **Mapping**: Results are mapped to one of the 4 Game Boy shades.
- **Tile Format**: Images are sent as 8x8 pixel tiles. Each tile is 16 bytes (2 bits per pixel).

---

#### 4. Web API (HTTP/JSON)
The adapter provides several endpoints for control and retrieving captured data.

##### GET `/status.json`
Returns the current system status.
```json
{
  "result": "ok",
  "options": { "debug": "off/on" },
  "status": { "last_size": 1234, "total_files": 1, "receiving": 0 },
  "system": { "fast": "true/false", "version": "2.3.0", "uptime": 3600 },
  "printer": 0,
  "dbg": ""
}
```
- `status.receiving`: `1` while a photo transfer from the Game Boy is in progress (used by the web UI to show a receive loader), `0` otherwise.

##### GET `/download` (or `/image.bin`)
Retrieves the oldest stored print job or transfer.
- **Format**: One record per received packet: the command byte, then (`DATA` only) the compression byte, then the 16-bit little-endian length and the payload. Checksums and status bytes are not stored.
- **Live frames**: gb-photo's *Transfer REC* streams the camera view as an `INIT` + `TRANSFER` pair per frame. A transfer that has its own `INIT` and starts within 2 s of the previous transfer ending is stored with command byte `0x11` instead of `0x10`, so the web UI shows it in the live view rather than the gallery. Only the 3 newest live frames are kept queued, so the view stays real time. *Transfer all* sends its frames without an `INIT` in between, so they stay `0x10` photos.
- **Behavior**: Pops the file from the internal queue (one-time download).
- **Back-pressure**: While the web UI is polling this endpoint and the buffer has no room for another print, the adapter keeps reporting *busy* after a `PRINT` (up to 8 s), so gb-photo's *Print all* waits for the UI to catch up instead of overflowing the buffer.

##### GET `/list.json`
Lists available dumps: `{"dumps": ["/image.bin"]}`.

##### GET `/led_status`
Returns current LED configuration: `{"r":0,"g":255,"b":0,"use_rgb":true,"mode":2}`.

##### GET `/set_color?r=...&g=...&b=...&use_rgb=...&mode=...`
Sets the adapter's LED color and compatibility mode.
- `mode`: `1` (Android/CDC+Network), `2` (iOS/Network only).
- **Side Effect**: Saves to flash and reboots.

##### GET `/reset`
Resets the internal data buffers and protocol state.

##### GET `/update`
Reboots the Pico into USB Bootloader mode (manual `.uf2` update).

##### POST `/fw_upload?crc=HEX`
One-click firmware update. The body is the release's `update.bin` (the raw flash image, boot2 included); `crc` is its CRC-32 (zlib/IEEE, 8 hex digits). `Content-Length` is required.
- **Where to get it**: each release carries `update.bin` as an asset. Release assets cannot be fetched from a web page (no CORS), so it is also mirrored to the `firmware` branch: `https://raw.githubusercontent.com/antoxa2584x/gameboy-camera-adapter/firmware/<tag>/update.bin` (and the latest one at `.../firmware/update.bin`).
- **Behavior**: the image is written to a staging area in the upper half of flash while it arrives, then checked: size, CRC, and the vector table (catches a `.uf2` or a foreign image). Nothing replaces the running firmware unless every check passes.
- **Response**: `{"result":"ok"}`, after which the adapter copies the image over the running firmware (~1 s later, takes a few seconds) and restarts. Poll `/status.json` until it answers again. Otherwise `{"result":"error","error":"<reason>","received":N}` and the current firmware stays: `size` (empty, too big or truncated), `crc`, `image` (not a firmware image), `busy` (an install is already running), `request` (wrong URL or missing `crc`).
- **Power loss**: the copy erases boot2 first and writes it last, so if power is cut mid-install the chip comes up as the **RPI-RP2** drive (ROM bootloader) and takes the `.uf2` as usual.
- **Size limit**: half the flash minus the settings sector (1020 KB on 2 MB boards).

##### GET `/fw_result.json`
The reply of the last `/fw_upload` (same body as above).

##### GET `/print_chunk?data=HEX_PACKET&done=0/1`
Sends a Game Boy Printer packet to a physical printer connected to the adapter.
- **Parameters**:
  - `data`: Hex-encoded string of a single binary packet (e.g., `88330100000001000000`).
  - `done`: Set to `1` to trigger the actual transmission of all buffered packets.
- **Behavior**:
  1. If `done=0`, the packet is added to a temporary queue in the firmware.
  2. If `done=1`, the firmware sends all queued packets to the printer over the Link Cable.
  3. If `done=1` is sent with an empty queue, a single `STATUS` packet is sent to the printer (status polling).
  4. An `INIT` packet arriving while packets are already queued starts a new job: the leftovers of an abandoned one are dropped first.
- **Response**: the `/status.json` body (`"result":"ok"`), sent after the burst for `done=1`. A refused packet (malformed, or the queue is full) answers `{"result":"error","printer":N}` instead.
- **Queue Limits**: Up to 64 packets or 8 KB total.
- **Printer detection**: the printer answers `0x81` during the second-to-last byte of every packet and its status during the last one. Without that `0x81` the status reads `0xFF` (disconnected); `PIN_SIN` is pulled up so an empty port reads `0xFF` rather than floating.

---

#### 5. Serial Protocol (USB CDC)
When enabled (`mode=1`), the firmware can send data over USB Serial.
- **Handshake**: `GBCA_PHOTO_TRANSFER\n`
- **Data**: Base64 encoded chunks of image data.
- **Framing**: Starts with `GBCA_PHOTO_TRANSFER_BASE64\n`, followed by chunks and ending with `DONE\n`. Each stored file (one print job or one transfer) gets its own header/`DONE` pair.
- **Live frames**: gb-photo *Transfer REC* frames (see `/download`) are sent whole as a separate message: `GBCA_LIVE_FRAME\n`, base64 lines of the same record (`0x11`, 16-bit length, 3584 bytes of tiles), then `DONE\n`. A live message never interleaves with a photo message. Frames that finish while the previous one is still being sent are dropped, so the stream stays real time. Hosts that do not know the header can ignore it.

##### CDC Commands (text lines, `\n` terminated)
The mobile app sends HTTP-style GET lines over the serial port:

| Command | Response | Description |
| :--- | :--- | :--- |
| `GET /led_status` | `{"r":..,"g":..,"b":..,"use_rgb":..}\n` | Query LED state. |
| `GET /set_color?r=..&g=..&b=..&use_rgb=..` | `OK\n` | Set LED color (no reboot). |
| `GET /print_chunk?data=HEX` | `PRINT_QUEUED\n` or `PRINT_ERR\n` | Buffer one hex-encoded printer packet (same queue as the Web API). `PRINT_ERR` means the packet was malformed or the queue is full. |
| `GET /print_chunk?done=1` | `{"printer":N}\n` | Send all buffered packets to the printer over the Link Cable, then report the printer status byte. With an empty queue, sends a single `STATUS` packet (used for polling). The response is sent only after the burst completes (can take several seconds). |
| `GET /printer_status` | `{"printer":N}\n` | Return the last cached printer status without touching the Link Cable. |

| `GET /fw_begin?size=N&crc=HEX` | `FW_OK\n` or `FW_ERR <reason>\n` | Start a firmware update of `N` bytes (see Firmware Update Flow below). |
| `GET /fw_chunk?offset=N&data=HEX` | `FW_OK <received>\n` or `FW_ERR <reason> <received>\n` | Next part of the image, hex-encoded, up to 960 bytes so the line stays under 2 KB (512 recommended). |
| `GET /version` | `{"version":"X.Y.Z"}\n` | Running firmware version, to compare against the latest release. |
| `GET /fw_finish` | `FW_OK\n` or `FW_ERR <reason>\n` | Check the image and, on `FW_OK`, install it and restart. |

`N` is the printer status byte (see Status Byte Decoding above); `255` (`0xFF`) means no printer detected.

##### Firmware Update Flow (Mobile App)
Same update as `POST /fw_upload`, over serial: the same staging, checks, error reasons and power-loss behavior apply.
1. Download `update.bin` of the release (the release asset, or the `firmware` branch mirror) and compute its CRC-32 (zlib/IEEE).
2. `GET /fw_begin?size=<bytes>&crc=<8 hex digits>` → `FW_OK`
3. For each 512-byte piece: `GET /fw_chunk?offset=<offset>&data=<hex>` → `FW_OK <received>`. `<received>` is the next offset to send.
   - Resending the chunk that was just accepted (its reply got lost) is answered `FW_OK <received>` again, nothing is written twice.
   - `FW_ERR offset <received>`: the offset was not the expected one; nothing was written, continue from `<received>`.
   - Any other `FW_ERR` aborts the upload: start again from `fw_begin`.
4. `GET /fw_finish` → `FW_OK`. About a second later the adapter installs the image (a few seconds, the serial port disconnects) and restarts with the new firmware. Reconnect and confirm with `GET /version`.

##### Print Flow (Mobile App)
1. `GET /print_chunk?data=88330100000001000000` (INIT) → `PRINT_QUEUED`
2. `GET /print_chunk?data=88330f0000000f000000` (STATUS) → `PRINT_QUEUED`
3. One `GET /print_chunk?data=...` per DATA packet (≤256 byte payloads; the firmware reassembles 640-byte strips) → `PRINT_QUEUED`
4. `GET /print_chunk?data=88330400000004000000` (empty DATA = end of image) → `PRINT_QUEUED`
5. `GET /print_chunk?data=8833020004000103E4<exposure><checksum>0000` (PRINT) → `PRINT_QUEUED`
6. `GET /print_chunk?done=1` → burst send → `{"printer":N}`
7. Poll `GET /print_chunk?done=1` every few seconds while `N & 0x02` (busy) until `N == 0` (done) or an error bit is set.

---

#### 6. Resources & References
- [Official Protocol Specification (shonumi.github.io)](https://shonumi.github.io/articles/art2.html)
- [PC-to-Game-Boy-Printer-interface (Raphael-Boichot)](https://github.com/Raphael-Boichot/PC-to-Game-Boy-Printer-interface)
