## ✅ What's New (v2.4.0)

- **Gallery:**
  - Photos stay in the gallery after a page reload or a firmware update
  - **Select** several photos to save, print, join, animate, delete, or turn into a contact sheet
  - **Save All** downloads one ZIP file, on iPhone and iPad too
  - Make up to 3 of your own **color palettes**, saved on the adapter so every browser and device sees them, and share them as a short code
  - **Frame** setting: keep the Game Boy Camera frame, remove it, or use your own
  - Long prints sent in parts (Pokémon Pinball, Zelda DX and others) arrive as one photo
  - Rotate, flip and favorite photos, and sort by date or favorites
  - Save several photos as an animated **GIF** or a **video**
  - gb-photo **Transfer REC**: step through the recording with the arrows or the slider and **Save Frame** keeps the one you pick
  - Simpler **Settings**: photo, adapter and firmware options in their own sections, quick LED color choices
- **Status LED:** fixed colors show what the adapter is doing: blue blink while receiving a photo, cyan for live view, orange while printing, purple during a firmware update, red blink when a print or update fails. Your LED color shows when idle.
- **Printer:**
  - A simpler print page: pick a **Picture** or **Text or QR**, check the preview, print
  - Print several images in a row, with copies, from your device or straight from the gallery
  - Print **text labels and QR codes**
  - **Long** layout prints banners and strips longer than one page
  - Shading styles, brightness and contrast under More options
  - Clear printer messages (paper jam, low battery, not connected), with **Resume** after a problem
- **Fixes:**
  - The print dialog no longer stays open after the phone was locked during a print
  - On iPhone, dialogs are no longer hidden behind the browser's toolbar, and the page can no longer be dragged past the footer
  - The ✔ on selected photos no longer shows as stray characters
  - Long-pressing a photo on iPhone to add it to Photos keeps working after the first time

---

## 🔄 How to Update

### From v2.3.0: one click

1. Open [http://192.168.7.1](http://192.168.7.1) with the adapter connected
2. Tap **Update available** (or **Settings → Firmware Update**), then **Update Now**
3. The adapter installs the update and restarts on its own

The Android app offers the same update from its main screen.

### From older firmware: USB drive

1. **Download** `pico_gb_printer.2.4.0.uf2` from the [Latest Release](https://github.com/antoxa2584x/gameboy-camera-adapter/releases/latest)
2. Put the adapter in update mode, either:
   - **Settings → Firmware Update → Force Update Mode** in the web UI, or
   - hold the **button** inside the adapter's housing while plugging it into your PC or Mac
3. A drive named **RPI-RP2** appears: **drag and drop** the `.uf2` file onto it
4. The adapter restarts on its own when the copy finishes
