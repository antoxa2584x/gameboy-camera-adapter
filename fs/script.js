const COMMAND_INIT = 0x01;
const COMMAND_PRINT = 0x02;
const COMMAND_DATA = 0x04;
const COMMAND_TRANSFER = 0x10;

const PRINTER_WIDTH = 20;
const CAMERA_WIDTH = 16;
const TILE_SIZE = 0x10;
const TILE_HEIGHT = 8;

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

const CURRENT_VERSION = "1.4.5";

String.prototype.format = function () {
    let formatted = this;
    for (let i = 0; i < arguments.length; i++) {
        const regexp = new RegExp('\\{' + i + '\\}', 'gi');
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
    let pal = new Uint8Array(4);
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

                writeData[offset] = writeData[offset + 1] = writeData[offset + 2] = 0xFF - pal[color_index];
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

    return ((margin & 0x0f) !== 0);
}

function decode(is_compressed, sour, sour_size, sour_data_len, sour_ptr, dest, dest_ptr) {
    if (sour_ptr + sour_data_len <= sour_size) {
        if (is_compressed) {
            const stop = sour_ptr + sour_data_len;
            while (sour_ptr < stop) {
                const tag = sour[sour_ptr++];
                if (tag && 0x80) {
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

async function get_camera_image(canvas) {
    const res = await fetch(imageBinPath);
    const resBody = await res.blob();
    const resBuf = await resBody.arrayBuffer();
    const resData = new Uint8Array(resBuf);
    const data_size = resBody.size;

    let processed_data = new Uint8Array(Math.max(1024 * 1024, data_size));

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
                if ((len = resData[idx++] | (resData[idx++] << 8)) !== 4) {
                    console.warn(`Unexpected length for COMMAND_PRINT: ${len}. Skipping to end.`);
                    idx = data_size;
                    break;
                }

                let sheets = resData[idx++];
                let margins = resData[idx++];
                let palette = resData[idx++];
                let exposure = Math.min(0xFF, 0x80 + resData[idx++]);
                palette = (palette) ? palette : 0xE4;

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
        div.appendChild(img);
        div.appendChild(document.createElement("br"));
        div.markedForAction = false;

        const input = document.createElement("input");
        input.setAttribute("type", "checkbox");
        input.setAttribute("id", `checkbox-${gallery.children.length}`);
        input.style.display = "none";
        input.checked = false;
        div.appendChild(input);

        const label = document.createElement("label");
        label.setAttribute("for", input.id);
        label.classList.add("image-label");
        label.appendChild(img);
        div.appendChild(label);

        label.addEventListener("click", function () {
            const inp = div.querySelector("input[type='checkbox']");
            inp.checked = !inp.checked;
            div.markedForAction = inp.checked;
            updateButtonStates();
        });

        const btn = document.createElement("button");
        btn.textContent = "SAVE";
        btn.classList.add("shake");
        btn.addEventListener("click", function () {
            downloadImage(img);
        });

        img.addEventListener("click", function () {
            showPopupWithUpscaledImage(img);
        });

        div.appendChild(btn);
        gallery.appendChild(div);
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

    // Create canvas for upscaled image
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    // Load the image
    const img = new Image();
    img.crossOrigin = "Anonymous"; // This enables CORS
    img.src = image.src;
    img.onload = function () {
        // Set canvas dimensions to 10 times the image dimensions
        canvas.width = img.width * 10;
        canvas.height = img.height * 10;

        // Disable image smoothing for Nearest Neighbor scaling
        ctx.imageSmoothingEnabled = false;

        // Draw the image scaled up by 10 times
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, canvas.width, canvas.height);
    };

    popup.appendChild(canvas);

    // Create close button
    const closeButton = document.createElement("button");
    closeButton.textContent = "X";
    closeButton.classList.add("popup-close-button");
    closeButton.classList.add("shake");

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
    const datetime = new Date();
    const file_name = `image_${datetime.toISOString().split('T')[0]}_${datetime.toTimeString().split(' ')[0].replace(/:/g, '-')}.jpg`;

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
        const exifObj = {"0th": zeroth};
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


getImageBtn.addEventListener("click", async function () {
    await get_camera_image(canvas);
});

selectAllBtn.addEventListener("click", function () {
    const items = gallery.children;
    if (items.length !== 0) {
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

deleteSelectedBtn.addEventListener("click", function () {
    const items = gallery.children;
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].markedForAction) items[i].remove();
    }
    updateButtonStates();
});

tearBtn.addEventListener("click", async function () {
    fetch(resetPath)
        .then((response) => {
            return response.json();
        })
        .then((data) => {
            if (data.result !== "ok") return;
            else {
                const items = gallery.children;
                for (let i = items.length - 1; i >= 0; i--) {
                    items[i].remove();
                }
            }

            getImageBtn.click();
        });

});

averageSelectedBtn.addEventListener("click", function () {
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
        if (tmpW !== img.width || tmpH !== img.height) {
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
let fetch_skip = false;
let fetch_ok = false;

let fetch_interval;

function periodic_fetch() {
    if (currentMode === "printer") {
        clearInterval(fetch_interval);
        fetch_interval = setInterval(periodic_fetch, 1000);
        return;
    }
    if (!fetch_skip) {
        fetch_skip = true;
        void (async () => {
            fetch_ok = await get_camera_image(canvas).catch(
                function () {
                    fetch_ok = false;
                }
            );
            fetch_skip = false;
            clearInterval(fetch_interval);
            fetch_interval = setInterval(periodic_fetch, (fetch_ok) ? 10 : 1000);
        })();
    }
}

fetch_interval = setInterval(periodic_fetch, 1000);
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

        // Set canvas size to match the image
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        // Draw the image onto the canvas
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // Get pixel data
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        // Loop through all pixels
        for (let i = 0; i < data.length; i += 4) {
            const rgbString = JSON.stringify([data[i], data[i + 1], data[i + 2]]);
            const grayHex = reverseColorMapping[rgbString] || rgbToHex(data[i], data[i + 1], data[i + 2]);

            // Ensure the darkest color is mapped correctly
            if (grayHex === "#3f3f3f" && scheme === "grayscale") {
                data[i] = 63;
                data[i + 1] = 63;
                data[i + 2] = 63;
                continue;
            }

            // If grayscale value exists in the scheme, replace it
            if (selectedPalette[grayHex]) {
                const newColor = selectedPalette[grayHex];
                data[i] = newColor[0]; // R
                data[i + 1] = newColor[1]; // G
                data[i + 2] = newColor[2]; // B
            }
        }

        // Put the modified image data back to the canvas
        ctx.putImageData(imageData, 0, 0);

        // Replace the image with the modified version
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

document.querySelectorAll(".color-circle").forEach(circle => {
    circle.addEventListener("click", () => {
        document.querySelectorAll(".color-circle").forEach(c => c.classList.remove("active"));
        circle.classList.add("active");
        applyColorScheme(circle.dataset.scheme);
    });
});

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
    try {
        const response = await fetch('https://api.github.com/repos/antoxa2584x/gameboy-camera-adapter/releases/latest');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const release = await response.json();
        const latestVersion = release.name.replace(/^v/, '');
        const releaseUrl = release.html_url;

        if (isNewerVersion(latestVersion, CURRENT_VERSION)) {
            const alertBox = document.getElementById("update-alert");
            const versionSpan = document.getElementById("latest-version");

            versionSpan.innerHTML = `<a href="${releaseUrl}" target="_blank" style="color:yellow;">v${latestVersion}</a>`;
            alertBox.style.display = "block";
        }
    } catch (err) {
        console.error("Failed to check for updates:", err);
    }
}


document.addEventListener("DOMContentLoaded", () => {
    const versionText = document.getElementById("firmware-version-text");

    if (versionText) {
        versionText.textContent = `Current firmware is v${CURRENT_VERSION}`;
    }

    // Run on load
    checkGitHubRelease();
    parseScheme();
    observeGalleryChanges();
});

document.querySelectorAll(".color-circle").forEach(circle => {
    circle.addEventListener("click", () => {
        // Remove active class from all circles
        document.querySelectorAll(".color-circle").forEach(c => c.classList.remove("active"));

        // Add active class to clicked circle
        circle.classList.add("active");

        // Store the selected scheme in localStorage
        const selectedScheme = circle.dataset.scheme;
        localStorage.setItem("selectedColorScheme", selectedScheme);

        // Apply the selected scheme
        applyColorScheme(selectedScheme);
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
    const r = parseInt(hex.substr(1, 2), 16);
    const g = parseInt(hex.substr(3, 2), 16);
    const b = parseInt(hex.substr(5, 2), 16);
    fetch(`/set_color?r=${r}&g=${g}&b=${b}&use_rgb=${useRGB}`);
}

function updatePreview() {
    document.getElementById("colorPreview").style.backgroundColor = document.getElementById("ledColorPicker").value;
}

document.getElementById("ledColorPicker").addEventListener("input", updatePreview);

function loadLedStatus() {
    fetch('/led_status')
        .then(response => response.json())
        .then(data => {
            const {r, g, b, use_rgb} = data;
            const hex = "#" + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
            document.getElementById('ledColorPicker').value = hex;
            document.getElementById('colorPreview').style.backgroundColor = hex;
            document.getElementById('colorMode').checked = use_rgb === true;
        })
        .catch(err => console.error("Failed to load LED status:", err));
}

function saveAllPictures() {
    const buttons = document.querySelectorAll('.gallery-image button');
    const total = buttons.length;

    if (total !== 0) {
        showGeneralPopup();
        updateGeneralPopup('SAVING PHOTOS', false);
        buttons.forEach((btn, index) => {
            setTimeout(() => {
                let showButton = false;
                if (index === total - 1) {
                    showButton = true;
                }
                updateGeneralPopup(`SAVING PHOTO ${index + 1}/${total}`, showButton);
                btn.click();
            }, 1000 * index);
        });
    } else {

    }
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
    sendChunkedData(binaryData);
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

    function createPrintPacket() {
        const exposure = parseInt(document.getElementById("print-exposure").value) || 0x40;
        // The standard Game Boy Printer PRINT command (0x02) uses 4 data bytes:
        // [sheets][margins][palette][exposure]
        // sheets: 0x01 (one copy)
        // margins: upper/lower margin (0x00 default)
        // palette: 0xE4 (standard)
        // exposure: 0x00-0x7F (0x40 default)
        const expValue = Math.min(0x7F, exposure);
        const data = new Uint8Array([0x01, 0x00, 0xE4, expValue]);
        const header = "883302000400";
        let hexData = "0100e4" + expValue.toString(16).padStart(2, '0');
        const checksum = calculateChecksum(0x02, data);
        const checkL = (checksum & 0xFF).toString(16).padStart(2, '0');
        const checkH = (checksum >> 8).toString(16).padStart(2, '0');
        return header + hexData + checkL + checkH + "0000";
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

    // After all data chunks, send a status check to ensure buffer is ready
    packets.push({ data: packetStatus, name: "STATUS" });

    packets.push({ data: createPrintPacket(), name: "PRINT" });
    // Final status checks
    packets.push({ data: packetStatus, name: "STATUS" });
    packets.push({ data: packetStatus, name: "STATUS" });

    let currentPrinterStatus = 0; // Local status for this print job
    function getPrinterStatusDisplay(status) {
        if (status === 0xFF) return "Disconnected";
        if (status === 0) return "OK";
        const flags = [
            "Checksum Error",
            "Printer Busy",
            "Image Data Full",
            "Unprocessed Data",
            "Packet Error",
            "Paper Jam",
            "Other Error",
            "Battery Low"
        ];
        const errors = [];
        for (let i = 0; i < 8; i++) {
            if (status & (1 << i)) errors.push(flags[i]);
        }
        return errors.length ? errors.join(", ") : "OK (" + status.toString(16).padStart(2, '0') + ")";
    }

    function updatePrinterStatusUI() {
        const statusEl = document.getElementById("printer-status");
        if (!statusEl) return;

        fetch("/status.json")
            .then(res => res.json())
            .then(data => {
                currentPrinterStatus = data.printer;
                statusEl.textContent = "Printer Status: " + getPrinterStatusDisplay(currentPrinterStatus);
                if (currentPrinterStatus === 0xFF) {
                    statusEl.style.color = "red";
                } else {
                    statusEl.style.color = currentPrinterStatus === 0 ? "lightgreen" : "orange";
                }
            })
            .catch(err => console.error("Failed to get status", err));
    }

    const statusInterval = setInterval(updatePrinterStatusUI, 5000);

    function sendNextPacket(index) {
        if (index >= packets.length) {
            clearInterval(statusInterval);
            alert("Printing complete!");
            return;
        }

        const packet = packets[index];
        const url = `/print_chunk?data=${packet.data}`;

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Server error");
                return new Promise(resolve => setTimeout(resolve, 150)); // Wait for bit-banging to finish
            })
            .then(() => fetch("/status.json"))
            .then(res => res.json())
            .then(statusData => {
                const printerStatus = statusData.printer;
                currentPrinterStatus = printerStatus;

                if (printerStatus === 0xFF) {
                    alert("Printer disconnected!");
                    clearInterval(statusInterval);
                    return;
                }
                
                // If it's a DATA packet, wait if buffer is full
                // If it's a PRINT packet, wait while printing
                let delay = 100;
                if (packet.name === "DATA" && (printerStatus & 0x04)) {
                    console.log("Printer buffer full, waiting...");
                    delay = 1000;
                    return setTimeout(() => sendNextPacket(index), delay);
                }
                
                if (packet.name === "PRINT" || (printerStatus & 0x02)) {
                    console.log("Printer busy, waiting...");
                    delay = 1000;
                    return setTimeout(() => sendNextPacket(index), delay);
                }

                setTimeout(() => sendNextPacket(index + 1), delay);
            })
            .catch(err => {
                clearInterval(statusInterval);
                console.error("Packet failed", err);
                alert("Printing failed at packet " + index + " (" + packet.name + ")");
            });
    }

    if (currentPrinterStatus === 0xFF) {
        alert("Printer is disconnected. Please connect the printer before printing.");
        return;
    }

    sendNextPacket(0);
}

function handleFileInput(e) {
    const file = e.target.files[0];
    const nameDisplay = document.getElementById("file-name");
    const printButton = document.getElementById("print-button");

    if (file) {
        const name = file.name;
        const dotIndex = name.lastIndexOf(".");
        const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
        const ext = dotIndex > 0 ? name.substring(dotIndex) : "";
        nameDisplay.textContent = base.length > 47 ? base.substring(0, 30) + "..." + base.substring(base.length - 3, base.length) + ext : name;
        printButton.style.display = "block";
        document.getElementById("printer-controls").style.display = "flex";
    } else {
        nameDisplay.textContent = "No file selected";
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

const logoImg = document.getElementById("logo-img");
let currentMode = "scanner";
logoImg.addEventListener("click", () => {
    const scanner = document.getElementById("scanner-mode");
    const printer = document.getElementById("printer-mode");
    if (currentMode === "scanner") {
        scanner.style.display = "none";
        printer.style.display = "block";
        currentMode = "printer";
        // Immediately trigger periodic_fetch to clear fast interval if it was running
        periodic_fetch();
    } else {
        scanner.style.display = "block";
        printer.style.display = "none";
        currentMode = "scanner";
    }
});

window.addEventListener("DOMContentLoaded", () => {
    const canvas = document.getElementById("preview-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#004d25";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#fff";
    ctx.font = "18px monospace";
    ctx.textAlign = "center";
    ctx.fillText("No Image", canvas.width / 2, canvas.height / 2);
});

function decodePrinterStatus(byte) {
    if (byte === 0xFF) return "Disconnected";
    const flags = [
        "Checksum Error",
        "Printer Busy",
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
        if (byte & (1 << i)) errors.push(flags[i]);
    }
    return errors.length ? errors.join(", ") : "OK";
}

function pollPrinterStatus() {
    // If we're in printer mode, the sendChunkedData function handles the status interval
    // But we need a global one for when not currently sending data
    if (currentMode !== "printer") return;
    
    fetch('/status.json')
        .then(r => r.json())
        .then(data => {
            if (data.printer !== undefined) {
                const el = document.getElementById("printer-status");
                if (el) {
                    el.textContent = "Printer Status: " + decodePrinterStatus(data.printer);
                    if (data.printer === 0xFF) {
                        el.style.color = "red";
                    } else {
                        el.style.color = data.printer === 0 ? "lightgreen" : "orange";
                    }
                }
            }
        })
        .catch(err => console.error("Status error:", err));
}

setInterval(pollPrinterStatus, 3000);

window.showFirmwarePopup = showFirmwarePopup;
window.closeFirmwarePopup = closeFirmwarePopup;
window.setLedColor = setLedColor;
window.checkForUpdate = checkForUpdate;
window.startUpdate = startUpdate;
window.saveAllPictures = saveAllPictures;
window.closeGeneralPopup = closeGeneralPopup;