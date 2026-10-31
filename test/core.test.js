// Run: node test/core.test.js
const assert = require('assert');
const { Core, DSP } = require('../core.js');

// Synthetic track: kick on every beat, hat on offbeats, sustained triad + bass.
function synth({ bpm, tonic, minor, seconds = 20, sr = 48000, offset = 0 }) {
  const x = new Float32Array(seconds * sr), P = 60 / bpm;
  const f = m => 440 * Math.pow(2, (m - 69) / 12);
  const root = 48 + tonic, third = root + (minor ? 3 : 4), fifth = root + 7;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    let v = 0;
    for (const m of [root, third, fifth, root + 12]) v += 0.08 * Math.sin(2 * Math.PI * f(m) * t) + 0.03 * Math.sin(4 * Math.PI * f(m) * t);
    v += 0.1 * Math.sin(2 * Math.PI * f(root - 12) * t);
    const tb = ((t - offset) % P + P) % P;
    v += 0.8 * Math.exp(-tb * 25) * Math.sin(2 * Math.PI * 55 * tb);
    const th = ((t - offset - P / 2) % P + P) % P;
    v += 0.2 * Math.exp(-th * 80) * (Math.random() * 2 - 1);
    x[i] = v * 0.5;
  }
  return x;
}

let pass = 0;
const ok = (c, m) => { assert(c, m); pass++; };

for (const [bpm, tonic, minor, cam] of [[128, 9, true, '8A'], [100, 0, false, '8B'], [174, 7, false, '9B'], [92, 2, true, '7A']]) {
  const r = DSP.analyze([synth({ bpm, tonic, minor }), synth({ bpm, tonic, minor })], 48000, { bpmMin: 80 });
  let want = bpm; while (want >= 160) want /= 2;
  console.log(`bpm ${bpm} → ${r.bpm} (conf ${r.bpmConf.toFixed(2)}), key ${Core.keyName(r.tonic, r.minor)} ${Core.camelot(r.tonic, r.minor)} want ${cam}`);
  ok(Math.abs(r.bpm - want) < 0.6, 'bpm');
  ok(Core.camelot(r.tonic, r.minor) === cam, 'key');
}

// 2x playback (pitch preserved): tempo doubles, analysis divides by rate.
{
  const r = DSP.analyze([synth({ bpm: 252, tonic: 9, minor: true, seconds: 10 })], 48000, { rate: 2, bpmMin: 80 });
  console.log('2x:', r.bpm);
  ok(Math.abs(r.bpm - 126) < 0.6, '2x bpm');
}

// Beat phase
{
  const r = DSP.analyze([synth({ bpm: 120, tonic: 0, minor: false, offset: 0.2, sr: 22050, seconds: 30 })], 22050, { phase: true });
  const err = Math.abs(((r.beatOffset - 0.2) % 0.5 + 0.75) % 0.5 - 0.25);
  console.log('phase offset', r.beatOffset.toFixed(3), 'err', err.toFixed(3));
  ok(err < 0.03, 'phase');
}

// Theory
ok(Core.camelot(9, true) === '8A' && Core.camelot(0, false) === '8B' && Core.camelot(11, false) === '1B', 'camelot');
ok(JSON.stringify(Core.parseKey('Bbm')) === JSON.stringify({ tonic: 10, minor: true }), 'parse Bbm');
ok(JSON.stringify(Core.parseKey('8a')) === JSON.stringify({ tonic: 9, minor: true }), 'parse 8a');
ok(Core.parseKey('F# major').tonic === 6 && Core.parseKey('C').minor === false && Core.parseKey('Hm') === null, 'parse misc');
ok(Core.titleKey('Daft Punk - One More Time (Official Video)') === Core.titleKey('Daft Punk - One More Time [Official Audio]'), 'titleKey');

// Ordering: shuffled tracks should come out with small BPM steps.
{
  const mk = (id, bpm, cam) => ({ id, bpm, camelot: cam });
  const ts = [mk('a', 128, '8A'), mk('b', 100, '5B'), mk('c', 124, '7A'), mk('d', 102, '5B'), mk('e', 126, '8A'),
    mk('f', 104, '6B'), mk('g', 122, '7A'), mk('h', 110, '6A'), mk('i', 116, '6A'), mk('j', 113, '6A')];
  const shuffled = ts.slice().sort(() => Math.random() - 0.5);
  const out = Core.orderTracks(shuffled, false, { keyWeight: 1, mode: 'smooth' });
  const steps = out.slice(1).map((t, i) => Math.abs(t.bpm / out[i].bpm - 1) * 100);
  console.log('smooth:', out.map(t => t.bpm).join(' → '), 'max step', Math.max(...steps).toFixed(1) + '%');
  ok(out.length === 10 && new Set(out).size === 10, 'perm');
  ok(Math.max(...steps) < 6, 'smooth steps');
  const rising = Core.orderTracks(shuffled, false, { keyWeight: 1, mode: 'rising' });
  ok(rising.every((t, i) => i === 0 || t.bpm >= rising[i - 1].bpm * 0.99), 'rising');
  const fixed = Core.orderTracks([ts[3], ...ts.filter(t => t !== ts[3])], true, {});
  ok(fixed[0] === ts[3], 'fixed first');
  const g = Core.tempoGroups(ts);
  console.log('groups:', g.map(x => `${x.lo}-${x.hi}(${x.ids.length})`).join(' '));
  ok(g.reduce((s, x) => s + x.ids.length, 0) === 10, 'groups');
}

// Perf: 400 tracks
{
  const ts = Array.from({ length: 400 }, (_, i) => ({ id: i, bpm: 85 + Math.random() * 70, camelot: (1 + (i % 12)) + 'AB'[i % 2] }));
  const t0 = Date.now(); Core.orderTracks(ts, false, {}); console.log('order 400 tracks:', Date.now() - t0, 'ms');
}
console.log(`\n${pass} checks passed`);
