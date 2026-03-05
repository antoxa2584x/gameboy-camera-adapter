### Game Boy Printer Protocol Documentation

This document provides a comprehensive overview of the Game Boy Printer protocol as implemented and optimized in this project. This information is intended for future developers to ensure consistent and reliable communication with the physical Game Boy Printer.

#### 1. Communication Layer
- **Interface**: Bit-banging via GPIO (Pico SDK).
- **Clock Frequency**: ~2.5kHz (200µs per half-cycle).
- **Inter-byte Delay**: 10µs to ensure the printer can process incoming bytes reliably.
- **Signal Logic**:
  - **SCK (Serial Clock)**: Driven by the Pico.
  - **SIN (Serial In)**: Data from the Pico to the Printer.
  - **SOUT (Serial Out)**: Data from the Printer to the Pico.
  - **Pull-ups**: Enabled on `PIN_SIN` to detect disconnected state (returns `0xFF`).

#### 2. Packet Structure
Every packet follows a mandatory 10-byte header/footer structure plus the variable-length data payload.

| Offset | Length | Name | Value / Description |
| :--- | :--- | :--- | :--- |
| 0x00 | 2 | Magic Bytes | `0x88`, `0x33` |
| 0x02 | 1 | Command | `0x01` (INIT), `0x02` (DATA), `0x04` (PRINT), `0x0F` (STATUS) |
| 0x03 | 1 | Compression | `0x00` (None), `0x01` (RLE - not implemented here) |
| 0x04 | 2 | Length | Data length (Lesser byte first) |
| 0x06 | N | Data | Payload bytes |
| 0x06+N | 2 | Checksum | Sum of Command + Compression + Length + Data (16-bit) |
| 0x08+N | 2 | Preamble | `0x00`, `0x00` (Sent by Pico to receive Printer's `0x81` sync and status) |

#### 3. Standard Packet Sequence
To print an image, the following sequence of packets must be sent:

1.  **INIT (`0x01`)**: Resets the printer's internal state.
2.  **STATUS (`0x0F`)**: Polls the printer to ensure it's connected and ready.
3.  **DATA (`0x02`)**: Sent in chunks (typically 640 bytes for a 160x16 pixel strip).
    - Repeat until the full image buffer is transferred.
4.  **STATUS (`0x0F`)**: Poll the status after each DATA packet to handle "Buffer Full" or "Busy" states.
5.  **PRINT (`0x04`)**: Initiates the actual printing process.
    - Payload: `[0x01 (sheets), 0x00 (margins), 0xE4 (palette), 0x40 (exposure)]`
    - Exposure range: `0x00` - `0x7F`.

#### 4. Status Byte Decoding
The printer returns a status byte following a `0x81` sync byte.

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

- **Special State**: `0xFF` indicates the printer is disconnected.

#### 5. Grayscale Conversion
The Game Boy Printer uses a 2-bit (4-level) grayscale. This project uses standard luminance weighting for conversion:
- `Gray = 0.299*R + 0.587*G + 0.114*B`
- The result is then mapped to one of the 4 Game Boy shades.

#### 6. Resources & References
- [Official Protocol Specification (shonumi.github.io)](https://shonumi.github.io/articles/art2.html)
- [Arduino Reference (Raphael-Boichot)](https://github.com/Raphael-Boichot/PC-to-Game-Boy-Printer-interface)
