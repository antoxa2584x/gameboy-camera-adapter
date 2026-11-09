// QR code encoder for printed labels: byte mode, error correction level M,
// versions 1 to 10. Version 10 is 57 modules wide, which still leaves every
// module 2 printer dots across the 160 dot paper; anything bigger would print
// too fine to scan. Follows the structure of Project Nayuki's reference encoder.
const QR_MAX_VERSION = 10;
// Level M, indexed by version (index 0 unused)
const QR_ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const QR_ECC_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const QR_FORMAT_ECL_M = 0;

function qrRawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}

function qrDataCodewords(ver) {
    return Math.floor(qrRawDataModules(ver) / 8) - QR_ECC_PER_BLOCK[ver] * QR_ECC_BLOCKS[ver];
}

// GF(2^8) multiply modulo x^8 + x^4 + x^3 + x^2 + 1
function qrMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}

function qrDivisor(degree) {
    const result = new Array(degree - 1).fill(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = qrMultiply(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = qrMultiply(root, 0x02);
    }
    return result;
}

function qrRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    data.forEach((b) => {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= qrMultiply(coef, factor); });
    });
    return result;
}

// Split into blocks, add Reed-Solomon codewords to each, interleave
function qrInterleave(data, ver) {
    const numBlocks = QR_ECC_BLOCKS[ver];
    const eccLen = QR_ECC_PER_BLOCK[ver];
    const rawCodewords = Math.floor(qrRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - rawCodewords % numBlocks;
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const divisor = qrDivisor(eccLen);

    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        const ecc = qrRemainder(dat, divisor);
        if (i < numShortBlocks) dat.push(0);
        blocks.push(dat.concat(ecc));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            // the padding byte of short blocks is not a real codeword
            if (i !== shortBlockLen - eccLen || j >= numShortBlocks) result.push(block[i]);
        });
    }
    return result;
}

function qrAlignmentPositions(ver, size) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
}

const QR_MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];

// The standard's mask penalty: long runs, 2x2 blocks, finder look-alikes and
// a lopsided dark/light balance all make a code harder to scan
function qrPenalty(modules, size) {
    let score = 0;
    const at = (x, y) => modules[y * size + x];

    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            let run = 1;
            for (let b = 1; b <= size; b++) {
                const same = b < size && (pass ? at(a, b) === at(a, b - 1) : at(b, a) === at(b - 1, a));
                if (same) {
                    run++;
                } else {
                    if (run >= 5) score += 3 + (run - 5);
                    run = 1;
                }
            }
        }
    }

    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const c = at(x, y);
            if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) score += 3;
        }
    }

    const PATTERN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const PATTERN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            for (let b = 0; b + 11 <= size; b++) {
                let matchA = true, matchB = true;
                for (let k = 0; k < 11 && (matchA || matchB); k++) {
                    const m = pass ? at(a, b + k) : at(b + k, a);
                    if (m !== PATTERN_A[k]) matchA = false;
                    if (m !== PATTERN_B[k]) matchB = false;
                }
                if (matchA) score += 40;
                if (matchB) score += 40;
            }
        }
    }

    let dark = 0;
    for (let i = 0; i < modules.length; i++) dark += modules[i];
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
}

// Returns { size, modules } with modules[y * size + x] = 1 for dark, or null
// when the text does not fit in a version 10 code
function encodeQr(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    for (; ver <= QR_MAX_VERSION; ver++) {
        const countBits = ver < 10 ? 8 : 16;
        if (4 + countBits + bytes.length * 8 <= qrDataCodewords(ver) * 8) break;
    }
    if (ver > QR_MAX_VERSION) return null;

    const bits = [];
    const put = (value, length) => {
        for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    put(0x4, 4); // byte mode
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const capacity = qrDataCodewords(ver) * 8;
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - bits.length % 8) % 8);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        data.push(b);
    }
    for (let pad = 0xEC; data.length < capacity / 8; pad ^= 0xEC ^ 0x11) data.push(pad);

    const codewords = qrInterleave(data, ver);
    const size = ver * 4 + 17;
    const modules = new Uint8Array(size * size);
    const isFunction = new Uint8Array(size * size);
    const setFunction = (x, y, dark) => {
        modules[y * size + x] = dark ? 1 : 0;
        isFunction[y * size + x] = 1;
    };

    for (let i = 0; i < size; i++) {
        setFunction(6, i, i % 2 === 0);
        setFunction(i, 6, i % 2 === 0);
    }

    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4);
            }
        }
    });

    const align = qrAlignmentPositions(ver, size);
    const last = align.length - 1;
    align.forEach((ay, i) => {
        align.forEach((ax, j) => {
            if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        });
    });

    const drawFormat = (mask) => {
        const value = (QR_FORMAT_ECL_M << 3) | mask;
        let rem = value;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const fmt = ((value << 10) | rem) ^ 0x5412;
        const bit = (i) => ((fmt >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
        setFunction(8, 7, bit(6));
        setFunction(8, 8, bit(7));
        setFunction(7, 8, bit(8));
        for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));
        setFunction(8, size - 8, true);
    };
    drawFormat(0); // reserves the area; redrawn once the mask is chosen

    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        const info = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const dark = ((info >>> i) & 1) !== 0;
            const a = size - 11 + i % 3, b = Math.floor(i / 3);
            setFunction(a, b, dark);
            setFunction(b, a, dark);
        }
    }

    // Codewords zig-zag up and down two-module columns from the right
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunction[y * size + x] && i < codewords.length * 8) {
                    modules[y * size + x] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
                    i++;
                }
            }
        }
    }

    const applyMask = (mask) => {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (!isFunction[y * size + x] && QR_MASKS[mask](x, y)) modules[y * size + x] ^= 1;
            }
        }
    };

    let bestMask = 0, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        applyMask(mask);
        drawFormat(mask);
        const score = qrPenalty(modules, size);
        if (score < bestScore) {
            bestScore = score;
            bestMask = mask;
        }
        applyMask(mask); // XOR again to undo
    }
    applyMask(bestMask);
    drawFormat(bestMask);

    return { size: size, modules: modules };
}
