import assert from 'node:assert/strict';
import { request } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, parseRange } from '../../server/app.js';
import { createConverter } from '../../server/convert.js';
import { fakeSource, tmpCache, waitFor } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ID = 'dQw4w9WgXcQ';

describe('parseRange', () => {
  it('handles the single-range forms', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=50-5000', 100), { start: 50, end: 99 });
  });
  it('flags unsatisfiable ranges', () => {
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=20-10', 100), 'unsatisfiable');
  });
  it('ignores missing or malformed headers', () => {
    for (const h of [undefined, '', 'bytes=-', 'items=0-1', 'bytes=a-b', 'bytes=0-1,5-6']) assert.equal(parseRange(h, 100), null, String(h));
  });
});

describe('HTTP API', () => {
  let server, base, port, converter;
  before(async () => {
    converter = createConverter({ cacheDir: tmpCache(), ...fakeSource() });
    server = createServer(createApp({ converter, root }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
    base = `http://127.0.0.1:${port}`;
  });
  after(() => server.close());

  // fetch() can't forge Host/Origin, so low-level requests cover the security checks.
  const raw = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });

  it('answers health checks', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  });

  it('rejects bad video ids with 400', async () => {
    for (const path of ['/api/status?id=bad', '/api/status', `/api/convert?id=${'x'.repeat(40)}`]) {
      const res = await fetch(base + path, { method: path.includes('convert') ? 'POST' : 'GET' });
      assert.equal(res.status, 400, path);
    }
  });

  it('only accepts POST for /api/convert', async () => {
    assert.equal((await fetch(`${base}/api/convert?id=${ID}`)).status, 405);
  });

  it('converts, reports progress and serves the audio', async () => {
    assert.equal((await (await fetch(`${base}/api/status?id=${ID}`)).json()).state, 'idle');
    assert.equal((await fetch(`${base}/api/audio/${ID}.mp3`)).status, 404);
    const started = await (await fetch(`${base}/api/convert?id=${ID}`, { method: 'POST' })).json();
    assert.ok(['queued', 'running', 'done'].includes(started.state));
    await waitFor(() => converter.status(ID).state === 'done');
    const st = await (await fetch(`${base}/api/status?id=${ID}`)).json();
    assert.equal(st.state, 'done');
    assert.equal(st.title, 'Fake Song');
    const res = await fetch(`${base}/api/audio/${ID}.mp3`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal((await res.arrayBuffer()).byteLength, st.bytes);
  });

  it('supports byte ranges so <audio> can seek', async () => {
    await waitFor(() => converter.status(ID).state === 'done' || (converter.start(ID), false));
    const size = converter.status(ID).bytes;
    const part = await fetch(`${base}/api/audio/${ID}.mp3`, { headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${size}`);
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    const tail = await fetch(`${base}/api/audio/${ID}.mp3`, { headers: { range: 'bytes=-5' } });
    assert.equal(tail.status, 206);
    assert.equal((await tail.arrayBuffer()).byteLength, 5);
    const bad = await fetch(`${base}/api/audio/${ID}.mp3`, { headers: { range: `bytes=${size + 5}-` } });
    assert.equal(bad.status, 416);
  });

  it('serves the app shell and DSP core, and nothing else from disk', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /Tube DJ/);
    assert.equal((await fetch(`${base}/core.js`)).status, 200);
    for (const path of ['/README.md', '/server/server.js', '/server/cache/x.json', '/.git/config', '/../package.json', '/%2e%2e/etc/passwd', '/test/core.test.js', '/index.html/../server/app.js']) {
      assert.equal((await raw(path)).status, 404, path);
    }
  });

  it('blocks foreign Host headers (DNS rebinding)', async () => {
    const res = await raw('/api/health', { headers: { host: 'evil.example:8000' } });
    assert.equal(res.status, 403);
  });

  it('allows localhost names and configured extra hosts', async () => {
    assert.equal((await raw('/api/health', { headers: { host: 'localhost:8000' } })).status, 200);
    assert.equal((await raw('/api/health', { headers: { host: '[::1]:8000' } })).status, 200);
    const s = createServer(createApp({ converter, root, extraHosts: ['dj.tailnet.ts.net'] }));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const p = s.address().port;
    const ok = await new Promise((resolve) => request({ host: '127.0.0.1', port: p, path: '/api/health', headers: { host: 'dj.tailnet.ts.net' } }, (res) => { res.resume(); resolve(res.statusCode); }).end());
    s.close();
    assert.equal(ok, 200);
  });

  it('blocks cross-site POSTs but allows same-origin ones', async () => {
    const cross = await raw(`/api/convert?id=${ID}`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);
    const same = await raw(`/api/convert?id=${ID}`, { method: 'POST', headers: { origin: base, host: `127.0.0.1:${port}` } });
    assert.equal(same.status, 200);
  });

  it('does not crash on a malformed Origin header', async () => {
    const res = await raw(`/api/convert?id=${ID}`, { method: 'POST', headers: { origin: 'not a url' } });
    assert.equal(res.status, 403);
  });

  it('sends no CORS headers to origins that are not allowed', async () => {
    const res = await raw('/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal((await raw('/api/health', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })).status, 403);
  });

  it('serves the downloadable convert script', async () => {
    const res = await fetch(`${base}/tools/tubedj-convert.mjs`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /tubedj-convert/);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });
});

describe('allowed origins (hosted web app)', () => {
  const PAGES = 'https://ahhh.github.io';
  let server, port, converter;
  before(async () => {
    converter = createConverter({ cacheDir: tmpCache(), ...fakeSource() });
    server = createServer(createApp({ converter, root, allowedOrigins: [PAGES + '/'] }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());
  const raw = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

  it('answers preflights, including the private-network check', async () => {
    const res = await raw(`/api/convert?id=${ID}`, {
      method: 'OPTIONS',
      headers: { origin: PAGES, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], PAGES);
    assert.equal(res.headers['access-control-allow-private-network'], 'true');
    assert.match(res.headers['access-control-allow-methods'], /POST/);
  });

  it('lets the allowed origin convert and fetch audio with CORS headers', async () => {
    const post = await raw(`/api/convert?id=${ID}`, { method: 'POST', headers: { origin: PAGES } });
    assert.equal(post.status, 200);
    assert.equal(post.headers['access-control-allow-origin'], PAGES);
    await waitFor(() => converter.status(ID).state === 'done');
    const audio = await raw(`/api/audio/${ID}.mp3`, { headers: { origin: PAGES, range: 'bytes=0-9' } });
    assert.equal(audio.status, 206);
    assert.equal(audio.headers['access-control-allow-origin'], PAGES);
    assert.match(audio.headers['access-control-expose-headers'], /content-range/);
    assert.equal(audio.headers.vary, 'origin');
  });

  it('still enforces the Host check for allowed origins', async () => {
    const res = await raw('/api/health', { headers: { origin: PAGES, host: 'evil.example' } });
    assert.equal(res.status, 403);
  });
});
