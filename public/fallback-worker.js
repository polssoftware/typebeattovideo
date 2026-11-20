// This compatibility encoder is fetched only if native encoding is unavailable.
const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
let engine;

function box(view, start, end, type) {
  for (let offset = start; offset + 8 <= end;) {
    const length = view.getUint32(offset);
    if (length < 8 || offset + length > end) break;
    if (view.getUint32(offset + 4) === type) return [offset + 8, offset + length];
    offset += length;
  }
  throw new Error('An MP4 metadata field could not be read.');
}

function mp4View(data) {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function movieDuration(data) {
  const view = mp4View(data);
  const [start, end] = box(view, 0, view.byteLength, 0x6d6f6f76); // moov
  const [header] = box(view, start, end, 0x6d766864); // mvhd
  return view.getUint8(header) === 1
    ? Number(view.getBigUint64(header + 24)) / view.getUint32(header + 20)
    : view.getUint32(header + 16) / view.getUint32(header + 12);
}

function videoSize(data) {
  const view = mp4View(data);
  const [movie, movieEnd] = box(view, 0, view.byteLength, 0x6d6f6f76); // moov
  const [track, trackEnd] = box(view, movie, movieEnd, 0x7472616b); // trak
  const [, headerEnd] = box(view, track, trackEnd, 0x746b6864); // tkhd
  return [view.getUint32(headerEnd - 8) / 65536, view.getUint32(headerEnd - 4) / 65536];
}

function motionFilter(settings) {
  if (settings.resolution === 'original') {
    const dimension = side => "'max(2,2*round(" + side + "*min(1,4096/max(iw,ih))/2))'";
    return 'scale=' + dimension('iw') + ':' + dimension('ih') + ',setsar=1';
  }
  const [width, height] = settings.resolution.split('x');
  const scale = 'scale=' + width + ':' + height;
  if (settings.scale === 'stretch') return scale + ',setsar=1';
  const fit = settings.scale === 'fit';
  return scale + ':force_original_aspect_ratio=' + (fit ? 'decrease' : 'increase') +
    ':force_divisible_by=2,' + (fit ? 'pad' : 'crop') + '=' + width + ':' + height + ',setsar=1';
}

function execute(...args) {
  engine.exec(...args);
  const status = engine.ret;
  engine.reset();
  return status;
}

self.onmessage = async ({ data }) => {
  const filenames = ['visual', 'cover.png', 'track', 'segment.mp4', 'audio.m4a', 'output.mp4'];
  try {
    if (!engine) {
      importScripts(base + 'ffmpeg-core.js');
      engine = await self.createFFmpegCore({
        mainScriptUrlOrBlob: base + 'ffmpeg-core.js#' + btoa(JSON.stringify({ wasmURL: base + 'ffmpeg-core.wasm' }))
      });
    }
    let inputUsesAac = false;
    engine.setLogger(({ type, message }) => {
      if (type === 'stderr' && /Audio: aac\b/.test(message)) inputUsesAac = true;
    });
    engine.setProgress(() => {});
    const motion = data.mode === 'gif' || data.mode === 'video';
    engine.FS.writeFile(motion ? 'visual' : 'cover.png', new Uint8Array(await data.image.arrayBuffer()));
    engine.FS.writeFile('track', new Uint8Array(await data.audio.arrayBuffer()));

    if (/\.(m4a|aac)$/i.test(data.audio.name)) execute('-hide_banner', '-i', 'track');
    postMessage({ progress: .05 });
    engine.setProgress(({ time }) => {
      if (data.duration > 0) postMessage({ progress: .05 + (motion ? .35 : .8) * Math.min(1, Math.max(0, time / 1e6 / data.duration)) });
    });
    const prepareAudio = copyAudio => execute('-i', 'track', '-map', '0:a:0', '-vn',
      '-c:a', copyAudio ? 'copy' : 'aac', ...(copyAudio ? [] : ['-b:a', data.settings.bitrate + 'k']), 'audio.m4a');
    if (prepareAudio(inputUsesAac) !== 0 && (!inputUsesAac || prepareAudio(false) !== 0)) {
      throw new Error('The audio could not be decoded or encoded as AAC.');
    }
    const duration = movieDuration(engine.FS.readFile('audio.m4a'));
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('The audio file has no playable duration.');
    const fps = Math.max(24, Number(data.settings.fps));
    postMessage({ progress: motion ? .4 : .85 });
    engine.setProgress(({ time }) => {
      if (motion) postMessage({ progress: .4 + .48 * Math.min(1, Math.max(0, time / 1e6 / duration)) });
    });

    // Encode the visual once. Loop the resulting video packets when the audio is longer.
    const input = motion
      ? [...(data.mode === 'gif' ? ['-ignore_loop', '1'] : []), '-i', 'visual',
        '-map', '0:V:0', '-vf', motionFilter(data.settings), '-r', String(fps), '-t', String(duration)]
      : ['-framerate', String(fps), '-loop', '1', '-i', 'cover.png',
        '-map', '0:v:0', '-frames:v', String(fps)];
    if (execute(...input, '-an', '-sn', '-dn', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-threads', '1', '-bf', '0', '-pix_fmt', 'yuv420p', 'segment.mp4') !== 0) {
      throw new Error('The visual could not be decoded or encoded as H.264.');
    }
    const dimensions = videoSize(engine.FS.readFile('segment.mp4'));
    postMessage({ progress: .9 });
    engine.setProgress(() => {});
    if (execute('-stream_loop', '-1', '-i', 'segment.mp4', '-i', 'audio.m4a',
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-t', String(duration), '-movflags', '+faststart', 'output.mp4') !== 0) {
      throw new Error('The video and audio could not be written to MP4.');
    }
    postMessage({ dimensions, blob: new Blob([engine.FS.readFile('output.mp4')], { type: 'video/mp4' }) });
  } catch (error) {
    const message = engine ? error.message : 'Could not load FFmpeg. Check your connection or try a browser with H.264 and AAC encoding.';
    postMessage({ error: 'MP4 compatibility renderer failed. ' + message });
  } finally {
    if (engine) {
      for (const name of filenames) {
        if (engine.FS.analyzePath(name).exists) engine.FS.unlink(name);
      }
    }
  }
};


