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
| `0x10` | `TRANSFER` | High-speed transfer (custom protocol for PXLR-Studio-next). |
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
  "status": { "last_size": 1234, "total_files": 1 },
  "system": { "fast": "true/false", "version": "2.0.1", "uptime": 3600 },
  "printer": 0,
  "dbg": ""
}
```

##### GET `/download` (or `/image.bin`)
Retrieves the stored binary data of the last captured print job.
- **Format**: A stream of raw Binary Packets (see section 2).
- **Behavior**: Pops the file from the internal queue (one-time download).

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
Reboots the Pico into USB Bootloader mode.

##### GET `/print_chunk?data=HEX_PACKET&done=0/1`
Sends a Game Boy Printer packet to a physical printer connected to the adapter.
- **Parameters**:
  - `data`: Hex-encoded string of a single binary packet (e.g., `88330100000001000000`).
  - `done`: Set to `1` to trigger the actual transmission of all buffered packets.
- **Behavior**:
  1. If `done=0`, the packet is added to a temporary queue in the firmware.
  2. If `done=1`, the firmware sends all queued packets to the printer over the Link Cable.
  3. If `done=1` is sent without `data`, a `STATUS` packet is sent to the printer.
- **Queue Limits**: Up to 64 packets or 16KB total payload.

---

#### 5. Serial Protocol (USB CDC)
When enabled (`mode=1`), the firmware can send data over USB Serial.
- **Handshake**: `GBCA_PHOTO_TRANSFER\n`
- **Data**: Base64 encoded chunks of image data.
- **Framing**: Starts with `GBCA_PHOTO_TRANSFER_BASE64\n`, followed by chunks and ending with `DONE\n`.

---

#### 6. Resources & References
- [Official Protocol Specification (shonumi.github.io)](https://shonumi.github.io/articles/art2.html)
- [PC-to-Game-Boy-Printer-interface (Raphael-Boichot)](https://github.com/Raphael-Boichot/PC-to-Game-Boy-Printer-interface)
