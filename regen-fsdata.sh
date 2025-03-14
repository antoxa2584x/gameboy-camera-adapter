#!/bin/sh

if [ ! -f makefsdata ]; then
    # Doing this outside cmake as we don't want it cross-compiled but for host
    echo Compiling makefsdata
    gcc -o build/makefsdata -Ibuild/pico-sdk/lib/lwip/src/include/ -Iinclude -I. makefsdata/makefsdata.c
fi

echo Regenerating fsdata.c
./build/makefsdata ./fs -f:include/pico_printer_fs.c
echo Done
