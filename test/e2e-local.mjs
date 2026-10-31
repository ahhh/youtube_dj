// End-to-end check of local-file mode in headless Chrome (macOS path below).
// Serve the folder first:  python3 -m http.server 8765
// Then run:                node test/e2e-local.mjs [http://localhost:8765/]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:8765/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + mkdtempSync(join(tmpdir(), 'tubedj-')),
  '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 40 && !ws; i++) {
  try { const j = await (await fetch('http://127.0.0.1:9333/json')).json(); ws = new WebSocket(j.find(x => x.type === 'page').webSocketDebuggerUrl); }
  catch { await sleep(250); }
}
await new Promise(r => (ws.onopen = r));
let id = 0, failures = 0;
const pend = {};
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === 'Runtime.exceptionThrown') { failures++; console.log('PAGE EXCEPTION', m.params.exceptionDetails.exception?.description); }
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result.result?.value;
};
const check = (cond, msg) => { console.log((cond ? 'ok   ' : 'FAIL ') + msg); if (!cond) failures++; };

await send('Runtime.enable');
await send('Page.navigate', { url: URL_ });
await sleep(3000);

// Three synthetic tracks: kick on every beat + a sustained triad.
await ev(`(() => {
  function wav(bpm, tonic, minor, secs) {
    const sr = 22050, n = sr * secs, P = 60 / bpm, f = m => 440 * Math.pow(2, (m - 69) / 12);
    const root = 48 + tonic, notes = [root, root + (minor ? 3 : 4), root + 7];
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const t = i / sr, tb = t % P;
      let s = 0.1 * Math.sin(2 * Math.PI * f(root - 12) * t) + 0.7 * Math.exp(-tb * 25) * Math.sin(2 * Math.PI * 55 * tb);
      for (const m of notes) s += 0.08 * Math.sin(2 * Math.PI * f(m) * t);
      v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s * 0.6)) * 32767, true);
    }
    return buf;
  }
  addFiles([
    new File([wav(124, 9, true, 40)], 'Test Artist - Alpha.wav', { type: 'audio/wav' }),
    new File([wav(126, 4, true, 40)], 'Test Artist - Bravo.wav', { type: 'audio/wav' }),
    new File([wav(100, 0, false, 40)], 'Test Artist - Charlie.wav', { type: 'audio/wav' }),
  ]);
})()`);
await sleep(5000);

const tracks = JSON.parse(await ev(`JSON.stringify(Object.values(S.tracks).map(t => ({ title: t.title, status: t.status, bpm: t.bpm, cam: t.camelot })))`));
const by = Object.fromEntries(tracks.map(t => [t.title, t]));
check(by.Alpha?.bpm === 124 && by.Alpha.cam === '8A', `Alpha analyzed: ${by.Alpha?.bpm} BPM ${by.Alpha?.cam}`);
check(by.Bravo?.bpm === 126 && by.Bravo.cam === '9A', `Bravo analyzed: ${by.Bravo?.bpm} BPM ${by.Bravo?.cam}`);
check(by.Charlie?.bpm === 100 && by.Charlie.cam === '8B', `Charlie analyzed: ${by.Charlie?.bpm} BPM ${by.Charlie?.cam}`);
const set = await ev(`S.set.map(id => S.tracks[id].title).join(' → ')`);
check(set === 'Charlie → Alpha → Bravo', 'set ordered by tempo: ' + set);

await ev(`S.settings.fadeSec = 3; startSet()`);
await sleep(1500);
check(await ev(`D.started && D.decks[D.live].playing && D.decks[1 - D.live].track?.title === 'Alpha'`), 'set started, Alpha queued');

// Mix 1 (100 → 124: too far apart to sync) — sample the crossfader mid-fade.
await ev(`void mixNow()`);
await sleep(1600);
const mid = JSON.parse(await ev(`JSON.stringify({ fading: D.fading, x: D.x, playing: D.decks.map(d => d.playing) })`));
check(mid.fading && mid.x > 0.2 && mid.x < 0.8 && mid.playing.every(Boolean), `mid-fade: x=${mid.x.toFixed(2)}, both decks playing`);
await sleep(3000);
check(await ev(`!D.fading && S.pos === 1 && D.decks[D.live].track.title === 'Alpha' && D.decks[1 - D.live].track?.title === 'Bravo'`), 'mix 1 complete, Bravo queued');

// Mix 2 (124 → 126: beat-synced) — measure phase error as the lock converges.
await ev(`S.settings.fadeSec = 6; window._ph = []; const fr = v => v - Math.floor(v);
  const iv = setInterval(() => { const o = D.decks[D.live], i = D.decks[1 - D.live];
    if (!D.fading) return clearInterval(iv); if (!i.playing) return;
    const a = o.track, b = i.track;
    _ph.push(Math.round((fr((i.time() - b.beatOffset) / (60 / b.bpm) - (o.time() - a.beatOffset) / (60 / a.bpm) + 0.5) - 0.5) * 60 / b.bpm * 1000)); }, 500);
  void mixNow()`);
await sleep(1500);
const rate = await ev(`D.decks[1 - D.live].audio.playbackRate`);
check(Math.abs(rate / (124 / 126) - 1) < 0.07, `incoming tempo matched (rate ${rate.toFixed(4)}, target ${(124 / 126).toFixed(4)})`);
await sleep(6000);
const ph = JSON.parse(await ev(`JSON.stringify(_ph)`));
console.log('     phase error (ms, every 0.5 s):', ph.join(' '));
const tail = ph.slice(-3).map(Math.abs).sort((a, b) => a - b)[1];
check(ph.length > 3 && tail < 30, `beats phase-locked by end of fade (median of last 3: ${tail} ms)`);
check(await ev(`!D.fading && S.pos === 2 && D.decks[D.live].track.title === 'Bravo'`), 'mix 2 complete');

chrome.kill();
await new Promise(r => chrome.on('exit', r));
console.log(failures ? `\n${failures} failure(s)` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
