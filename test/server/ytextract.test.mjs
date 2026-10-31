import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { pickAudio, resolveAudio, streamAudio, VIDEO_ID } from '../../server/ytextract.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const fmt = (o) => ({ url: 'http://x/a', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 100, ...o });
const player = (status, formats = [], extra = {}) => ({
  playabilityStatus: { status, reason: status === 'OK' ? '' : 'nope' },
  streamingData: { adaptiveFormats: formats },
  videoDetails: { title: 'T', author: 'A', lengthSeconds: '12' },
  ...extra,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

describe('VIDEO_ID', () => {
  it('accepts 11-char ids', () => {
    for (const ok of ['dQw4w9WgXcQ', 'a-_A0b1C2d3']) assert.ok(VIDEO_ID.test(ok), ok);
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'short', 'dQw4w9WgXcQ1', 'dQw4w9WgXc!', '../etc/pass', 'dQw4w9WgXcQ\n']) assert.ok(!VIDEO_ID.test(bad), JSON.stringify(bad));
  });
});

describe('pickAudio', () => {
  it('prefers AAC over a higher-bitrate Opus stream', () => {
    const aac = fmt({ itag: 140, bitrate: 130000 });
    const opus = fmt({ itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 });
    assert.equal(pickAudio([opus, aac]).itag, 140);
  });
  it('takes the highest bitrate within a codec', () => {
    assert.equal(pickAudio([fmt({ itag: 1, bitrate: 50 }), fmt({ itag: 2, bitrate: 130 })]).itag, 2);
  });
  it('avoids DRC renditions and non-default dubs when alternatives exist', () => {
    const plain = fmt({ itag: 1, bitrate: 10 });
    const drc = fmt({ itag: 2, bitrate: 999, isDrc: true });
    const dub = fmt({ itag: 3, bitrate: 999, audioTrack: { audioIsDefault: false } });
    assert.equal(pickAudio([drc, dub, plain]).itag, 1);
  });
  it('ignores video formats and formats without a direct url', () => {
    const video = fmt({ mimeType: 'video/mp4; codecs="avc1"' });
    const cipher = { mimeType: 'audio/mp4', signatureCipher: 's=abc' };
    assert.equal(pickAudio([video, cipher]), undefined);
  });
});

describe('resolveAudio', () => {
  it('returns metadata from the first client that works', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(player('OK', [fmt({ itag: 140, contentLength: '1234' })])); };
    const info = await resolveAudio('dQw4w9WgXcQ');
    assert.equal(calls, 1);
    assert.deepEqual([info.title, info.author, info.durationSec, info.size], ['T', 'A', 12, 1234]);
  });
  it('falls back to the next client when one is unplayable or has no audio', async () => {
    const replies = [player('UNPLAYABLE'), player('OK', [fmt({ itag: 140, contentLength: '9' })])];
    globalThis.fetch = async () => json(replies.shift());
    assert.equal((await resolveAudio('dQw4w9WgXcQ')).size, 9);
  });
  it('falls back on HTTP errors and network failures', async () => {
    let n = 0;
    globalThis.fetch = async () => { if (n++ === 0) throw new Error('boom'); return json(player('OK', [fmt({ contentLength: '5' })])); };
    assert.equal((await resolveAudio('dQw4w9WgXcQ')).size, 5);
  });
  it('reports every client failure when none work', async () => {
    globalThis.fetch = async () => json(player('LOGIN_REQUIRED'));
    await assert.rejects(resolveAudio('dQw4w9WgXcQ'), (e) => /ANDROID_VR: LOGIN_REQUIRED/.test(e.message) && /IOS: LOGIN_REQUIRED/.test(e.message));
  });
  it('rejects invalid ids without touching the network', async () => {
    globalThis.fetch = async () => { throw new Error('should not be called'); };
    await assert.rejects(resolveAudio('nope'), /invalid video id/);
  });
});

describe('streamAudio', () => {
  const MB = 1024 * 1024;
  const source = (total, onRequest) => async (url) => {
    const [, a, b] = /range=(\d+)-(\d+)/.exec(url);
    const res = onRequest?.(Number(a), Number(b));
    return res || new Response(Buffer.alloc(Number(b) - Number(a) + 1, 7));
  };
  const collect = async (info, signal) => {
    const out = [];
    for await (const part of streamAudio(info, signal)) out.push(part);
    return out;
  };

  it('covers the whole file in contiguous ranged chunks', async () => {
    const ranges = [];
    globalThis.fetch = source(0, (a, b) => { ranges.push([a, b]); });
    const total = 20 * MB;
    const parts = await collect({ url: 'http://x/a?x=1', size: total, ua: 'ua' });
    assert.equal(parts.length, 3);
    assert.equal(ranges[0][0], 0);
    for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
    assert.equal(ranges.at(-1)[1], total - 1);
    assert.equal(parts.reduce((n, p) => n + p.chunk.length, 0), total);
    assert.equal(parts.at(-1).received, total);
  });
  it('sends the extractor user agent', async () => {
    let seen;
    globalThis.fetch = async (url, init) => { seen = init.headers['user-agent']; return new Response(Buffer.alloc(10)); };
    await collect({ url: 'http://x/a?x=1', size: 10, ua: 'my-ua' });
    assert.equal(seen, 'my-ua');
  });
  it('retries a transient failure and then succeeds', async () => {
    let tries = 0;
    globalThis.fetch = source(0, () => (++tries < 3 ? new Response('', { status: 503 }) : undefined));
    const parts = await collect({ url: 'http://x/a?x=1', size: 1000, ua: 'ua' });
    assert.equal(tries, 3);
    assert.equal(parts[0].chunk.length, 1000);
  });
  it('gives up after repeated failures', async () => {
    let tries = 0;
    globalThis.fetch = source(0, () => { tries++; return new Response('', { status: 500 }); });
    await assert.rejects(collect({ url: 'http://x/a?x=1', size: 10, ua: 'ua' }), /HTTP 500/);
    assert.equal(tries, 3);
  });
  it('does not retry client errors such as an expired url', async () => {
    let tries = 0;
    globalThis.fetch = source(0, () => { tries++; return new Response('', { status: 403 }); });
    await assert.rejects(collect({ url: 'http://x/a?x=1', size: 10, ua: 'ua' }), /HTTP 403/);
    assert.equal(tries, 1);
  });
  it('rejects a short read instead of silently truncating audio', async () => {
    globalThis.fetch = async () => new Response(Buffer.alloc(5));
    await assert.rejects(collect({ url: 'http://x/a?x=1', size: 10, ua: 'ua' }), /short read/);
  });
  it('requires a known content length', async () => {
    await assert.rejects(collect({ url: 'http://x/a', size: 0, ua: 'ua' }), /content length/);
  });
});
