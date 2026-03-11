# 📸 GameBoy Camera Photo Save Adapter

<p align="center">
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/preview_1.jpg?raw=true" width="30%" />
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/preview_2.jpg?raw=true" width="30%" />
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/preview_3.jpg?raw=true" width="30%" />
</p>

A modern, **RP2040 Zero** based adapter that lets you **save photos** from your GameBoy Camera and **print images** to a real GameBoy Printer via a web interface or an Android app.

---

## ✨ Features

*   **🚀 Plug & Play Web Interface**: Access your photos and settings at `http://192.168.7.1/` (RP2040 Zero acts as a USB Ethernet device).
*   **📷 Gallery Mode**: Automatically captures images sent from your GameBoy.
*   **🖨️ Printer Mode**: Upload any image from your PC/Phone and print it to a real GameBoy Printer.
*   **📱 Mobile Ready**: 
    *   **iOS Support**: Specialized mode for seamless connection.
    *   **Android Companion**: Use the [GameBoy Camera Adapter Companion](https://github.com/antoxa2584x/gameboy-camera-adapter-companion) app for easy photo management.
*   **🌈 RGB Status LED**: Visual feedback for connection and transfer status.
*   **⚡ High Performance**: Built with Pico SDK for low-latency Link Cable communication.

---

## 🛠️ Hardware Assembly

To build this adapter, you will need:

### 📦 Bill of Materials (BOM)
1.  **RP2040 Zero**.
2.  **GameBoy Color Link Cable** (one half).
3.  **4-Channel Level Shifter** (5V to 3.3V).

### 🔌 Wiring Diagram

Connect the parts to the **RP2040 Zero** as shown in the schematics below:

<p align="center">
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/schematics.jpg?raw=true" width="80%"/>
</p>

| GameBoy Link Pin | RP2040 Zero GPIO | Description |
| :--- | :--- | :--- |
| **1: VCC (5V)**    | **VBUS**| Power (5V) |
| **2: SO** (Serial Out)| **GP2** | Data from GB to RP2040 (SIN) |
| **3: SI** (Serial In) | **GP3** | Data from RP2040 to GB (SOUT) |
| **4: SD** (Unused) | - | Not connected |
| **5: SCK** (Clock)    | **GP4** | Serial Clock |
| **6: GND**            | **GND** | Ground |

*Note: Pins 2, 3, and 5 must use a level shifter to convert 5V (GameBoy) to 3.3V. In the firmware, GP2 is configured as SIN (Input) and GP3 as SOUT (Output).*

---

## 🚀 Getting Started

### 1. Flash the Firmware
Download the latest `pico_gb_printer.uf2` from the [Releases](https://github.com/antoxa2584x/gameboy-camera-adapter/releases) page. Hold the **BOOT** button on your **RP2040 Zero**, plug it into your PC, and drag the file onto the `RPI-RP2` drive.

### 2. Connect
*   **PC/Mac/iOS**: The RP2040 Zero will appear as a USB Ethernet device. Navigate to `http://192.168.7.1/`.
*   **Android**: Enable "Android Mode" in settings or via Serial to use the Companion App.

### 3. Compatibility Modes
Switch modes in the Web UI or via a Serial Terminal (9600 baud):
*   `GET /set_mode_ios`: iOS/Desktop (CDC disabled for better iOS detection).
*   `GET /set_mode_android`: Android/Desktop (CDC enabled for the App).
*   `GET /update`: Enter bootloader mode for firmware updates.

---

## 🏗️ Build from Source

### 🐳 Docker Build (Recommended)
No local dependencies required:
```bash
git clone --depth 1 https://github.com/antoxa2584x/gameboy-camera-adapter
cd gameboy-camera-adapter
git submodule update --init
./build.sh
```
The resulting `pico_gb_printer.uf2` will be in the `output/` directory.

---

## 📜 Technical Details & API

This project uses a custom implementation of the GameBoy Printer protocol. For detailed protocol information, API endpoints, and serial commands, please refer to [COMMUNICATION.md](COMMUNICATION.md).

---

## 🙏 Credits

*   Based on the original [pico-gb-printer](https://github.com/untoxa/pico-gb-printer).
*   [Raphael-Boichot](https://github.com/Raphael-Boichot/The-Arduino-SD-Game-Boy-Printer) for printer communication details.

---