// Shared test helpers: synthetic audio and a fake extractor, so server tests run offline.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tmpCache = () => mkdtempSync(join(tmpdir(), 'tubedj-cache-'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mono 16-bit WAV: a kick on every beat plus a sustained A-minor triad.
export function clickTrack({ bpm = 128, seconds = 24, sampleRate = 22050 } = {}) {
  const n = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(44 + n * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + n * 2, 4); pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(sampleRate, 24); pcm.writeUInt32LE(sampleRate * 2, 28);
  pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(n * 2, 40);
  const beat = Math.round((60 / bpm) * sampleRate);
  const chord = [220, 261.63, 329.63];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const since = (i % beat) / sampleRate;
    const kick = Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-since * 40)) * since) * Math.exp(-since * 18);
    const pad = chord.reduce((a, f) => a + Math.sin(2 * Math.PI * f * t), 0) / 12;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, kick * 0.8 + pad)) * 32000), 44 + i * 2);
  }
  return pcm;
}

// Fake extractor pair for createConverter: resolve() returns metadata, stream() yields `audio` in chunks.
export function fakeSource(audio = clickTrack({ seconds: 6 }), { chunkSize = 64 * 1024, title = 'Fake Song', author = 'Fake Artist' } = {}) {
  const calls = { resolve: 0, stream: 0 };
  return {
    calls,
    resolve: async (id) => {
      calls.resolve++;
      return { id, title, author, durationSec: 6, url: 'http://fake', size: audio.length, mime: 'audio/wav', ua: 'x' };
    },
    stream: async function* () {
      calls.stream++;
      for (let at = 0; at < audio.length; at += chunkSize) {
        const chunk = audio.subarray(at, at + chunkSize);
        yield { chunk, received: Math.min(at + chunkSize, audio.length), total: audio.length };
      }
    },
  };
}

export async function waitFor(fn, { timeout = 15000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(every);
  }
}
