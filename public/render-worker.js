import { makeMp4 } from './mp4.js';

const report = progress => postMessage({ progress });
function copy(chunk) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return data;
}
function store(track, chunk, metadata) {
  if (metadata?.decoderConfig?.description) track.description = new Uint8Array(metadata.decoderConfig.description);
  track.samples.push({ data: copy(chunk), key: chunk.type === 'key', timestamp: chunk.timestamp });
}
async function artwork(file, settings) {
  const image = await createImageBitmap(file);
  try {
    let [width, height] = settings.resolution === 'original' ?
      [image.width, image.height] : settings.resolution.split('x').map(Number);
    const limit = Math.min(1, 4096 / Math.max(width, height));
    width = Math.max(2, Math.round(width * limit / 2) * 2);
    height = Math.max(2, Math.round(height * limit / 2) * 2);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    const scale = (settings.scale === 'fill' ? Math.max : Math.min)(width / image.width, height / image.height);
    const drawWidth = settings.scale === 'stretch' ? width : image.width * scale;
    const drawHeight = settings.scale === 'stretch' ? height : image.height * scale;
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return canvas;
  } finally {
    image.close();
  }
}
async function flushQueue(encoder) {
  if (encoder.encodeQueueSize < 12) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 50);
    encoder.addEventListener('dequeue', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
async function nativeRender(canvas, pcm, settings) {
  if (!globalThis.VideoEncoder || !globalThis.AudioEncoder || !pcm) throw new Error('Native encoding unavailable');
  const { width, height } = canvas;
  const preferredRate = Number(settings.fps);
  const audio = { samples: [], timescale: pcm.rate, channels: pcm.channels.length, bitrate: Number(settings.bitrate) * 1000 };
  const video = { samples: [], timescale: 1000000, width, height };
  const audioConfig = { codec: 'mp4a.40.2', sampleRate: audio.timescale, numberOfChannels: audio.channels, bitrate: audio.bitrate };
  let videoConfig;
  let fps;
  for (const rate of new Set([preferredRate, 24])) {
    const level = width * height > 2073600 ? (rate > 30 ? '34' : '33') : (rate > 30 ? '2a' : '28');
    const config = { codec: 'avc1.4200' + level, width, height, bitrate: width * height > 2073600 ? 10000000 : 4000000,
      framerate: rate, latencyMode: 'realtime', avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(config)).supported) {
      videoConfig = config;
      fps = rate;
      break;
    }
  }
  if (!videoConfig || !(await AudioEncoder.isConfigSupported(audioConfig)).supported) throw new Error('H.264 or AAC encoder unavailable');
  let encoderError;
  const onError = error => { encoderError = error; };
  const videoEncoder = new VideoEncoder({ output: (chunk, meta) => store(video, chunk, meta), error: onError });
  const audioEncoder = new AudioEncoder({ output: (chunk, meta) => store(audio, chunk, meta), error: onError });
  try {
    videoEncoder.configure(videoConfig);
    audioEncoder.configure(audioConfig);
    const length = pcm.channels[0].length;
    const duration = Math.round(length / pcm.rate * video.timescale);
    const frames = Math.ceil(duration * fps / video.timescale);
    // A closed GOP of identical frames can be replayed without re-encoding it.
    const gopLength = Math.min(frames, fps * 5);
    for (let i = 0; i < gopLength; i++) {
      if (encoderError) throw encoderError;
      const timestamp = Math.round(i * video.timescale / fps);
      const next = Math.min(duration, Math.round((i + 1) * video.timescale / fps));
      const frame = new VideoFrame(canvas, { timestamp, duration: next - timestamp });
      try { videoEncoder.encode(frame, { keyFrame: i === 0 }); }
      finally { frame.close(); }
      await flushQueue(videoEncoder);
    }
    await videoEncoder.flush();
    const gop = video.samples;
    if (gop.length !== gopLength || !gop[0]?.key ||
      gop.some((sample, i) => sample.timestamp !== Math.round(i * video.timescale / fps))) {
      throw new Error('The H.264 encoder did not produce a reusable frame sequence.');
    }
    const encoded = gop.map(sample => ({ key: sample.key, data: new Blob([sample.data]) }));
    video.samples = Array.from({ length: frames }, (_, i) => {
      const start = Math.round(i * video.timescale / fps);
      const end = Math.min(duration, Math.round((i + 1) * video.timescale / fps));
      return { ...encoded[i % gopLength], duration: end - start };
    });
    report(.1);
    for (let index = 0; index < length; index += 4096) {
      if (encoderError) throw encoderError;
      const count = Math.min(4096, length - index);
      const data = new Float32Array(count * audio.channels);
      pcm.channels.forEach((channel, n) => data.set(channel.subarray(index, index + count), n * count));
      const sample = new AudioData({ format: 'f32-planar', sampleRate: pcm.rate, numberOfChannels: audio.channels,
        numberOfFrames: count, timestamp: Math.round(index / pcm.rate * 1e6), data });
      try { audioEncoder.encode(sample); }
      finally { sample.close(); }
      await flushQueue(audioEncoder);
      if (index % (4096 * 8) === 0) report(.1 + .88 * index / length);
    }
    await audioEncoder.flush();
    if (encoderError) throw encoderError;
    const audioStart = audio.samples[0]?.timestamp ?? 0;
    audio.samples.forEach((sample, i) => {
      const start = Math.round((sample.timestamp - audioStart) * pcm.rate / 1e6);
      const next = audio.samples[i + 1];
      sample.duration = Math.min(length, next ? Math.round((next.timestamp - audioStart) * pcm.rate / 1e6) : length) - start;
    });
    audio.samples = audio.samples.filter(sample => sample.duration > 0);
    return makeMp4(video, audio);
  } finally {
    if (videoEncoder.state !== 'closed') videoEncoder.close();
    if (audioEncoder.state !== 'closed') audioEncoder.close();
  }
}
self.onmessage = async ({ data }) => {
  try {
    const canvas = await artwork(data.image, data.settings);
    try {
      if (!data.pcm) throw new Error('Native audio decoding unavailable');
      const blob = await nativeRender(canvas, data.pcm, data.settings);
      postMessage({ blob, dimensions: [canvas.width, canvas.height] });
    } catch {
      postMessage({ fallback: await canvas.convertToBlob({ type: 'image/png' }) });
    }
  } catch (error) {
    postMessage({ error: error.message });
  }
};
