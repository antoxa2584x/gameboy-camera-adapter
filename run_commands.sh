#!/bin/bash

# Run regen-fsdata.sh
./regen-fsdata.sh

# Change directory to build
cd build/

# Run cmake
cmake ..

# Run make
make
