// Offline stand-in for the real server, used by the browser e2e test.
// Same app + converter, but the extractor serves synthetic click tracks:
//   aaaaaaaaaaa = 128 BPM, bbbbbbbbbbb = 100 BPM, ssssssssssi = silence, anything starting "fail" fails.
// Usage: PORT=8766 node test/server/fake-server.mjs
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.js';
import { createConverter } from '../../server/convert.js';
import { clickTrack, sleep, tmpCache } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracks = {
  aaaaaaaaaaa: { title: 'Alpha - 128 Song', audio: clickTrack({ bpm: 128, seconds: 20 }) },
  bbbbbbbbbbb: { title: 'Beta - 100 Song', audio: clickTrack({ bpm: 100, seconds: 20 }) },
  ssssssssssi: { title: 'Silence', audio: Buffer.concat([clickTrack({ seconds: 1 }).subarray(0, 44), Buffer.alloc(22050 * 2 * 8)]) },
};
// the silent track needs a WAV header that matches its length
tracks.ssssssssssi.audio.writeUInt32LE(36 + 22050 * 2 * 8, 4);
tracks.ssssssssssi.audio.writeUInt32LE(22050 * 2 * 8, 40);

const converter = createConverter({
  cacheDir: tmpCache(),
  resolve: async (id) => {
    await sleep(Number(process.env.FAKE_DELAY_MS) || 150);
    if (id.startsWith('fail')) throw new Error('video unavailable (fake)');
    const t = tracks[id];
    if (!t) throw new Error('unknown fake video ' + id);
    return { id, title: t.title, author: 'Fake', durationSec: 20, url: 'fake', size: t.audio.length, mime: 'audio/wav', ua: 'x' };
  },
  stream: async function* (info) {
    const { audio } = tracks[info.id];
    for (let at = 0; at < audio.length; at += 100_000) {
      yield { chunk: audio.subarray(at, at + 100_000), received: Math.min(at + 100_000, audio.length), total: audio.length };
    }
  },
});
const port = Number(process.env.PORT) || 8766;
createServer(createApp({ converter, root })).listen(port, '127.0.0.1', () => console.log(`fake Tube DJ on http://127.0.0.1:${port}`));
