cmake_minimum_required(VERSION 3.13)

# Enable fetching the Pico SDK from Git if it's not found locally
set(PICO_SDK_FETCH_FROM_GIT TRUE)

include(pico_sdk_import.cmake)
project(pico_gb_printer)

pico_sdk_init()

# LWIP
set(LWIP_DIR ${PICO_SDK_PATH}/lib/lwip)
set (LWIP_INCLUDE_DIRS
    "include"
    "${LWIP_DIR}/src/include"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
include(${LWIP_DIR}/src/Filelists.cmake)

# Extra stuff from TinyUSB, that is not part of tinyusb_device library
set(PICO_TINYUSB_PATH ${PICO_SDK_PATH}/lib/tinyusb)
set(TINYUSB_LIBNETWORKING_SOURCES
    ${PICO_TINYUSB_PATH}/lib/networking/dhserver.c
    ${PICO_TINYUSB_PATH}/lib/networking/dnserver.c
    ${PICO_TINYUSB_PATH}/lib/networking/rndis_reports.c
)

add_executable(
    pico_gb_printer
    src/ws2812.c
    src/pico_gb_printer.c
    src/linkcable.c
    src/gb_printer.c
    src/datablocks.c
    src/tusb_lwip_glue.c
    src/usb_descriptors.c
    src/cdc_sender.c
    ${TINYUSB_LIBNETWORKING_SOURCES}
)

pico_generate_pio_header(pico_gb_printer ${CMAKE_CURRENT_LIST_DIR}/src/linkcable.pio)
pico_generate_pio_header(pico_gb_printer ${CMAKE_CURRENT_LIST_DIR}/src/linkcable_sm.pio)
pico_generate_pio_header(pico_gb_printer ${CMAKE_CURRENT_LIST_DIR}/src/ws2812.pio)

pico_enable_stdio_usb(pico_gb_printer 0)
pico_enable_stdio_uart(pico_gb_printer 0)

target_include_directories(pico_gb_printer PRIVATE ${LWIP_INCLUDE_DIRS} ${PICO_TINYUSB_PATH}/src ${PICO_TINYUSB_PATH}/lib/networking)

target_link_libraries(pico_gb_printer pico_stdlib hardware_pio pico_unique_id tinyusb_device lwipallapps lwipcore hardware_clocks pico_flash)

pico_add_extra_outputs(pico_gb_printer)

target_compile_definitions(pico_gb_printer PRIVATE 
    PICO_ENTER_USB_BOOT_ON_EXIT=1 
    CFG_TUD_CDC=1 
    CFG_TUD_NET_ENABLED=1
)
