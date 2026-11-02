import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVideoId, safeFilename } from '../../tools/tubedj-convert.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'tubedj-convert.mjs');
const run = (...args) => promisify(execFile)(process.execPath, [CLI, ...args]).then(
  (r) => ({ code: 0, ...r }),
  (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
);

describe('parseVideoId', () => {
  const ID = 'dQw4w9WgXcQ';
  it('understands the usual link shapes', () => {
    for (const s of [
      ID, ` ${ID} `,
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}&list=PLx&t=30s`,
      `youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `https://www.youtube.com/live/${ID}`,
    ]) assert.equal(parseVideoId(s), ID, s);
  });
  it('rejects playlists, other sites and junk', () => {
    for (const s of ['', 'hello', 'https://www.youtube.com/playlist?list=PL123', `https://example.com/watch?v=${ID}`, 'https://youtu.be/short', 'https://www.youtube.com/watch?v=dQw4w9WgXc!']) {
      assert.equal(parseVideoId(s), null, s);
    }
  });
});

describe('safeFilename', () => {
  it('strips characters that are illegal on common filesystems', () => {
    assert.equal(safeFilename('AC/DC: Back <In> "Black"?*|', 'x'), 'AC DC Back In Black');
    assert.equal(safeFilename('trailing dots...', 'x'), 'trailing dots');
  });
  it('falls back when nothing usable is left', () => {
    assert.equal(safeFilename('///', 'dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(safeFilename('', 'id'), 'id');
  });
  it('caps the length', () => {
    assert.equal(safeFilename('a'.repeat(400), 'x').length, 150);
  });
});

describe('command line', () => {
  it('prints usage for --help', async () => {
    const r = await run('--help');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: node tubedj-convert\.mjs/);
  });
  it('exits 2 with usage when given nothing', async () => {
    const r = await run();
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Usage/);
  });
  it('reports links it cannot use without touching the network', async () => {
    const r = await run('https://www.youtube.com/playlist?list=PL1', '--raw');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not a YouTube video link or id/);
  });
});
