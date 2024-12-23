const translations = {
    en: {
        title: "GameBoy Camera Adapter",
        description: "Start printing on your Game Boy. Photos will appear on this page",
        getImageBtn: "Get Images",
        tearBtn: "Tear",
        selectAllBtn: "Select All",
        deleteSelectedBtn: "Delete",
        averageSelectedBtn: "Average"
    },
    uk: {
        title: "Адаптер камери GameBoy",
        description: "Почніть друкувати на своєму Game Boy. Фото з'являться на цій сторінці автоматично",
        getImageBtn: "Отримати зображення",
        tearBtn: "Очистити",
        selectAllBtn: "Вибрати все",
        deleteSelectedBtn: "Видалити",
        averageSelectedBtn: "Середнє"
    }
};

function detectLanguage() {
    const userLang = navigator.language || navigator.userLanguage;
    if (userLang.startsWith('ru') || userLang.startsWith('uk')) {
        document.documentElement.lang = 'uk';
        document.getElementById('language_select').value = 'uk';
        translatePage('uk');
    } else {
        document.documentElement.lang = 'en';
        translatePage('en');
    }
}

document.getElementById('language_select').addEventListener('change', (event) => {
    const selectedLanguage = event.target.value;
    document.documentElement.lang = selectedLanguage;
    translatePage(selectedLanguage);
});

function translatePage(language) {
    document.getElementById('title').textContent = translations[language].title;
    document.getElementById('description').textContent = translations[language].description;
    document.getElementById('get_image_btn').textContent = translations[language].getImageBtn;
    document.getElementById('tear_btn').textContent = translations[language].tearBtn;
    document.getElementById('select_all_btn').textContent = translations[language].selectAllBtn;
    document.getElementById('delete_selected_btn').textContent = translations[language].deleteSelectedBtn;
    document.getElementById('average_selected_btn').textContent = translations[language].averageSelectedBtn;
}

// Initialize the page with the default language
detectLanguage();

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

async function get_camera_image(canvas, binPath) {
    const res = await fetch(imageBinPath);
    const resBody = await res.blob();
    const resBuf = await resBody.arrayBuffer();
    const resData = new Uint8Array(resBuf);
    const data_size = resBody.size;

    processed_data = new Uint8Array(Math.max(1024 * 1024, data_size));

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
            let palette = resData[idx++];
            let exposure = Math.min(0xFF, 0x80 + resData[idx++]);
            palette = (palette) ? palette : 0xE4;

            console.log(`COMMAND_PRINT details: sheets=${sheets}, margins=${margins}, palette=${palette.toString(16)}, exposure=${exposure}`);

            if (render(canvas, processed_data, buffer_start, ptr, PRINTER_WIDTH, sheets, margins, palette, exposure)) {
                console.log("Rendering completed, adding canvas to gallery...");
                addCanvasToGallery(canvas);
                reset_canvas(canvas);

                const description = document.getElementById("description");
                if (description) {
                    description.style.display = "none";
                    console.log("Description hidden as gallery is not empty.");
                }
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
    popup.classList.add("popup-container");

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

document.addEventListener('DOMContentLoaded', () => {
    detectLanguage();
});

async function downloadImage(image) {
    downloadIndex += 1;
    var datetime = new Date();
    file_name = `image_${datetime.toISOString().split('T')[0]}_${datetime.toTimeString().split(' ')[0].replace(/:/g, '-')}.png`;

    // Create a canvas to draw the image
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

        // Convert the canvas to a blob and initiate the download
        canvas.toBlob(function(blob) {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = file_name;
            a.style.display = "none";
            document.body.appendChild(a);
            a.click();
            a.remove();
        }, "image/png");
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
var fetch_ok = false;

function periodic_fetch() {
    if (!fetch_skip) {
        fetch_skip = true;
        void(async () => {
            fetch_ok = await get_camera_image(canvas, imageBinPath).catch(
                function(err) {
                    fetch_ok = false;
                }
            );
            fetch_skip = false;
            clearInterval(fetch_interval);
            fetch_interval = setInterval(periodic_fetch, (fetch_ok) ? 10 : 1000);
        })();
    }
}
var fetch_interval = setInterval(periodic_fetch, 1000);

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

    // Add the generated canvas to the gallery    addCanvasToGallery(canvas);
	addCanvasToGallery(canvas)
}
