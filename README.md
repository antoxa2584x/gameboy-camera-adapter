# GameBoy Camera Photo Save Adapter

<p align="center">
   <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/preview_1.jpg?raw=true"/>
</p>
<p align="center">
   <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/preview_2.jpg?raw=true"/>
</p>

Based on the original pico-gb-printer repo: https://github.com/untoxa/pico-gb-printer

Webserver example that came with TinyUSB slightly modified to run on a Raspberry Pi Pico.
Lets the Pico pretend to be a USB Ethernet device. Runs the webinterface at http://192.168.7.1/

Special thanks to Raphael-Boichot, please check this repo: https://github.com/Raphael-Boichot/The-Arduino-SD-Game-Boy-Printer

## Schematics

You will need a Raspberry Pi, 1/2 of the game boy link cable and a four-channel 5v to 3.3v level shifter. Connect parts as shown:

<p align="center">
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/schematics.png?raw=true"/>
</p>

This is the example of the ready-to-use device:

<p align="center">
  <img src="https://github.com/antoxa2584x/gameboy-camera-adapter/blob/main/preview_3.jpg?raw=true"/>
</p>

As finding which is SIN and SOUT is sometimes tricky as signals are crossed within the serial cable, you can also make your own PCB with a Pi Zero and a GBC/GBA serial socket [following the guide here](https://github.com/Raphael-Boichot/Collection-of-PCB-for-Game-Boy-Printer-Emulators). Just [route the LED to GPIO 8](https://github.com/Raphael-Boichot/pico-gb-printer/blob/c10a31e7458818ecd8ce3af9a09c53344a659cd4/include/globals.h#L8C33-L8C35) and the [Pushbutton to GPIO9](https://github.com/Raphael-Boichot/pico-gb-printer/blob/c10a31e7458818ecd8ce3af9a09c53344a659cd4/include/globals.h#L21) to make it shine and cut paper !

### 🐳 Docker Build (Cross-platform, no local dependencies)

```bash
git clone --depth 1 https://github.com/antoxa2584x/gameboy-camera-adapter
cd gameboy-camera-adapter
git submodule update --init
./build.sh
```

This will build the firmware inside a Docker container.  
The final `pico_gb_printer.uf2` file will be placed in the `build/` directory.  
Just drag and drop it to your Pi Pico device.
