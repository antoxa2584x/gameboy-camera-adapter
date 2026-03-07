const COMMAND_INIT = 0x01;
const COMMAND_PRINT = 0x02;
const COMMAND_DATA = 0x04;
const COMMAND_TRANSFER = 0x10;

const PRINTER_WIDTH = 20;
const CAMERA_WIDTH = 16;
const TILE_SIZE = 0x10;
const TILE_HEIGHT = 8;
const TILE_WIDTH = 8;

const imageBinPath = "/download";
const resetPath = "/reset";

let downloadIndex = 0;

const canvas = document.createElement('canvas');
const getImageBtn = document.getElementById("get_image_btn");
const gallery = document.getElementById("gallery");
const tearBtn = document.getElementById("tear_btn");
const deleteSelectedBtn = document.getElementById("delete_selected_btn");
const selectAllBtn = document.getElementById("select_all_btn");
const averageSelectedBtn = document.getElementById("average_selected_btn");

const CURRENT_VERSION = "1.4.8"; // Fallback version
let dynamicVersion = CURRENT_VERSION;

Date.prototype.today = function(delim) {
    return ((this.getDate() < 10) ? "0" : "") + this.getDate() + delim + (((this.getMonth() + 1) < 10) ? "0" : "") + (this.getMonth() + 1) + delim + this.getFullYear();
}
Date.prototype.timeNow = function(delim) {
    return ((this.getHours() < 10) ? "0" : "") + this.getHours() + delim + ((this.getMinutes() < 10) ? "0" : "") + this.getMinutes() + delim + ((this.getSeconds() < 10) ? "0" : "") + this.getSeconds();
}
String.prototype.format = function() {
    var formatted = this;
    for (var i = 0; i < arguments.length; i++) {
        var regexp = new RegExp('\\{' + i + '\\}', 'gi');
        formatted = formatted.replace(regexp, arguments[i]);
    }
    return formatted;
};

function reset_canvas(canvas) {
    canvas.height = 1;
    canvas.width = 1;
}

function resize_canvas(canvas, new_w, new_h) {
    const ctx = canvas.getContext("2d");
    let temp = ctx.getImageData(0, 0, canvas.width, canvas.height)
    canvas.width = new_w;
    canvas.height = new_h;
    ctx.putImageData(temp, 0, 0);
}

function render(canvas, image_data, image_start, image_end, image_tile_width, sheets, margin, palette, exposure) {
    pal = new Uint8Array(4);
    pal[0] = ((exposure * ((palette >> 0) & 0x03)) / 3) >> 0;
    pal[1] = ((exposure * ((palette >> 2) & 0x03)) / 3) >> 0;
    pal[2] = ((exposure * ((palette >> 4) & 0x03)) / 3) >> 0;
    pal[3] = ((exposure * ((palette >> 6) & 0x03)) / 3) >> 0;

    let tile_y = ((canvas.height / TILE_HEIGHT) >> 0);
    let tile_x = 0;

    resize_canvas(canvas, (image_tile_width * 8), ((canvas.height >> 3) << 3) + ((Math.max(0, image_end - image_start) / (TILE_SIZE * image_tile_width)) >> 0) * 8)

    const ctx = canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const writeData = imageData.data;
    for (let i = image_start; i < image_end;) {
        for (let t = 0; t < 8; t++) {
            let b1 = image_data[i++];
            let b2 = image_data[i++];
            for (let b = 0; b < 8; b++) {
                let offset = (((tile_y << 3) + t) * canvas.width + (tile_x << 3) + b) << 2;
                let color_index = ((b1 >> (7 - b)) & 1) | (((b2 >> (7 - b)) & 1) << 1);

                writeData[offset + 0] = writeData[offset + 1] = writeData[offset + 2] = 0xFF - pal[color_index];
                writeData[offset + 3] = 0xff;
            }
        }
        tile_x += 1;
        if (tile_x >= image_tile_width) {
            tile_x = 0;
            tile_y++;
        }
    }
    ctx.putImageData(imageData, 0, 0);

    return ((margin & 0x0f) != 0);
}

function decode(is_compressed, sour, sour_size, sour_data_len, sour_ptr, dest, dest_ptr) {
    if (sour_ptr + sour_data_len <= sour_size) {
        if (is_compressed) {
            const stop = sour_ptr + sour_data_len;
            while (sour_ptr < stop) {
                const tag = sour[sour_ptr++];
                if (tag & 0x80) {
                    const data = sour[sour_ptr++];
                    for (let i = 0; i < ((tag & 0x7f) + 2); i++) {
                        dest[dest_ptr++] = data;
                    }
                } else {
                    for (let i = 0; i < (tag + 1); i++) {
                        dest[dest_ptr++] = sour[sour_ptr++];
                    }
                }
            }
            return dest_ptr;
        } else {
            for (let i = 0; i < sour_data_len; i++) {
                dest[dest_ptr++] = sour[sour_ptr++];
            }
            return dest_ptr;
        }
    }
    return dest_ptr;
}

let processed_data = new Uint8Array(1024 * 1024);

async function get_camera_image(canvas, binPath) {
    const res = await fetch(imageBinPath, { cache: "no-store" });
    if (!res.ok) return false;
    const resBody = await res.blob();
    const resBuf = await resBody.arrayBuffer();
    const resData = new Uint8Array(resBuf);
    const data_size = resBody.size;

    if (data_size === 0) return true;

    if (data_size > processed_data.length) {
        processed_data = new Uint8Array(data_size);
    }

    reset_canvas(canvas);

    let buffer_start = 0;
    let ptr = 0;
    let idx = 0;
    let len = 0;
    while (idx < data_size) {
        const command = resData[idx++];
        console.log(`Processing command: ${command.toString(16)}`); // Log the current command in hex format

        switch (command) {
            case COMMAND_INIT:
                console.log("COMMAND_INIT: Initialization command received.");
                break;

            case COMMAND_PRINT:
                console.log("COMMAND_PRINT: Processing print command...");
                if ((len = resData[idx++] | (resData[idx++] << 8)) != 4) {
                    console.warn(`Unexpected length for COMMAND_PRINT: ${len}. Skipping to end.`);
                    idx = data_size;
                    break;
                }

    let sheets = resData[idx++];
                let margins = resData[idx++];
                let palette = resData[idx++] || 0xE4;
                let exposure = Math.min(0xFF, 0x80 + resData[idx++]);

                console.log(`COMMAND_PRINT details: sheets=${sheets}, margins=${margins}, palette=${palette.toString(16)}, exposure=${exposure}`);

                if (render(canvas, processed_data, buffer_start, ptr, PRINTER_WIDTH, sheets, margins, palette, exposure)) {
                    console.log("Rendering completed, adding canvas to gallery...");
                    addCanvasToGallery(canvas);
                    reset_canvas(canvas);

                    renderExtraViews();
                    parseScheme();
                }

                buffer_start = ptr;
                break;

            case COMMAND_TRANSFER: {
                console.log("COMMAND_TRANSFER: Processing transfer command...");
                len = resData[idx++] | (resData[idx++] << 8);
                console.log(`Transfer length: ${len}`);
                let current_image_start = ptr;
                ptr = decode(false, resData, data_size, len, idx, processed_data, ptr);
                idx += len;

                console.log("Rendering transfer image...");
                render(canvas, processed_data, current_image_start, ptr, CAMERA_WIDTH, 1, 0x03, 0xE4, 0xFF);
                addCanvasToGallery(canvas);
                reset_canvas(canvas);
                buffer_start = ptr;
                break;
            }

            case COMMAND_DATA: {
                console.log("COMMAND_DATA: Processing data command...");
                const compression = resData[idx++];
                len = resData[idx++] | (resData[idx++] << 8);
                console.log(`Data length: ${len}, Compression: ${compression}`);
                ptr = decode(compression, resData, data_size, len, idx, processed_data, ptr);
                idx += len;
                break;
            }

            default:
                console.warn(`Unknown command: ${command.toString(16)}. Skipping to end.`);
                idx = data_size;
                break;
        }
    }

    if (canvas.height > 1) {
        addCanvasToGallery(canvas);
        reset_canvas(canvas);
    }
    return res.ok
}

function addCanvasToGallery(canvas) {
    if (canvas.height > 1) {
        const div = document.createElement("div");
        div.classList.add("gallery-image");

        const img = new Image();
        img.src = canvas.toDataURL();
        img.addEventListener("click", function() {
            showPopupWithUpscaledImage(img);
        });

        const btn = document.createElement("button");
        btn.textContent = "SAVE";
        btn.addEventListener("click", function(e) {
            e.stopPropagation(); // Prevent opening popup when clicking SAVE
            downloadImage(img);
        });

        div.appendChild(img);
        div.appendChild(btn);

        gallery.appendChild(div);

        // Ensure UI elements like "Save All" and colors are visible
        const colors = document.getElementById('color-selector');
        const saveAll = document.getElementById('save_all_btn');
        const description = document.getElementById('description');
        if (description) description.style.display = 'none';
        if (colors) colors.style.display = 'flex';
        if (saveAll) saveAll.style.display = 'flex';

        selectAllBtn.disabled = false;
    }
}

function showPopupWithUpscaledImage(image) {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.id = "image-popup-overlay";
    overlay.classList.add("popup-overlay");

    // Create popup container
    const popup = document.createElement("div");
    popup.classList.add("image-container");
    // Ensure relative positioning for the close button
    popup.style.position = "relative";
    popup.style.display = "flex";
    popup.style.flexDirection = "column";
    popup.style.alignItems = "center";
    popup.style.gap = "0";
    popup.style.padding = "0";
    popup.style.backgroundColor = "transparent"; // Remove weird background square
    popup.style.borderRadius = "10px";
    popup.style.boxSizing = "border-box";
    popup.style.maxWidth = "90vw";
    popup.style.maxHeight = "90vh";
    popup.style.justifyContent = "center";

    // Create canvas for upscaled image
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Load the image
    const img = new Image();
    img.crossOrigin = "Anonymous"; // This enables CORS
    img.src = image.src;
    img.onload = function() {
        // Set canvas dimensions to 10 times the image dimensions
        canvas.width = img.width * 10;
        canvas.height = img.height * 10;

        // Disable image smoothing for Nearest Neighbor scaling
        ctx.imageSmoothingEnabled = false;

        // Draw the image scaled up by 10 times
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, canvas.width, canvas.height);
    };

    popup.appendChild(canvas);

    // Create save button as text at the bottom
    const saveButton = document.createElement("button");
    saveButton.textContent = "SAVE";
    saveButton.style.background = "none";
    saveButton.style.border = "none";
    saveButton.style.color = "white";
    saveButton.style.padding = "0"; // Remove horizontal padding as it's right aligned
    saveButton.style.fontFamily = "inherit";
    saveButton.style.fontSize = "1.2rem";
    saveButton.style.marginTop = "20px";
    saveButton.style.alignSelf = "flex-end";
    saveButton.style.marginRight = "10px";
    saveButton.style.cursor = "pointer";
    saveButton.style.transition = "opacity 0.2s";

    saveButton.onmouseover = () => {
        saveButton.style.opacity = "0.8";
        saveButton.style.textDecoration = "underline";
    };
    saveButton.onmouseout = () => {
        saveButton.style.opacity = "1";
        saveButton.style.textDecoration = "none";
    };

    saveButton.onclick = () => {
        downloadImage(image);
    };
    popup.appendChild(saveButton);

    // Create close button
    const closeButton = document.createElement("button");
    closeButton.textContent = "X";
    closeButton.classList.add("popup-close-button");

    closeButton.onclick = () => {
        document.body.removeChild(overlay);
    };
    popup.appendChild(closeButton);

    overlay.appendChild(popup);
    document.body.appendChild(overlay);
}


function updateButtonStates() {
    const items = gallery.children;
    let anyChecked = false;
    for (let i = 0; i < items.length; i++) {
        if (items[i].markedForAction) {
            anyChecked = true;
            break;
        }
    }
    deleteSelectedBtn.disabled = !anyChecked;
    averageSelectedBtn.disabled = !anyChecked;
    selectAllBtn.disabled = items.length === 0;
}

async function downloadImage(image) {
    downloadIndex += 1;
    var datetime = new Date();
    var file_name = `image_${datetime.toISOString().split('T')[0]}_${datetime.toTimeString().split(' ')[0].replace(/:/g, '-')}.jpg`;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.src = image.src;
    img.onload = function () {
        canvas.width = img.width * 10;
        canvas.height = img.height * 10;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, canvas.width, canvas.height);

        // Convert to JPEG base64
        let jpegDataUrl = canvas.toDataURL("image/jpeg", 1.0);

        // Add EXIF metadata
        const zeroth = {};
        zeroth[piexif.ImageIFD.Make] = "Nintendo";
        zeroth[piexif.ImageIFD.Model] = "Game Boy Camera";
        zeroth[piexif.ImageIFD.Software] = "GameBoy Camera Adapter";
        const exifObj = { "0th": zeroth };
        const exifBytes = piexif.dump(exifObj);

        const jpegWithExif = piexif.insert(exifBytes, jpegDataUrl);

        // Trigger download
        const a = document.createElement("a");
        a.href = jpegWithExif;
        a.download = file_name;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
    };
}


getImageBtn.addEventListener("click", async function() {
    await get_camera_image(canvas, imageBinPath);
});

selectAllBtn.addEventListener("click", function() {
    var items = gallery.children;
    if (items.length != 0) {
        Array.from(items).forEach(item => {
            const input = item.querySelector("input[type='checkbox']");
            if (input) {
                input.checked = true;
                item.markedForAction = true;
            }
        });
        deleteSelectedBtn.disabled = false;
        averageSelectedBtn.disabled = false;
    } else {
        deleteSelectedBtn.disabled = true;
        averageSelectedBtn.disabled = false;
    }
});

deleteSelectedBtn.addEventListener("click", function() {
    var items = gallery.children;
    for (var i = items.length - 1; i >= 0; i--) {
        if (items[i].markedForAction) items[i].remove();
    }
    updateButtonStates();
});

tearBtn.addEventListener("click", async function() {
    fetch(resetPath)
        .then((response) => {
            return response.json();
        })
        .then((data) => {
            if (data.result != "ok") return;
            else {
                var items = gallery.children;
                for (var i = items.length - 1; i >= 0; i--) {
                    items[i].remove();
                }
            };
            getImageBtn.click();
        });

});

averageSelectedBtn.addEventListener("click", function() {
    const items = gallery.children;

    const avgCanvas = document.createElement('canvas');
    const avgCtx = avgCanvas.getContext('2d');

    const tmpCanvas = document.createElement('canvas');
    const tmpCtx = tmpCanvas.getContext('2d');

    // Verify that image dimensions are the same
    const firstImg = items[0].querySelector("img");
    const tmpW = firstImg.width;
    const tmpH = firstImg.height;
    for (let i = 1; i < items.length; i++) {
        const img = items[i].querySelector("img");
        if (tmpW != img.width || tmpH != img.height) {
            alert("Image dimensions should be the same to do an average");
            return;
        }
    }

    tmpCanvas.width = tmpW;
    tmpCanvas.height = tmpH;

    avgCanvas.width = tmpW;
    avgCanvas.height = tmpH;

    const sumImgData = [];
    const avgImgData = avgCtx.createImageData(avgCanvas.width, avgCanvas.height);
    let selectedItems = 0;
    // Generate average image
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].markedForAction) {
            selectedItems++;
            const item = items[i];
            const img = item.querySelector("img");
            tmpCtx.drawImage(img, 0, 0);
            const tmpImgData = tmpCtx.getImageData(0, 0, tmpCanvas.width, tmpCanvas.height);
            for (let j = 0; j < tmpImgData.data.length; j += 1) {
                if (!sumImgData[j]) {
                    sumImgData.push(0);
                }
                sumImgData[j] += tmpImgData.data[j];
            }
        }
    }
    for (let i = 0; i < avgImgData.data.length; i += 1) {
        avgImgData.data[i] = (sumImgData[i] / selectedItems);
    }
    avgCtx.putImageData(avgImgData, 0, 0);
    addCanvasToGallery(avgCanvas);
});

// auto fetch images
var fetch_skip = false;

async function periodic_fetch() {
    if (typeof currentMode !== 'undefined' && currentMode === "printer") {
        return;
    }
    if (fetch_skip) return;
    fetch_skip = true;

    try {
        const fetch_ok = await get_camera_image(canvas, imageBinPath);
        const next_interval = fetch_ok ? 500 : 2000;
        setTimeout(periodic_fetch, next_interval);
    } catch (err) {
        console.error("Fetch error:", err);
        setTimeout(periodic_fetch, 2000);
    } finally {
        fetch_skip = false;
    }
}
setTimeout(periodic_fetch, 1000);

function generateExampleImage() {
    // Create a canvas
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Set canvas dimensions
    canvas.width = 160;
    canvas.height = 160;

    // Draw a background color
    ctx.fillStyle = "#004d25";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw some text
    ctx.fillStyle = "white";
    ctx.font = "20px 'Press Start 2P'";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Example", canvas.width / 2, canvas.height / 2 - 20);
    ctx.fillText("Image", canvas.width / 2, canvas.height / 2 + 20);

    addCanvasToGallery(canvas);
}

const pocketCameraPalettes = {
    "grayscale": {
        "#ffffff": [255, 255, 255],
        "#bfbfbf": [191, 191, 191],
        "#7f7f7f": [127, 127, 127],
        "#3f3f3f": [63, 63, 63]
    },
    "game-boy": {
        "#ffffff": [208, 217, 60],
        "#bfbfbf": [120, 164, 106],
        "#7f7f7f": [84, 88, 84],
        "#3f3f3f": [36, 70, 36]
    },
    "super-game-boy": {
        "#ffffff": [255, 255, 255],
        "#bfbfbf": [181, 179, 189],
        "#7f7f7f": [84, 83, 103],
        "#3f3f3f": [9, 7, 19]
    },
    "game-boy-color-jpn": {
        "#ffffff": [240, 240, 240],
        "#bfbfbf": [218, 196, 106],
        "#7f7f7f": [112, 88, 52],
        "#3f3f3f": [30, 30, 30]
    },
    "game-boy-color-usa-gold": {
        "#ffffff": [240, 240, 240],
        "#bfbfbf": [220, 160, 160],
        "#7f7f7f": [136, 78, 78],
        "#3f3f3f": [30, 30, 30]
    },
    "game-boy-color-usa-eur": {
        "#ffffff": [240, 240, 240],
        "#bfbfbf": [134, 200, 100],
        "#7f7f7f": [58, 96, 132],
        "#3f3f3f": [30, 30, 30]
    }
};

// Map reverse colors back to grayscale before applying a new scheme
const reverseColorMapping = {};
Object.keys(pocketCameraPalettes).forEach(scheme => {
    Object.entries(pocketCameraPalettes[scheme]).forEach(([grayHex, rgb]) => {
        reverseColorMapping[JSON.stringify(rgb)] = grayHex;
    });
});

function applyColorScheme(scheme) {
    const selectedPalette = pocketCameraPalettes[scheme];
    if (!selectedPalette) return;

    const images = document.querySelectorAll(".gallery-image img");

    images.forEach(img => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const rgb = [data[i], data[i + 1], data[i + 2]];
            const rgbString = JSON.stringify(rgb);
            const grayHex = reverseColorMapping[rgbString] || rgbToHex(data[i], data[i + 1], data[i + 2]);

            const newColor = selectedPalette[grayHex];
            if (newColor) {
                data[i] = newColor[0];
                data[i + 1] = newColor[1];
                data[i + 2] = newColor[2];
            }
        }

        ctx.putImageData(imageData, 0, 0);
        img.src = canvas.toDataURL();
    });
}

// Convert RGB values to HEX string
function rgbToHex(r, g, b) {
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function parseScheme() {
    console.log("parseScheme");

    // Retrieve last selected scheme or default to grayscale
    const savedScheme = localStorage.getItem("selectedColorScheme") || "grayscale";

    // Find the corresponding color circle
    const selectedCircle = document.querySelector(`.color-circle[data-scheme="${savedScheme}"]`);

    if (selectedCircle) {
        selectedCircle.classList.add("active");
    }

    console.log("applyColorScheme", savedScheme);
    applyColorScheme(savedScheme);
}

function renderExtraViews() {
    const description = document.getElementById("description");
    if (description) {
        description.style.display = "none";
        console.log("Description hidden as gallery is not empty.");
    }

    const colors = document.getElementById("color-selector");
    if (colors) {
        colors.style.display = "flex";
        console.log("Colors visible as gallery is not empty.");
    }

    const saveAll = document.getElementById("save_all_btn");
    if (saveAll) {
        saveAll.style.display = "flex";
    }
}

// Color scheme selector handler
function setupColorSchemeSelector() {
    document.querySelectorAll(".color-circle").forEach(circle => {
        circle.onclick = () => {
            // Remove active class from all circles
            document.querySelectorAll(".color-circle").forEach(c => c.classList.remove("active"));

            // Add active class to clicked circle
            circle.classList.add("active");

            // Store the selected scheme in localStorage
            localStorage.setItem("selectedColorScheme", circle.dataset.scheme);

            // Apply color scheme
            applyColorScheme(circle.dataset.scheme);
        };
    });
}

// Function to observe changes in the gallery container
function observeGalleryChanges() {
    const gallery = document.getElementById("gallery");

    if (!gallery) return;

    let timeout = null; // Timeout variable to delay execution

    const observer = new MutationObserver(() => {
        // Clear any previous timeout to prevent multiple triggers
        clearTimeout(timeout);

        // Set a delay of 1 second (1000ms) before applying the color scheme
        timeout = setTimeout(() => {
            console.log("Gallery updated! Applying color scheme...");
            const activeScheme = document.querySelector(".color-circle.active")?.dataset.scheme || "grayscale";
            applyColorScheme(activeScheme);
        }, 200);
    });

    observer.observe(gallery, {
        childList: true
    });
}

function isNewerVersion(latest, current) {
    const latestParts = latest.replace(/^v/, '').split('.').map(Number);
    const currentParts = current.replace(/^v/, '').split('.').map(Number);
    const maxLen = Math.max(latestParts.length, currentParts.length);

    for (let i = 0; i < maxLen; i++) {
        const latestNum = latestParts[i] || 0;
        const currentNum = currentParts[i] || 0;
        if (latestNum > currentNum) return true;
        if (latestNum < currentNum) return false;
    }
    return false;
}

async function checkGitHubRelease() {
    // Only check if we have internet connection (best effort)
    if (!navigator.onLine) return;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

    try {
        const response = await fetch('https://api.github.com/repos/antoxa2584x/gameboy-camera-adapter/releases/latest', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const release = await response.json();
        const latestVersion = release.name.replace(/^v/, '');
        const releaseUrl = release.html_url;

        if (isNewerVersion(latestVersion, dynamicVersion)) {
            const alertBox = document.getElementById("update-alert");
            const versionSpan = document.getElementById("latest-version");

            versionSpan.innerHTML = `<a href="${releaseUrl}" target="_blank" style="color:yellow;">v${latestVersion}</a>`;
            alertBox.style.display = "block";
        }
    } catch (err) {
        console.error("Failed to check for updates:", err);
    }
}


async function fetchFirmwareVersion() {
    try {
        const response = await fetch('/status.json');
        if (!response.ok) return;
        const data = await response.json();
        if (data.system && data.system.version) {
            dynamicVersion = data.system.version;
            const versionText = document.getElementById("firmware-version-text");
            if (versionText) {
                versionText.textContent = `Current firmware is v${dynamicVersion}`;
            }
        }
    } catch (err) {
        console.error("Failed to fetch firmware version:", err);
    }
}


document.addEventListener("DOMContentLoaded", () => {
    const versionText = document.getElementById("firmware-version-text");

    if (versionText) {
        versionText.textContent = `Current firmware is v${dynamicVersion}`;
    }

    // Local initialization should be fast
    parseScheme();
    observeGalleryChanges();
    setupColorSchemeSelector();

    // Background tasks
    fetchFirmwareVersion().then(() => {
        // Only check GitHub after some delay to ensure page is usable
        setTimeout(() => {
            checkGitHubRelease();
        }, 1000);
    });
});


function showFirmwarePopup() {
    const popup = document.getElementById('fw-popup');
    popup.style.display = 'flex';

    loadLedStatus();
}

function closeFirmwarePopup() {
    const popup = document.getElementById('fw-popup');
    popup.style.display = 'none';
}

function checkForUpdate() {
    window.open("https://github.com/antoxa2584x/gameboy-camera-adapter/releases", "_blank");
}

function startUpdate() {
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        alert("⚠️ Update is only available on macOS or Windows.");
        return;
    }

    window.location.href = "http://192.168.7.1/update";
}

function setLedColor() {
    const hex = document.getElementById("ledColorPicker").value;
    const useRGB = document.getElementById("colorMode").checked;
    const mobileMode = document.getElementById("mobileMode").value;
    const r = parseInt(hex.substr(1, 2), 16);
    const g = parseInt(hex.substr(3, 2), 16);
    const b = parseInt(hex.substr(5, 2), 16);
    fetch(`/set_color?r=${r}&g=${g}&b=${b}&use_rgb=${useRGB}&mode=${mobileMode}`)
        .then(() => {
            alert("Settings saved. The device will now reboot.");
            window.location.reload();
        });
}

function updatePreview() {
    const color = document.getElementById("ledColorPicker").value;
    document.getElementById("colorPreview").style.backgroundColor = color;
}

document.getElementById("ledColorPicker").addEventListener("input", updatePreview);

function loadLedStatus() {
    fetch('/led_status')
        .then(response => response.json())
        .then(data => {
            const { r, g, b, use_rgb, mode } = data;
            const hex = "#" + [r, g, b].map(x => (x || 0).toString(16).padStart(2, '0')).join('');
            document.getElementById('ledColorPicker').value = hex;
            document.getElementById('colorPreview').style.backgroundColor = hex;
            document.getElementById('colorMode').checked = use_rgb === true;
            if (mode !== undefined) {
                document.getElementById('mobileMode').value = mode;
            }
        })
        .catch(err => console.error("Failed to load LED status:", err));
}

function saveAllPictures() {
    const buttons = document.querySelectorAll('.gallery-image button');
    const total = buttons.length;

    if (total == 0) {
        return;
    }

    showGeneralPopup();

    updateGeneralPopup('SAVING PHOTOS', false);

    buttons.forEach((btn, index) => {
        setTimeout(() => {
            let showButton = false;
            if (index == total - 1) {
                showButton = true;
            }
            updateGeneralPopup(`SAVING PHOTO ${index + 1}/${total}`, showButton);
            btn.click();
        }, 1000 * index);
    });
}

function showGeneralPopup() {
    const popup = document.getElementById('general-popup');
    popup.style.display = 'flex';
}

function closeGeneralPopup() {
    const popup = document.getElementById('general-popup');
    popup.style.display = 'none';
}

function updateGeneralPopup(html, showCloseButton) {
    const popupContent = document.querySelector('.general-popup-content');
    if (popupContent) popupContent.innerHTML = html;

    const closeButton = document.querySelector('.general-popup-button-close-button');
    if (showCloseButton) {
        if (closeButton) closeButton.style.display = 'flex';
    } else {
        if (closeButton) closeButton.style.display = 'none';
    }
}

window.showFirmwarePopup = showFirmwarePopup;
window.closeFirmwarePopup = closeFirmwarePopup;
window.setLedColor = setLedColor;
window.checkForUpdate = checkForUpdate;
window.downloadImage = downloadImage;
window.saveAllPictures = saveAllPictures;

function decodePrinterStatus(byte, ignoreBusyFull = false) {
    if (byte === 0xFF) return "Disconnected";
    const flags = [
        "Checksum Error",
        "Printing image",
        "Image Data Full",
        "Unprocessed Data",
        "Packet Error",
        "Paper Jam",
        "Other Error",
        "Battery Low"
    ];
    const errors = [];
    if (byte === 0) return "OK";
    for (let i = 0; i < 8; i++) {
        if (byte & (1 << i)) {
            if (ignoreBusyFull && (i === 1 || i === 2)) continue;
            errors.push(flags[i]);
        }
    }
    return errors.length ? errors.join(", ") : "OK";
}

function pollPrinterStatus() {
    if (typeof currentMode !== 'undefined' && currentMode !== "printer") return;

    // Trigger status update on firmware if in printer mode
    fetch('/print_chunk?done=1')
        .then(() => fetch('/status.json', { cache: "no-store" }))
        .then(r => r.json())
        .then(data => {
            if (data.printer !== undefined) {
                const status = decodePrinterStatus(data.printer);
                const el = document.getElementById("printer-status");
                if (el) {
                    el.textContent = "Printer Status: " + status;
                    if (data.printer === 0xFF) {
                        el.style.color = "red";
                    } else {
                        // Treat busy/full as "normal" orange, others as lightgreen if only busy/full
                        const isError = (data.printer & ~0x06) !== 0 && data.printer !== 0x00;
                        el.style.color = isError ? "red" : (data.printer === 0 ? "lightgreen" : "orange");
                    }
                }

                // Show overlay if busy, hide if OK or Disconnected
                const overlay = document.getElementById("print-overlay");
                const statusText = document.getElementById("print-status-text");
                if (overlay && statusText) {
                    if (data.printer & 0x02) { // Printer Busy (Printing image)
                        overlay.style.display = "flex";
                        statusText.textContent = "Printing image...";
                    } else if (data.printer === 0x00 || data.printer === 0xFF) {
                        overlay.style.display = "none";
                    } else if (data.printer & 0x04) { // Image Data Full
                        overlay.style.display = "flex";
                        statusText.textContent = "Image Data Full";
                        // Auto-hide full status after some time or let user click?
                        // Requirement says "close when status ok or disconnected".
                    }
                }
            }
        })
        .catch(err => console.error("Status error:", err));
}

setInterval(pollPrinterStatus, 3000);

const logoImg = document.getElementById("logo-img");
let currentMode = "scanner";
if (logoImg) {
    logoImg.addEventListener("click", () => {
        const scanner = document.getElementById("scanner-mode");
        const printer = document.getElementById("printer-mode");
        const modeName = document.getElementById("mode-name");

        const switchMode = () => {
            if (currentMode === "scanner") {
                if (scanner) {
                    scanner.style.display = "none";
                    scanner.classList.remove("fade-out");
                }
                if (printer) {
                    printer.style.display = "block";
                    printer.classList.add("fade-in");
                }
                if (modeName) modeName.textContent = "Printer";
                currentMode = "printer";
                periodic_fetch();
                pollPrinterStatus();
            } else {
                if (printer) {
                    printer.style.display = "none";
                    printer.classList.remove("fade-out");
                }
                if (scanner) {
                    scanner.style.display = "block";
                    scanner.classList.add("fade-in");
                }
                if (modeName) modeName.textContent = "Gallery";
                currentMode = "scanner";
                periodic_fetch();
            }
        };

        const currentBlock = currentMode === "scanner" ? scanner : printer;
        if (currentBlock) {
            currentBlock.classList.remove("fade-in");
            currentBlock.classList.add("fade-out");
            currentBlock.addEventListener("animationend", () => {
                switchMode();
            }, { once: true });
        } else {
            switchMode();
        }
    });
}
window.startUpdate = startUpdate;
window.saveAllPictures = saveAllPictures;
window.closeGeneralPopup = closeGeneralPopup;

function canvasToTileData(canvas) {
    const ctx = canvas.getContext("2d");
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imgData.data;
    const tiles = [];

    const w = canvas.width;
    const h = canvas.height;

    for (let y = 0; y < h; y += 8) {
        for (let x = 0; x < w; x += 8) {
            for (let row = 0; row < 8; row++) {
                let byte1 = 0;
                let byte2 = 0;
                for (let col = 0; col < 8; col++) {
                    let px = ((y + row) * w + (x + col)) * 4;
                    // Game Boy grayscale uses inverted intensity: 0=White, 3=Black
                    let gray = (0.299 * pixels[px] + 0.587 * pixels[px + 1] + 0.114 * pixels[px + 2]);
                    let shade = gray > 192 ? 0 : gray > 128 ? 1 : gray > 64 ? 2 : 3;
                    byte1 |= ((shade & 1) << (7 - col));
                    byte2 |= (((shade >> 1) & 1) << (7 - col));
                }
                tiles.push(byte1);
                tiles.push(byte2);
            }
        }
    }

    return new Uint8Array(tiles);
}

function printSelectedImage() {
    const canvas = document.getElementById("preview-canvas");
    const binaryData = canvasToTileData(canvas);
    // Truncate to complete strips (640 bytes each = 2 tile rows = 16px)
    const STRIP_SIZE = 640;
    const totalStrips = Math.floor(binaryData.length / STRIP_SIZE);
    const trimmedLen = totalStrips * STRIP_SIZE;
    const trimmed = binaryData.slice(0, trimmedLen);
    console.log(`Image: ${binaryData.length} bytes -> ${totalStrips} strips (${trimmedLen} bytes)`);
    sendChunkedData(trimmed);
}

function sendChunkedData(binaryData, chunkSize = 256) {
    const totalChunks = Math.ceil(binaryData.length / chunkSize);

    function calculateChecksum(command, data) {
        let sum = command + (data.length & 0xFF) + (data.length >> 8);
        for (let i = 0; i < data.length; i++) {
            sum = (sum + data[i]);
        }
        return sum & 0xFFFF;
    }

    const packetInit = "88330100000001000000";
    const packetStatus = "88330f0000000f000000";

    function createDataPacket(data) {
        let header = "88330400";
        let lenL = (data.length & 0xFF).toString(16).padStart(2, '0');
        let lenH = (data.length >> 8).toString(16).padStart(2, '0');
        let hexData = '';
        for (let i = 0; i < data.length; i++) {
            hexData += data[i].toString(16).padStart(2, '0');
        }
        let checksum = calculateChecksum(0x04, data);
        let checkL = (checksum & 0xFF).toString(16).padStart(2, '0');
        let checkH = (checksum >> 8).toString(16).padStart(2, '0');
        return header + lenL + lenH + hexData + checkL + checkH + "0000";
    }

    let packets = [];
    packets.push({ data: packetInit, name: "INIT" });
    packets.push({ data: packetStatus, name: "STATUS" });

    for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, binaryData.length);
        const chunk = binaryData.slice(start, end);
        packets.push({ data: createDataPacket(chunk), name: "DATA" });
    }

    // Empty DATA packet signals end of image data to the printer
    packets.push({ data: "88330400000004000000", name: "DATA_END" });

    // PRINT packet
    const exposure = parseInt(document.getElementById("print-exposure").value) || 0x40;
    const expValue = Math.min(0x7F, exposure);
    const printData = new Uint8Array([0x01, 0x03, 0xE4, expValue]);
    const printHeader = "883302000400";
    let printHexData = "0103e4" + expValue.toString(16).padStart(2, '0');
    const printChecksum = calculateChecksum(0x02, printData);
    const printCheckL = (printChecksum & 0xFF).toString(16).padStart(2, '0');
    const printCheckH = (printChecksum >> 8).toString(16).padStart(2, '0');
    packets.push({ data: printHeader + printHexData + printCheckL + printCheckH + "0000", name: "PRINT" });

    // Status checks after print
    packets.push({ data: packetStatus, name: "STATUS" });
    packets.push({ data: packetStatus, name: "STATUS" });
    packets.push({ data: packetStatus, name: "STATUS" });

    function getPrinterStatusDisplay(status) {
        return decodePrinterStatus(status, true);
    }

    const printBtn = document.getElementById("print-button");
    const overlay = document.getElementById("print-overlay");
    const statusText = document.getElementById("print-status-text");

    if (printBtn) printBtn.style.display = "none";
    if (overlay) overlay.style.display = "flex";
    if (statusText) statusText.textContent = "Sending to printer...";

    // Buffer all packets to firmware, then trigger burst send
    function bufferNextPacket(index) {
        if (index >= packets.length) {
            console.log(`All ${packets.length} packets buffered. Triggering burst send...`);
            if (statusText) statusText.textContent = "Starting print...";
            fetch("/print_chunk?done=1")
                .then(() => new Promise(resolve => setTimeout(resolve, 2000))) // wait for printing
                .then(() => fetch("/status.json"))
                .then(res => res.json())
                .then(statusData => {
                    if (printBtn) printBtn.style.display = "block";
                    // Note: overlay is managed by pollPrinterStatus from now on
                    const printerStatus = statusData.printer;
                    console.log(`Final status: 0x${printerStatus.toString(16).padStart(2, '0')} (${getPrinterStatusDisplay(printerStatus)})`);
                    const statusDesc = getPrinterStatusDisplay(printerStatus);

                    if (printerStatus === 0x00 || printerStatus === 0xFF) {
                        if (overlay) overlay.style.display = "none";
                    } else if (statusDesc !== "OK") {
                        if (statusText) statusText.textContent = statusDesc;
                        // If it's a real error (not just busy), maybe keep it visible?
                        // "close when status ok or disconected" - implies we close on those.
                    }
                })
                .catch(err => {
                    console.error("Print failed", err);
                    if (printBtn) printBtn.style.display = "block";
                    if (overlay) overlay.style.display = "none";
                });
            return;
        }

        const packet = packets[index];
        const url = `/print_chunk?data=${packet.data}`;
        console.log(`[${index}/${packets.length}] Buffering ${packet.name} (${packet.data.length / 2} bytes)`);

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Server error");
                setTimeout(() => bufferNextPacket(index + 1), 50);
            })
            .catch(err => {
                console.error("Buffer failed at packet " + index, err);
            });
    }

    bufferNextPacket(0);
}

function handleFileInput(e) {
    const file = e.target.files[0];
    const nameDisplay = document.getElementById("file-name");
    const printButton = document.getElementById("print-button");

    if (file) {
        if (nameDisplay) {
            const name = file.name;
            const dotIndex = name.lastIndexOf(".");
            const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
            const ext = dotIndex > 0 ? name.substring(dotIndex) : "";
            nameDisplay.textContent = base.length > 47 ? base.substring(0, 30) + "..." + base.substring(base.length - 3, base.length) + ext : name;
        }
        printButton.style.display = "block";
        document.getElementById("printer-controls").style.display = "flex";
    } else {
        if (nameDisplay) nameDisplay.textContent = "No file selected";
        printButton.style.display = "none";
        document.getElementById("printer-controls").style.display = "none";
        return;
    }

    const reader = new FileReader();
    reader.onload = function (evt) {
        const img = new Image();
        img.onload = function () {
            const canvas = document.getElementById("preview-canvas");
            const ctx = canvas.getContext("2d");
            canvas.width = 160;
            canvas.height = 144;
            ctx.drawImage(img, 0, 0, 160, 144);

            const imageData = ctx.getImageData(0, 0, 160, 144);
            const data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
                let level = gray > 192 ? 255 : gray > 128 ? 170 : gray > 64 ? 85 : 0;
                data[i] = data[i + 1] = data[i + 2] = level;
            }
            ctx.putImageData(imageData, 0, 0);
        };
        img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
}

window.handleFileInput = handleFileInput;
window.printSelectedImage = printSelectedImage;
window.showPopupWithUpscaledImage = showPopupWithUpscaledImage;