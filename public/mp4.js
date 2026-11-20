const bytes = (...values) => Uint8Array.of(...values);
const ascii = value => Uint8Array.from(value, char => char.charCodeAt(0));
const sampleSize = sample => sample.data.size ?? sample.data.byteLength;
const zeros = length => new Uint8Array(length);
function int(value, size = 4) {
  const data = zeros(size);
  if (size === 2) new DataView(data.buffer).setUint16(0, value);
  else new DataView(data.buffer).setUint32(0, value);
  return data;
}
const short = value => int(value, 2);
function join(parts) {
  const data = zeros(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  return data;
}
const box = (name, ...parts) => join([int(8 + parts.reduce((n, p) => n + p.length, 0)), ascii(name), ...parts]);
const full = (name, flags, ...parts) => box(name, int(flags), ...parts);
const matrix = join([int(65536), zeros(12), int(65536), zeros(12), int(1073741824)]);
function descriptor(tag, ...parts) {
  const data = join(parts);
  const length = [data.length & 127];
  for (let remaining = data.length >>> 7; remaining; remaining >>>= 7) {
    length.unshift(128 | (remaining & 127));
  }
  return join([bytes(tag, ...length), data]);
}
function sampleEntry(track) {
  const base = join([zeros(6), short(1)]);
  if (track.width) {
    return box('avc1', base, zeros(16), short(track.width), short(track.height),
      int(72 << 16), int(72 << 16), zeros(4), short(1), zeros(32), short(24), short(65535),
      box('avcC', track.description));
  }
  const config = descriptor(4, bytes(64, 21), zeros(3), int(track.bitrate), int(track.bitrate),
    descriptor(5, track.description));
  return box('mp4a', base, zeros(8), short(track.channels), short(16), zeros(4),
    int(track.timescale * 65536),
    full('esds', 0, descriptor(3, short(2), bytes(0), config, descriptor(6, bytes(2)))));
}
function trackBox(track, id, offset) {
  const video = Boolean(track.width);
  const durations = [];
  const keyframes = [];
  const sizes = [];
  for (const [index, sample] of track.samples.entries()) {
    const last = durations.at(-1);
    if (last?.duration === sample.duration) last.count++;
    else durations.push({ count: 1, duration: sample.duration });
    sizes.push(sampleSize(sample));
    if (sample.key) keyframes.push(index + 1);
  }
  const table = box('stbl',
    full('stsd', 0, int(1), sampleEntry(track)),
    full('stts', 0, int(durations.length), ...durations.map(run => join([int(run.count), int(run.duration)]))),
    full('stsc', 0, int(1), int(1), int(sizes.length), int(1)),
    full('stsz', 0, int(0), int(sizes.length), uintTable(sizes)),
    full('stco', 0, int(1), int(offset)),
    ...(video ? [full('stss', 0, int(keyframes.length), uintTable(keyframes))] : []));
  const minf = box('minf', video ? full('vmhd', 1, zeros(8)) : full('smhd', 0, zeros(4)),
    box('dinf', full('dref', 0, int(1), full('url ', 1))), table);
  return box('trak',
    full('tkhd', 7, zeros(8), int(id), zeros(4), int(track.movieDuration), zeros(12),
      short(video ? 0 : 256), zeros(2), matrix, int((track.width || 0) * 65536), int((track.height || 0) * 65536)),
    box('mdia', full('mdhd', 0, zeros(8), int(track.timescale), int(track.duration), short(21956), zeros(2)),
      full('hdlr', 0, zeros(4), ascii(video ? 'vide' : 'soun'), zeros(12), ascii(video ? 'Video\0' : 'Audio\0')),
      minf));
}
function uintTable(values) {
  const result = new Uint8Array(values.length * 4);
  const view = new DataView(result.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return result;
}
export function makeMp4(video, audio) {
  const movieScale = 1000;
  for (const track of [video, audio]) {
    if (!track.description?.length || !track.samples.length) throw new Error('The encoder returned an incomplete track.');
    track.duration = track.samples.reduce((total, sample) => total + sample.duration, 0);
    track.movieDuration = Math.max(1, Math.round(track.duration / track.timescale * movieScale));
  }
  const ftyp = box('ftyp', ascii('isom'), int(512), ascii('isomiso2avc1mp41'));
  const videoBytes = video.samples.reduce((total, sample) => total + sampleSize(sample), 0);
  const audioBytes = audio.samples.reduce((total, sample) => total + sampleSize(sample), 0);
  const mvhd = full('mvhd', 0, zeros(8), int(movieScale), int(Math.max(video.movieDuration, audio.movieDuration)),
    int(65536), short(256), zeros(10), matrix, zeros(24), int(3));
  const moov = box('moov', mvhd, trackBox(video, 1, ftyp.length + 8), trackBox(audio, 2, ftyp.length + 8 + videoBytes));
  return new Blob([ftyp, int(8 + videoBytes + audioBytes), ascii('mdat'),
    ...video.samples.map(sample => sample.data), ...audio.samples.map(sample => sample.data), moov], { type: 'video/mp4' });
}
