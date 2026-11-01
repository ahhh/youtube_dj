import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createConverter } from '../../server/convert.js';
import { clickTrack, fakeSource, sleep, tmpCache, waitFor } from './helpers.mjs';

const ID = 'dQw4w9WgXcQ';
const finished = (c, id) => waitFor(() => ['done', 'error'].includes(c.status(id).state) && c.status(id));

describe('createConverter', () => {
  it('transcodes a stream into a cached, tagged mp3', async () => {
    const src = fakeSource();
    const c = createConverter({ cacheDir: tmpCache(), ...src });
    assert.deepEqual(c.status(ID), { state: 'idle' });
    c.start(ID);
    const st = await finished(c, ID);
    assert.equal(st.state, 'done');
    assert.equal(st.pct, 100);
    assert.equal(st.title, 'Fake Song');
    const mp3 = readFileSync(c.mp3Path(ID));
    assert.ok(mp3.length > 10_000);
    assert.equal(mp3.subarray(0, 3).toString(), 'ID3');
    assert.ok(mp3.includes('Fake Song') && mp3.includes('Fake Artist'), 'tags written');
  });

  it('serves repeat requests from the cache without re-downloading', async () => {
    const src = fakeSource();
    const c = createConverter({ cacheDir: tmpCache(), ...src });
    c.start(ID);
    await finished(c, ID);
    assert.equal(c.start(ID).state, 'done');
    assert.equal(src.calls.resolve, 1);
    assert.equal(src.calls.stream, 1);
  });

  it('survives a restart: a new converter sees the old cache', async () => {
    const dir = tmpCache();
    const a = createConverter({ cacheDir: dir, ...fakeSource() });
    a.start(ID);
    await finished(a, ID);
    const b = createConverter({ cacheDir: dir, resolve: async () => { throw new Error('unused'); } });
    assert.equal(b.status(ID).state, 'done');
    assert.equal(b.status(ID).title, 'Fake Song');
  });

  it('reports resolve failures and allows a retry', async () => {
    let fail = true;
    const src = fakeSource();
    const c = createConverter({ cacheDir: tmpCache(), ...src, resolve: (id) => (fail ? Promise.reject(new Error('video unavailable')) : src.resolve(id)) });
    c.start(ID);
    const st = await finished(c, ID);
    assert.equal(st.state, 'error');
    assert.match(st.error, /video unavailable/);
    fail = false;
    c.start(ID);
    assert.equal((await finished(c, ID)).state, 'done');
  });

  it('cleans up the partial file when the download fails midway', async () => {
    const dir = tmpCache();
    const src = fakeSource(clickTrack({ seconds: 6 }));
    const c = createConverter({
      cacheDir: dir,
      resolve: src.resolve,
      stream: async function* (info) {
        let n = 0;
        for await (const part of src.stream(info)) {
          yield part;
          if (++n === 3) throw new Error('connection reset');
        }
      },
    });
    c.start(ID);
    const st = await finished(c, ID);
    assert.equal(st.state, 'error');
    assert.match(st.error, /connection reset/);
    assert.deepEqual(readdirSync(dir), [], 'no .part or partial mp3 left behind');
    assert.equal(c.cached(ID), null);
  });

  it('fails cleanly when ffmpeg is missing (no crash, no hang)', async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = createConverter({ cacheDir: tmpCache(), ...fakeSource(), ffmpeg: async () => '/nonexistent/ffmpeg' });
      c.start(ID);
      const st = await finished(c, ID);
      assert.equal(st.state, 'error');
      assert.match(st.error, /ENOENT/);
      await sleep(100);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not hang when ffmpeg exits early while we still have data to write', async () => {
    const big = Buffer.alloc(40 * 1024 * 1024, 1);
    const c = createConverter({ cacheDir: tmpCache(), ...fakeSource(big, { chunkSize: 1024 * 1024 }), ffmpeg: async () => '/bin/false' });
    c.start(ID);
    const st = await finished(c, ID);
    assert.equal(st.state, 'error');
  });

  it('rejects ffmpeg output that is not valid audio', async () => {
    const c = createConverter({ cacheDir: tmpCache(), ...fakeSource(Buffer.from('this is not audio at all')) });
    c.start(ID);
    const st = await finished(c, ID);
    assert.equal(st.state, 'error');
    assert.match(st.error, /ffmpeg exited/);
    assert.equal(c.cached(ID), null);
  });

  it('limits concurrent jobs and queues the rest', async () => {
    const src = fakeSource();
    let release;
    const gate = new Promise((r) => (release = r));
    let running = 0;
    let peak = 0;
    const c = createConverter({
      cacheDir: tmpCache(),
      ...src,
      maxConcurrent: 1,
      resolve: async (id) => { running++; peak = Math.max(peak, running); await gate; running--; return src.resolve(id); },
    });
    c.start('aaaaaaaaaaa');
    c.start('bbbbbbbbbbb');
    await waitFor(() => c.status('aaaaaaaaaaa').state === 'running');
    assert.equal(c.status('bbbbbbbbbbb').state, 'queued');
    release();
    await finished(c, 'aaaaaaaaaaa');
    await finished(c, 'bbbbbbbbbbb');
    assert.equal(peak, 1);
    assert.equal(c.status('bbbbbbbbbbb').state, 'done');
  });

  it('shares one job between duplicate requests', async () => {
    const src = fakeSource();
    const c = createConverter({ cacheDir: tmpCache(), ...src });
    c.start(ID);
    c.start(ID);
    c.start(ID);
    await finished(c, ID);
    assert.equal(src.calls.resolve, 1);
  });

  it('rejects ids that could escape the cache directory', () => {
    const c = createConverter({ cacheDir: tmpCache(), ...fakeSource() });
    for (const bad of ['../../etc/passwd', 'a/b', '', 'short']) {
      assert.throws(() => c.start(bad), /invalid video id/);
      assert.equal(c.cached(bad), null);
    }
  });

  it('keeps temporary files out of the finished cache listing', async () => {
    const dir = tmpCache();
    const c = createConverter({ cacheDir: dir, ...fakeSource() });
    c.start(ID);
    await finished(c, ID);
    assert.deepEqual(readdirSync(dir).sort(), [`${ID}.json`, `${ID}.mp3`]);
    assert.ok(!existsSync(`${dir}/${ID}.part.mp3`));
  });
});
