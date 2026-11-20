const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});
function header(size, fields) {
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  for (const [offset, value, width = 2] of fields) {
    if (width === 4) view.setUint32(offset, value, true);
    else view.setUint16(offset, value, true);
  }
  return data;
}
export async function makeZip(entries) {
  const files = [];
  const central = [];
  let offset = 0;
  let directorySize = 0;
  if (entries.length > 65535 || entries.reduce((total, item) => total + item.blob.size + 1024, 0) >= 0xffffffff) {
    throw new Error('This batch is too large for a ZIP. Download the videos individually.');
  }
  for (const { name, blob } of entries) {
    const label = new TextEncoder().encode(name);
    let crc = 0xffffffff;
    for await (const chunk of blob.stream()) {
      for (const value of chunk) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    files.push(header(30, [[0, 0x04034b50, 4], [4, 20], [6, 2048], [12, 33], [14, crc, 4],
      [18, blob.size, 4], [22, blob.size, 4], [26, label.length]]), label, blob);
    central.push(header(46, [[0, 0x02014b50, 4], [4, 20], [6, 20], [8, 2048], [14, 33],
      [16, crc, 4], [20, blob.size, 4], [24, blob.size, 4], [28, label.length], [42, offset, 4]]), label);
    offset += 30 + label.length + blob.size;
    directorySize += 46 + label.length;
  }
  return new Blob([...files, ...central, header(22, [[0, 0x06054b50, 4], [8, entries.length],
    [10, entries.length], [12, directorySize, 4], [16, offset, 4]])], { type: 'application/zip' });
}
