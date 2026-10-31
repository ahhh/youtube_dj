// Tube DJ server: serves the static app and the local YouTube -> mp3 API.
// Binds to loopback only; this is a personal tool, not a public service.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startJob, jobStatus, mp3Path, cachedInfo } from './convert.js';
import { VIDEO_ID } from './ytextract.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.md': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const STATIC = new Set(['/index.html', '/core.js']);

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function serveFile(req, res, file, type) {
  const { size } = statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = size - 1;
  let code = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    code = 206;
  }
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1 };
  if (code === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, headers);
  createReadStream(file, { start, end }).pipe(res);
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (path === '/api/health') return json(res, 200, { ok: true });
    if (path === '/api/convert' && req.method === 'POST') {
      const id = url.searchParams.get('id') || '';
      if (!VIDEO_ID.test(id)) return json(res, 400, { error: 'invalid video id' });
      return json(res, 200, startJob(id));
    }
    if (path === '/api/status') {
      const id = url.searchParams.get('id') || '';
      if (!VIDEO_ID.test(id)) return json(res, 400, { error: 'invalid video id' });
      return json(res, 200, jobStatus(id));
    }
    const audio = /^\/api\/audio\/([A-Za-z0-9_-]{11})\.mp3$/.exec(path);
    if (audio) {
      if (!cachedInfo(audio[1])) return json(res, 404, { error: 'not converted yet' });
      return serveFile(req, res, mp3Path(audio[1]), TYPES['.mp3']);
    }
    const rel = path === '/' ? '/index.html' : normalize(path);
    if (STATIC.has(rel) || rel.startsWith('/test/')) {
      const file = join(root, rel);
      if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
        return serveFile(req, res, file, TYPES[extname(file)] || 'application/octet-stream');
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, HOST, () => console.log(`Tube DJ on http://${HOST}:${PORT}`));
