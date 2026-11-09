// Printer mode: print images, gallery photos and text labels on a real Game
// Boy Printer through the adapter. Everything to print sits in a queue; the
// selected queue item is the one the preview and the controls work on.

// Status bits that mean something went wrong: low battery, other error, paper
// jam, packet error, checksum. Printing (0x02), image data full (0x04) and
// unprocessed data (0x08) are what a healthy printer reports mid-job.
const PRINTER_ERROR_MASK = 0xF1;
const PRINTER_BUSY = 0x02;
const PRINTER_FULL = 0x04;
const PRINTER_DISCONNECTED = 0xFF;

function decodePrinterStatus(byte, ignoreBusyFull = false) {
    if (byte === PRINTER_DISCONNECTED) return "Disconnected";
    const flags = [
        "Checksum Error",
        "Printing image",
        "Image Data Full",
        "", // unprocessed data: normal while a job is in the printer, not worth a label
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
            if (flags[i]) errors.push(flags[i]);
        }
    }
    return errors.length ? errors.join(", ") : "OK";
}

// What to do about a status, in words, or "" when there is nothing to do
function printerStatusAdvice(byte) {
    if (byte === undefined || byte === null) return "";
    if (byte === PRINTER_DISCONNECTED) return "No printer found. Check the link cable and that the printer is switched on.";
    if (byte & 0x80) return "The printer batteries are low. Replace them, then try again.";
    if (byte & 0x20) return "Paper jam or out of paper. Check the paper roll.";
    if (byte & 0x40) return "The printer reported an error. Switch it off and on again.";
    if (byte & 0x11) return "The image did not arrive intact. Check the cable connection and try again.";
    return "";
}

let printerPollId = null;
let isPrintingActive = false;
// The status poll that is still on its way, if any. done=1 sends whatever the
// adapter has queued, so a poll landing after a print started buffering would
// fire the first few chunks off as their own job: printing waits for it first.
let printerPollInFlight = null;

// done=1 with nothing queued sends the printer a STATUS packet; the reply is
// /status.json, read after that packet went out
// iOS freezes the page while the phone is locked, and a request caught in that
// can hang forever - which left the job, and its "Printing..." dialog, waiting
// for good. A deadline turns it into an ordinary failure the job recovers from.
async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { cache: "no-store", signal: controller.signal });
        return res.ok ? await res.json() : null;
    } finally {
        clearTimeout(timer);
    }
}

// The burst to the printer runs inside this request: allow it a while
const BURST_TIMEOUT_MS = 30000;
const PACKET_TIMEOUT_MS = 5000;
// How long one part may take to print
const PART_TIMEOUT_MS = 45000;

function queryPrinterStatus() {
    return fetchJson("/print_chunk?done=1", BURST_TIMEOUT_MS).then(data => data ? data.printer : undefined);
}

function showPrinterStatus(byte) {
    const el = document.getElementById("printer-status");
    const text = document.getElementById("printer-status-text");
    const help = document.getElementById("printer-status-help");
    let label, state;
    if (byte === PRINTER_DISCONNECTED) {
        label = "Not connected";
        state = "off";
    } else if (byte & PRINTER_ERROR_MASK) {
        label = decodePrinterStatus(byte, true);
        state = "error";
    } else if (byte & (PRINTER_BUSY | PRINTER_FULL)) {
        label = "Printing...";
        state = "busy";
    } else {
        label = "Ready";
        state = "ready";
    }
    if (text) text.textContent = "Printer: " + label;
    if (el) el.dataset.state = state;
    if (help) {
        const advice = printerStatusAdvice(byte);
        help.textContent = advice;
        help.classList.toggle("hidden", !advice);
    }
}

function pollPrinterStatus() {
    if (typeof currentMode !== 'undefined' && currentMode !== "printer") return;
    if (isPrintingActive || printerPollInFlight) return;

    printerPollInFlight = queryPrinterStatus()
        .then(status => {
            if (status === undefined) return;
            showPrinterStatus(status);

            // A job from elsewhere (the Android app) still shows as busy here
            const overlay = document.getElementById("print-overlay");
            if (!overlay || printJob) return;
            if (status !== PRINTER_DISCONNECTED && (status & (PRINTER_BUSY | PRINTER_FULL))) {
                setPrintOverlay(true, (status & PRINTER_BUSY) ? "Printing image..." : "Image Data Full", "", false);
            } else {
                setPrintOverlay(false);
            }
        })
        .catch(err => {
            console.error("Status error:", err);
            if (!printJob) setPrintOverlay(false);
        })
        .finally(() => {
            printerPollInFlight = null;
        });
}

// Poll printer status only while in printer mode (started/stopped on mode switch)
function startPrinterPolling() {
    if (printerPollId !== null) return;
    printerPollId = setInterval(pollPrinterStatus, 3000);
}

function stopPrinterPolling() {
    if (printerPollId !== null) {
        clearInterval(printerPollId);
        printerPollId = null;
    }
}

function setPrintOverlay(visible, text, detail, showButtons) {
    const overlay = document.getElementById("print-overlay");
    if (!overlay) return;
    overlay.classList.toggle("hidden", !visible);
    if (!visible) return;
    const statusText = document.getElementById("print-status-text");
    const detailText = document.getElementById("print-status-detail");
    const spinner = document.getElementById("print-spinner");
    const buttons = document.getElementById("print-job-buttons");
    const cancel = document.getElementById("print-cancel-btn");
    if (statusText) statusText.textContent = text || "";
    if (detailText) detailText.textContent = detail || "";
    if (spinner) spinner.classList.toggle("hidden", !!showButtons);
    if (buttons) buttons.classList.toggle("hidden", !showButtons);
    // Cancelling a running job stops it after the part on its way
    if (cancel) cancel.classList.toggle("hidden", !printJob);
}

// ---- Image processing ----

// Printer exposure byte = thermal head burn time, 0x00 lightest to 0x7F darkest.
// 0x7F is the hardware limit. The usable range is taken from the "print-exposure"
// slider itself rather than repeated here, so tuning the input's min and max is
// enough - a constant tighter than the input would clamp part of the slider's
// travel to one value and make that end look dead. These are only the fallback
// for when the input is missing. The light end sits above 0x00 because the bottom
// of the range prints washed out with no true black.
const PRINT_EXPOSURE_MIN = 0x10;
const PRINT_EXPOSURE_MAX = 0x7F;

function printExposureRange() {
    const el = document.getElementById("print-exposure");
    const min = parseInt(el && el.min);
    const max = parseInt(el && el.max);
    return {
        min: Number.isFinite(min) ? Math.max(0, min) : PRINT_EXPOSURE_MIN,
        max: Math.min(PRINT_EXPOSURE_MAX, Number.isFinite(max) ? max : PRINT_EXPOSURE_MAX)
    };
}

// The exposure the slider is currently asking for, clamped to what the printer
// accepts. Single source of truth for both the PRINT packet and the preview.
function currentPrintExposure() {
    const { min, max } = printExposureRange();
    const el = document.getElementById("print-exposure");
    const value = el ? parseInt(el.value) : NaN;
    const exposure = Number.isFinite(value) ? value : min;
    return Math.min(max, Math.max(min, exposure));
}

const PRINT_WIDTH = 160;
const PRINT_PAGE_HEIGHT = 144;
// The printer buffers 9 strips of 16 rows; taller images go out in parts of that
const PRINT_PART_ROWS = 144;
const PRINT_ROW_STEP = 16;
// About 70 cm of paper; past that a banner is shrunk to fit
const PRINT_MAX_HEIGHT = 2880;

// The four greys of Game Boy shades 0..3, brightest first
const PRINT_LEVELS = [255, 170, 85, 0];

// 4x4 ordered dither matrix.
const BAYER_4X4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5]
];

// Decide whether the canvas already holds a Game Boy picture, i.e. one built from
// exactly four shades. Photos saved from the gallery are written out upscaled;
// saved as JPEG the shades come back slightly smeared and cannot simply be
// compared for equality - they are clustered with a tolerance instead (a saved
// PNG lands dead on the levels). Returns the four shades brightest first, or null
// when the source is an ordinary photo that still needs quantising.
function detectGameBoyLevels(data, tolerance = 12, coverage = 0.97) {
    const histogram = new Uint32Array(256);
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
        const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        histogram[Math.round(gray)]++;
    }

    // Greedily take the densest remaining shade as a cluster centre and absorb
    // everything within tolerance of it. Four clusters that between them account
    // for nearly every pixel means four shades; a continuous tone photo spreads
    // far too widely to be covered by four narrow windows.
    const centres = [];
    let counted = 0;
    for (let n = 0; n < 4; n++) {
        let peak = -1;
        for (let v = 0; v < 256; v++) {
            if (histogram[v] > 0 && (peak === -1 || histogram[v] > histogram[peak])) peak = v;
        }
        if (peak === -1) break;
        centres.push(peak);
        for (let v = Math.max(0, peak - tolerance); v <= Math.min(255, peak + tolerance); v++) {
            counted += histogram[v];
            histogram[v] = 0;
        }
    }

    if (centres.length !== 4 || counted < pixels * coverage) return null;
    return centres.sort((a, b) => b - a);
}

function nearestShade(gray) {
    return gray > 192 ? 0 : gray > 128 ? 1 : gray > 64 ? 2 : 3;
}

// Greys (0..255) to Game Boy shades (0 white .. 3 black)
const DITHERERS = {
    // Ordered dither, the way the camera itself does it. A flat threshold
    // collapses gradients into big even blobs.
    bayer(gray, w, h) {
        const out = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const p = y * w + x;
                out[p] = nearestShade(gray[p] + ((BAYER_4X4[y & 3][x & 3] + 0.5) / 16 - 0.5) * 64);
            }
        }
        return out;
    },
    floyd(gray, w, h) {
        return diffuse(gray, w, h, [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]]);
    },
    // Spreads only 3/4 of the error, which keeps highlights and shadows clean
    atkinson(gray, w, h) {
        return diffuse(gray, w, h, [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]]);
    },
    none(gray, w, h) {
        const out = new Uint8Array(w * h);
        for (let p = 0; p < out.length; p++) out[p] = nearestShade(gray[p]);
        return out;
    },
    bw(gray, w, h) {
        const out = new Uint8Array(w * h);
        for (let p = 0; p < out.length; p++) out[p] = gray[p] < 128 ? 3 : 0;
        return out;
    }
};

function diffuse(gray, w, h, kernel) {
    const buf = Float32Array.from(gray);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            const shade = nearestShade(buf[p]);
            out[p] = shade;
            const error = buf[p] - PRINT_LEVELS[shade];
            for (const [dx, dy, weight] of kernel) {
                const nx = x + dx, ny = y + dy;
                if (nx >= 0 && nx < w && ny < h) buf[ny * w + nx] += error * weight;
            }
        }
    }
    return out;
}

// Brightness and contrast run -100..100, 0 leaves the picture alone
function adjustGray(gray, brightness, contrast) {
    if (!brightness && !contrast) return gray;
    const factor = Math.pow((100 + contrast) / 100, 2);
    const shift = brightness * 1.28;
    for (let p = 0; p < gray.length; p++) gray[p] = (gray[p] - 128) * factor + 128 + shift;
    return gray;
}

// Where the source lands on the paper. Every mode is 160 dots wide; only the
// banner keeps the source's own aspect and so its own length.
function printGeometry(srcW, srcH, mode) {
    let width = PRINT_WIDTH, height = PRINT_PAGE_HEIGHT;
    let sx = 0, sy = 0, sw = srcW, sh = srcH;
    let dx = 0, dy = 0, dw = width, dh = height;
    const targetRatio = width / height;
    const ratio = srcW / srcH;

    if (mode === "crop") {
        if (ratio > targetRatio) {
            sw = Math.round(srcH * targetRatio);
            sx = Math.round((srcW - sw) / 2);
        } else {
            sh = Math.round(srcW / targetRatio);
            sy = Math.round((srcH - sh) / 2);
        }
    } else if (mode === "center") {
        // Pixel for pixel: a 128x112 transfer gets a white border, a bigger
        // picture is cropped around its middle
        if (srcW > width) { sx = Math.floor((srcW - width) / 2); sw = width; }
        if (srcH > height) { sy = Math.floor((srcH - height) / 2); sh = height; }
        dw = sw;
        dh = sh;
        dx = Math.floor((width - dw) / 2);
        dy = Math.floor((height - dh) / 2);
    } else if (mode === "banner") {
        dh = Math.max(1, Math.round(width / ratio));
        if (dh > PRINT_MAX_HEIGHT) {
            dh = PRINT_MAX_HEIGHT;
            dw = Math.max(1, Math.round(dh * ratio));
            dx = Math.floor((width - dw) / 2);
        }
        height = Math.ceil(dh / PRINT_ROW_STEP) * PRINT_ROW_STEP;
    } else { // fit
        if (ratio > targetRatio) {
            dh = Math.round(width / ratio);
            dy = Math.round((height - dh) / 2);
        } else {
            dw = Math.round(height * ratio);
            dx = Math.round((width - dw) / 2);
        }
    }
    return { width, height, sx, sy, sw, sh, dx, dy, dw, dh };
}

function rotateCanvas(source, quarterTurns) {
    if (!quarterTurns) return source;
    const odd = quarterTurns % 2 === 1;
    const out = document.createElement("canvas");
    out.width = odd ? source.height : source.width;
    out.height = odd ? source.width : source.height;
    const ctx = out.getContext("2d");
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(quarterTurns * Math.PI / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
    return out;
}

// The queue item as Game Boy shades on 160 dot wide paper:
// { width, height, pixels, passthrough }
function buildPrintImage(item) {
    if (item.result) return item.result;

    if (!item.rotated || item.rotatedTurns !== item.rotation) {
        item.rotated = rotateCanvas(item.source, item.rotation);
        item.rotatedTurns = item.rotation;
    }
    const src = item.rotated;
    const g = printGeometry(src.width, src.height, item.mode);

    const work = document.createElement("canvas");
    work.width = g.width;
    work.height = g.height;
    const ctx = work.getContext("2d", { willReadFrequently: true });
    const draw = (smooth) => {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, g.width, g.height);
        // Nearest neighbour first: photos saved from the gallery are upscaled
        // nearest-neighbour, so scaling one back down with smoothing on would blur
        // every hard pixel edge and the quantiser would turn that blur into blotches.
        ctx.imageSmoothingEnabled = smooth;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, g.sx, g.sy, g.sw, g.sh, g.dx, g.dy, g.dw, g.dh);
        return ctx.getImageData(0, 0, g.width, g.height).data;
    };

    let data = draw(false);
    const adjusted = item.brightness !== 0 || item.contrast !== 0;
    const count = g.width * g.height;
    let pixels = null;
    let passthrough = false;

    if (!adjusted) {
        if (item.kind === "photo") {
            // Already Game Boy shades: hand them over as they are
            pixels = new Uint8Array(count);
            for (let p = 0; p < count; p++) pixels[p] = nearestShade(data[p * 4]);
            passthrough = true;
        } else if (item.kind === "image") {
            const levels = detectGameBoyLevels(data);
            if (levels) {
                // A saved Game Boy photo re-prints exactly as the camera itself
                // would have printed it instead of being dithered a second time
                pixels = new Uint8Array(count);
                for (let p = 0; p < count; p++) {
                    const i = p * 4;
                    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                    let nearest = 0;
                    for (let n = 1; n < 4; n++) {
                        if (Math.abs(gray - levels[n]) < Math.abs(gray - levels[nearest])) nearest = n;
                    }
                    pixels[p] = nearest;
                }
                passthrough = true;
            }
        }
    }

    if (!pixels) {
        // An ordinary photo scales better smoothed
        if (item.kind === "image") data = draw(true);
        const gray = new Float32Array(count);
        for (let p = 0; p < count; p++) {
            const i = p * 4;
            gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        adjustGray(gray, item.brightness, item.contrast);
        pixels = (DITHERERS[item.dither] || DITHERERS.bayer)(gray, g.width, g.height);
    }

    item.result = { width: g.width, height: g.height, pixels: pixels, passthrough: passthrough };
    return item.result;
}

function shadesToCanvas(image, canvas = document.createElement("canvas")) {
    paintPixels(canvas, image, PRINT_LEVELS.map(v => [v, v, v]));
    return canvas;
}

// How far the burn simulation goes at the darkest end of the slider.
// How completely the paper takes the ink at each end of the slider. Below 1.0 the
// head does not burn long enough to lay a shade down in full, so even a black pixel
// comes out a washed grey with no true black - which is the whole of issue #9. 1.0
// at the dark end means black arrives at solid exactly at the top of the travel;
// going past 1.0 would only clip it to 0 early and flatten the last stretch of the
// slider. Over-burn past nominal shows through the dot gain below instead.
const BURN_DENSITY_MIN = 0.55;
const BURN_DENSITY_MAX = 1.0;
// How far a burnt dot bleeds into the white beside it at the dark end of the
// slider. Real thermal dots grow with burn time, and that thickening is a large
// part of why a longer exposure reads as darker on paper.
const BURN_GAIN = 0.4;

// Paint the visible preview from the print data, showing what the exposure will do
// on paper. Exposure is burn time: it does not change which of the four shades a
// pixel is, only how heavily each one is laid down.
function renderPrintPreview(exposure) {
    const preview = document.getElementById("preview-canvas");
    const item = selectedQueueItem();
    if (!preview) return;
    if (!item) {
        preview.width = PRINT_WIDTH;
        preview.height = PRINT_PAGE_HEIGHT;
        const ctx = preview.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, preview.width, preview.height);
        return;
    }

    const image = buildPrintImage(item);
    const w = image.width;
    const h = image.height;
    preview.width = w;
    preview.height = h;

    const { min, max } = printExposureRange();
    const span = max - min;
    const burn = span > 0 ? Math.min(1, Math.max(0, (exposure - min) / span)) : 0;

    const ctx = preview.getContext("2d");
    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;
    const source = new Uint8ClampedArray(w * h);
    for (let p = 0; p < w * h; p++) source[p] = PRINT_LEVELS[image.pixels[p]];

    const density = BURN_DENSITY_MIN + (BURN_DENSITY_MAX - BURN_DENSITY_MIN) * burn;
    const gain = BURN_GAIN * burn;
    // A shade asks for a certain amount of ink; the burn decides how much of it the
    // paper actually gets. White asks for none, so it stays bare paper at any
    // exposure and can only be reached by a neighbouring dot growing into it.
    const inked = v => Math.max(0, 255 - (255 - v) * density);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const p = y * w + x;
            let darkest = source[p];
            if (x > 0) darkest = Math.min(darkest, source[p - 1]);
            if (x < w - 1) darkest = Math.min(darkest, source[p + 1]);
            if (y > 0) darkest = Math.min(darkest, source[p - w]);
            if (y < h - 1) darkest = Math.min(darkest, source[p + w]);

            const self = inked(source[p]);
            const v = self - gain * (self - inked(darkest));

            const i = p * 4;
            data[i] = data[i + 1] = data[i + 2] = Math.round(v);
            data[i + 3] = 0xFF;
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

// ---- Queue ----

let printQueue = [];
let selectedQueueId = null;
let nextQueueId = 1;

function selectedQueueItem() {
    return printQueue.find(item => item.id === selectedQueueId) || null;
}

// source: a canvas. kind: "image" (a picture file), "photo" (from the gallery),
// "text" (a label)
function addQueueItem(source, name, kind, options = {}) {
    const item = Object.assign({
        id: nextQueueId++,
        source: source,
        name: name,
        kind: kind,
        mode: "fit",
        rotation: 0,
        dither: "bayer",
        brightness: 0,
        contrast: 0,
        copies: 1,
        result: null
    }, options);
    printQueue.push(item);
    selectedQueueId = item.id;
    renderPrintQueue();
    syncPrinterControls();
    refreshPreview();
    return item;
}

function removeQueueItem(id) {
    const index = printQueue.findIndex(item => item.id === id);
    if (index < 0) return;
    printQueue.splice(index, 1);
    if (selectedQueueId === id) {
        const next = printQueue[Math.min(index, printQueue.length - 1)];
        selectedQueueId = next ? next.id : null;
    }
    renderPrintQueue();
    syncPrinterControls();
    refreshPreview();
}

function renderPrintQueue() {
    const empty = printQueue.length === 0;
    const start = document.getElementById("print-start");
    const editor = document.getElementById("print-editor");
    if (start) start.classList.toggle("hidden", !empty);
    if (editor) editor.classList.toggle("hidden", empty);
    // Wide screens give the editor two columns
    const panel = document.querySelector(".printer-panel");
    if (panel) panel.classList.toggle("editing", !empty);

    // One picture needs no list: the preview is the whole story
    const block = document.getElementById("print-queue-block");
    if (block) block.classList.toggle("hidden", printQueue.length < 2);
    const list = document.getElementById("print-queue");
    if (list) {
        list.innerHTML = "";
        printQueue.forEach((item) => list.appendChild(queueRow(item)));
    }

    const sheets = printQueue.reduce((total, item) => total + item.copies, 0);
    const printBtn = document.getElementById("print-button");
    if (printBtn) printBtn.textContent = sheets > 1 ? `Print all (${sheets})` : "Print";
    const spacing = document.getElementById("print-spacing-row");
    if (spacing) spacing.classList.toggle("hidden", sheets < 2);
}

function queueRow(item) {
    const row = document.createElement("div");
    row.className = "queue-item" + (item.id === selectedQueueId ? " selected" : "");
    row.addEventListener("click", () => {
        selectedQueueId = item.id;
        renderPrintQueue();
        syncPrinterControls();
        refreshPreview();
    });

    const thumb = shadesToCanvas(buildPrintImage(item));
    thumb.className = "queue-thumb";
    row.appendChild(thumb);

    const label = document.createElement("div");
    label.className = "queue-name";
    label.textContent = item.name;
    row.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "queue-controls";
    const button = (text, title, onClick, disabled) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = text;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.disabled = !!disabled;
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            onClick();
        });
        controls.appendChild(b);
    };
    button("-", "One copy less", () => { item.copies = Math.max(1, item.copies - 1); renderPrintQueue(); }, item.copies <= 1);
    const copies = document.createElement("span");
    copies.className = "queue-copies";
    copies.textContent = item.copies + (item.copies === 1 ? " copy" : " copies");
    controls.appendChild(copies);
    button("+", "One copy more", () => { item.copies = Math.min(20, item.copies + 1); renderPrintQueue(); }, item.copies >= 20);
    button("X", "Remove from the list", () => removeQueueItem(item.id));
    row.appendChild(controls);
    return row;
}

function clearPrintQueue() {
    if (printQueue.length > 1 && !confirm("Remove everything from the print list?")) return;
    printQueue = [];
    selectedQueueId = null;
    renderPrintQueue();
    syncPrinterControls();
    refreshPreview();
}

const LAYOUT_HINTS = {
    fit: "The whole picture, with white borders",
    crop: "Fills the paper, edges are cut off",
    center: "Pixel for pixel, no resizing",
    banner: "Paper wide and as long as it needs"
};

// Put the selected item's settings into the controls
function syncPrinterControls() {
    const item = selectedQueueItem();
    const nameDisplay = document.getElementById("file-name");
    if (nameDisplay) nameDisplay.textContent = item ? item.name : "";
    if (!item) return;

    document.querySelectorAll("[data-layout]").forEach((b) => {
        b.classList.toggle("active", b.dataset.layout === item.mode);
    });
    const hint = document.getElementById("layout-hint");
    if (hint) hint.textContent = LAYOUT_HINTS[item.mode] || "";
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    };
    set("print-dither", item.dither);
    set("print-brightness", item.brightness);
    set("print-contrast", item.contrast);
    updateAdjustLabels();
    const editText = document.getElementById("edit-text-btn");
    if (editText) editText.classList.toggle("hidden", item.kind !== "text");
}

function updateAdjustLabels() {
    const show = (id, labelId) => {
        const el = document.getElementById(id);
        const label = document.getElementById(labelId);
        if (el && label) label.textContent = (el.value > 0 ? "+" : "") + el.value;
    };
    show("print-brightness", "print-brightness-value");
    show("print-contrast", "print-contrast-value");
}

// Controls -> the selected item
function updatePrintSettings() {
    const item = selectedQueueItem();
    if (!item) return;
    const get = (id, fallback) => {
        const el = document.getElementById(id);
        return el ? el.value : fallback;
    };
    item.dither = get("print-dither", item.dither);
    item.brightness = parseInt(get("print-brightness", 0)) || 0;
    item.contrast = parseInt(get("print-contrast", 0)) || 0;
    item.result = null;
    updateAdjustLabels();
    refreshPreview();
    renderPrintQueue();
}

function setPrintLayout(mode) {
    const item = selectedQueueItem();
    if (!item || !LAYOUT_HINTS[mode]) return;
    item.mode = mode;
    item.result = null;
    syncPrinterControls();
    refreshPreview();
    renderPrintQueue();
}

function resetPrintAdjustments() {
    const b = document.getElementById("print-brightness");
    const c = document.getElementById("print-contrast");
    if (b) b.value = 0;
    if (c) c.value = 0;
    updatePrintSettings();
}

function rotatePrintItem() {
    const item = selectedQueueItem();
    if (!item) return;
    item.rotation = (item.rotation + 1) % 4;
    item.result = null;
    refreshPreview();
    renderPrintQueue();
}

// Debounced: the sliders fire on every step, and an error-diffused banner can
// take a moment to rebuild
let previewTimer = null;
function refreshPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
        renderPrintPreview(currentPrintExposure());
        const item = selectedQueueItem();
        const hint = document.getElementById("print-passthrough-hint");
        if (hint) hint.classList.toggle("hidden", !(item && item.result && item.result.passthrough));
        const size = document.getElementById("print-size");
        if (size) {
            if (item && item.result) {
                const parts = Math.ceil(item.result.height / PRINT_PART_ROWS);
                size.textContent = `${item.result.width} x ${item.result.height}` + (parts > 1 ? ` (${parts} parts)` : "");
            } else {
                size.textContent = "";
            }
        }
    }, 30);
}

// Exposure never changes the tile data, so moving the slider only needs the
// preview repainted rather than the whole image re-quantised.
function refreshExposure() {
    renderPrintPreview(currentPrintExposure());
}

function loadImageFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d").drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            resolve(canvas);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Not an image"));
        };
        img.src = url;
    });
}

function shortName(name) {
    const dotIndex = name.lastIndexOf(".");
    const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
    const ext = dotIndex > 0 ? name.substring(dotIndex) : "";
    return base.length > 24 ? base.substring(0, 18) + "..." + base.substring(base.length - 3) + ext : name;
}

async function handleFileInput(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    for (const file of files) {
        try {
            const canvas = await loadImageFile(file);
            addQueueItem(canvas, shortName(file.name), "image");
        } catch (err) {
            console.error("Could not open", file.name, err);
            alert(`Could not open ${file.name}`);
        }
    }
}

// Gallery photos arrive as Game Boy shades: print them pixel for pixel
function sendPhotosToPrinter(images) {
    images.forEach((image, index) => {
        // Joined photos are taller than a page but already paper wide
        const mode = (image.width <= PRINT_WIDTH && image.height <= PRINT_PAGE_HEIGHT) ? "center"
            : (image.width === PRINT_WIDTH ? "banner" : "fit");
        addQueueItem(shadesToCanvas(image), `Photo ${index + 1}`, "photo", { mode: mode, dither: "none" });
    });
}

// ---- Labels: text and QR codes ----

const LABEL_FONTS = {
    pixel: { family: "'Press Start 2P', monospace", sizes: { s: 8, m: 16, l: 24, xl: 32 } },
    sans: { family: "Arial, Helvetica, sans-serif", sizes: { s: 12, m: 18, l: 28, xl: 40 } },
    serif: { family: "Georgia, 'Times New Roman', serif", sizes: { s: 12, m: 18, l: 28, xl: 40 } },
    mono: { family: "'Courier New', monospace", sizes: { s: 12, m: 18, l: 28, xl: 40 } }
};

function readTextForm() {
    const value = (id, fallback) => {
        const el = document.getElementById(id);
        return el ? el.value : fallback;
    };
    return {
        text: value("print-text", ""),
        font: value("print-text-font", "pixel"),
        size: value("print-text-size", "m"),
        align: value("print-text-align", "center"),
        qr: value("print-qr", "").trim()
    };
}

function fillTextForm(form) {
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el && el.value !== v) el.value = v;
    };
    set("print-text", form.text);
    set("print-text-font", form.font);
    set("print-text-size", form.size);
    set("print-text-align", form.align);
    set("print-qr", form.qr);
}

function wrapText(ctx, text, maxWidth) {
    const lines = [];
    text.split("\n").forEach((paragraph) => {
        let line = "";
        paragraph.split(" ").forEach((word) => {
            const candidate = line ? line + " " + word : word;
            if (ctx.measureText(candidate).width <= maxWidth) {
                line = candidate;
                return;
            }
            if (line) lines.push(line);
            // A word wider than the paper is broken wherever it has to be
            line = "";
            for (const ch of word) {
                if (ctx.measureText(line + ch).width > maxWidth && line) {
                    lines.push(line);
                    line = "";
                }
                line += ch;
            }
        });
        lines.push(line);
    });
    return lines;
}

// Black on white, 160 dots wide, as tall as it needs. Returns null when there is
// nothing to print; throws when the QR text does not fit.
function renderLabel(form) {
    const PAD = 4;
    const font = LABEL_FONTS[form.font] || LABEL_FONTS.pixel;
    const size = font.sizes[form.size] || font.sizes.m;
    const lineHeight = Math.round(size * 1.3);

    const canvas = document.createElement("canvas");
    canvas.width = PRINT_WIDTH;
    const measure = canvas.getContext("2d");
    measure.font = `${size}px ${font.family}`;
    const text = form.text.replace(/\s+$/, "");
    const lines = text ? wrapText(measure, text, PRINT_WIDTH - PAD * 2) : [];

    let qr = null;
    if (form.qr) {
        qr = encodeQr(form.qr);
        if (!qr) throw new Error("QR text is too long. Keep it under about 200 letters.");
    }
    if (!lines.length && !qr) return null;

    // Two quiet modules either side; as many dots per module as fit
    const qrScale = qr ? Math.max(1, Math.floor((PRINT_WIDTH - PAD * 2) / (qr.size + 4))) : 0;
    const qrSide = qr ? qr.size * qrScale : 0;
    const textHeight = lines.length * lineHeight;
    canvas.height = PAD + textHeight + (lines.length && qr ? PAD * 2 : 0) + qrSide + PAD;

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "black";
    ctx.font = `${size}px ${font.family}`;
    ctx.textBaseline = "top";
    ctx.textAlign = form.align;
    const x = form.align === "left" ? PAD : form.align === "right" ? PRINT_WIDTH - PAD : PRINT_WIDTH / 2;
    lines.forEach((line, i) => {
        ctx.fillText(line, x, PAD + i * lineHeight + Math.round((lineHeight - size) / 2));
    });

    if (qr) {
        const top = PAD + textHeight + (lines.length ? PAD * 2 : 0);
        const left = Math.floor((PRINT_WIDTH - qrSide) / 2);
        for (let y = 0; y < qr.size; y++) {
            for (let mx = 0; mx < qr.size; mx++) {
                if (qr.modules[y * qr.size + mx]) ctx.fillRect(left + mx * qrScale, top + y * qrScale, qrScale, qrScale);
            }
        }
    }
    return canvas;
}

async function ensureLabelFont(form) {
    if (form.font !== "pixel" || !document.fonts || !document.fonts.load) return;
    try {
        await document.fonts.load("16px 'Press Start 2P'");
    } catch (e) { /* draw with the fallback */ }
}

function labelName(form) {
    const first = (form.text.trim().split("\n")[0] || "").trim();
    if (first) return first.length > 20 ? first.substring(0, 18) + "..." : first;
    return "QR code";
}

// ---- Text dialog ----

let textEditingId = null;
const EMPTY_LABEL = { text: "", font: "pixel", size: "m", align: "center", qr: "" };

function openTextDialog(editId = null) {
    const item = editId ? printQueue.find(i => i.id === editId) : null;
    textEditingId = item ? item.id : null;
    fillTextForm(item && item.text ? item.text : EMPTY_LABEL);
    const title = document.getElementById("text-popup-title");
    if (title) title.textContent = item ? "Edit Label" : "Text or QR Code";
    const save = document.getElementById("text-save-btn");
    if (save) save.textContent = item ? "Save Label" : "Add to List";
    const popup = document.getElementById("text-popup");
    if (popup) popup.classList.remove("hidden");
    updateLabelPreview();
    const text = document.getElementById("print-text");
    if (text && !isAppleMobile()) text.focus();
}

function closeTextDialog() {
    const popup = document.getElementById("text-popup");
    if (popup) popup.classList.add("hidden");
}

function showLabelError(message) {
    const el = document.getElementById("label-error");
    if (!el) return;
    el.textContent = message || "";
    el.classList.toggle("hidden", !message);
}

// The label as it will print, while typing
let labelTimer = null;
function updateLabelPreview() {
    clearTimeout(labelTimer);
    labelTimer = setTimeout(async () => {
        const preview = document.getElementById("label-preview");
        const form = readTextForm();
        await ensureLabelFont(form);
        let canvas = null;
        try {
            canvas = renderLabel(form);
            showLabelError("");
        } catch (err) {
            showLabelError(err.message);
        }
        if (!preview) return;
        preview.classList.toggle("hidden", !canvas);
        if (canvas) {
            const item = { source: canvas, kind: "text", mode: "banner", rotation: 0, dither: "bw", brightness: 0, contrast: 0 };
            shadesToCanvas(buildPrintImage(item), preview);
        }
    }, 150);
}

async function saveTextDialog() {
    const form = readTextForm();
    await ensureLabelFont(form);
    let canvas;
    try {
        canvas = renderLabel(form);
    } catch (err) {
        showLabelError(err.message);
        return;
    }
    if (!canvas) {
        showLabelError("Type some text or a QR code first.");
        return;
    }
    const item = textEditingId ? printQueue.find(i => i.id === textEditingId) : null;
    if (item) {
        item.source = canvas;
        item.rotated = null;
        item.text = form;
        item.name = labelName(form);
        item.result = null;
        selectedQueueId = item.id;
        renderPrintQueue();
        syncPrinterControls();
        refreshPreview();
    } else {
        addQueueItem(canvas, labelName(form), "text", { mode: "banner", dither: "bw", text: form });
    }
    closeTextDialog();
}

// Editing the form updates the selected label as you type
// ---- Printing ----

let printJob = null;

function shadesToTileData(image, startRow, rows) {
    const out = new Uint8Array((PRINT_WIDTH / 8) * rows * 2);
    let o = 0;
    for (let y = 0; y < rows; y += 8) {
        for (let x = 0; x < PRINT_WIDTH; x += 8) {
            for (let row = 0; row < 8; row++) {
                let byte1 = 0, byte2 = 0;
                const py = startRow + y + row;
                for (let col = 0; col < 8; col++) {
                    const px = x + col;
                    const shade = (py < image.height && px < image.width) ? image.pixels[py * image.width + px] : 0;
                    byte1 |= ((shade & 1) << (7 - col));
                    byte2 |= (((shade >> 1) & 1) << (7 - col));
                }
                out[o++] = byte1;
                out[o++] = byte2;
            }
        }
    }
    return out;
}

function toHex(bytes) {
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return hex;
}

function makePacket(command, data) {
    const packet = new Uint8Array(10 + data.length);
    packet[0] = 0x88;
    packet[1] = 0x33;
    packet[2] = command;
    packet[3] = 0x00;
    packet[4] = data.length & 0xFF;
    packet[5] = data.length >> 8;
    packet.set(data, 6);
    let sum = command + (data.length & 0xFF) + (data.length >> 8);
    for (let i = 0; i < data.length; i++) sum += data[i];
    packet[6 + data.length] = sum & 0xFF;
    packet[7 + data.length] = (sum >> 8) & 0xFF;
    return toHex(packet);
}

// One printer buffer full: INIT, the strips, an empty DATA to end them, PRINT.
// margins: high nibble feeds before, low nibble after; 0 joins the next part on.
function buildPartPackets(tiles, margins, exposure) {
    const CHUNK = 256; // the adapter regroups these into the printer's 640 byte strips
    const packets = [makePacket(0x01, []), makePacket(0x0F, [])];
    for (let i = 0; i < tiles.length; i += CHUNK) packets.push(makePacket(0x04, tiles.subarray(i, i + CHUNK)));
    packets.push(makePacket(0x04, []));
    // The slider follows the Game Boy Camera's exposure bar: right is darker,
    // which is already the direction of the printer's exposure byte
    packets.push(makePacket(0x02, [0x01, margins, 0xE4, exposure]));
    packets.push(makePacket(0x0F, []), makePacket(0x0F, []), makePacket(0x0F, []));
    return packets;
}

// Every part of every copy of every item, in printing order
function planPrintJob(items, spacing) {
    const steps = [];
    const sheets = [];
    items.forEach((item) => {
        const image = buildPrintImage(item);
        for (let copy = 0; copy < item.copies; copy++) sheets.push({ item, image, copy });
    });
    sheets.forEach((sheet, sheetIndex) => {
        const parts = Math.ceil(sheet.image.height / PRINT_PART_ROWS);
        const lastSheet = sheetIndex === sheets.length - 1;
        for (let part = 0; part < parts; part++) {
            const startRow = part * PRINT_PART_ROWS;
            const rows = Math.min(PRINT_PART_ROWS, sheet.image.height - startRow);
            const lastPart = part === parts - 1;
            // Feed 3 lines after a finished sheet so it can be torn off; between
            // parts, and between sheets printed back to back, feed nothing
            const after = lastPart && (lastSheet || spacing === "feed") ? 0x03 : 0x00;
            steps.push({
                sheet: sheetIndex + 1,
                sheets: sheets.length,
                part: part + 1,
                parts: parts,
                name: sheet.item.name,
                tiles: shadesToTileData(sheet.image, startRow, rows),
                margins: after
            });
        }
    });
    return steps;
}

function printSelectedImage() {
    if (printJob || !printQueue.length) return;
    const spacingEl = document.getElementById("print-spacing");
    printJob = {
        steps: planPrintJob(printQueue, spacingEl ? spacingEl.value : "feed"),
        index: 0,
        retries: 0,
        cancelled: false
    };
    runPrintJob();
}

// Send one part and wait for the printer to finish it. Resolves with
// { ok, status, message }.
async function printPart(step, exposure) {
    const packets = buildPartPackets(step.tiles, step.margins, exposure);
    for (const packet of packets) {
        let reply = null;
        try {
            reply = await fetchJson(`/print_chunk?data=${packet}`, PACKET_TIMEOUT_MS);
        } catch (e) { /* reported below */ }
        // The adapter answers "error" when it refuses a packet (queue full, malformed)
        if (!reply || reply.result !== "ok") return { ok: false, message: "Could not send the image to the adapter." };
        await sleep(20);
    }

    // Runs the burst; replies once it is out. If the reply is lost (the phone
    // locked, the request timed out) the polls below still push out whatever is
    // queued, since each one is a done=1 too - so keep going on an unknown status.
    const poll = () => queryPrinterStatus().catch(() => undefined);
    let status = await poll();

    // Busy while the head burns the part; idle again once the paper stops
    const started = Date.now();
    let idleSeen = 0;
    while (true) {
        if (status !== undefined) {
            showPrinterStatus(status);
            if (status === PRINTER_DISCONNECTED) return { ok: false, status, message: printerStatusAdvice(status) };
            if (status & PRINTER_ERROR_MASK) return { ok: false, status, message: printerStatusAdvice(status) || decodePrinterStatus(status) };
            if (!(status & (PRINTER_BUSY | PRINTER_FULL))) {
                // Twice in a row, so a status taken just before the motor starts
                // does not count as finished. Past the deadline once is enough:
                // after the lock screen the job may have finished long ago.
                if (++idleSeen >= 2 || status === 0 || Date.now() - started > PART_TIMEOUT_MS) return { ok: true, status };
            } else {
                idleSeen = 0;
            }
        }
        if (Date.now() - started > PART_TIMEOUT_MS) {
            return {
                ok: false,
                status,
                message: status === undefined
                    ? "Lost the connection to the adapter."
                    : "The printer did not finish in time. Check it is switched on and has paper."
            };
        }
        await sleep(1000);
        status = await poll();
    }
}

async function runPrintJob() {
    const job = printJob;
    if (!job) return;
    isPrintingActive = true;
    // Let a status poll already on its way finish first (see printerPollInFlight)
    await (printerPollInFlight || Promise.resolve());

    while (job.index < job.steps.length) {
        if (job.cancelled) break;
        const step = job.steps[job.index];
        const where = step.sheets > 1 ? `Sheet ${step.sheet} of ${step.sheets}` : "";
        const part = step.parts > 1 ? `part ${step.part} of ${step.parts}` : "";
        setPrintOverlay(true, "Printing...", [where, part].filter(Boolean).join(", "), false);

        const result = await printPart(step, currentPrintExposure());
        if (result.ok) {
            job.index++;
            job.retries = 0;
            continue;
        }
        // A garbled transfer is worth one quiet retry before bothering anyone
        if (result.status !== undefined && result.status !== PRINTER_DISCONNECTED &&
            (result.status & 0x11) && !(result.status & 0xE0) && job.retries < 1) {
            job.retries++;
            continue;
        }
        // Stopped: Resume prints this part again
        isPrintingActive = false;
        setPrintOverlay(true, "Printing stopped", result.message || "Something went wrong.", true);
        return;
    }

    isPrintingActive = false;
    printJob = null;
    setPrintOverlay(false);
    pollPrinterStatus();
}

function resumePrintJob() {
    if (!printJob) {
        setPrintOverlay(false);
        return;
    }
    printJob.retries = 0;
    runPrintJob();
}

function cancelPrintJob() {
    if (!printJob) {
        setPrintOverlay(false);
        return;
    }
    if (isPrintingActive) {
        // The part on its way cannot be called back; stop after it
        printJob.cancelled = true;
        setPrintOverlay(true, "Cancelling...", "Stopping after the current part.", false);
        return;
    }
    printJob = null;
    setPrintOverlay(false);
    pollPrinterStatus();
}

function setupPrinter() {
    // Back from the lock screen: look at the printer now rather than at the next poll
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && !printJob) pollPrinterStatus();
    });
    const dither = document.getElementById("print-dither");
    if (dither) dither.addEventListener("change", updatePrintSettings);
    ["print-brightness", "print-contrast"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", updatePrintSettings);
    });
    document.querySelectorAll("[data-layout]").forEach((b) => {
        b.addEventListener("click", () => setPrintLayout(b.dataset.layout));
    });
    ["print-text", "print-qr"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("input", updateLabelPreview);
    });
    ["print-text-font", "print-text-size", "print-text-align"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("change", updateLabelPreview);
    });
    renderPrintQueue();
    syncPrinterControls();
    renderPrintPreview(currentPrintExposure());
}

document.addEventListener("DOMContentLoaded", setupPrinter);

window.handleFileInput = handleFileInput;
window.refreshPreview = refreshPreview;
window.refreshExposure = refreshExposure;
window.printSelectedImage = printSelectedImage;
window.rotatePrintItem = rotatePrintItem;
window.resetPrintAdjustments = resetPrintAdjustments;
window.clearPrintQueue = clearPrintQueue;
window.openTextDialog = openTextDialog;
window.closeTextDialog = closeTextDialog;
window.saveTextDialog = saveTextDialog;
window.resumePrintJob = resumePrintJob;
window.cancelPrintJob = cancelPrintJob;
