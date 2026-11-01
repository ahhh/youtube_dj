// Download + ffmpeg transcode jobs. One mp3 per video id, cached on disk.
// createConverter takes its collaborators as options so tests can inject a fake
// extractor and a real (or deliberately broken) ffmpeg.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAudio, streamAudio, VIDEO_ID } from './ytextract.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function defaultFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    return (await import('ffmpeg-static')).default;
  } catch {
    return 'ffmpeg'; // fall back to whatever is on PATH
  }
}

export function createConverter({
  cacheDir = process.env.TUBEDJ_CACHE || join(here, 'cache'),
  resolve = resolveAudio,
  stream = streamAudio,
  ffmpeg = defaultFfmpeg,
  maxConcurrent = Number(process.env.TUBEDJ_JOBS) || 2,
} = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const mp3Path = (id) => join(cacheDir, `${id}.mp3`);
  const metaPath = (id) => join(cacheDir, `${id}.json`);
  const jobs = new Map(); // id -> { state, phase, pct, title, error }
  const queue = [];
  let active = 0;

  function cached(id) {
    if (!VIDEO_ID.test(id) || !existsSync(mp3Path(id))) return null;
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(metaPath(id), 'utf8'));
    } catch {}
    return { ...meta, bytes: statSync(mp3Path(id)).size };
  }

  function status(id) {
    const hit = cached(id);
    if (hit) return { state: 'done', pct: 100, ...hit };
    return jobs.get(id) || { state: 'idle' };
  }

  function start(id) {
    if (!VIDEO_ID.test(id)) throw new Error('invalid video id');
    const existing = status(id);
    if (existing.state === 'done' || existing.state === 'running' || existing.state === 'queued') return existing;
    const job = { state: 'queued', phase: 'queued', pct: 0, title: '' };
    jobs.set(id, job);
    queue.push({ id, job });
    pump();
    return job;
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const { id, job } = queue.shift();
      active++;
      job.state = 'running';
      job.phase = 'resolving';
      run(id, job)
        .catch((e) => {
          job.state = 'error';
          job.error = e.message;
        })
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  async function run(id, job) {
    const info = await resolve(id);
    job.title = info.title;
    job.phase = 'downloading';
    const tmp = join(cacheDir, `${id}.part.mp3`);
    const ff = spawn(
      await ffmpeg(),
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-vn', '-map_metadata', '-1',
       '-codec:a', 'libmp3lame', '-q:a', '2', '-metadata', `title=${info.title}`,
       '-metadata', `artist=${info.author}`, '-f', 'mp3', tmp],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr += d));
    // Settles when ffmpeg exits or fails to spawn. The no-op catch stops an early
    // rejection from being reported as unhandled before we await it below.
    const exited = new Promise((res, rej) => {
      ff.on('error', rej);
      ff.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
    });
    exited.catch(() => {});
    ff.stdin.on('error', () => {}); // EPIPE when ffmpeg dies early; reported via `exited`
    try {
      for await (const { chunk, received, total } of stream(info)) {
        job.pct = Math.round((received / total) * 90);
        // Race against `exited` so a dead ffmpeg can't leave us waiting on a drain that never comes.
        if (!ff.stdin.write(chunk)) await Promise.race([new Promise((r) => ff.stdin.once('drain', r)), exited]);
      }
      job.phase = 'encoding';
      job.pct = 95;
      ff.stdin.end();
      await exited;
      writeFileSync(metaPath(id), JSON.stringify({ id, title: info.title, author: info.author, durationSec: info.durationSec }));
      renameSync(tmp, mp3Path(id));
    } catch (e) {
      // Wait for ffmpeg to be gone before deleting its output, or it can recreate the file after us.
      ff.kill('SIGKILL');
      await exited.catch(() => {});
      rmSync(tmp, { force: true });
      throw e;
    }
    job.state = 'done';
    job.pct = 100;
  }

  return { cacheDir, mp3Path, cached, status, start };
}
