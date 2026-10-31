// HTTP handler for the Tube DJ server: static app files plus the conversion API.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { VIDEO_ID } from './ytextract.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
};
const STATIC = new Set(['/index.html', '/core.js']);
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const sendJson = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

// Parse a single-range `Range: bytes=` header against a file size.
// Returns null (serve everything), 'unsatisfiable', or { start, end }.
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end = size - 1;
  if (m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  } else {
    start = Math.max(0, size - Number(m[2]));
  }
  return start > end || start >= size ? 'unsatisfiable' : { start, end };
}

function serveFile(req, res, file, type) {
  const { size } = statSync(file);
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  const { start, end } = range || { start: 0, end: size - 1 };
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': end - start + 1 };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const body = createReadStream(file, { start, end });
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
}

export function createApp({ converter, root, extraHosts = [] }) {
  const hosts = new Set([...LOOPBACK, ...extraHosts.map((h) => h.toLowerCase())]);
  const hostname = (h) => (h || '').toLowerCase().replace(/:\d+$/, '');

  return function handle(req, res) {
    // Reject DNS-rebinding (foreign Host) and cross-site requests: this server can
    // spend bandwidth and disk, so a random web page must not be able to drive it.
    if (!hosts.has(hostname(req.headers.host))) return sendJson(res, 403, { error: 'host not allowed' });
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: 'cross-origin request blocked' });
    }
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    const id = url.searchParams.get('id') || '';
    try {
      if (path === '/api/health') return sendJson(res, 200, { ok: true });
      if (path === '/api/convert') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
        if (!VIDEO_ID.test(id)) return sendJson(res, 400, { error: 'invalid video id' });
        return sendJson(res, 200, converter.start(id));
      }
      if (path === '/api/status') {
        if (!VIDEO_ID.test(id)) return sendJson(res, 400, { error: 'invalid video id' });
        return sendJson(res, 200, converter.status(id));
      }
      const audio = /^\/api\/audio\/([A-Za-z0-9_-]{11})\.mp3$/.exec(path);
      if (audio) {
        if (!converter.cached(audio[1])) return sendJson(res, 404, { error: 'not converted yet' });
        return serveFile(req, res, converter.mp3Path(audio[1]), TYPES['.mp3']);
      }
      const rel = path === '/' ? '/index.html' : normalize(path);
      if (STATIC.has(rel)) {
        const file = join(root, rel);
        if (existsSync(file) && statSync(file).isFile()) return serveFile(req, res, file, TYPES[extname(file)]);
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  };
}
