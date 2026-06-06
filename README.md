<p align="center">
  <img src="https://rgaming.com.ua/camera_adapter/assets/logo.webp" width="400">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Firmware-v2.0.5-266d3f?style=for-the-badge&logo=raspberrypi" alt="Firmware Version">
  <img src="https://img.shields.io/badge/Hardware-RP2040-004d25?style=for-the-badge" alt="Hardware">
  <img src="https://img.shields.io/badge/Compatibility-iOS_%7C_Android_%7C_Web-4caf50?style=for-the-badge" alt="Compatibility">
</p>

<p align="center">
  <b>A modern adapter to save GameBoy Camera photos to your PC or Phone via Web Interface.</b>
</p>

---

### 📸 Features

<div align="center">
<table>
  <tr>
    <td align="center"><b>🖼️ Web Gallery</b><br>Real-time photo receiving</td>
    <td align="center"><b>🎨 Color Palettes</b><br>Retro GB & GBC styles</td>
  </tr>
  <tr>
    <td align="center"><b>🖨️ Printer Mode</b><br>Print from PC to GameBoy</td>
    <td align="center"><b>📱 Mobile Ready</b><br>iOS & Android Support</td>
  </tr>
</table>
</div>

### 🚀 Getting Started

1.  **Build or Buy**: Get a Raspberry Pi Pico and follow the [Schematics](#-schematics) below.
2.  **Flash**: Download the latest `.uf2` from [Releases](https://github.com/antoxa2584x/gameboy-camera-adapter/releases) or [build it yourself](#-docker-build).
3.  **Connect**: Plug it into your PC/Phone. It will appear as a USB Ethernet device.
4.  **Open**: Navigate to **[http://192.168.7.1/](http://192.168.7.1/)** in your browser.

---

### 🛠️ Compatibility Modes

The adapter features two specialized modes to ensure it works across all your devices. Switch via Web UI Settings or Serial commands.

*   **🍏 iOS + Desktop (Default)**: Optimized for Apple devices. Prioritizes the Web Interface.
*   **🤖 Android + Desktop**: Enables USB Serial (CDC) for use with the [Android Companion App](https://github.com/antoxa2584x/gameboy-camera-adapter-companion).

#### ⌨️ Serial Commands
If the web UI is unreachable, use a serial terminal to send:
*   `GET /set_mode_ios` / `GET /set_mode_android`
*   `GET /update` (Reboots to Bootloader)

---

### 📟 Modes of Operation

#### 📥 Scanner Mode (Default)
Acts as a virtual **Game Boy Printer**. Simply select "Print" on your Game Boy, and photos will appear instantly in the web gallery.

#### 📤 Printer Mode
Click the **Logo** in the web interface to switch. Upload any image from your device to print it on a real Game Boy Printer connected to the adapter. Includes **Live Preview** and **Exposure Control**.

---

### 🔌 Schematics

<p align="center">
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/schematics.jpg?raw=true" width="600"/>
</p>

#### 💡 Hardware Tips
*   Uses **GPIO 8** for the Status LED.
*   Uses **GPIO 9** for the Action Button.
*   Requires a **5V to 3.3V level shifter** for safe operation with the Game Boy's 5V logic.

<p align="center">
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/preview_3.jpg?raw=true" width="400"/>
  <br><i>Example of a finished build.</i>
</p>

---

### 🐳 Docker Build

Build the firmware without installing any local dependencies:

```bash
git clone --depth 1 https://github.com/antoxa2584x/gameboy-camera-adapter
cd gameboy-camera-adapter
git submodule update --init
./build.sh
```

---

### 🤝 Credits & Links
*   Based on [pico-gb-printer](https://github.com/untoxa/pico-gb-printer).
*   Protocol insights from [Raphael-Boichot](https://github.com/Raphael-Boichot/The-Arduino-SD-Game-Boy-Printer).
*   [Instagram @retrogaming_ua](https://www.instagram.com/retrogaming_ua/)
