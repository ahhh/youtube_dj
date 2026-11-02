#!/usr/bin/env node
// tubedj-convert: download a YouTube video's audio and save it as an mp3.
//
//   node tubedj-convert.mjs <youtube url or id> [more urls...] [-o folder] [--raw]
//
// Needs Node 20+ and nothing else from npm. With ffmpeg installed (brew install ffmpeg,
// winget install ffmpeg, sudo apt install ffmpeg) you get an .mp3; without it, or with
// --raw, you get the original audio stream (.m4a or .webm), which Tube DJ plays too.
// Only download things you have the right to.
//
// This file is also the Tube DJ server's extractor (server/ytextract.js re-exports it).
// It talks to YouTube's InnerTube player API the way the mobile apps do, picks the
// best audio-only format, and streams it in ranged chunks. No yt-dlp, no signature
// deciphering: the clients below get plain URLs.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, realpathSync, renameSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLIENTS = [
  {
    name: 'ANDROID_VR',
    num: 28,
    ua: 'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.60.19',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      androidSdkVersion: 32,
    },
  },
  {
    name: 'IOS',
    num: 5,
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '18.3.2.22D82',
    },
  },
];

const CHUNK = 9 * 1024 * 1024; // googlevideo throttles/403s on unbounded requests
const REQUEST_TIMEOUT_MS = 20_000;
const CHUNK_TIMEOUT_MS = 60_000;
const CHUNK_ATTEMPTS = 3;

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

async function playerRequest(id, c) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': c.ua,
      'x-youtube-client-name': String(c.num),
      'x-youtube-client-version': c.client.clientVersion,
    },
    body: JSON.stringify({
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
      context: { client: { ...c.client, hl: 'en', gl: 'US' } },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${c.name}: HTTP ${res.status}`);
  return res.json();
}

// Rank audio-only formats. Skip DRC (compressed-dynamics) renditions and dubbed
// tracks; prefer AAC (m4a) at the highest bitrate so ffmpeg has the cleanest
// source for the mp3 encode. Opus/webm is the fallback.
export function pickAudio(formats) {
  const audio = formats.filter((f) => f.url && f.mimeType?.startsWith('audio/'));
  const score = (f) =>
    (f.isDrc ? -1e12 : 0) +
    (f.audioTrack && f.audioTrack.audioIsDefault === false ? -1e11 : 0) +
    (f.mimeType.includes('mp4a') ? 1e9 : 0) +
    (f.bitrate || 0);
  return audio.sort((a, b) => score(b) - score(a))[0];
}

export async function resolveAudio(id) {
  if (!VIDEO_ID.test(id)) throw new Error('invalid video id');
  const errors = [];
  for (const c of CLIENTS) {
    try {
      const j = await playerRequest(id, c);
      const status = j.playabilityStatus?.status;
      if (status !== 'OK') {
        errors.push(`${c.name}: ${status} ${j.playabilityStatus?.reason || ''}`.trim());
        continue;
      }
      const fmt = pickAudio(j.streamingData?.adaptiveFormats || []);
      if (!fmt) {
        errors.push(`${c.name}: no direct audio format`);
        continue;
      }
      return {
        id,
        title: j.videoDetails?.title || id,
        author: j.videoDetails?.author || '',
        durationSec: Number(j.videoDetails?.lengthSeconds) || 0,
        url: fmt.url,
        size: Number(fmt.contentLength) || 0,
        mime: fmt.mimeType,
        ua: c.ua,
      };
    } catch (e) {
      errors.push(`${c.name}: ${e.message}`);
    }
  }
  throw new Error(`could not resolve audio (${errors.join('; ')})`);
}

async function fetchChunk(info, start, end, signal) {
  let lastError;
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${info.url}&range=${start}-${end}`, {
        headers: { 'user-agent': info.ua },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)]) : AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== end - start + 1) throw new Error(`short read: got ${buf.length} of ${end - start + 1} bytes`);
      return buf;
    } catch (e) {
      lastError = e;
      if (signal?.aborted) break;
      // 4xx means the URL is bad or expired; retrying won't help.
      if (/HTTP 4\d\d/.test(e.message)) break;
      if (attempt < CHUNK_ATTEMPTS) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastError;
}

// Async generator covering the whole stream in ranged chunks.
export async function* streamAudio(info, signal) {
  const total = info.size;
  if (!total) throw new Error('unknown content length');
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total) - 1;
    yield { chunk: await fetchChunk(info, start, end, signal), received: end + 1, total };
  }
}

// ---------------------------------------------------------------- CLI

// Pull an 11-char video id out of the URL shapes people paste. Returns null for
// anything else, including playlist-only links.
export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (VIDEO_ID.test(s)) return s;
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1];
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

// A title that's safe as a file name on macOS, Windows and Linux.
export function safeFilename(title, fallback) {
  const clean = String(title || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 150);
  return clean || fallback;
}

const rawExt = (mime) => (String(mime).startsWith('audio/webm') ? 'webm' : 'm4a');
const ffmpegBin = () => process.env.FFMPEG || 'ffmpeg';
const hasFfmpeg = () => !spawnSync(ffmpegBin(), ['-version'], { stdio: 'ignore' }).error;

function progress(label, received, total) {
  if (!process.stderr.isTTY) return;
  const pct = total ? Math.round((received / total) * 100) : 0;
  process.stderr.write(`\r  ${label} ${pct}% (${(received / 1048576).toFixed(1)} MB)   `);
}

async function saveOne(id, { outDir, raw }) {
  const info = await resolveAudio(id);
  const name = safeFilename(info.author && !info.title.includes(info.author) ? `${info.author} - ${info.title}` : info.title, id);
  const ext = raw ? rawExt(info.mime) : 'mp3';
  const final = join(outDir, `${name}.${ext}`);
  const tmp = join(outDir, `.${id}.part.${ext}`);
  console.error(`→ ${info.title}`);

  let sink, done;
  if (raw) {
    sink = createWriteStream(tmp);
    done = new Promise((res, rej) => { sink.on('finish', res); sink.on('error', rej); });
  } else {
    const ff = spawn(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-vn', '-map_metadata', '-1',
      '-codec:a', 'libmp3lame', '-q:a', '2', '-metadata', `title=${info.title}`, '-metadata', `artist=${info.author}`, '-f', 'mp3', tmp],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d));
    ff.stdin.on('error', () => {});
    sink = ff.stdin;
    done = new Promise((res, rej) => {
      ff.on('error', rej);
      ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
    });
  }
  done.catch(() => {});
  try {
    for await (const { chunk, received, total } of streamAudio(info)) {
      progress(raw ? 'downloading' : 'downloading + encoding', received, total);
      if (!sink.write(chunk)) await Promise.race([new Promise((r) => sink.once('drain', r)), done]);
    }
    sink.end();
    await done;
    renameSync(tmp, final);
  } catch (e) {
    sink.destroy?.();
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  }
  console.log(final);
}

const USAGE = `Usage: node tubedj-convert.mjs <youtube url or id> [more...] [-o folder] [--raw]

Saves each video's audio as an mp3 (needs ffmpeg) in the current folder, or in -o.
--raw   keep YouTube's original audio (.m4a/.webm) and skip ffmpeg
Playlist links aren't supported: pass the individual video links.`;

export async function main(argv) {
  let outDir = '.';
  let raw = false;
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); return 0; }
    else if (a === '--raw') raw = true;
    else if (a === '-o' || a === '--out') outDir = argv[++i];
    else inputs.push(a);
  }
  if (!inputs.length || !outDir) { console.error(USAGE); return 2; }
  if (!raw && !hasFfmpeg()) {
    console.error(`ffmpeg not found, so saving the original audio instead of mp3.
Install ffmpeg for mp3s (macOS: brew install ffmpeg, Windows: winget install ffmpeg, Linux: sudo apt install ffmpeg).`);
    raw = true;
  }
  outDir = resolvePath(outDir);
  let failed = 0;
  for (const input of inputs) {
    const id = parseVideoId(input);
    if (!id) { console.error(`✗ ${input}: not a YouTube video link or id`); failed++; continue; }
    try {
      await saveOne(id, { outDir, raw });
    } catch (e) {
      console.error(`✗ ${input}: ${e.message}`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) main(process.argv.slice(2)).then((code) => (process.exitCode = code));
