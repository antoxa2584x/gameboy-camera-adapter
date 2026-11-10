const COMMAND_INIT = 0x01;
const COMMAND_PRINT = 0x02;
const COMMAND_DATA = 0x04;
const COMMAND_TRANSFER = 0x10;
// Not a printer command: the adapter stores gb-photo "Transfer REC" frames under
// this tag so they go to the live view instead of the gallery
const COMMAND_TRANSFER_LIVE = 0x11;

const PRINTER_WIDTH = 20;
const CAMERA_WIDTH = 16;
const TILE_SIZE = 0x10;
const TILE_HEIGHT = 8;
const TILE_WIDTH = 8;

const imageBinPath = "/download";

const gallery = document.getElementById("gallery");

function safeAddEventListener(el, event, handler) {
    if (el) el.addEventListener(event, handler);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// A request caught by the lock screen on iOS can hang forever, and the gallery
// polls one at a time: a deadline keeps polling alive once the phone is unlocked.
async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { cache: "no-store", signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function readStored(key) {
    try {
        return localStorage.getItem(key);
    } catch (e) {
        return null; // storage unavailable (private mode)
    }
}

function writeStored(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable */ }
}

const CURRENT_VERSION = "2.5.0"; // Fallback version
let dynamicVersion = CURRENT_VERSION;

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

// One printed part: the tile rows in the print buffer, mapped through the PRINT
// command's palette byte to the shade each colour index actually prints as
function printedShades(data, start, end, palette) {
    const image = decodeTilePixels(data.subarray(start, end), PRINTER_WIDTH);
    const map = [0, 1, 2, 3].map(i => (palette >> (i * 2)) & 3);
    for (let p = 0; p < image.pixels.length; p++) image.pixels[p] = map[image.pixels[p]];
    return image;
}

// A print with no paper feed after it continues in the next one: games print
// long pictures (Pokemon Pinball, Zelda DX...) a page at a time. The parts are
// collected here and only go into the gallery as one photo once a part ends with
// a feed, a new sheet starts, or nothing more arrives for a while - the next
// part can come in a later download than the one before it.
const PENDING_PRINT_MS = 4000;
let pendingPrint = null; // { width, height, parts, time }

function appendPendingPrint(image) {
    if (!image.height) return;
    if (pendingPrint && pendingPrint.width !== image.width) flushPendingPrint();
    if (!pendingPrint) pendingPrint = { width: image.width, height: 0, parts: [], time: 0 };
    pendingPrint.parts.push(image);
    pendingPrint.height += image.height;
    pendingPrint.time = Date.now();
}

function flushPendingPrint() {
    if (!pendingPrint) return null;
    const image = stackImages(pendingPrint.parts);
    pendingPrint = null;
    return addPhoto(image);
}

async function get_camera_image() {
    const res = await fetchWithTimeout(imageBinPath, 10000);
    if (!res.ok) return false;
    const resData = new Uint8Array(await res.arrayBuffer());
    const data_size = resData.length;

    if (data_size === 0) return true;

    if (data_size > processed_data.length) {
        processed_data = new Uint8Array(data_size);
    }

    let buffer_start = 0;
    let ptr = 0;
    let idx = 0;
    let len = 0;
    while (idx < data_size) {
        const command = resData[idx++];

        switch (command) {
            case COMMAND_INIT:
                break;

            case COMMAND_PRINT: {
                if ((len = resData[idx++] | (resData[idx++] << 8)) != 4) {
                    console.warn(`Unexpected length for COMMAND_PRINT: ${len}. Skipping to end.`);
                    idx = data_size;
                    break;
                }

                idx++; // sheets
                const margins = resData[idx++];
                const palette = resData[idx++] || 0xE4;
                idx++; // exposure: only how dark the paper burns, not part of the picture

                const part = printedShades(processed_data, buffer_start, ptr, palette);
                // A feed before this part means it starts a sheet of its own
                if ((margins >> 4) && pendingPrint) flushPendingPrint();
                appendPendingPrint(part);
                if (margins & 0x0f) flushPendingPrint();

                buffer_start = ptr;
                break;
            }

            case COMMAND_TRANSFER: {
                flushPendingPrint();
                len = resData[idx++] | (resData[idx++] << 8);
                const current_image_start = ptr;
                ptr = decode(false, resData, data_size, len, idx, processed_data, ptr);
                idx += len;

                const tiles = processed_data.slice(current_image_start, ptr);
                const record = addPhoto(decodeTilePixels(tiles, CAMERA_WIDTH));
                buffer_start = ptr;
                // "Transfer REC" starts with a frame that looks like a plain Transfer
                rememberTransferPhoto(record, tiles);
                break;
            }

            case COMMAND_TRANSFER_LIVE: {
                len = resData[idx++] | (resData[idx++] << 8);
                if (idx + len <= data_size) addLiveFrame(resData.slice(idx, idx + len));
                idx += len;
                break;
            }

            case COMMAND_DATA: {
                const compression = resData[idx++];
                len = resData[idx++] | (resData[idx++] << 8);
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

    return true;
}

// ---- Photos ----
// Every photo is kept as one shade per pixel (0 lightest .. 3 darkest), exactly
// what the Game Boy printed, and only painted in colour for the screen or a saved
// file. That is what lets the palette, the frame and the rotation change after
// the fact, and it is what IndexedDB stores so the gallery survives a reload.

let photos = []; // { id, created, width, height, pixels, favorite, rotation, flip }
let photoSeq = 0;

function newPhotoId() {
    return Date.now() * 100 + (photoSeq++ % 100);
}

function addPhoto(image) {
    if (!image || !image.width || !image.height) return null;
    const record = {
        id: newPhotoId(),
        created: Date.now(),
        width: image.width,
        height: image.height,
        pixels: image.pixels,
        favorite: false,
        rotation: 0,
        flip: false
    };
    insertPhoto(record);
    storePhoto(record);
    return record;
}

function insertPhoto(record) {
    photos.push(record);
    createPhotoTile(record);
    renderPhotoTile(record);
    arrangeGallery();
    updateButtonStates();
}

function removePhotos(records) {
    if (!records.length) return;
    const ids = new Set(records.map(r => r.id));
    photos = photos.filter(r => !ids.has(r.id));
    records.forEach(r => r.el && r.el.remove());
    deleteStoredPhotos(Array.from(ids));
    updateButtonStates();
    updateSelectionBar();
}

// Four shades fit in a byte; a 160x144 photo is 5.6 KB stored
function packShades(pixels) {
    const out = new Uint8Array(Math.ceil(pixels.length / 4));
    for (let i = 0; i < pixels.length; i++) out[i >> 2] |= (pixels[i] & 3) << ((i & 3) * 2);
    return out;
}

function unpackShades(packed, count) {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = (packed[i >> 2] >> ((i & 3) * 2)) & 3;
    return out;
}

// ---- Gallery storage (IndexedDB) ----
// Best effort: without IndexedDB (some private modes) the gallery simply lasts
// as long as the page, as it always used to.

const PHOTO_DB = "gbca-gallery";
const PHOTO_STORE = "photos";
let photoDbPromise = null;

function openPhotoDb() {
    if (!photoDbPromise) {
        photoDbPromise = new Promise((resolve) => {
            try {
                const request = indexedDB.open(PHOTO_DB, 1);
                request.onupgradeneeded = () => request.result.createObjectStore(PHOTO_STORE, { keyPath: "id" });
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(null);
                request.onblocked = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }
    return photoDbPromise;
}

function withPhotoStore(mode, work) {
    return openPhotoDb().then((db) => new Promise((resolve) => {
        if (!db) return resolve(null);
        try {
            const tx = db.transaction(PHOTO_STORE, mode);
            const request = work(tx.objectStore(PHOTO_STORE));
            tx.oncomplete = () => resolve(request ? request.result : null);
            tx.onerror = tx.onabort = () => {
                console.error("Gallery storage failed:", tx.error);
                resolve(null);
            };
        } catch (e) {
            console.error("Gallery storage failed:", e);
            resolve(null);
        }
    }));
}

function storePhoto(record) {
    return withPhotoStore("readwrite", store => store.put({
        id: record.id,
        created: record.created,
        width: record.width,
        height: record.height,
        shades: packShades(record.pixels),
        favorite: record.favorite,
        rotation: record.rotation,
        flip: record.flip
    }));
}

function deleteStoredPhotos(ids) {
    return withPhotoStore("readwrite", store => {
        ids.forEach(id => store.delete(id));
        return null;
    });
}

async function restoreGallery() {
    const stored = await withPhotoStore("readonly", store => store.getAll());
    if (!stored || !stored.length) return;
    const known = new Set(photos.map(r => r.id));
    stored.forEach((s) => {
        if (known.has(s.id) || !s.shades) return;
        const record = {
            id: s.id,
            created: s.created,
            width: s.width,
            height: s.height,
            pixels: unpackShades(s.shades, s.width * s.height),
            favorite: !!s.favorite,
            rotation: s.rotation || 0,
            flip: !!s.flip
        };
        photos.push(record);
        createPhotoTile(record);
        renderPhotoTile(record);
    });
    arrangeGallery();
    updateButtonStates();
}

// ---- Image helpers (shade arrays) ----

function stackImages(images) {
    const width = images[0].width;
    const height = images.reduce((total, image) => total + image.height, 0);
    const pixels = new Uint8Array(width * height);
    let offset = 0;
    images.forEach((image) => {
        pixels.set(image.pixels.subarray(0, image.width * image.height), offset);
        offset += image.width * image.height;
    });
    return { width, height, pixels };
}

function cropShades(image, x0, y0, w, h) {
    const pixels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const from = (y0 + y) * image.width + x0;
        pixels.set(image.pixels.subarray(from, from + w), y * w);
    }
    return { width: w, height: h, pixels };
}

function flipShades(image) {
    const { width, height } = image;
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) pixels[y * width + x] = image.pixels[y * width + width - 1 - x];
    }
    return { width, height, pixels };
}

// A quarter turn clockwise
function rotateShades(image) {
    const { width, height } = image;
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) pixels[x * height + (height - 1 - y)] = image.pixels[y * width + x];
    }
    return { width: height, height: width, pixels };
}

// Centre every image on a canvas as big as the largest, lightest shade around
function padImages(images) {
    const width = Math.max(...images.map(i => i.width));
    const height = Math.max(...images.map(i => i.height));
    return images.map((image) => {
        if (image.width === width && image.height === height) return image;
        const pixels = new Uint8Array(width * height);
        const ox = Math.floor((width - image.width) / 2);
        const oy = Math.floor((height - image.height) / 2);
        for (let y = 0; y < image.height; y++) {
            pixels.set(image.pixels.subarray(y * image.width, (y + 1) * image.width), (oy + y) * width + ox);
        }
        return { width, height, pixels };
    });
}

// ---- Frames ----
// A Game Boy Camera print is 160x144: the 128x112 picture inside a 16 pixel frame.

const CAMERA_FRAME = { width: 160, height: 144, x: 16, y: 16, w: 128, h: 112 };
const FRAME_MODES = ["keep", "remove", "custom"];
const FRAME_MODE_KEY = "photoFrame";
const CUSTOM_FRAME_KEY = "customFrame";
let customFrame = null; // shades of a 160x144 frame
let frameVersion = 0;   // bumped when the frame setting changes, for the caches

function getFrameMode() {
    const select = document.getElementById("photoFrame");
    const raw = select ? select.value : readStored(FRAME_MODE_KEY);
    return FRAME_MODES.includes(raw) ? raw : "keep";
}

function applyFrame(image) {
    const mode = getFrameMode();
    const F = CAMERA_FRAME;
    const framed = image.width === F.width && image.height === F.height;
    const bare = image.width === F.w && image.height === F.h;
    if (mode === "remove" && framed) return cropShades(image, F.x, F.y, F.w, F.h);
    if (mode === "custom" && customFrame && (framed || bare)) {
        const pixels = customFrame.slice();
        const ox = framed ? F.x : 0, oy = framed ? F.y : 0;
        for (let y = 0; y < F.h; y++) {
            const from = (oy + y) * image.width + ox;
            pixels.set(image.pixels.subarray(from, from + F.w), (F.y + y) * F.width + F.x);
        }
        return { width: F.width, height: F.height, pixels };
    }
    return image;
}

function bytesToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function loadStoredFrame() {
    const stored = readStored(CUSTOM_FRAME_KEY);
    if (!stored) return;
    try {
        customFrame = unpackShades(base64ToBytes(stored), CAMERA_FRAME.width * CAMERA_FRAME.height);
    } catch (e) {
        customFrame = null;
    }
}

// Any picture becomes a 160x144 frame in Game Boy shades; only its border is used
async function loadCustomFrame(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    let source;
    try {
        source = await loadImageFile(file);
    } catch (e) {
        showMessage("COULD NOT OPEN THE IMAGE");
        return;
    }
    const F = CAMERA_FRAME;
    const canvas = document.createElement("canvas");
    canvas.width = F.width;
    canvas.height = F.height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(source, 0, 0, F.width, F.height);
    const data = ctx.getImageData(0, 0, F.width, F.height).data;
    const levels = detectGameBoyLevels(data);
    const pixels = new Uint8Array(F.width * F.height);
    for (let p = 0; p < pixels.length; p++) {
        const i = p * 4;
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (levels) {
            let nearest = 0;
            for (let n = 1; n < 4; n++) if (Math.abs(gray - levels[n]) < Math.abs(gray - levels[nearest])) nearest = n;
            pixels[p] = nearest;
        } else {
            pixels[p] = nearestShade(gray);
        }
    }
    customFrame = pixels;
    writeStored(CUSTOM_FRAME_KEY, bytesToBase64(packShades(pixels)));
    const select = document.getElementById("photoFrame");
    if (select) select.value = "custom";
    writeStored(FRAME_MODE_KEY, "custom");
    onFrameChanged();
}

function onFrameChanged() {
    frameVersion++;
    const mode = getFrameMode();
    const button = document.getElementById("frame-file-btn");
    if (button) button.classList.toggle("hidden", mode !== "custom");
    const note = document.getElementById("frame-note");
    if (note) {
        note.textContent = mode === "custom"
            ? "Pick a 160 x 144 picture. Its outer 16 pixels become the frame."
            : mode === "remove"
                ? "Camera photos are cropped to the 128 x 112 picture."
                : "Applies to Game Boy Camera photos.";
    }
    renderAllTiles();
}

function setupFrameSelector() {
    loadStoredFrame();
    const select = document.getElementById("photoFrame");
    if (!select) return;
    const stored = readStored(FRAME_MODE_KEY);
    select.value = FRAME_MODES.includes(stored) ? stored : "keep";
    safeAddEventListener(select, "change", () => {
        writeStored(FRAME_MODE_KEY, select.value);
        onFrameChanged();
    });
    onFrameChanged();
}

// The photo as it is shown and saved: frame, then flip, then rotation
function photoPixels(record) {
    const key = `${frameVersion}|${record.rotation}|${record.flip}`;
    if (record.composed && record.composedKey === key) return record.composed;
    let image = applyFrame({ width: record.width, height: record.height, pixels: record.pixels });
    if (record.flip) image = flipShades(image);
    for (let r = 0; r < record.rotation; r++) image = rotateShades(image);
    record.composed = image;
    record.composedKey = key;
    return image;
}

// ---- Palettes ----

const BUILTIN_PALETTES = [
    { id: "grayscale", colors: [[255, 255, 255], [191, 191, 191], [127, 127, 127], [63, 63, 63]] },
    { id: "game-boy", colors: [[208, 217, 60], [120, 164, 106], [84, 88, 84], [36, 70, 36]] },
    { id: "super-game-boy", colors: [[255, 255, 255], [181, 179, 189], [84, 83, 103], [9, 7, 19]] },
    { id: "game-boy-color-jpn", colors: [[240, 240, 240], [218, 196, 106], [112, 88, 52], [30, 30, 30]] },
    { id: "game-boy-color-usa-gold", colors: [[240, 240, 240], [220, 160, 160], [136, 78, 78], [30, 30, 30]] },
    { id: "game-boy-color-usa-eur", colors: [[240, 240, 240], [134, 200, 100], [58, 96, 132], [30, 30, 30]] }
];
const GRAYSCALE = BUILTIN_PALETTES[0].colors;
const PALETTE_KEY = "selectedColorScheme";
// Palettes made before they moved to the adapter; uploaded once there is room
const CUSTOM_PALETTES_KEY = "customPalettes";
const PALETTE_TIMEOUT_MS = 5000;

// Custom palettes live on the adapter, one per slot: { id: "custom-<slot>", slot, colors }
let customPalettes = [];
let paletteSlots = 3;
let activePaletteId = "grayscale";

// Takes the adapter's reply ({"result","slots","palettes":[code|null,...]}); false if it was not one
function applyAdapterPalettes(data) {
    if (!data || !Array.isArray(data.palettes)) return false;
    paletteSlots = data.slots || data.palettes.length;
    customPalettes = [];
    data.palettes.forEach((code, slot) => {
        const colors = parsePaletteCode(code);
        if (colors) customPalettes.push({ id: `custom-${slot}`, slot, colors });
    });
    return true;
}

async function paletteRequest(url) {
    try {
        const response = await fetchWithTimeout(url, PALETTE_TIMEOUT_MS);
        const data = response.ok ? await response.json() : null;
        return applyAdapterPalettes(data) ? data : null;
    } catch (e) {
        console.error("Palette request failed:", e);
        return null;
    }
}

function freePaletteSlot() {
    for (let slot = 0; slot < paletteSlots; slot++) {
        if (!customPalettes.some(p => p.slot === slot)) return slot;
    }
    return -1;
}

// Move palettes still kept in this browser onto the adapter, as many as fit.
// Ones that do not fit stay here and go up once a slot frees.
async function migrateLocalPalettes() {
    let legacy;
    try {
        legacy = JSON.parse(readStored(CUSTOM_PALETTES_KEY) || "[]");
    } catch (e) {
        legacy = [];
    }
    if (!Array.isArray(legacy) || !legacy.length) return;

    const selectedId = readStored(PALETTE_KEY);
    const left = [];
    for (const palette of legacy) {
        if (!palette || !Array.isArray(palette.colors) || palette.colors.length !== 4) continue;
        const code = paletteCode(palette.colors);
        let match = customPalettes.find(p => paletteCode(p.colors) === code);
        const slot = freePaletteSlot();
        if (!match && slot >= 0) {
            const data = await paletteRequest(`/set_palette?slot=${slot}&colors=${code}`);
            if (data && data.result === "ok") match = customPalettes.find(p => p.slot === slot);
        }
        if (!match) {
            left.push(palette);
        } else if (palette.id === selectedId) {
            activePaletteId = match.id;
            writeStored(PALETTE_KEY, match.id);
        }
    }
    writeStored(CUSTOM_PALETTES_KEY, JSON.stringify(left));
}

async function loadCustomPalettes() {
    if (!(await paletteRequest("/palettes.json"))) return; // adapter unreachable: built-in palettes only
    await migrateLocalPalettes();
    if (!findPalette(activePaletteId)) activePaletteId = "grayscale";
    renderPaletteSelector();
    renderAllTiles();
    redrawLiveView();
}

function findPalette(id) {
    return BUILTIN_PALETTES.concat(customPalettes).find(p => p.id === id) || null;
}

// The four colours of the selected palette, lightest first (shade order)
function activeSchemeColors() {
    return (findPalette(activePaletteId) || BUILTIN_PALETTES[0]).colors;
}

function rgbToHex(r, g, b) {
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function hexToRgb(hex) {
    const value = parseInt(hex.replace("#", ""), 16);
    return [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
}

function paletteGradient(colors) {
    const hex = colors.map(c => rgbToHex(c[0], c[1], c[2]));
    return `linear-gradient(to right, ${hex[0]} 25%, ${hex[1]} 25% 50%, ${hex[2]} 50% 75%, ${hex[3]} 75%)`;
}

// "e0f8d0-88c070-346856-081820": four colours, lightest first, easy to share
function paletteCode(colors) {
    return colors.map(c => rgbToHex(c[0], c[1], c[2]).slice(1)).join("-");
}

function parsePaletteCode(text) {
    const found = (text || "").match(/[0-9a-f]{6}/gi);
    return (found && found.length === 4) ? found.map(hexToRgb) : null;
}

function renderPaletteSelector() {
    const container = document.getElementById("color-selector");
    if (!container) return;
    container.innerHTML = "";
    BUILTIN_PALETTES.concat(customPalettes).forEach((palette) => {
        const circle = document.createElement("button");
        circle.type = "button";
        circle.className = "color-circle" + (palette.id === activePaletteId ? " active" : "");
        circle.style.background = paletteGradient(palette.colors);
        circle.dataset.scheme = palette.id;
        circle.setAttribute("aria-label", palette.id.startsWith("custom") ? "Custom palette" : palette.id.replace(/-/g, " ") + " palette");
        circle.addEventListener("click", () => selectPalette(palette.id));
        container.appendChild(circle);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "color-circle color-circle--add";
    add.textContent = "+";
    add.setAttribute("aria-label", "New palette");
    add.addEventListener("click", () => {
        if (freePaletteSlot() < 0) {
            alert(`The adapter keeps up to ${paletteSlots} custom palettes. Edit or delete one to make room.`);
            return;
        }
        openPaletteEditor(null);
    });
    container.appendChild(add);

    const edit = document.getElementById("palette-edit-btn");
    if (edit) edit.classList.toggle("hidden", !activePaletteId.startsWith("custom") || !findPalette(activePaletteId));
}

function selectPalette(id) {
    if (!findPalette(id)) id = "grayscale";
    activePaletteId = id;
    writeStored(PALETTE_KEY, id);
    renderPaletteSelector();
    renderAllTiles();
    redrawLiveView();
}

let editingPaletteId = null;

function paletteEditorInputs() {
    return Array.from(document.querySelectorAll("#palette-popup .palette-color"));
}

function paletteEditorColors() {
    return paletteEditorInputs().map(input => hexToRgb(input.value));
}

function openPaletteEditor(id) {
    editingPaletteId = id;
    const palette = id ? findPalette(id) : null;
    const colors = palette ? palette.colors : activeSchemeColors();
    paletteEditorInputs().forEach((input, i) => { input.value = rgbToHex(colors[i][0], colors[i][1], colors[i][2]); });
    const title = document.getElementById("palette-popup-title");
    if (title) title.textContent = id ? "Edit Palette" : "New Palette";
    const del = document.getElementById("palette-delete-btn");
    if (del) del.classList.toggle("hidden", !id);
    updatePaletteEditor();
    const popup = document.getElementById("palette-popup");
    if (popup) popup.classList.remove("hidden");
}

function editActivePalette() {
    if (activePaletteId.startsWith("custom")) openPaletteEditor(activePaletteId);
}

function closePaletteEditor() {
    const popup = document.getElementById("palette-popup");
    if (popup) popup.classList.add("hidden");
}

// Shows the palette on the first photo in the gallery, or on four bars
function updatePaletteEditor() {
    const colors = paletteEditorColors();
    const code = document.getElementById("palette-code");
    if (code && document.activeElement !== code) code.value = paletteCode(colors);
    const preview = document.getElementById("palette-preview");
    if (!preview) return;
    const first = displayedPhotos()[0];
    let image;
    if (first) {
        image = photoPixels(first);
    } else {
        const pixels = new Uint8Array(160 * 36);
        for (let p = 0; p < pixels.length; p++) pixels[p] = Math.floor((p % 160) / 40);
        image = { width: 160, height: 36, pixels };
    }
    paintPixels(preview, image, colors);
}

function onPaletteCodeInput(input) {
    const colors = parsePaletteCode(input.value);
    if (!colors) return;
    paletteEditorInputs().forEach((el, i) => { el.value = rgbToHex(colors[i][0], colors[i][1], colors[i][2]); });
    updatePaletteEditor();
}

function copyPaletteCode() {
    const code = document.getElementById("palette-code");
    if (!code) return;
    // The clipboard API needs https; the page is plain http, so select and copy
    code.focus();
    code.select();
    let copied = false;
    try {
        copied = document.execCommand("copy");
    } catch (e) { /* not supported */ }
    const button = document.getElementById("palette-copy-btn");
    if (button) {
        button.textContent = copied ? "Copied" : "Select + copy";
        setTimeout(() => { button.textContent = "Copy"; }, 1500);
    }
}

async function savePaletteFromEditor() {
    const existing = editingPaletteId ? customPalettes.find(p => p.id === editingPaletteId) : null;
    const slot = existing ? existing.slot : freePaletteSlot();
    if (slot < 0) {
        alert(`The adapter keeps up to ${paletteSlots} custom palettes. Edit or delete one to make room.`);
        return;
    }
    const data = await paletteRequest(`/set_palette?slot=${slot}&colors=${paletteCode(paletteEditorColors())}`);
    if (!data || data.result !== "ok") {
        alert("Could not save the palette on the adapter. Reconnect it and try again.");
        return;
    }
    closePaletteEditor();
    selectPalette(`custom-${slot}`);
}

async function deletePaletteFromEditor() {
    const existing = editingPaletteId ? customPalettes.find(p => p.id === editingPaletteId) : null;
    if (!existing || !confirm("Delete this palette?")) return;
    const data = await paletteRequest(`/delete_palette?slot=${existing.slot}`);
    if (!data || data.result !== "ok") {
        alert("Could not delete the palette on the adapter. Reconnect it and try again.");
        return;
    }
    closePaletteEditor();
    selectPalette(activePaletteId === existing.id ? "grayscale" : activePaletteId);
}

function setupPalettes() {
    // A custom palette may be selected: keep it while the adapter's list loads
    activePaletteId = readStored(PALETTE_KEY) || "grayscale";
    renderPaletteSelector();
    paletteEditorInputs().forEach(input => input.addEventListener("input", updatePaletteEditor));
    loadCustomPalettes();
}

// ---- Gallery tiles ----

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17.4l-6.1 3.5 1.5-6.8L2.2 9.5l6.9-.7z"/></svg>';
const tileCanvas = document.createElement("canvas");

function createPhotoTile(record) {
    const div = document.createElement("div");
    div.className = "gallery-image";
    div.photo = record;
    record.el = div;

    const img = new Image();
    img.alt = "Game Boy photo";
    img.draggable = false;

    const fav = document.createElement("button");
    fav.type = "button";
    fav.className = "photo-fav";
    fav.innerHTML = STAR_SVG;
    fav.setAttribute("aria-label", "Favorite");
    fav.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePhotoFavorite(record);
    });

    const save = document.createElement("button");
    save.type = "button";
    save.className = "photo-save";
    save.textContent = "SAVE";
    save.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent opening popup when clicking SAVE
        downloadImage(record);
    });

    div.addEventListener("click", () => {
        if (selectMode) togglePhotoSelected(record);
        else showPopupWithUpscaledImage(record);
    });

    div.appendChild(img);
    div.appendChild(fav);
    div.appendChild(save);
}

function renderPhotoTile(record, colors = activeSchemeColors()) {
    if (!record.el) return;
    paintPixels(tileCanvas, photoPixels(record), colors);
    record.el.querySelector("img").src = tileCanvas.toDataURL();
    record.el.classList.toggle("favorite", !!record.favorite);
    record.el.classList.toggle("selected", !!record.selected);
}

function renderAllTiles() {
    const colors = activeSchemeColors();
    photos.forEach(record => renderPhotoTile(record, colors));
}

const GALLERY_SORTS = ["oldest", "newest", "favorites"];
const GALLERY_SORT_KEY = "gallerySort";

function getGallerySort() {
    const select = document.getElementById("gallery-sort");
    const raw = select ? select.value : readStored(GALLERY_SORT_KEY);
    return GALLERY_SORTS.includes(raw) ? raw : "oldest";
}

function sortedPhotos() {
    const mode = getGallerySort();
    const list = photos.slice().sort((a, b) => mode === "newest" ? (b.created - a.created || b.id - a.id) : (a.created - b.created || a.id - b.id));
    // Array.sort is stable, so favourites keep their age order
    if (mode === "favorites") list.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));
    return list;
}

function arrangeGallery() {
    if (!gallery) return;
    sortedPhotos().forEach((record, i) => {
        if (gallery.children[i] !== record.el) gallery.insertBefore(record.el, gallery.children[i] || null);
    });
}

// In the order they are on screen
function displayedPhotos() {
    return gallery ? Array.from(gallery.children).map(el => el.photo).filter(Boolean) : [];
}

function setupGallerySort() {
    const select = document.getElementById("gallery-sort");
    if (!select) return;
    const stored = readStored(GALLERY_SORT_KEY);
    select.value = GALLERY_SORTS.includes(stored) ? stored : "oldest";
    safeAddEventListener(select, "change", () => {
        writeStored(GALLERY_SORT_KEY, select.value);
        arrangeGallery();
    });
}

function togglePhotoFavorite(record) {
    record.favorite = !record.favorite;
    renderPhotoTile(record);
    storePhoto(record);
    arrangeGallery();
}

// ---- Selection ----

let selectMode = false;

function setSelectMode(on) {
    selectMode = !!on;
    if (!selectMode) {
        photos.forEach((record) => {
            if (record.selected) {
                record.selected = false;
                if (record.el) record.el.classList.remove("selected");
            }
        });
    }
    if (gallery) gallery.classList.toggle("selecting", selectMode);
    updateSelectionBar();
}

function togglePhotoSelected(record) {
    record.selected = !record.selected;
    record.el.classList.toggle("selected", record.selected);
    updateSelectionBar();
}

function selectAllPhotos() {
    const all = photos.length > 0 && photos.every(r => r.selected);
    photos.forEach((record) => {
        record.selected = !all;
        record.el.classList.toggle("selected", record.selected);
    });
    updateSelectionBar();
}

function selectedPhotos() {
    return displayedPhotos().filter(r => r.selected);
}

function updateSelectionBar() {
    const main = document.getElementById("toolbar-main");
    const bar = document.getElementById("toolbar-select");
    if (main) main.classList.toggle("hidden", selectMode);
    const toolbar = document.getElementById("gallery-toolbar");
    if (toolbar) toolbar.classList.toggle("selecting", selectMode);
    if (bar) bar.classList.toggle("hidden", !selectMode);
    if (!bar) return;
    const count = photos.filter(r => r.selected).length;
    const label = document.getElementById("selection-count");
    if (label) label.textContent = `${count} selected`;
    bar.querySelectorAll("[data-needs]").forEach((button) => {
        button.disabled = count < parseInt(button.dataset.needs);
    });
    const all = document.getElementById("select-all-btn");
    if (all) all.textContent = (count > 0 && count === photos.length) ? "None" : "All";
}

function saveSelectedPhotos() {
    savePhotos(selectedPhotos());
}

function deleteSelectedPhotos() {
    const selected = selectedPhotos();
    if (!selected.length) return;
    if (!confirm(selected.length === 1 ? "Delete this photo?" : `Delete ${selected.length} photos?`)) return;
    removePhotos(selected);
    if (!photos.length) setSelectMode(false);
}

function joinSelectedPhotos() {
    const images = selectedPhotos().map(photoPixels);
    if (images.length < 2) return;
    if (images.some(image => image.width !== images[0].width)) {
        showMessage("PHOTOS MUST BE THE SAME WIDTH TO JOIN<br><br><small>Rotate them the same way first</small>");
        return;
    }
    addPhoto(stackImages(images));
    setSelectMode(false);
}

function printSelectedPhotos() {
    const images = selectedPhotos().map(photoPixels);
    if (!images.length) return;
    sendPhotosToPrinter(images);
    setSelectMode(false);
    setMode("printer");
}

function contactSheetSelected() {
    saveContactSheet(selectedPhotos());
}

function animateSelectedPhotos() {
    const records = selectedPhotos();
    if (records.length < 2) return;
    openAnimatePopup((format, delay) => {
        const images = padImages(records.map(photoPixels));
        const getFrame = (i) => ({ image: images[i], delay: delay });
        if (format === "video") saveAnimationVideo(images.length, getFrame, "animation");
        else saveAnimationGif(images.length, getFrame, "animation");
    }, true);
}

// ---- Photo viewer ----

function showPopupWithUpscaledImage(record) {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.id = "image-popup-overlay";
    overlay.classList.add("popup-overlay");

    const popup = document.createElement("div");
    popup.classList.add("image-container", "viewer");

    // Show the upscaled photo as a real <img>, not a <canvas>: iOS only offers its
    // native long-press "Add to Photos" menu on images, and long-pressing a canvas
    // just selects the surrounding text instead. Same format, scale and metadata
    // the SAVE button produces, so both routes give an identical file.
    const upscaled = document.createElement("img");
    upscaled.classList.add("popup-image");
    upscaled.alt = "Game Boy Camera photo";

    // The photo on screen; the arrows, arrow keys and swipes move it through the gallery
    let current = record;
    let showOriginal = false;

    // A blob: URL rather than the data: URL itself. iOS (Safari and Chrome alike)
    // offered the long-press "Save to Photos" menu only once per page load while
    // the photo was a data: URL of the whole upscaled file; a blob: URL is the
    // same bytes without the half-megabyte string.
    let objectUrl = null;
    const setPhotoSrc = (dataUrl) => {
        const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
        upscaled.src = url;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = url;
    };

    const prevButton = document.createElement("button");
    prevButton.textContent = "<";
    prevButton.classList.add("popup-nav-button", "popup-nav-button--prev");
    prevButton.setAttribute("aria-label", "Previous photo");

    const nextButton = document.createElement("button");
    nextButton.textContent = ">";
    nextButton.classList.add("popup-nav-button", "popup-nav-button--next");
    nextButton.setAttribute("aria-label", "Next photo");

    const toolbar = document.createElement("div");
    toolbar.className = "viewer-toolbar";
    const tool = (text, label, onClick) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "viewer-btn";
        b.textContent = text;
        b.setAttribute("aria-label", label);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            onClick();
        });
        toolbar.appendChild(b);
        return b;
    };

    const showImage = (target) => {
        current = target;
        try {
            setPhotoSrc(renderPhotoDataUrl(target, showOriginal ? GRAYSCALE : activeSchemeColors()));
        } catch (e) {
            console.error("Upscale failed:", e);
            upscaled.src = target.el ? target.el.querySelector("img").src : "";
        }
        const list = displayedPhotos();
        const index = list.indexOf(target);
        prevButton.classList.toggle("hidden", index <= 0);
        nextButton.classList.toggle("hidden", index < 0 || index >= list.length - 1);
        favButton.classList.toggle("active", !!target.favorite);
    };

    const step = (delta) => {
        const list = displayedPhotos();
        const index = list.indexOf(current);
        if (index >= 0 && list[index + delta]) showImage(list[index + delta]);
    };

    prevButton.onclick = (e) => { e.stopPropagation(); step(-1); };
    nextButton.onclick = (e) => { e.stopPropagation(); step(1); };

    const edited = () => {
        renderPhotoTile(current);
        storePhoto(current);
        showImage(current);
    };

    tool("ROTATE", "Rotate a quarter turn", () => {
        current.rotation = (current.rotation + 1) % 4;
        edited();
    });
    tool("FLIP", "Mirror left to right", () => {
        // The flip is stored before the rotation; mirroring what is on screen
        // reverses the turn as well
        current.rotation = (4 - current.rotation) % 4;
        current.flip = !current.flip;
        edited();
    });
    const favButton = tool("FAVORITE", "Favorite", () => {
        togglePhotoFavorite(current);
        favButton.classList.toggle("active", !!current.favorite);
    });
    const originalButton = tool("ORIGINAL", "Compare with the original greys", () => {
        showOriginal = !showOriginal;
        originalButton.classList.toggle("active", showOriginal);
        showImage(current);
    });
    tool("DELETE", "Delete photo", () => {
        if (!confirm("Delete this photo?")) return;
        const list = displayedPhotos();
        const index = list.indexOf(current);
        const next = list[index + 1] || list[index - 1];
        removePhotos([current]);
        if (next) showImage(next);
        else closePopup();
    });
    tool("SAVE", "Save photo", () => downloadImage(current));

    showImage(record);
    popup.appendChild(upscaled);

    // Point iOS users at the long-press route, which lands straight in Photos
    if (isAppleMobile()) {
        const hint = document.createElement("p");
        hint.classList.add("popup-save-hint");
        hint.textContent = "Touch and hold the photo to add it to Photos";
        popup.appendChild(hint);
    }
    popup.appendChild(toolbar);

    // Create close button
    const closeButton = document.createElement("button");
    closeButton.textContent = "X";
    closeButton.classList.add("popup-close-button");

    const onKey = (e) => {
        if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "ArrowRight") step(1);
        else if (e.key === "Escape") closePopup();
    };

    const closePopup = () => {
        document.removeEventListener("keydown", onKey);
        overlay.remove();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
    };

    closeButton.onclick = closePopup;
    popup.appendChild(closeButton);

    // Horizontal swipe on touch screens; mostly-vertical drags are left to scrolling
    let touchStart = null;
    overlay.addEventListener("touchstart", (e) => {
        touchStart = (e.touches.length === 1) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    overlay.addEventListener("touchend", (e) => {
        if (!touchStart) return;
        const dx = e.changedTouches[0].clientX - touchStart.x;
        const dy = e.changedTouches[0].clientY - touchStart.y;
        touchStart = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });

    document.addEventListener("keydown", onKey);
    overlay.appendChild(popup);
    overlay.appendChild(prevButton);
    overlay.appendChild(nextButton);
    document.body.appendChild(overlay);
}

function updateButtonStates() {
    const count = photos.length;
    const colors = document.querySelector('.color-selector-container');
    const toolbar = document.getElementById('gallery-toolbar');
    const saveAll = document.getElementById('save_all_btn');
    const description = document.getElementById('description');

    // The live view needs the palette picker too, and stands in for the empty-gallery hint
    const showTools = count > 0 || liveViewOpen();
    if (description) description.classList.toggle('hidden', showTools);
    if (colors) colors.classList.toggle('hidden', !showTools);
    if (toolbar) toolbar.classList.toggle('hidden', count === 0);
    // One file per photo was hopeless on iOS (a save prompt each); it is a single ZIP now
    if (saveAll) saveAll.classList.toggle('hidden', count < 2);
    if (count === 0 && selectMode) setSelectMode(false);
}

function makeFileName(suffix, ext = PHOTO_FORMATS[getPhotoFormat()].extension, prefix = "image") {
    const datetime = new Date();
    const date = datetime.toISOString().split('T')[0];
    const time = datetime.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `${prefix}_${date}_${time}${suffix ? "_" + suffix : ""}.${ext}`;
}

// Nearest-neighbour upscale applied when a photo is saved (and to the popup
// preview, so what you see is what you get). 10x keeps the long-standing default.
const PHOTO_SCALES = [1, 2, 5, 10];
const DEFAULT_PHOTO_SCALE = 10;
const PHOTO_SCALE_KEY = "photoScale";

function getPhotoScale() {
    // A select that has not been rendered yet, or storage blocked in private
    // mode, must not break saving -- fall back to the default.
    const select = document.getElementById("photoScale");
    const raw = select ? select.value : readStored(PHOTO_SCALE_KEY);
    const scale = parseInt(raw, 10);
    return PHOTO_SCALES.includes(scale) ? scale : DEFAULT_PHOTO_SCALE;
}

function setupPhotoScaleSelector() {
    const select = document.getElementById("photoScale");
    if (!select) return;
    const scale = parseInt(readStored(PHOTO_SCALE_KEY), 10);
    select.value = String(PHOTO_SCALES.includes(scale) ? scale : DEFAULT_PHOTO_SCALE);
    safeAddEventListener(select, "change", () => writeStored(PHOTO_SCALE_KEY, select.value));
}

// File format photos are saved in. Both carry the camera tags below; PNG is
// lossless, which for a 4-shade grayscale photo is usually the smaller file too.
const PHOTO_FORMATS = {
    jpeg: { mime: "image/jpeg", extension: "jpg" },
    png:  { mime: "image/png",  extension: "png" },
};
const DEFAULT_PHOTO_FORMAT = "jpeg";
const PHOTO_FORMAT_KEY = "photoFormat";

function getPhotoFormat() {
    // Same fallbacks as getPhotoScale(): an unrendered select or blocked storage
    // must not break saving.
    const select = document.getElementById("photoFormat");
    const raw = select ? select.value : readStored(PHOTO_FORMAT_KEY);
    return Object.prototype.hasOwnProperty.call(PHOTO_FORMATS, raw) ? raw : DEFAULT_PHOTO_FORMAT;
}

function setupPhotoFormatSelector() {
    const select = document.getElementById("photoFormat");
    if (!select) return;
    const stored = readStored(PHOTO_FORMAT_KEY);
    select.value = Object.prototype.hasOwnProperty.call(PHOTO_FORMATS, stored) ? stored : DEFAULT_PHOTO_FORMAT;
    safeAddEventListener(select, "change", () => writeStored(PHOTO_FORMAT_KEY, select.value));
}

// How "Save All" hands over several photos: one ZIP file, or a download each
const SAVE_ALL_MODES = ["zip", "files"];
const SAVE_ALL_MODE_KEY = "saveAllMode";

function getSaveAllMode() {
    // A download per photo means a save prompt per photo on iOS
    if (isAppleMobile()) return "zip";
    const select = document.getElementById("saveAllMode");
    const raw = select ? select.value : readStored(SAVE_ALL_MODE_KEY);
    return SAVE_ALL_MODES.includes(raw) ? raw : "zip";
}

function setupSaveAllModeSelector() {
    const select = document.getElementById("saveAllMode");
    const block = document.getElementById("save-all-mode-block");
    if (block && isAppleMobile()) block.classList.add("hidden");
    if (!select) return;
    const stored = readStored(SAVE_ALL_MODE_KEY);
    select.value = SAVE_ALL_MODES.includes(stored) ? stored : "zip";
    safeAddEventListener(select, "change", () => writeStored(SAVE_ALL_MODE_KEY, select.value));
}

// The camera tags stamped into every saved photo, whatever the format.
const PHOTO_METADATA = {
    make: "Nintendo",
    model: "Game Boy Camera",
    software: "GameBoy Camera Adapter",
};

// EXIF as piexif hands it over: the string "Exif\0\0" followed by a TIFF block.
// JPEG wants it whole, PNG wants only the TIFF part. Returns null when piexif is
// missing, which is not fatal -- the photo just goes out untagged.
function buildExifPayload() {
    if (typeof piexif === "undefined") return null;
    const zeroth = {};
    zeroth[piexif.ImageIFD.Make] = PHOTO_METADATA.make;
    zeroth[piexif.ImageIFD.Model] = PHOTO_METADATA.model;
    zeroth[piexif.ImageIFD.Software] = PHOTO_METADATA.software;
    return piexif.dump({"0th": zeroth});
}

// length + 4-char type + payload + CRC over type and payload.
function makePngChunk(type, data) {
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
}

function latin1Bytes(str) {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xFF;
    return bytes;
}

// tEXt is keyword, a NUL, then Latin-1 text.
function makePngTextChunk(keyword, text) {
    return makePngChunk("tEXt", latin1Bytes(keyword + "\0" + text));
}

// PNG has no EXIF segment of its own, so the camera tags go in twice: an eXIf
// chunk (PNG 1.5, what exiftool, Explorer and photo managers read) and plain tEXt
// for anything that only speaks PNG keywords. Both have to precede IDAT, so they
// are spliced in directly after IHDR, which is always the first chunk. A file that
// does not look like a PNG is handed back untouched rather than corrupted.
function insertPngMetadata(bytes) {
    const SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (bytes.length < 8 + 12) return bytes;
    for (let i = 0; i < SIGNATURE.length; i++) {
        if (bytes[i] !== SIGNATURE[i]) return bytes;
    }
    if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return bytes;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const insertAt = 8 + 12 + view.getUint32(8); // past IHDR's length, type, data and CRC
    if (insertAt > bytes.length) return bytes;

    const chunks = [];
    const exif = buildExifPayload();
    // Strip the "Exif\0\0" header: the eXIf chunk holds the bare TIFF block.
    if (exif) chunks.push(makePngChunk("eXIf", latin1Bytes(exif.slice(6))));
    chunks.push(makePngTextChunk("Make", PHOTO_METADATA.make));
    chunks.push(makePngTextChunk("Model", PHOTO_METADATA.model));
    chunks.push(makePngTextChunk("Software", PHOTO_METADATA.software));

    const added = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const out = new Uint8Array(bytes.length + added);
    out.set(bytes.subarray(0, insertAt), 0);
    let offset = insertAt;
    chunks.forEach((chunk) => {
        out.set(chunk, offset);
        offset += chunk.length;
    });
    out.set(bytes.subarray(insertAt), offset);
    return out;
}

const scaleSource = document.createElement("canvas");

// Shades painted in `colors`, nearest-neighbour upscaled
function scaledPhotoCanvas(image, colors, scale) {
    paintPixels(scaleSource, image, colors);
    const canvas = document.createElement("canvas");
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scaleSource, 0, 0, canvas.width, canvas.height);
    return canvas;
}

// A canvas as a tagged data URL in the chosen format
function encodePhotoCanvas(canvas) {
    const format = getPhotoFormat();
    const mime = PHOTO_FORMATS[format].mime;
    const dataUrl = canvas.toDataURL(mime, 1.0);

    // Tagging is a nicety; a failure here must still leave a saveable photo.
    try {
        if (format === "png") {
            return bytesToDataUrl(insertPngMetadata(dataUrlToBytes(dataUrl)), mime);
        }
        const exif = buildExifPayload();
        if (exif) return piexif.insert(exif, dataUrl);
    } catch (e) {
        console.error("Metadata error:", e);
    }

    return dataUrl;
}

// A photo as an upscaled, tagged data URL in the chosen format. Synchronous on
// purpose: it must not consume the user gesture, or iOS refuses to open the share
// sheet / start a download.
function renderPhotoDataUrl(record, colors = activeSchemeColors()) {
    return encodePhotoCanvas(scaledPhotoCanvas(photoPixels(record), colors, getPhotoScale()));
}

function dataUrlToBytes(dataUrl) {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToDataUrl(bytes, mime) {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

function dataUrlToBlob(dataUrl) {
    const header = dataUrl.slice(0, dataUrl.indexOf(','));
    const mime = (header.match(/:(.*?);/) || [null, "image/jpeg"])[1];
    return new Blob([dataUrlToBytes(dataUrl)], { type: mime });
}

function renderPhotoFile(record, suffix) {
    const name = makeFileName(suffix);
    const blob = dataUrlToBlob(renderPhotoDataUrl(record));
    return new File([blob], name, { type: blob.type });
}

// NOTE: the Web Share API is secure-context only, and the adapter serves the UI
// over plain http://192.168.7.1, so this is false on iOS in practice — there is no
// share sheet to reach and every save goes through downloadViaLink() below. It
// stays here in case the UI is ever served over HTTPS.
function canShareFiles(files) {
    return typeof navigator.canShare === "function" &&
           typeof navigator.share === "function" &&
           navigator.canShare({ files: files });
}

// iOS/iPadOS ignores the `download` attribute and blocks navigation to data: URLs,
// so an <a download> never worked there. The share sheet is the only route into
// Photos, and blob: URLs are the fallback for everything else.
function downloadViaLink(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 30000);
}

function saveFiles(files) {
    if (canShareFiles(files)) {
        return navigator.share({ files: files }).catch((err) => {
            if (err && (err.name === "AbortError" || err.name === "NotAllowedError")) return;
            console.error("Share failed, falling back to download:", err);
            files.forEach(downloadViaLink);
        });
    }
    files.forEach(downloadViaLink);
    return Promise.resolve();
}

function downloadImage(record) {
    return saveFiles([renderPhotoFile(record)]);
}

function saveAllPictures() {
    savePhotos(displayedPhotos());
}

async function savePhotos(records) {
    if (!records.length) return;
    if (records.length === 1) {
        downloadImage(records[0]);
        return;
    }

    // The share sheet (https only) takes them all at once and lands in Photos.
    // Render everything up front, still inside the click handler: iOS allows only
    // one share per user gesture.
    if (typeof navigator.canShare === "function") {
        const files = records.map((record, index) => renderPhotoFile(record, String(index + 1).padStart(2, '0')));
        if (canShareFiles(files)) {
            saveFiles(files);
            return;
        }
    }

    showGeneralPopup();
    if (getSaveAllMode() === "files") {
        records.forEach((record, index) => {
            setTimeout(() => {
                updateGeneralPopup(`SAVING PHOTO ${index + 1}/${records.length}`, index === records.length - 1);
                downloadViaLink(renderPhotoFile(record, String(index + 1).padStart(2, '0')));
            }, 500 * index);
        });
        return;
    }

    const entries = [];
    for (let i = 0; i < records.length; i++) {
        updateGeneralPopup(`PACKING PHOTO ${i + 1}/${records.length}`, false);
        await sleep(0); // let the popup paint
        entries.push({
            name: makeFileName(String(i + 1).padStart(2, '0')),
            data: dataUrlToBytes(renderPhotoDataUrl(records[i])),
            date: new Date(records[i].created)
        });
    }
    const zip = buildZip(entries);
    downloadViaLink(new File([zip], makeFileName(null, "zip", "photos"), { type: "application/zip" }));
    updateGeneralPopup(`SAVED ${records.length} PHOTOS<br><br><small>in one ZIP file</small>`, true);
}

// Every photo on one page, darkest shade between them like a film contact sheet
function saveContactSheet(records) {
    if (!records.length) return;
    const images = records.map(photoPixels);
    const GAP = 8;
    const cellW = Math.max(...images.map(i => i.width));
    const cellH = Math.max(...images.map(i => i.height));
    const cols = Math.ceil(Math.sqrt(images.length));
    const rows = Math.ceil(images.length / cols);
    const width = cols * cellW + (cols + 1) * GAP;
    const height = rows * cellH + (rows + 1) * GAP;
    const pixels = new Uint8Array(width * height).fill(3);
    images.forEach((image, i) => {
        const x0 = GAP + (i % cols) * (cellW + GAP) + Math.floor((cellW - image.width) / 2);
        const y0 = GAP + Math.floor(i / cols) * (cellH + GAP) + Math.floor((cellH - image.height) / 2);
        for (let y = 0; y < image.height; y++) {
            pixels.set(image.pixels.subarray(y * image.width, (y + 1) * image.width), (y0 + y) * width + x0);
        }
    });
    // Big enough to print, small enough for any phone to open
    const scale = Math.max(1, Math.min(getPhotoScale(), Math.floor(4096 / Math.max(width, height))));
    const dataUrl = encodePhotoCanvas(scaledPhotoCanvas({ width, height, pixels }, activeSchemeColors(), scale));
    const blob = dataUrlToBlob(dataUrl);
    saveFiles([new File([blob], makeFileName(null, PHOTO_FORMATS[getPhotoFormat()].extension, "contact_sheet"), { type: blob.type })]);
}

// auto fetch images
var fetch_skip = false;

// Receive loader overlay (like the mobile app): shown while the Game Boy
// is transferring a photo to the adapter, hidden once it lands in the gallery.
let receiveOverlayVisible = false;

function setReceiveOverlay(visible) {
    if (visible === receiveOverlayVisible) return;
    receiveOverlayVisible = visible;
    const overlay = document.getElementById("receive-overlay");
    if (overlay) overlay.classList.toggle("hidden", !visible);
}

async function is_receiving() {
    try {
        const res = await fetchWithTimeout('/status.json', 5000);
        if (!res.ok) return false;
        const data = await res.json();
        return data && data.status && data.status.receiving === 1;
    } catch (_) {
        return false;
    }
}

async function periodic_fetch() {
    if (typeof currentMode !== 'undefined' && currentMode === "printer") {
        setReceiveOverlay(false);
        return;
    }
    if (fetch_skip) return;
    fetch_skip = true;

    try {
        // Live frames come back to back: skip the status round trip, and keep the
        // loader off -- the live view itself shows what is arriving
        const live = liveStreaming();
        const receiving = live ? false : await is_receiving();
        if (receiving) setReceiveOverlay(true);

        const fetch_ok = await get_camera_image();

        // A long print whose next part never came is a photo of its own
        if (!fetch_ok && !receiving && pendingPrint && (Date.now() - pendingPrint.time) > PENDING_PRINT_MS) {
            flushPendingPrint();
        }

        // Hide the loader only after the finished photo has been fetched/rendered
        if (!receiving || liveStreaming()) setReceiveOverlay(false);

        // Drain queued photos back to back ("Print all", "Transfer all", live view),
        // and poll fast while a transfer is in progress so it shows up promptly
        const next_interval = fetch_ok ? 0 : (live ? 50 : (receiving ? 500 : 2000));
        setTimeout(periodic_fetch, next_interval);
    } catch (err) {
        console.error("Fetch error:", err);
        setReceiveOverlay(false);
        setTimeout(periodic_fetch, 2000);
    } finally {
        fetch_skip = false;
    }
}
setTimeout(periodic_fetch, 1000);

// Live view for gb-photo's "Transfer REC". Frames are kept as the raw 2bpp tile
// data the Game Boy sent (3.5 KB each) and only turned into pixels to draw the
// latest one and to export the recording as a GIF.
const LIVE_IDLE_MIN_MS = 1500;    // REC counts as stopped once a frame is this late at the least...
const LIVE_IDLE_MAX_MS = 12000;   // ...and at the most; DMG frames are ~4 s apart
const LIVE_IDLE_PACE = 2.5;       // ...judged as this many average frame intervals
const LIVE_FIRST_FRAME_MS = 8000; // a Transfer this recent was the first frame of the stream
const LIVE_MAX_FRAMES = 1200;     // rolling limit, ~4 MB of tile data
const LIVE_GIF_MAX_SCALE = 4;     // GIF frames are re-encoded per frame, so cap the size
const LIVE_DEFAULT_DELAY_MS = 100;

let liveFrames = [];              // { tiles: Uint8Array, time: ms }
let liveIndex = null;             // frame on screen, null = follow the newest one
let liveUnsaved = false;
let liveIdleTimer = null;
let lastTransferPhoto = null;     // { record, tiles, time } of the latest plain Transfer

function liveViewOpen() {
    const view = document.getElementById("live-view");
    return !!view && !view.classList.contains("hidden");
}

// REC sends no "stop" over the link cable: it has stopped once the next frame is
// clearly overdue. Overdue is judged from the recent pace, so a fast GBC stream
// reads as stopped within a couple of seconds while a slow DMG one is not cut
// off between frames.
function liveIdleTimeout() {
    const count = liveFrames.length;
    const recent = Math.min(count - 1, 5);
    if (recent < 1) return LIVE_IDLE_MAX_MS;
    const average = (liveFrames[count - 1].time - liveFrames[count - 1 - recent].time) / recent;
    return Math.min(LIVE_IDLE_MAX_MS, Math.max(LIVE_IDLE_MIN_MS, average * LIVE_IDLE_PACE));
}

function liveStreaming() {
    return liveFrames.length > 0 && (Date.now() - liveFrames[liveFrames.length - 1].time) < liveIdleTimeout();
}

function rememberTransferPhoto(record, tiles) {
    lastTransferPhoto = record ? { record: record, tiles: tiles, time: Date.now() } : null;
}

function addLiveFrame(tiles) {
    const now = Date.now();
    // A stream that starts after the last one stopped is a new recording
    if (liveFrames.length > 0 && !liveStreaming()) {
        liveFrames = [];
        liveIndex = null;
    }
    // The adapter can only tell a REC stream from a single Transfer once the second
    // frame arrives, so the first one landed in the gallery: move it over here.
    if (liveFrames.length === 0 && lastTransferPhoto && (now - lastTransferPhoto.time) < LIVE_FIRST_FRAME_MS) {
        removePhotos([lastTransferPhoto.record]);
        liveFrames.push({ tiles: lastTransferPhoto.tiles, time: lastTransferPhoto.time });
    }
    lastTransferPhoto = null;

    liveFrames.push({ tiles: tiles, time: now });
    if (liveFrames.length > LIVE_MAX_FRAMES) {
        const dropped = liveFrames.length - LIVE_MAX_FRAMES;
        liveFrames.splice(0, dropped);
        if (liveIndex !== null) liveIndex = Math.max(0, liveIndex - dropped);
    }
    liveUnsaved = true;

    const view = document.getElementById("live-view");
    if (view) view.classList.remove("hidden");
    updateButtonStates();
    redrawLiveView();
    updateLiveStatus();

    clearTimeout(liveIdleTimer);
    liveIdleTimer = setTimeout(updateLiveStatus, liveIdleTimeout());
}

// 2bpp tiles, tileWidth tiles per row, to one palette index (0 white .. 3 black) per pixel
function decodeTilePixels(tiles, tileWidth) {
    const width = tileWidth * TILE_WIDTH;
    const tileRows = Math.floor(tiles.length / (TILE_SIZE * tileWidth));
    const height = tileRows * TILE_HEIGHT;
    const pixels = new Uint8Array(width * height);
    for (let tile = 0; tile < tileRows * tileWidth; tile++) {
        const x0 = (tile % tileWidth) * TILE_WIDTH;
        const y0 = Math.floor(tile / tileWidth) * TILE_HEIGHT;
        for (let row = 0; row < TILE_HEIGHT; row++) {
            const lo = tiles[tile * TILE_SIZE + row * 2];
            const hi = tiles[tile * TILE_SIZE + row * 2 + 1];
            const base = (y0 + row) * width + x0;
            for (let bit = 0; bit < 8; bit++) {
                pixels[base + bit] = ((lo >> (7 - bit)) & 1) | (((hi >> (7 - bit)) & 1) << 1);
            }
        }
    }
    return { width: width, height: height, pixels: pixels };
}

function paintPixels(canvas, image, colors) {
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(image.width, image.height);
    const data = imageData.data;
    for (let i = 0; i < image.pixels.length; i++) {
        const color = colors[image.pixels[i]];
        data[i * 4] = color[0];
        data[i * 4 + 1] = color[1];
        data[i * 4 + 2] = color[2];
        data[i * 4 + 3] = 0xFF;
    }
    ctx.putImageData(imageData, 0, 0);
}

function redrawLiveView() {
    const liveCanvas = document.getElementById("live-canvas");
    if (!liveCanvas || liveFrames.length === 0) return;
    const frame = liveFrames[shownLiveIndex()];
    paintPixels(liveCanvas, decodeTilePixels(frame.tiles, CAMERA_WIDTH), activeSchemeColors());
    updateLiveNav();
}

function shownLiveIndex() {
    const last = liveFrames.length - 1;
    return (liveIndex === null) ? last : Math.min(liveIndex, last);
}

function updateLiveNav() {
    const count = liveFrames.length;
    const index = shownLiveIndex();
    const scrub = document.getElementById("live-scrub");
    if (scrub) {
        scrub.max = String(Math.max(0, count - 1));
        scrub.value = String(Math.max(0, index));
        scrub.disabled = count < 2;
    }
    const prev = document.getElementById("live-prev");
    if (prev) prev.disabled = index <= 0;
    const next = document.getElementById("live-next");
    if (next) next.disabled = index >= count - 1;
    const pos = document.getElementById("live-pos");
    if (pos) pos.textContent = count ? `FRAME ${index + 1} OF ${count}${(liveIndex === null && liveStreaming()) ? " - LIVE" : ""}` : "";
}

// Show frame `index`; the last frame means following the stream again
function seekLiveFrame(index) {
    if (liveFrames.length === 0) return;
    const last = liveFrames.length - 1;
    index = Math.max(0, Math.min(last, Number(index) || 0));
    liveIndex = (index === last) ? null : index;
    redrawLiveView();
}

function stepLiveFrame(delta) {
    seekLiveFrame(shownLiveIndex() + delta);
}

// Left / right arrow keys step through the recording while no dialog is open
document.addEventListener("keydown", (e) => {
    if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || !liveViewOpen() || liveFrames.length === 0) return;
    if (document.querySelector(".popup-overlay:not(.hidden)")) return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    e.preventDefault();
    stepLiveFrame(e.key === "ArrowLeft" ? -1 : 1);
});

function updateLiveStatus() {
    const streaming = liveStreaming();
    const badge = document.getElementById("live-badge");
    if (badge) {
        badge.textContent = streaming ? "REC" : "STOPPED";
        badge.classList.toggle("live-badge--idle", !streaming);
    }
    const info = document.getElementById("live-info");
    if (info) {
        const count = liveFrames.length;
        const seconds = (count > 1) ? (liveFrames[count - 1].time - liveFrames[0].time) / 1000 : 0;
        const fps = (seconds > 0) ? ((count - 1) / seconds).toFixed(1) : "0.0";
        info.textContent = `${count} FRAME${count === 1 ? "" : "S"} / ${fps} FPS`;
    }
    updateLiveNav();
}

// Copy the frame on screen into the gallery as an ordinary photo
function saveLiveFrame() {
    if (liveFrames.length === 0) return;
    addPhoto(decodeTilePixels(liveFrames[shownLiveIndex()].tiles, CAMERA_WIDTH));
    const button = document.getElementById("live-save-frame-btn");
    if (button) {
        button.textContent = "Saved";
        clearTimeout(saveLiveFrame.timer);
        saveLiveFrame.timer = setTimeout(() => { button.textContent = "Save Frame"; }, 1200);
    }
}

// The recording with its real timing; the last frame holds for as long as the one before it
function liveAnimation() {
    const frames = liveFrames.slice();
    return {
        count: frames.length,
        getFrame: (i) => {
            const delay = (i + 1 < frames.length) ? frames[i + 1].time - frames[i].time
                : (frames.length > 1 ? frames[i].time - frames[i - 1].time : LIVE_DEFAULT_DELAY_MS);
            return { image: decodeTilePixels(frames[i].tiles, CAMERA_WIDTH), delay: delay };
        }
    };
}

function saveLiveVideo() {
    if (liveFrames.length === 0) return;
    const live = liveAnimation();
    saveAnimationGif(live.count, live.getFrame, "video", () => { liveUnsaved = false; });
}

function saveLiveMovie() {
    if (liveFrames.length === 0) return;
    const live = liveAnimation();
    saveAnimationVideo(live.count, live.getFrame, "video", () => { liveUnsaved = false; });
}

function closeLiveView() {
    if (liveUnsaved && liveFrames.length > 1 && !confirm("Discard this recording?")) return;
    clearTimeout(liveIdleTimer);
    liveFrames = [];
    liveIndex = null;
    liveUnsaved = false;
    const view = document.getElementById("live-view");
    if (view) view.classList.add("hidden");
    updateButtonStates();
}

// Nearest-neighbour upscale of palette indices
function scalePixels(image, scale) {
    if (scale === 1) return image.pixels;
    const width = image.width * scale;
    const out = new Uint8Array(width * image.height * scale);
    for (let y = 0; y < image.height; y++) {
        const rowStart = y * scale * width;
        for (let x = 0; x < image.width; x++) {
            out.fill(image.pixels[y * image.width + x], rowStart + x * scale, rowStart + (x + 1) * scale);
        }
        for (let r = 1; r < scale; r++) out.copyWithin(rowStart + r * width, rowStart, rowStart + width);
    }
    return out;
}

// getFrame(i) returns { image, delay } with the delay in ms
function saveAnimationGif(count, getFrame, prefix, onDone) {
    const colors = activeSchemeColors();
    const scale = Math.min(getPhotoScale(), LIVE_GIF_MAX_SCALE);

    showGeneralPopup();
    updateGeneralPopup("ENCODING GIF", false);
    // Let the popup paint before the encoder holds the main thread. The share sheet
    // is out of reach over plain http anyway (see canShareFiles), so losing the
    // click gesture here costs nothing.
    setTimeout(() => {
        try {
            const first = getFrame(0).image;
            const gif = encodeGif(first.width * scale, first.height * scale, colors, count, (i) => {
                const frame = getFrame(i);
                return {
                    pixels: scalePixels(frame.image, scale),
                    delay: Math.max(2, Math.round(frame.delay / 10))
                };
            });
            const name = makeFileName(null, "gif", prefix);
            saveFiles([new File([gif], name, { type: "image/gif" })]);
            if (onDone) onDone();
            closeGeneralPopup();
        } catch (e) {
            console.error("GIF export failed:", e);
            updateGeneralPopup("COULD NOT SAVE THE GIF", true);
        }
    }, 50);
}

// MP4 where the browser can record it (Safari, recent Chrome), WebM otherwise
function videoMimeType() {
    if (typeof MediaRecorder === "undefined" || typeof HTMLCanvasElement.prototype.captureStream !== "function") return null;
    const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return types.find(t => {
        try {
            return MediaRecorder.isTypeSupported(t);
        } catch (e) {
            return false;
        }
    }) || null;
}

// Plays the frames on a canvas and records it, so it takes as long as the clip
async function saveAnimationVideo(count, getFrame, prefix, onDone) {
    const mime = videoMimeType();
    if (!mime) {
        showMessage("THIS BROWSER CANNOT RECORD VIDEO<br><br><small>Save a GIF instead</small>");
        return;
    }
    const colors = activeSchemeColors();
    const first = getFrame(0).image;
    // Video codecs smear single pixels, so never record at 1x
    const scale = Math.max(2, Math.min(4, getPhotoScale()));
    const canvas = document.createElement("canvas");
    canvas.width = first.width * scale;
    canvas.height = first.height * scale;
    canvas.className = "video-preview";
    const ctx = canvas.getContext("2d");
    const draw = (image) => {
        paintPixels(scaleSource, image, colors);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scaleSource, 0, 0, canvas.width, canvas.height);
    };
    draw(first);

    showGeneralPopup();
    updateGeneralPopup("RECORDING VIDEO<br><br><small id=\"video-progress\"></small>", true);
    // Shown while recording: some browsers only capture a canvas that is on the page
    const content = document.querySelector(".general-popup-content");
    if (content) content.appendChild(canvas);
    const popup = document.getElementById("general-popup");
    const cancelled = () => !popup || popup.classList.contains("hidden");

    let recorder, stream;
    const chunks = [];
    try {
        stream = canvas.captureStream(30);
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5000000 });
    } catch (e) {
        console.error("Video recording failed:", e);
        updateGeneralPopup("COULD NOT RECORD THE VIDEO", true);
        return;
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start(500);

    for (let i = 0; i < count && !cancelled(); i++) {
        const frame = getFrame(i);
        draw(frame.image);
        const progress = document.getElementById("video-progress");
        if (progress) progress.textContent = `Frame ${i + 1} of ${count}`;
        await sleep(Math.max(33, frame.delay));
    }
    recorder.stop();
    await stopped;
    stream.getTracks().forEach(track => track.stop());
    if (cancelled()) return;

    const type = mime.split(";")[0];
    const ext = type === "video/mp4" ? "mp4" : "webm";
    saveFiles([new File([new Blob(chunks, { type })], makeFileName(null, ext, prefix), { type })]);
    if (onDone) onDone();
    updateGeneralPopup(`VIDEO SAVED<br><br><small>${ext.toUpperCase()}</small>`, true);
}

let animateCallback = null;

function openAnimatePopup(onSave, withSpeed) {
    animateCallback = onSave;
    const popup = document.getElementById("animate-popup");
    const speed = document.getElementById("animate-speed-block");
    if (speed) speed.classList.toggle("hidden", !withSpeed);
    const videoOption = document.querySelector('#animate-format option[value="video"]');
    if (videoOption) videoOption.disabled = !videoMimeType();
    const format = document.getElementById("animate-format");
    if (format && format.value === "video" && !videoMimeType()) format.value = "gif";
    if (popup) popup.classList.remove("hidden");
}

function closeAnimatePopup() {
    const popup = document.getElementById("animate-popup");
    if (popup) popup.classList.add("hidden");
}

function exportAnimation() {
    const format = document.getElementById("animate-format");
    const delay = document.getElementById("animate-delay");
    closeAnimatePopup();
    if (animateCallback) animateCallback(format ? format.value : "gif", delay ? parseInt(delay.value) || 200 : 200);
}

class ByteWriter {
    constructor() {
        this.buf = new Uint8Array(1 << 16);
        this.len = 0;
    }
    reserve(n) {
        if (this.len + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.len + n) size *= 2;
        const grown = new Uint8Array(size);
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
    }
    byte(b) {
        this.reserve(1);
        this.buf[this.len++] = b & 0xFF;
    }
    word(w) {
        this.byte(w);
        this.byte(w >> 8);
    }
    text(s) {
        for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
    }
    bytes(data) {
        this.reserve(data.length);
        this.buf.set(data, this.len);
        this.len += data.length;
    }
    result() {
        return this.buf.slice(0, this.len);
    }
}

// Minimal GIF89a writer. Every frame shares one 4-colour global palette, so all
// it needs is the framing plus LZW over 2-bit palette indices. getFrame(i)
// returns { pixels, delay } with the delay in 1/100 s; frames are encoded one at
// a time so only one upscaled frame is ever held in memory.
function encodeGif(width, height, colors, frameCount, getFrame) {
    const out = new ByteWriter();
    out.text("GIF89a");
    out.word(width);
    out.word(height);
    out.byte(0x91); // global colour table, 4 entries, 2-bit colour resolution
    out.byte(0);    // background colour index
    out.byte(0);    // square pixels
    colors.forEach((c) => { out.byte(c[0]); out.byte(c[1]); out.byte(c[2]); });

    // NETSCAPE2.0 application extension: loop forever
    out.byte(0x21); out.byte(0xFF); out.byte(11);
    out.text("NETSCAPE2.0");
    out.byte(3); out.byte(1); out.word(0); out.byte(0);

    for (let i = 0; i < frameCount; i++) {
        const frame = getFrame(i);
        // Graphic control extension: leave the frame in place, then wait `delay`
        out.byte(0x21); out.byte(0xF9); out.byte(4);
        out.byte(0x04); out.word(frame.delay); out.byte(0); out.byte(0);
        // Image descriptor: the whole canvas, no local colour table
        out.byte(0x2C); out.word(0); out.word(0); out.word(width); out.word(height); out.byte(0);
        writeGifLzw(out, frame.pixels);
    }

    out.byte(0x3B);
    return out.result();
}

function writeGifLzw(out, pixels) {
    const MIN_CODE_SIZE = 2;
    const CLEAR_CODE = 1 << MIN_CODE_SIZE;
    const EOI_CODE = CLEAR_CODE + 1;
    // Dictionary keyed by (prefix code << 2 | next index): 4096 codes x 4 symbols
    const table = new Int16Array(4096 << 2);
    let codeSize = 0, nextCode = 0;
    const resetTable = () => {
        table.fill(-1);
        codeSize = MIN_CODE_SIZE + 1;
        nextCode = EOI_CODE + 1;
    };

    // Codes are packed LSB first into data sub-blocks of at most 255 bytes
    const block = new Uint8Array(255);
    let blockLen = 0, bitBuf = 0, bitCount = 0;
    const flushBlock = () => {
        if (blockLen === 0) return;
        out.byte(blockLen);
        out.bytes(block.subarray(0, blockLen));
        blockLen = 0;
    };
    const emit = (code) => {
        bitBuf |= code << bitCount;
        bitCount += codeSize;
        while (bitCount >= 8) {
            block[blockLen++] = bitBuf & 0xFF;
            if (blockLen === block.length) flushBlock();
            bitBuf >>>= 8;
            bitCount -= 8;
        }
    };

    out.byte(MIN_CODE_SIZE);
    resetTable();
    emit(CLEAR_CODE);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
        const key = (prefix << 2) | pixels[i];
        const code = table[key];
        if (code >= 0) {
            prefix = code;
            continue;
        }
        emit(prefix);
        if (nextCode === 4096) {
            emit(CLEAR_CODE);
            resetTable();
        } else {
            if (nextCode >= (1 << codeSize)) codeSize++;
            table[key] = nextCode++;
        }
        prefix = pixels[i];
    }
    emit(prefix);
    emit(EOI_CODE);
    if (bitCount > 0) {
        block[blockLen++] = bitBuf & 0xFF;
        if (blockLen === block.length) flushBlock();
    }
    flushBlock();
    out.byte(0); // block terminator
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

// "X.Y.Z" of a release, from its tag or name: "v2.3.0", "v2.2.2_test" and
// "v2.2.2 test" all work. A suffix used to turn into NaN, which reads as "not newer".
function releaseVersion(release) {
    for (const text of [release.tag_name, release.name]) {
        const match = /\d+(?:\.\d+)+/.exec(text || "");
        if (match) return match[0];
    }
    return null;
}

async function checkGitHubRelease() {
    // Only check if we have internet connection (best effort)
    if (!navigator.onLine) {
        latestRelease = false;
        renderUpdateState();
        return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

    try {
        const response = await fetch('https://api.github.com/repos/antoxa2584x/gameboy-camera-adapter/releases/latest', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const release = await response.json();
        const latestVersion = releaseVersion(release);
        if (!latestVersion) throw new Error(`No version in release "${release.name}"`);
        const releaseUrl = release.html_url;
        const asset = (release.assets || []).find(a => a.name === "update.bin");
        latestRelease = { version: latestVersion, tag: release.tag_name, assetUrl: asset ? asset.browser_download_url : releaseUrl };
        renderUpdateState();

        if (isNewerVersion(latestVersion, dynamicVersion)) {
            const alertBox = document.getElementById("update-alert");
            const versionSpan = document.getElementById("latest-version");

            if (versionSpan) {
                versionSpan.innerHTML = `<a href="${releaseUrl}" target="_blank" style="color:yellow;">v${latestVersion}</a>`;
            }
            if (alertBox) {
                alertBox.classList.remove("hidden");
                alertBox.classList.add("jingle");
            }
        }
    } catch (err) {
        console.error("Failed to check for updates:", err);
        latestRelease = false;
        renderUpdateState();
    }
}

// update.bin of a release, the raw flash image the adapter installs itself.
// Release downloads cannot be fetched from a page (GitHub sends no CORS headers
// for them), so the release workflow mirrors each one to the "firmware" branch,
// which raw.githubusercontent.com serves with CORS.
const FIRMWARE_MIRROR_URL = "https://raw.githubusercontent.com/antoxa2584x/gameboy-camera-adapter/firmware";
// null while checking, false when GitHub could not be reached
let latestRelease = null;

function renderUpdateState() {
    const versions = document.getElementById("fw-update-versions");
    const updateNowBtn = document.getElementById("fw-update-now-btn");
    const updateNowHint = document.getElementById("fw-update-now-hint");
    const available = latestRelease && isNewerVersion(latestRelease.version, dynamicVersion);

    if (versions) {
        if (latestRelease === null) versions.textContent = "Checking for updates...";
        else if (latestRelease === false) versions.textContent = `Firmware v${dynamicVersion}. Could not check for updates.`;
        else if (available) versions.textContent = `v${dynamicVersion} → v${latestRelease.version}`;
        else versions.textContent = `Firmware v${dynamicVersion} is up to date.`;
    }
    if (updateNowBtn) updateNowBtn.classList.toggle("hidden", !available);
    if (updateNowHint) updateNowHint.classList.toggle("hidden", !available);
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

// CRC-32 as zlib computes it: PNG chunks, ZIP entries, and the adapter checks
// the staged firmware image against it
function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function startAutoUpdate() {
    if (!latestRelease) return;
    closeUpdateInstructions();
    showGeneralPopup();
    updateGeneralPopup("DOWNLOADING UPDATE", false);

    let image;
    try {
        const response = await fetch(`${FIRMWARE_MIRROR_URL}/${latestRelease.tag}/update.bin`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        image = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
        console.error("Failed to download the update:", err);
        // The browser can still save the release file itself, it just can't read it
        updateGeneralPopup(`COULD NOT DOWNLOAD THE UPDATE<br><br><small><a href="${latestRelease.assetUrl}" target="_blank" class="fw-update-link">Download update.bin</a>, then use Install From File</small>`, true);
        return;
    }
    uploadFirmware(image);
}

function installFirmwareFile(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    closeUpdateInstructions();
    showGeneralPopup();
    updateGeneralPopup("READING FILE", false);
    file.arrayBuffer()
        .then(buffer => uploadFirmware(new Uint8Array(buffer)))
        .catch(() => updateGeneralPopup("COULD NOT READ THE FILE", true));
}

// Send the image to the adapter, which checks it and then installs it on its own
function uploadFirmware(image) {
    // "UF2\n": the drag-and-drop file, not the one the adapter installs
    if (image.length >= 4 && image[0] === 0x55 && image[1] === 0x46 && image[2] === 0x32 && image[3] === 0x0A) {
        updateGeneralPopup("THIS IS THE .UF2 FILE<br><br><small>Pick update.bin instead</small>", true);
        return;
    }

    const crc = crc32(image).toString(16).padStart(8, "0");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/fw_upload?crc=${crc}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const percent = Math.floor(e.loaded * 100 / e.total);
        updateGeneralPopup(`SENDING UPDATE ${percent}%<br><br><small>Do not unplug the Adapter</small>`, false);
    };
    xhr.onload = () => {
        let result = {};
        try { result = JSON.parse(xhr.responseText); } catch (e) {}
        if (result.result === "ok") {
            waitForUpdatedAdapter();
        } else {
            updateGeneralPopup(`UPDATE FAILED (${result.error || xhr.status})<br><br><small>The Adapter kept its current firmware</small>`, true);
        }
    };
    xhr.onerror = () => {
        updateGeneralPopup("UPDATE FAILED<br><br><small>Lost the connection to the Adapter. It kept its current firmware.</small>", true);
    };
    updateGeneralPopup("SENDING UPDATE<br><br><small>Do not unplug the Adapter</small>", false);
    xhr.send(image);
}

// The adapter installs the image about a second after replying, then restarts;
// wait for it to answer again and reload, so the new web UI comes up too
function waitForUpdatedAdapter() {
    updateGeneralPopup("INSTALLING UPDATE<br><br><small>Do not unplug the Adapter. It restarts on its own.</small>", false);
    const startedAt = Date.now();

    const poll = async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        try {
            const response = await fetch("/status.json", { cache: "no-store", signal: controller.signal });
            if (response.ok) {
                const data = await response.json();
                const version = (data.system && data.system.version) || "";
                updateGeneralPopup(`UPDATED TO V${version}`, false);
                setTimeout(() => window.location.reload(), 1500);
                return;
            }
        } catch (e) {
            // still installing or restarting
        } finally {
            clearTimeout(timeoutId);
        }
        if (Date.now() - startedAt > 90000) {
            updateGeneralPopup("THE ADAPTER DID NOT COME BACK<br><br><small>Unplug it and plug it back in. If an RPI-RP2 drive shows up instead, drop the .uf2 from the GitHub release onto it.</small>", true);
            return;
        }
        setTimeout(poll, 2000);
    };
    // the install itself takes several seconds; don't catch the old firmware before it starts
    setTimeout(poll, 6000);
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
                versionText.textContent = `Version ${dynamicVersion}`;
            }
            renderUpdateState();
        }
    } catch (err) {
        console.error("Failed to fetch firmware version:", err);
    }
}


document.addEventListener("DOMContentLoaded", () => {
    const versionText = document.getElementById("firmware-version-text");

    if (versionText) {
        versionText.textContent = `Version ${dynamicVersion}`;
    }

    // Local initialization should be fast
    setupPalettes();
    setupPhotoScaleSelector();
    setupPhotoFormatSelector();
    setupSaveAllModeSelector();
    setupFrameSelector();
    setupGallerySort();
    updateSelectionBar();
    restoreGallery();

    const liveVideoBtn = document.getElementById("live-video-btn");
    if (liveVideoBtn) liveVideoBtn.classList.toggle("hidden", !videoMimeType());

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
    if (popup) popup.classList.remove('hidden');

    loadLedStatus();
}

function closeFirmwarePopup() {
    const popup = document.getElementById('fw-popup');
    if (popup) popup.classList.add('hidden');
}

function showUpdateInstructions() {
    const popup = document.getElementById('update-instructions-popup');
    if (popup) popup.classList.remove('hidden');
}

function closeUpdateInstructions() {
    const popup = document.getElementById('update-instructions-popup');
    if (popup) popup.classList.add('hidden');
}

function startUpdate() {
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        alert("⚠️ Update is only available on macOS or Windows.");
        return;
    }

    const currentOrigin = window.location.origin;
    const updateUrl = currentOrigin.includes('192.168.7.1') ? "http://192.168.7.1/update" : "/update";

    // Navigate directly to the update endpoint.
    // The server will respond with updating.html and then reboot.
    window.location.href = updateUrl;
}

function isAppleMobile() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function setLedColor() {
    const hex = document.getElementById("ledColorPicker").value;
    const useRGB = !document.getElementById("colorMode").checked; // the switch swaps red and green
    const mobileMode = document.getElementById("mobileMode").value;
    const r = parseInt(hex.substr(1, 2), 16);
    const g = parseInt(hex.substr(3, 2), 16);
    const b = parseInt(hex.substr(5, 2), 16);

    if (mobileMode == "1" && isAppleMobile()) {
        const proceed = confirm(
            "Android mode is meant for use with the Android app.\n\n" +
            "Continue?"
        );
        if (!proceed) return;
    }

    fetch(`/set_color?r=${r}&g=${g}&b=${b}&use_rgb=${useRGB}&mode=${mobileMode}`, { cache: "no-store" })
        .then(() => {
            alert("Settings saved. The device will now reboot.");
            window.location.reload();
        })
        .catch((err) => {
            console.error("Failed to save settings:", err);
            alert(
                "Could not reach the adapter, settings were NOT saved.\n\n" +
                "Reconnect the adapter and reload this page, then try again."
            );
        });
}

function updatePreview() {
    const color = document.getElementById("ledColorPicker").value.toLowerCase();
    const idleDot = document.getElementById("led-idle-dot");
    if (idleDot) idleDot.style.backgroundColor = color;
    let preset = false;
    document.querySelectorAll(".led-swatch").forEach(swatch => {
        const match = swatch.dataset.color === color;
        swatch.classList.toggle("active", match);
        preset = preset || match;
    });
    // The "any color" circle shows a rainbow until it holds a color of its own
    document.getElementById("colorPreview").style.backgroundColor = preset ? "transparent" : color;
    const picker = document.querySelector(".led-color");
    if (picker) picker.classList.toggle("active", !preset);
}

document.getElementById("ledColorPicker").addEventListener("input", updatePreview);
document.querySelectorAll(".led-swatch").forEach(swatch => {
    swatch.addEventListener("click", () => {
        document.getElementById("ledColorPicker").value = swatch.dataset.color;
        updatePreview();
    });
});
updatePreview();

function loadLedStatus() {
    fetch('/led_status', { cache: "no-store" })
        .then(response => response.json())
        .then(data => {
            const { r, g, b, use_rgb, mode } = data;
            const hex = "#" + [r, g, b].map(x => (x || 0).toString(16).padStart(2, '0')).join('');
            document.getElementById('ledColorPicker').value = hex;
            updatePreview();
            document.getElementById('colorMode').checked = use_rgb === false;
            if (mode !== undefined) {
                document.getElementById('mobileMode').value = String(mode);
            }
        })
        .catch(err => console.error("Failed to load LED status:", err));
}

function showGeneralPopup() {
    const popup = document.getElementById('general-popup');
    if (popup) popup.classList.remove('hidden');
}

function closeGeneralPopup() {
    const popup = document.getElementById('general-popup');
    if (popup) popup.classList.add('hidden');
}

function updateGeneralPopup(html, showCloseButton) {
    const popupContent = document.querySelector('.general-popup-content');
    if (popupContent) popupContent.innerHTML = html;

    const closeButton = document.querySelector('.general-popup-button-close-button');
    if (closeButton) closeButton.classList.toggle('hidden', !showCloseButton);
}

function showMessage(html) {
    showGeneralPopup();
    updateGeneralPopup(html, true);
}

// ---- Modes ----

let currentMode = "scanner";
let modeSwitching = false;

function setMode(mode) {
    if (mode === currentMode || modeSwitching) return;
    const scanner = document.getElementById("scanner-mode");
    const printer = document.getElementById("printer-mode");
    const modeName = document.getElementById("mode-name");

    const switchMode = () => {
        modeSwitching = false;
        const toPrinter = mode === "printer";
        const from = toPrinter ? scanner : printer;
        const to = toPrinter ? printer : scanner;
        if (from) {
            from.classList.add("hidden");
            from.classList.remove("fade-out");
        }
        if (to) {
            to.classList.remove("hidden");
            to.classList.add("fade-in");
        }
        if (modeName) modeName.textContent = toPrinter ? "Printer" : "Gallery";
        currentMode = mode;
        if (toPrinter) {
            periodic_fetch();
            pollPrinterStatus();
            startPrinterPolling();
        } else {
            stopPrinterPolling();
            periodic_fetch();
        }
    };

    const currentBlock = currentMode === "scanner" ? scanner : printer;
    if (currentBlock) {
        modeSwitching = true;
        currentBlock.classList.remove("fade-in");
        currentBlock.classList.add("fade-out");
        currentBlock.addEventListener("animationend", switchMode, { once: true });
    } else {
        switchMode();
    }
}

safeAddEventListener(document.getElementById("logo-img"), "click", () => {
    setMode(currentMode === "scanner" ? "printer" : "scanner");
});

window.showFirmwarePopup = showFirmwarePopup;
window.closeFirmwarePopup = closeFirmwarePopup;
window.setLedColor = setLedColor;
window.downloadImage = downloadImage;
window.saveAllPictures = saveAllPictures;
window.startUpdate = startUpdate;
window.startAutoUpdate = startAutoUpdate;
window.installFirmwareFile = installFirmwareFile;
window.showUpdateInstructions = showUpdateInstructions;
window.closeUpdateInstructions = closeUpdateInstructions;
window.closeGeneralPopup = closeGeneralPopup;
window.saveLiveVideo = saveLiveVideo;
window.saveLiveMovie = saveLiveMovie;
window.saveLiveFrame = saveLiveFrame;
window.closeLiveView = closeLiveView;
window.showPopupWithUpscaledImage = showPopupWithUpscaledImage;
window.setSelectMode = setSelectMode;
window.selectAllPhotos = selectAllPhotos;
window.saveSelectedPhotos = saveSelectedPhotos;
window.deleteSelectedPhotos = deleteSelectedPhotos;
window.joinSelectedPhotos = joinSelectedPhotos;
window.printSelectedPhotos = printSelectedPhotos;
window.contactSheetSelected = contactSheetSelected;
window.animateSelectedPhotos = animateSelectedPhotos;
window.openPaletteEditor = openPaletteEditor;
window.editActivePalette = editActivePalette;
window.closePaletteEditor = closePaletteEditor;
window.onPaletteCodeInput = onPaletteCodeInput;
window.copyPaletteCode = copyPaletteCode;
window.savePaletteFromEditor = savePaletteFromEditor;
window.deletePaletteFromEditor = deletePaletteFromEditor;
window.loadCustomFrame = loadCustomFrame;
window.closeAnimatePopup = closeAnimatePopup;
window.exportAnimation = exportAnimation;
