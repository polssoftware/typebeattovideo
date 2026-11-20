import { makeZip } from './zip.js';
const $ = id => document.getElementById(id);
const defaults = { resolution: '1920x1080', scale: 'fit', fps: '1', bitrate: '320',
  gif: 'still', concurrent: '1', prefix: '', suffix: '', quick: false, pair: true, name: true, autoDownload: false, low: false };
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem('image2video-settings')) ?? {}); } catch {}
const rows = [];
const artwork = new Map();
const artworkDragType = 'application/x-image2video-artwork';
let artworkId = 0;
let selectedArtwork;
let selected;
let previewRow;
let previewStillUrl;
let pendingPreview;
const visualAccept = '.png,.jpg,.jpeg,.webp,.gif,.bmp,.avif,.mp4,.mov,.webm,.mkv,.m4v';
const audioAccept = '.mp3,.wav,.m4a,.flac,.ogg,.aac,.opus';
const isVideo = file => Boolean(file && (/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name) ||
  (file.type.startsWith('video/') && !/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(file.name))));
function visualMode(file) {
  if (isVideo(file)) return 'video';
  if (settings.gif === 'loop' && /\.gif$/i.test(file.name)) return 'gif';
  return 'still';
}
let zipBusy = false;
let batch = new Set();
let idleCompatibility;
const busy = row => ['queued', 'rendering'].includes(row.status);
const canRender = row => row.image && row.audio && !row.loading && !row.badImage && !busy(row) && row.status !== 'completed';
const basename = name => name.replace(/\.[^.]+$/, '');
const durationText = seconds => {
  if (!Number.isFinite(seconds)) return 'Unknown duration';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return (hours ? hours + ':' : '') + String(minutes).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};
const size = value => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB';
function fileType(file) {
  if (isVideo(file) || file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(file.name)) return 'image';
  if (file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(file.name)) return 'audio';
}
function safeName(input) {
  const stem = input.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.mp4$/i, '')
    .trim().replace(/[. ]+$/, '').slice(0, 100).trim().replace(/[. ]+$/, '') || 'Video';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? '_' + stem : stem;
}
function outputName(row) {
  const used = new Set();
  for (const entry of rows) {
    const stem = safeName(settings.prefix + (entry.name.trim() || 'Video') + settings.suffix);
    let name = stem + '.mp4';
    for (let n = 2; used.has(name.toLowerCase()); n++) name = stem + ' (' + n + ').mp4';
    if (entry === row) return name;
    used.add(name.toLowerCase());
  }
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label, handler, disabled = false, className = '') {
  const el = element('button', className, label);
  el.onclick = handler;
  el.disabled = disabled;
  return el;
}
function addArtwork(file) {
  for (const asset of artwork.values()) {
    if (asset.file === file) return asset;
  }
  const id = String(++artworkId);
  const url = URL.createObjectURL(file);
  const tile = element('div', 'artwork-tile');
  const choose = button('', () => selectArtwork(selectedArtwork?.id === id ? null : id), false, 'artwork-choice');
  choose.title = file.name;
  choose.setAttribute('aria-pressed', 'false');
  choose.draggable = true;
  choose.ondragstart = event => {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(artworkDragType, id);
  };
  const thumbnail = visualThumbnail(file, url);
  choose.append(thumbnail, element('span', '', file.name));
  const remove = button('×', () => {
    if (selectedArtwork?.id === id) selectArtwork(null);
    artwork.delete(id);
    URL.revokeObjectURL(url);
    tile.remove();
    refreshArtworkTray();
  }, false, 'artwork-remove');
  remove.setAttribute('aria-label', 'Remove ' + file.name + ' from artwork tray');
  tile.append(choose, remove);
  $('artwork-items').append(tile);
  const asset = { id, file, choose, url };
  artwork.set(id, asset);
  refreshArtworkTray();
  return asset;
}
function refreshArtworkTray() {
  $('artwork-empty').hidden = artwork.size > 0;
  $('clear-artwork').disabled = !artwork.size;
}
function visualThumbnail(file, url, className) {
  const thumbnail = element(isVideo(file) ? 'video' : 'img', className);
  thumbnail.draggable = false;
  if (isVideo(file)) {
    thumbnail.muted = true;
    thumbnail.playsInline = true;
    thumbnail.preload = 'metadata';
    thumbnail.src = url + '#t=0.01';
    thumbnail.onerror = () => {
      const placeholder = element('div', (className || '') + ' clip-placeholder', 'Video');
      thumbnail.replaceWith(placeholder);
    };
  } else {
    thumbnail.alt = '';
    thumbnail.src = url;
  }
  return thumbnail;
}
function selectArtwork(id) {
  selectedArtwork?.choose.setAttribute('aria-pressed', 'false');
  selectedArtwork = artwork.get(id);
  selectedArtwork?.choose.setAttribute('aria-pressed', 'true');
  for (const row of rows) updateArtworkAction(row);
}
function updateArtworkAction(row) {
  row.assignArtwork.hidden = !selectedArtwork || !row.audio || busy(row);
  row.assignArtwork.title = selectedArtwork?.file.name ?? '';
}
function assignArtwork(row, asset) {
  if (!asset || !row.audio || busy(row) || row.image === asset.file) return;
  if (row.blob && !row.downloaded && !confirm('Replace the artwork and discard this undownloaded MP4?')) return;
  setMedia(row, 'image', asset.file);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function downloadRow(row) {
  download(row.blob, outputName(row));
  row.downloaded = true;
}
function hint(message = '') { $('notice').textContent = message; }
function makeRow() {
  const row = { status: 'waiting', name: '', progress: 0, el: element('article', 'item') };
  row.el.tabIndex = 0;
  row.el.addEventListener('focusin', () => { selected = row; });
  dropTarget(row.el, files => {
    const updates = {};
    const extra = [];
    for (const file of files) {
      const kind = fileType(file);
      if (kind && !updates[kind] && (kind === 'image' || !row.audio)) updates[kind] = file;
      else extra.push(file);
    }
    if (updates.audio) setMedia(row, 'audio', updates.audio);
    if (updates.image) {
      const asset = addArtwork(updates.image);
      if (row.audio) assignArtwork(row, asset);
      else setMedia(row, 'image', asset.file);
    }
    if (extra.length) importFiles(extra);
  }, row);
  rows.push(row);
  draw(row);
  arrange();
  return row;
}
function arrange() {
  for (const [index, row] of rows.entries()) {
    $('items').append(row.el);
    row.up.disabled = index === 0;
    row.down.disabled = index === rows.length - 1;
  }
  refresh();
}
function move(row, delta) {
  const index = rows.indexOf(row);
  rows.splice(index, 1);
  rows.splice(index + delta, 0, row);
  arrange();
  row.el.focus();
}
function refresh() {
  $('count').textContent = String(rows.length);
  $('empty').hidden = rows.length > 0;
  const done = rows.filter(row => row.status === 'completed').length;
  $('queue-summary').textContent = rows.length ? done + ' completed · ' + rows.filter(canRender).length + ' ready to render' : 'Add one pair or render a batch.';
  $('render-all').disabled = !rows.some(canRender);
  $('clear').disabled = !rows.length;
  $('zip').disabled = !done || zipBusy;
  const active = rows.some(busy);
  $('overall').hidden = !active;
  $('overall').value = batch.size ? [...batch].reduce((sum, row) => sum +
    (row.status === 'rendering' ? row.progress : row.status === 'queued' ? 0 : 1), 0) / batch.size : 0;
}
function attachPicker(row, kind) {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = kind === 'image' ? visualAccept : audioAccept;
  picker.onchange = () => {
    const file = picker.files[0];
    if (!file || busy(row)) return;
    if (fileType(file) !== kind) {
      hint(kind === 'image' ? 'Choose a supported image or video file.' : 'Choose a supported audio file.');
      return;
    }
    if (kind === 'image' && row.audio) assignArtwork(row, addArtwork(file));
    else {
      if (kind === 'image') addArtwork(file);
      setMedia(row, kind, file);
    }
  };
  picker.click();
}
function draw(row) {
  const locked = busy(row);
  const art = row.imageUrl ? visualThumbnail(row.image, row.imageUrl, 'art') : element('div', 'art', '♫');
  const body = element('div', 'item-body');
  const title = element('h3', 'track-title', row.audio?.name || 'New audio track');
  const field = element('label', 'field', 'Output');
  const name = element('input');
  name.placeholder = 'Video';
  name.value = row.name;
  name.maxLength = 100;
  name.oninput = () => { row.name = name.value; row.customName = true; };
  name.disabled = locked;
  field.append(name, element('span', '', '.mp4'));
  const media = element('div', 'media-row');
  for (const kind of ['image', 'audio']) {
    const mediaLabel = kind === 'image' ? 'visual' : 'audio';
    const label = row[kind]?.name || 'Add ' + mediaLabel;
    const choose = button(label, () => attachPicker(row, kind), locked);
    choose.title = row[kind] ? 'Replace ' + mediaLabel + ': ' + label : label;
    media.append(choose);
    if (row[kind]) {
      const remove = button('×', () => setMedia(row, kind, null), locked, 'quiet');
      remove.setAttribute('aria-label', 'Remove ' + mediaLabel);
      media.append(remove);
    }
  }
  row.assignArtwork = button('Use selected artwork', () => assignArtwork(row, selectedArtwork), false, 'assign-artwork');
  updateArtworkAction(row);
  media.append(row.assignArtwork);
  const bottom = element('div', 'item-bottom');
  row.detail = element('div', 'status');
  row.bar = element('progress');
  row.bar.max = 1;
  row.bar.setAttribute('aria-label', 'Render progress');
  const actions = element('div', 'actions');
  row.up = button('↑', () => move(row, -1), false, 'quiet');
  row.up.setAttribute('aria-label', 'Move item up');
  row.down = button('↓', () => move(row, 1), false, 'quiet');
  row.down.setAttribute('aria-label', 'Move item down');
  actions.append(row.up, row.down, button('Preview', () => preview(row), !row.image || !row.audio || row.badImage, 'quiet'));
  if (locked) actions.append(button('Cancel', () => cancel(row)));
  else if (row.blob) actions.append(button('Download MP4', () => downloadRow(row), false, 'primary'));
  else actions.append(button(['failed', 'cancelled'].includes(row.status) ? 'Retry' : 'Render', () => enqueue([row]), !canRender(row)));
  actions.append(button('Remove', () => removeRow(row), locked, 'quiet'));
  bottom.append(row.detail, actions);
  body.append(title, media, field, bottom, row.bar);
  row.el.replaceChildren(art, body);
  const index = rows.indexOf(row);
  row.up.disabled = index === 0;
  row.down.disabled = index === rows.length - 1;
  updateDetail(row);
}
function updateDetail(row) {
  const renderTime = row.started ? ((row.finished || performance.now()) - row.started) / 1000 : 0;
  const state = { waiting: row.loading ? 'Reading files…' : 'Waiting', ready: 'Ready',
    queued: 'Queued', rendering: row.stage + (row.progress ? ' ' + Math.floor(row.progress * 100) + '%' : ''),
    completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[row.status];
  row.detail.textContent = [state, row.duration ? durationText(row.duration) : '', row.blob ? size(row.blob.size) : '',
    row.started ? renderTime.toFixed(1) + ' s render' : '', row.error || ''].filter(Boolean).join(' · ');
  row.detail.classList.toggle('error', Boolean(row.error));
  row.bar.hidden = row.status !== 'rendering' || !row.progress;
  row.bar.value = row.progress;
}
function readAudio(url) {
  return new Promise(resolve => {
    const audio = document.createElement('audio');
    const done = duration => { clearTimeout(timer); audio.removeAttribute('src'); audio.load(); resolve(duration); };
    const timer = setTimeout(() => done(NaN), 8000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(NaN);
    audio.src = url;
  });
}
async function setMedia(row, kind, file) {
  const key = kind + 'Url';
  if (row[key]) URL.revokeObjectURL(row[key]);
  row[kind] = file;
  row[key] = file ? URL.createObjectURL(file) : '';
  const url = row[key];
  row.status = 'waiting';
  row.blob = null;
  row.exportSettings = null;
  row.exportDimensions = null;
  row.downloaded = false;
  row.error = '';
  row.started = row.finished = 0;
  if (kind === 'audio') {
    row.duration = NaN;
    row.audioLoading = Boolean(file);
    if (!row.customName && settings.name) row.name = file ? basename(file.name) : '';
  } else {
    row.badImage = false;
    row.imageLoading = Boolean(file) && !isVideo(file);
  }
  row.loading = row.audioLoading || row.imageLoading;
  draw(row);
  refresh();
  if (file && kind === 'audio') {
    const duration = await readAudio(url);
    if (row[key] !== url || !rows.includes(row)) return;
    row.duration = duration;
    row.audioLoading = false;
  }
  if (file && kind === 'image' && !isVideo(file)) {
    try { const image = await createImageBitmap(file); image.close(); }
    catch { if (row[key] === url) row.badImage = true; }
    if (row[key] !== url || !rows.includes(row)) return;
    row.imageLoading = false;
  }
  row.loading = row.audioLoading || row.imageLoading;
  row.status = row.image && row.audio && !row.loading && !row.badImage ? 'ready' : 'waiting';
  row.error = row.badImage ? 'This artwork could not be decoded. Try PNG or JPEG.' : '';
  draw(row);
  refresh();
  if (settings.quick && row.status === 'ready') enqueue([row]);
}
function importFiles(files) {
  hint();
  const rejected = [];
  for (const file of files) {
    const kind = fileType(file);
    if (kind === 'image') addArtwork(file);
    else if (kind === 'audio') {
      const row = rows.find(item => !item.audio && !busy(item)) || makeRow();
      setMedia(row, 'audio', file);
    } else rejected.push(file.name);
  }
  if (rejected.length) hint('Unsupported files: ' + rejected.join(', '));
  if (!settings.pair) return;
  const unpaired = rows.filter(row => row.audio && !row.image && !busy(row));
  for (const row of unpaired) {
    const stem = basename(row.audio.name).toLowerCase();
    const matches = [...artwork.values()].filter(asset => basename(asset.file.name).toLowerCase() === stem);
    if (matches.length === 1) assignArtwork(row, matches[0]);
  }
  if (artwork.size === 1 && rows.filter(row => row.audio).length === 1) {
    const row = unpaired[0];
    if (row && !row.image) assignArtwork(row, artwork.values().next().value);
  }
}
function dropTarget(target, callback, row) {
  const acceptsArtwork = event => row?.audio && event.dataTransfer.types.includes(artworkDragType);
  target.ondragover = event => {
    if (row && busy(row)) return;
    if (!acceptsArtwork(event) && !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    target.classList.add('over');
  };
  target.ondragleave = event => { if (!target.contains(event.relatedTarget)) target.classList.remove('over'); };
  target.ondrop = event => {
    event.preventDefault();
    event.stopPropagation();
    target.classList.remove('over');
    if (row && busy(row)) return;
    if (acceptsArtwork(event)) assignArtwork(row, artwork.get(event.dataTransfer.getData(artworkDragType)));
    else if (event.dataTransfer.files.length) callback([...event.dataTransfer.files]);
  };
}
function previewDimensions(prefs, sourceWidth, sourceHeight) {
  if (prefs.resolution !== 'original') return prefs.resolution.split('x').map(Number);
  if (!sourceWidth || !sourceHeight) return [];
  const limit = Math.min(1, 4096 / Math.max(sourceWidth, sourceHeight));
  return [sourceWidth, sourceHeight].map(value => Math.max(2, Math.round(value * limit / 2) * 2));
}
function updatePreviewSize(width, height) {
  const prefs = previewRow.exportSettings ?? settings;
  const [w, h] = previewRow.exportDimensions ?? previewDimensions(prefs, width, height);
  $('preview-resolution').textContent = w ? 'Export resolution: ' + w + ' × ' + h : 'Export resolution: original size';
  const frame = $('preview-frame');
  frame.style.aspectRatio = w ? w + ' / ' + h : '16 / 9';
  frame.style.width = w ? 'min(100%, ' + (52 * w / h) + 'vh)' : '100%';
  const fit = { fit: 'contain', fill: 'cover', stretch: 'fill' }[prefs.scale];
  $('preview-art').style.objectFit = $('preview-video').style.objectFit = fit;
}
async function preview(row) {
  previewRow = row;
  const request = pendingPreview = {};
  const audio = $('preview-audio');
  const image = $('preview-art');
  const video = $('preview-video');
  const prefs = row.exportSettings ?? settings;
  $('preview-error').textContent = '';
  audio.src = row.audioUrl;
  image.hidden = isVideo(row.image);
  video.hidden = !image.hidden;
  updatePreviewSize();
  $('preview').showModal();
  if (!video.hidden) {
    video.src = row.imageUrl;
    return;
  }
  if (!/\.gif$/i.test(row.image.name) || prefs.gif === 'loop') {
    image.src = row.imageUrl;
    return;
  }
  try {
    const bitmap = await createImageBitmap(row.image);
    let still;
    try {
      if (pendingPreview !== request || !$('preview').open) return;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      still = await canvas.convertToBlob();
    } finally { bitmap.close(); }
    if (pendingPreview !== request || !$('preview').open) return;
    previewStillUrl = URL.createObjectURL(still);
    image.src = previewStillUrl;
  } catch {
    if (pendingPreview === request && $('preview').open) $('preview-error').textContent = 'The GIF preview could not be opened.';
  }
}
$('preview-art').onload = () => {
  const image = $('preview-art');
  if (previewRow) updatePreviewSize(image.naturalWidth, image.naturalHeight);
};
$('preview-video').onloadedmetadata = () => {
  const video = $('preview-video');
  if (previewRow) updatePreviewSize(video.videoWidth, video.videoHeight);
  syncPreviewVideo(true);
};
$('preview-video').onerror = () => {
  if (previewRow) $('preview-error').textContent = 'This browser cannot preview this clip. You can still try exporting it.';
};
function syncPreviewVideo(seek = false) {
  const audio = $('preview-audio');
  const video = $('preview-video');
  if (video.hidden || !Number.isFinite(video.duration) || video.duration <= 0) return;
  const time = audio.currentTime % video.duration;
  if (seek || Math.abs(time - video.currentTime) > .35) video.currentTime = time;
  if (audio.paused || audio.ended) video.pause();
  else if (video.paused) video.play().catch(() => {});
}
$('preview-audio').onplay = $('preview-audio').onseeked = () => syncPreviewVideo(true);
$('preview-audio').onpause = $('preview-audio').ontimeupdate = () => syncPreviewVideo();
$('preview').onclose = () => {
  previewRow = null;
  pendingPreview = null;
  const image = $('preview-art');
  image.removeAttribute('src');
  if (previewStillUrl) URL.revokeObjectURL(previewStillUrl);
  previewStillUrl = null;
  for (const id of ['preview-audio', 'preview-video']) {
    const media = $(id);
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
};
function removeRow(row) {
  if (row === previewRow) $('preview').close();
  for (const url of [row.imageUrl, row.audioUrl]) if (url) URL.revokeObjectURL(url);
  rows.splice(rows.indexOf(row), 1);
  batch.delete(row);
  row.el.remove();
  if (selected === row) selected = null;
  arrange();
}
function compatibilityWorker() {
  if (!idleCompatibility) return new Worker('./fallback-worker.js');
  const { worker, timer } = idleCompatibility;
  clearTimeout(timer);
  idleCompatibility = null;
  return worker;
}
function keepCompatibilityWorker(worker) {
  if (idleCompatibility || settings.low) {
    worker.terminate();
    return;
  }
  const timer = setTimeout(() => {
    worker.terminate();
    idleCompatibility = null;
  }, 30000);
  idleCompatibility = { worker, timer };
}
function jobWorker(row, worker, data, signal, transfer = [], reuse = false) {
  return new Promise((resolve, reject) => {
    const close = success => {
      signal.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = null;
      if (success && reuse) keepCompatibilityWorker(worker);
      else worker.terminate();
    };
    const abort = () => { close(false); reject(new DOMException('Cancelled', 'AbortError')); };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      if (event.data.progress !== undefined) {
        row.progress = Math.max(row.progress, event.data.progress);
        updateDetail(row);
        refresh();
        return;
      }
      close(!event.data.error);
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = event => { close(false); reject(new Error(event.message || 'The render worker stopped unexpectedly.')); };
    try { worker.postMessage(data, transfer); }
    catch (error) { close(false); reject(error); }
  });
}
async function getPcm(row, signal) {
  if (row.audio.size > 160 * 1024 ** 2 || row.duration > (settings.low ? 300 : 900) ||
      !globalThis.VideoEncoder || !globalThis.AudioEncoder) return null;
  try {
    const context = new OfflineAudioContext(2, 1, 48000);
    const decoded = await context.decodeAudioData(await row.audio.arrayBuffer());
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const channels = Array.from({ length: Math.min(2, decoded.numberOfChannels) }, (_, i) => decoded.getChannelData(i).slice());
    return { rate: decoded.sampleRate, channels };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
async function run(row) {
  row.controller = new AbortController();
  const { signal } = row.controller;
  const prefs = { ...settings };
  row.status = 'rendering';
  row.stage = 'Preparing';
  row.started = performance.now();
  row.finished = 0;
  draw(row);
  refresh();
  try {
    let result;
    const mode = visualMode(row.image);
    if (mode === 'still') {
      const pcm = await getPcm(row, signal);
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      row.stage = 'Encoding';
      result = await jobWorker(row, new Worker('./render-worker.js', { type: 'module' }),
        { image: row.image, pcm, settings: prefs }, signal, pcm?.channels.map(channel => channel.buffer));
    }
    if (!result?.blob) {
      row.stage = mode === 'still' ? 'Compatibility encoding' : 'Encoding muted loop';
      row.progress = 0;
      updateDetail(row);
      result = await jobWorker(row, compatibilityWorker(),
        { image: result?.fallback ?? row.image, mode, audio: row.audio, settings: prefs, duration: row.duration },
        signal, [], true);
    }
    row.blob = result.blob;
    row.exportSettings = prefs;
    row.exportDimensions = result.dimensions;
    row.status = 'completed';
    row.progress = 1;
    if (prefs.quick && prefs.autoDownload) downloadRow(row);
  } catch (error) {
    row.status = signal.aborted ? 'cancelled' : 'failed';
    row.error = signal.aborted ? '' : /memory|allocation/i.test(error.message) ?
      'Browser memory limit reached. Try one render at a time with Low memory mode.' : error.message;
  } finally {
    row.finished = performance.now();
    row.controller = null;
    if (rows.includes(row)) draw(row);
    pump();
  }
}
function pump() {
  const max = settings.low ? 1 : Math.min(Number(settings.concurrent), Math.max(1, Math.floor((navigator.deviceMemory || 8) / 2)));
  const slots = max - rows.filter(row => row.status === 'rendering').length;
  rows.filter(row => row.status === 'queued').slice(0, Math.max(0, slots)).forEach(run);
  refresh();
}
function enqueue(entries) {
  if (!rows.some(busy)) batch = new Set();
  for (const row of entries.filter(canRender)) {
    row.status = 'queued';
    row.progress = 0;
    row.error = '';
    row.started = row.finished = 0;
    batch.add(row);
    draw(row);
  }
  pump();
}
function cancel(row) {
  if (row.controller) row.controller.abort();
  else { row.status = 'cancelled'; draw(row); refresh(); }
}
const options = [
  ['resolution', 'Resolution', [['1920x1080', '1080p'], ['1280x720', '720p'], ['3840x2160', '4K'], ['1080x1080', 'Square'], ['1080x1920', 'Vertical'], ['original', 'Original aspect ratio']]],
  ['gif', 'GIF playback', [['still', 'First frame'], ['loop', 'Loop GIF']]],
  ['scale', 'Artwork scaling', [['fit', 'Fit'], ['fill', 'Fill / crop'], ['stretch', 'Stretch']]],
  ['fps', 'Video frame rate', ['1', '24', '30', '60']],
  ['bitrate', 'Audio bitrate (kbps)', ['128', '192', '256', '320']],
  ['concurrent', 'Concurrent renders', ['1', '2', '3', '4']],
  ['prefix', 'Filename prefix'], ['suffix', 'Filename suffix'],
  ['low', 'Low memory mode'], ['quick', 'Quick Render'], ['pair', 'Auto-pair matching names'],
  ['name', 'Name outputs from audio'], ['autoDownload', 'Auto-download Quick Render exports']
];
function saveSettings() {
  try { localStorage.setItem('image2video-settings', JSON.stringify(settings)); } catch {}
}
for (const [key, label, values] of options) {
  const field = element('label', 'setting', label);
  const control = element(values ? 'select' : 'input');
  if (values) {
    for (const value of values) {
      const [id, title] = Array.isArray(value) ? value : [value, value];
      const option = element('option', '', title);
      option.value = id;
      control.append(option);
    }
  } else if (typeof defaults[key] === 'boolean') {
    control.type = 'checkbox';
    control.checked = settings[key];
  } else control.maxLength = 40;
  control.value = settings[key];
  control.oninput = () => {
    settings[key] = control.type === 'checkbox' ? control.checked : control.value;
    saveSettings();
    if (key === 'concurrent' || key === 'low') pump();
  };
  field.append(control);
  $('settings-fields').append(field);
}
$('settings-fields').append(button('Reset output names', () => {
  settings.prefix = settings.suffix = '';
  for (const input of $('settings-fields').querySelectorAll('input[type=text], input:not([type])')) input.value = '';
  saveSettings();
  for (const row of rows) {
    if (busy(row)) continue;
    row.customName = false;
    row.name = row.audio ? basename(row.audio.name) : '';
    draw(row);
  }
}));
$('settings-open').onclick = () => $('settings').showModal();
$('browse').onclick = () => $('files').click();
$('files').onchange = () => { importFiles([...$('files').files]); $('files').value = ''; };
$('add').onclick = () => makeRow().el.focus();
$('render-all').onclick = () => enqueue(rows);
$('clear-artwork').onclick = () => {
  selectArtwork(null);
  for (const asset of artwork.values()) URL.revokeObjectURL(asset.url);
  artwork.clear();
  $('artwork-items').replaceChildren();
  refreshArtworkTray();
};
$('clear').onclick = () => {
  if (rows.some(row => busy(row) || (row.blob && !row.downloaded)) &&
    !confirm('Clear the queue and discard unfinished or undownloaded videos?')) return;
  for (const row of [...rows]) { if (busy(row)) cancel(row); removeRow(row); }
};
$('zip').onclick = async () => {
  const complete = rows.filter(row => row.blob);
  zipBusy = true;
  $('zip').textContent = 'Preparing ZIP…';
  refresh();
  try {
    const blob = await makeZip(complete.map(row => ({ blob: row.blob, name: outputName(row) })));
    download(blob, 'Music Videos.zip');
    complete.forEach(row => { row.downloaded = true; });
  } catch (error) { hint(error.message); }
  finally {
    zipBusy = false;
    $('zip').textContent = 'Download ZIP';
    refresh();
  }
};
dropTarget($('drop'), importFiles);
window.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer.files.length) event.preventDefault(); });
window.addEventListener('keydown', event => {
  if (event.target.matches('input,textarea,select,[contenteditable]') || document.querySelector('dialog[open]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    $('files').click();
  } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    enqueue(rows);
  } else if (event.key === 'Delete' && selected && !busy(selected)) removeRow(selected);
});
setInterval(() => rows.filter(row => row.status === 'rendering').forEach(updateDetail), 250);
refresh();
