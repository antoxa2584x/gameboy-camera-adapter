// Minimal ZIP writer for "Save All". Entries are stored, not deflated: the
// photos inside are PNG or JPEG and already compressed, so deflate would only
// cost time. entries: [{ name, data: Uint8Array, date: Date }]. Uses crc32()
// from script.js.
function buildZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;

    const dosTime = (d) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (d) => ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    entries.forEach((entry) => {
        const name = new TextEncoder().encode(entry.name);
        const date = entry.date || new Date();
        const crc = crc32(entry.data);

        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);         // version needed
        lv.setUint16(6, 0x0800, true);     // names are UTF-8
        lv.setUint16(8, 0, true);          // stored
        lv.setUint16(10, dosTime(date), true);
        lv.setUint16(12, dosDate(date), true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, entry.data.length, true);
        lv.setUint32(22, entry.data.length, true);
        lv.setUint16(26, name.length, true);
        local.set(name, 30);

        const header = new Uint8Array(46 + name.length);
        const cv = new DataView(header.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);         // version made by
        cv.setUint16(6, 20, true);         // version needed
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, dosTime(date), true);
        cv.setUint16(14, dosDate(date), true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, entry.data.length, true);
        cv.setUint32(24, entry.data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);    // where the local header starts
        header.set(name, 46);

        parts.push(local, entry.data);
        central.push(header);
        offset += local.length + entry.data.length;
    });

    const centralSize = central.reduce((total, h) => total + h.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob(parts.concat(central, [end]), { type: "application/zip" });
}
