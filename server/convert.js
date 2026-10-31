// Download + ffmpeg transcode jobs. One mp3 per video id, cached on disk.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAudio, streamAudio, VIDEO_ID } from './ytextract.js';

const here = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = process.env.TUBEDJ_CACHE || join(here, 'cache');
mkdirSync(CACHE_DIR, { recursive: true });

async function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    return (await import('ffmpeg-static')).default;
  } catch {
    return 'ffmpeg'; // fall back to whatever is on PATH
  }
}

export const mp3Path = (id) => join(CACHE_DIR, `${id}.mp3`);
const metaPath = (id) => join(CACHE_DIR, `${id}.json`);

export function cachedInfo(id) {
  if (!existsSync(mp3Path(id))) return null;
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(metaPath(id), 'utf8'));
  } catch {}
  return { ...meta, bytes: statSync(mp3Path(id)).size };
}

const jobs = new Map(); // id -> { state, phase, pct, title, error }

export function jobStatus(id) {
  const cached = cachedInfo(id);
  if (cached) return { state: 'done', pct: 100, ...cached };
  return jobs.get(id) || { state: 'idle' };
}

export function startJob(id) {
  if (!VIDEO_ID.test(id)) throw new Error('invalid video id');
  const existing = jobStatus(id);
  if (existing.state === 'done' || existing.state === 'running') return existing;
  const job = { state: 'running', phase: 'resolving', pct: 0, title: '' };
  jobs.set(id, job);
  run(id, job).catch((e) => {
    job.state = 'error';
    job.error = e.message;
  });
  return job;
}

async function run(id, job) {
  const info = await resolveAudio(id);
  job.title = info.title;
  job.phase = 'downloading';
  const tmp = join(CACHE_DIR, `${id}.part.mp3`);
  const ff = spawn(
    await ffmpegPath(),
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-vn', '-map_metadata', '-1',
     '-codec:a', 'libmp3lame', '-q:a', '2', '-metadata', `title=${info.title}`,
     '-metadata', `artist=${info.author}`, '-f', 'mp3', tmp],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let stderr = '';
  ff.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
  });
  ff.stdin.on('error', () => {}); // surfaced through `exited` instead
  try {
    for await (const { chunk, received, total } of streamAudio(info)) {
      job.pct = Math.round((received / total) * 90);
      if (!ff.stdin.write(chunk)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    job.phase = 'encoding';
    job.pct = 95;
    ff.stdin.end();
    await exited;
  } catch (e) {
    ff.kill();
    throw e;
  }
  writeFileSync(metaPath(id), JSON.stringify({ id, title: info.title, author: info.author, durationSec: info.durationSec }));
  renameSync(tmp, mp3Path(id));
  job.state = 'done';
  job.pct = 100;
}
