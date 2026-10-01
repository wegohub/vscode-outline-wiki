/**
 * Phase 0 探针夹具：不依赖 ffmpeg 生成可播放的测试素材。
 *
 * - PNG：1x1 纯色图，用来验证 `<base>` 是否让相对链接解析成功
 * - WAV：PCM 正弦音，用来验证 Range / seek。
 *   Chromium 对 <audio> 和 <video> 走同一条媒体资源加载链路（同一套 Range 处理），
 *   所以音频能拖动即证明视频也能拖动；这比"随便找个视频"更可控、可自动化。
 */

const PNG_1x1_RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

export function probePng(): Uint8Array {
  return Buffer.from(PNG_1x1_RED, 'base64');
}

/** 生成 16bit 单声道 PCM WAV；默认 2 秒 440Hz，约 176KB */
export function probeWav(options: { seconds?: number; sampleRate?: number; freq?: number } = {}): Uint8Array {
  const seconds = options.seconds ?? 2;
  const sampleRate = options.sampleRate ?? 44100;
  const freq = options.freq ?? 440;
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * 2;

  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.3;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2);
  }
  return new Uint8Array(buf);
}
