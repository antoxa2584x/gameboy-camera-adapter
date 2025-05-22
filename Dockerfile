FROM debian:bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
  git build-essential cmake \
  gcc-arm-none-eabi libnewlib-arm-none-eabi \
  libstdc++-arm-none-eabi-newlib \
  python3 python3-pip ca-certificates \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN git clone -b master https://github.com/raspberrypi/pico-sdk.git && cd pico-sdk \
    && git submodule update --init

ENV PICO_SDK_PATH=/pico-sdk

WORKDIR /project

COPY . .

RUN mkdir -p build && \
  gcc -o build/makefsdata -I$PICO_SDK_PATH/lib/lwip/src/include/ -Iinclude -I. makefsdata/makefsdata.c && \
  ./build/makefsdata ./fs -f:include/pico_printer_fs.c && \
  cd build && \
  cmake .. && \
  make -j$(nproc)

FROM scratch AS export

COPY --from=builder /project/build/*.uf2 /
