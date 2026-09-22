## ✅ What's New (v2.1.0)

- **New Features:**
  - **Saved Photo Scale** picker in Settings — save photos at 1x (160 × 144), 2x, 5x or 10x. 10x stays the default, and your choice is remembered in the browser.
- **Bug Fixes:**
  - Fix the web interface freezing while a photo is being sent over USB serial — the page stays alive for the whole transfer
  - Fix the print exposure slider doing nothing on photos taken with the Game Boy Camera
- **Improvements:**
  - Exposure slider now darkens to the right, matching the Game Boy Camera, and the preview shows the exposure instead of baking it into the printed image
  - Exposure slider opened back up to the printer's full range (0x00–0x7F), defaulting to the Game Boy's own 0x40
  - Camera photos are re-printed as they are; only other images get dithered

---

## 🔄 How to Update

1. **Download** the file: `pico_gb_printer.2.1.0.uf2` from the [Latest Release](https://github.com/antoxa2584x/gameboy-camera-adapter/releases/latest)

---

### 📡 Method 1: Update via Web Interface

- 2.1. Connect the adapter to your PC or Mac  
- 2.2. Open [http://192.168.7.1](http://192.168.7.1) in your browser  
- 2.3. Click **Settings** (⚙️ in the top-right corner)  
- 2.4. Select **Force update mode** and follow the prompts  

### 🔘 Method 2: Update via Physical Button
While **holding the button** inside the adapter’s housing, connect it to your PC or Mac  

---

3. A drive named **RPI-RP2** will appear  
4. **Drag and drop** the `pico_gb_printer.2.1.0.uf2` file into that drive  
5. Wait until the update is complete  

---

## ✅ Final Step
- After updating, click **UPDATE IS FINISHED** on the adapter’s page  
  > ℹ️ If the page doesn’t reload automatically, unplug and reconnect the adapter, then reload the page manually.
