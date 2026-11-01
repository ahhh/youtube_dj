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

// Regressions: bad settings must not hang or throw (run in a child so a hang fails instead of freezing the suite)
{
  const { spawnSync } = require('child_process');
  const run = code => spawnSync(process.execPath, ['-e', `const {DSP,Core}=require(${JSON.stringify(require.resolve('../core.js'))});${code}`], { timeout: 8000, encoding: 'utf8' });
  const tone = 'const x=new Float32Array(48000*8);for(let i=0;i<x.length;i++)x[i]=Math.sin(i*0.05)*(i%24000<2000?1:0.05);';
  for (const [name, opt] of [['bpmMin 0', '{bpmMin:0}'], ['bpmMin NaN', '{bpmMin:NaN}'], ['bpmMin negative', '{bpmMin:-5}'], ['rate 0', '{rate:0}'], ['rate NaN', '{rate:NaN}']]) {
    const r = run(`${tone}const r=DSP.analyze([x],48000,${opt});console.log(Number.isFinite(r.bpm)&&r.bpm>=30&&r.bpm<=400?'fine':'bad '+r.bpm)`);
    ok(r.status === 0 && r.stdout.trim() === 'fine', `analyze survives ${name}: ${r.error || r.stderr || r.stdout}`);
  }
  const r = run(`const ts=[{id:1,bpm:120,camelot:'8A'},{id:2,bpm:124,camelot:'9A'},{id:3,bpm:100,camelot:'1B'}];console.log(Core.orderTracks(ts,false,{keyWeight:NaN}).length)`);
  ok(r.status === 0 && r.stdout.trim() === '3', 'orderTracks survives a NaN keyWeight: ' + r.stderr);
}
{
  const a = { bpm: 70, camelot: '8A' }, b = { bpm: 140, camelot: '8A' }, c = { bpm: 132, camelot: '8A' }, d = { bpm: 120, camelot: '8A' };
  ok(Core.bpmRel(a, b).half && !Core.bpmRel(a, b, { halfDouble: false }).half, 'halfDouble:false disables half/double-time matching');
  ok(Core.transCost(a, b, { halfDouble: false }) > Core.transCost(a, b) + 5, 'without half/double time a 2:1 jump is expensive');
  ok(Core.transCost(d, c, { bpmWeight: 0 }) === 0, 'bpmWeight 0 leaves only the key cost');
  ok(Core.transCost(d, c, { bpmWeight: 2 }) > Core.transCost(d, c), 'bpmWeight scales the tempo cost');
  ok(Core.transCost(d, c, { maxJump: 6 }) >= Core.transCost(d, c) + 8, 'a jump past maxJump is penalised');
  ok(Core.transCost(d, { bpm: 123, camelot: '8A' }, { maxJump: 6 }) === Core.transCost(d, { bpm: 123, camelot: '8A' }), 'a jump inside maxJump is not');
}
{
  const silent = DSP.analyze([new Float32Array(48000 * 6)], 48000, {});
  ok(silent.rms < 0.0005, 'silent audio reports ~zero rms so callers can reject it');
  ok(DSP.analyze([synth({ bpm: 120, tonic: 0, minor: false, seconds: 8 })], 48000, { bpmMin: 'junk' }).bpm >= 80, 'non-numeric bpmMin falls back to the default');
}

// titleKey: same song uploaded twice collapses, different versions do not
{
  const k = Core.titleKey;
  ok(k('Song (Official Video)') === k('Song'), 'official video suffix ignored');
  ok(k('Song [Lyrics]') === k('Song'), 'lyrics tag ignored');
  ok(k('Song (HD Remastered)') === k('Song'), 'remaster tag ignored');
  ok(k('Song (Official Remix)') !== k('Song'), 'remix is a different track');
  ok(k('Song (Clean Bandit Remix)') !== k('Song'), 'named remix is a different track');
  ok(k('Song (Live)') !== k('Song'), 'live version kept');
  ok(k('Song (Official Video) [4K]') === k('Song'), 'stacked tags');
  ok(k('') === '' && k(null) === '', 'empty titles');
}

// Perf: 400 tracks
{
  const ts = Array.from({ length: 400 }, (_, i) => ({ id: i, bpm: 85 + Math.random() * 70, camelot: (1 + (i % 12)) + 'AB'[i % 2] }));
  const t0 = Date.now(); Core.orderTracks(ts, false, {}); console.log('order 400 tracks:', Date.now() - t0, 'ms');
}
console.log(`\n${pass} checks passed`);
