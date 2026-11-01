// Pure logic shared by the app and the Node tests: music theory, transition
// scoring, set ordering, and audio analysis (tempo, key, beat phase).
// No DOM access in this file.

const Core = (() => {
  const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function camelot(tonic, minor) {
    const p = minor ? (tonic + 3) % 12 : tonic; // relative major for minor keys
    return ((p * 7 + 7) % 12 + 1) + (minor ? 'A' : 'B');
  }

  function keyFromCamelot(code) {
    const m = /^(\d{1,2})\s*([AB])$/i.exec(String(code).trim());
    if (!m) return null;
    const minor = m[2].toUpperCase() === 'A';
    const want = +m[1] + (minor ? 'A' : 'B');
    for (let t = 0; t < 12; t++) if (camelot(t, minor) === want) return { tonic: t, minor };
    return null;
  }

  // Accepts "8A", "Am", "C#m", "Bb", "F# minor", "Eb major"
  function parseKey(str) {
    const s = String(str || '').trim();
    if (!s) return null;
    const c = keyFromCamelot(s);
    if (c) return c;
    const L = s[0].toUpperCase();
    if (!(L in PC)) return null;
    let rest = s.slice(1).trim().toLowerCase().replace('♯', '#').replace('♭', 'b');
    let t = PC[L];
    if (rest[0] === '#') { t++; rest = rest.slice(1); }
    else if (rest[0] === 'b') { t--; rest = rest.slice(1); }
    rest = rest.trim();
    let minor;
    if (rest === '' || /^maj(or)?$/.test(rest)) minor = false;
    else if (/^(m|min|minor)$/.test(rest)) minor = true;
    else return null;
    return { tonic: (t + 12) % 12, minor };
  }

  const keyName = (tonic, minor) => NOTES[tonic] + (minor ? 'm' : '');

  function camParts(t) {
    if (!t || !t.camelot) return null;
    return { n: parseInt(t.camelot, 10), l: t.camelot.slice(-1) };
  }

  function keyRel(a, b) {
    const A = camParts(a), B = camParts(b);
    if (!A || !B) return { cost: 2, label: 'key ?' };
    const up = (B.n - A.n + 12) % 12;
    const dn = Math.min(up, 12 - up);
    if (A.l === B.l) {
      if (dn === 0) return { cost: 0, label: 'same key' };
      if (dn === 1) return { cost: 1, label: (up === 1 ? '+1' : '−1') + ' harmonic' };
      if (up === 2) return { cost: 2.5, label: '+2 energy boost' };
      if (up === 7) return { cost: 3, label: '+1 semitone lift' };
      return { cost: 4 + dn, label: 'key clash' };
    }
    if (dn === 0) return { cost: 1, label: 'relative ' + (B.l === 'A' ? 'minor' : 'major') };
    if (dn === 1) return { cost: 2.5, label: 'diagonal' };
    return { cost: 5 + dn, label: 'key clash' };
  }

  function bpmRel(a, b) {
    if (!a || !b || !a.bpm || !b.bpm) return { cost: 3, pct: null, half: false, label: 'BPM ?' };
    const r = Math.log(b.bpm / a.bpm);
    let d = Math.abs(r) * 100, half = false;
    const dh = Math.min(Math.abs(r - Math.LN2), Math.abs(r + Math.LN2)) * 100;
    if (dh + 4 < d) { d = dh + 4; half = true; }
    const cost = d <= 1.5 ? d * 0.3 : 0.45 + Math.pow(d - 1.5, 1.4) * 0.6;
    const pct = (b.bpm / a.bpm - 1) * 100;
    const label = half ? 'half/double time' : (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(1) + '%';
    return { cost, pct, half, label };
  }

  function transCost(a, b, o = {}) {
    let c = bpmRel(a, b).cost + (Number.isFinite(o.keyWeight) ? o.keyWeight : 1) * keyRel(a, b).cost;
    if (a.bpm && b.bpm) {
      const pct = (b.bpm / a.bpm - 1) * 100;
      if (o.mode === 'rising' && pct < -1) c += 2 - pct;
      if (o.mode === 'falling' && pct > 1) c += 2 + pct;
    }
    return c;
  }

  const quality = c => (c < 2.2 ? 'good' : c < 5 ? 'ok' : 'bad');

  // Open-path ordering (asymmetric TSP): greedy nearest neighbour from a few
  // starts, then 2-opt + relocate. If fixedFirst, tracks[0] stays first.
  function orderTracks(tracks, fixedFirst, o = {}) {
    const n = tracks.length;
    if (n <= 2 && fixedFirst) return tracks.slice();
    if (n <= 1) return tracks.slice();
    const C = new Float64Array(n * n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) if (i !== j) C[i * n + j] = transCost(tracks[i], tracks[j], o);
    const c = (a, b) => C[a * n + b];
    const lo = fixedFirst ? 1 : 0;

    const greedy = s => {
      const used = new Uint8Array(n), p = [s];
      used[s] = 1;
      for (let k = 1; k < n; k++) {
        const last = p[p.length - 1];
        let bj = -1, bc = Infinity;
        for (let j = 0; j < n; j++) if (!used[j] && c(last, j) < bc) { bc = c(last, j); bj = j; }
        p.push(bj); used[bj] = 1;
      }
      return p;
    };
    const pathCost = p => { let s = 0; for (let k = 0; k + 1 < p.length; k++) s += c(p[k], p[k + 1]); return s; };

    const improve = p => {
      const F = new Float64Array(n), B = new Float64Array(n);
      const prefix = () => {
        for (let k = 1; k < n; k++) { F[k] = F[k - 1] + c(p[k - 1], p[k]); B[k] = B[k - 1] + c(p[k], p[k - 1]); }
      };
      let improved = true, guard = 0;
      while (improved && guard++ < 60) {
        improved = false;
        prefix();
        for (let i = lo; i < n - 1; i++) {
          for (let j = i + 1; j < n; j++) {
            const pre = i > 0 ? c(p[i - 1], p[i]) : 0, preN = i > 0 ? c(p[i - 1], p[j]) : 0;
            const post = j < n - 1 ? c(p[j], p[j + 1]) : 0, postN = j < n - 1 ? c(p[i], p[j + 1]) : 0;
            const delta = preN + (B[j] - B[i]) + postN - (pre + (F[j] - F[i]) + post);
            if (delta < -1e-9) {
              for (let a = i, b = j; a < b; a++, b--) { const t = p[a]; p[a] = p[b]; p[b] = t; }
              prefix();
              improved = true;
            }
          }
        }
        for (let i = lo; i < n; i++) {
          const x = p[i], a = i > 0 ? p[i - 1] : -1, b = i < n - 1 ? p[i + 1] : -1;
          const rem = (a >= 0 ? c(a, x) : 0) + (b >= 0 ? c(x, b) : 0) - (a >= 0 && b >= 0 ? c(a, b) : 0);
          const q = p.slice(0, i).concat(p.slice(i + 1));
          let bestGain = 1e-9, bestK = -1;
          for (let k = lo; k <= q.length; k++) {
            if (k === i) continue;
            const u = k > 0 ? q[k - 1] : -1, v = k < q.length ? q[k] : -1;
            const add = (u >= 0 ? c(u, x) : 0) + (v >= 0 ? c(x, v) : 0) - (u >= 0 && v >= 0 ? c(u, v) : 0);
            if (rem - add > bestGain) { bestGain = rem - add; bestK = k; }
          }
          if (bestK >= 0) { q.splice(bestK, 0, x); for (let k = 0; k < n; k++) p[k] = q[k]; improved = true; }
        }
      }
      return p;
    };

    let starts;
    if (fixedFirst) starts = [0];
    else {
      const byBpm = [...Array(n).keys()].sort((a, b) => (tracks[a].bpm || 0) - (tracks[b].bpm || 0));
      const k = n > 200 ? 3 : 6;
      if (o.mode === 'rising') starts = byBpm.slice(0, k);
      else if (o.mode === 'falling') starts = byBpm.slice(-k);
      else starts = [...new Set(Array.from({ length: k }, (_, i) => byBpm[Math.round(i * (n - 1) / (k - 1))]))];
    }
    let best = null, bestCost = Infinity;
    for (const s of starts) {
      const p = improve(greedy(s));
      const pc = pathCost(p);
      if (pc < bestCost) { bestCost = pc; best = p; }
    }
    return best.map(i => tracks[i]);
  }

  // Cluster tracks into tempo groups: a group spans at most ~4.5% from its slowest track.
  function tempoGroups(tracks) {
    const ts = tracks.filter(t => t.bpm).sort((a, b) => a.bpm - b.bpm);
    const groups = [];
    let g = null;
    for (const t of ts) {
      if (!g || t.bpm > g.lo * 1.045) { g = { lo: t.bpm, hi: t.bpm, ids: [] }; groups.push(g); }
      g.hi = t.bpm;
      g.ids.push(t.id);
    }
    return groups;
  }

  // Normalised title used to spot the same song uploaded twice.
  function titleKey(title) {
    return String(title || '').toLowerCase()
      // Drop upload-noise brackets, but keep ones naming a different version (remix, edit, live...).
      .replace(/[([{][^)\]}]*[)\]}]/g, m => (/\b(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(ed)?|explicit)\b/.test(m) && !/\b(re-?mix|mix|edit|cover|live|acoustic|instrumental|version|bootleg|flip)\b/.test(m) ? '' : m))
      .replace(/\b(official (music )?video|official audio|lyrics?|hd|hq)\b/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  return { NOTES, camelot, parseKey, keyName, keyRel, bpmRel, transCost, quality, orderTracks, tempoGroups, titleKey };
})();

const DSP = (() => {
  const hannCache = {};
  const hann = n => (hannCache[n] ||= Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))));

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const a = i + k, b = a + h;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function biquadLP(x, sr, fc) {
    const w0 = 2 * Math.PI * fc / sr, alpha = Math.sin(w0) / (2 * Math.SQRT1_2), cs = Math.cos(w0);
    const a0 = 1 + alpha, b0 = (1 - cs) / 2 / a0, b1 = (1 - cs) / a0, b2 = b0, a1 = -2 * cs / a0, a2 = (1 - alpha) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  // Low-pass and decimate to ~11 kHz: plenty for onsets and chroma, and much faster.
  function prepare(x, sr) {
    const factor = Math.max(1, Math.round(sr / 11025));
    if (factor === 1) return { x, sr };
    const fc = sr / factor * 0.42;
    const y = biquadLP(biquadLP(x, sr, fc), sr, fc);
    const out = new Float32Array(Math.floor(y.length / factor));
    for (let i = 0; i < out.length; i++) out[i] = y[i * factor];
    return { x: out, sr: sr / factor };
  }

  // Spectral-flux onset strength, local-mean removed and half-wave rectified.
  function onsetEnv(x, sr) {
    const N = 1024, H = 128, half = N / 2, w = hann(N);
    const re = new Float32Array(N), im = new Float32Array(N), prev = new Float32Array(half);
    const nF = Math.max(0, Math.floor((x.length - N) / H) + 1);
    const env = new Float32Array(nF), lowEnv = new Float32Array(nF);
    const lowK = Math.max(2, Math.round(180 / (sr / N))); // kick/bass band marks the beat phase
    for (let f = 0; f < nF; f++) {
      const o = f * H;
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
      fft(re, im);
      let s = 0, sl = 0;
      for (let k = 1; k < half; k++) {
        const m = Math.log1p(100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
        const d = m - prev[k];
        if (d > 0 && f > 0) { s += d; if (k <= lowK) sl += d; }
        prev[k] = m;
      }
      env[f] = s;
      lowEnv[f] = sl;
    }
    const fps = sr / H, W = Math.max(1, Math.round(fps * 0.25));
    const cs = new Float64Array(nF + 1);
    for (let i = 0; i < nF; i++) cs[i + 1] = cs[i] + env[i];
    const out = new Float32Array(nF);
    for (let i = 0; i < nF; i++) {
      const a = Math.max(0, i - W), b = Math.min(nF, i + W + 1);
      out[i] = Math.max(0, env[i] - (cs[b] - cs[a]) / (b - a));
    }
    return { env: out, lowEnv, fps, frameCenter: N / 2 / sr };
  }

  function autocorr(env, maxLag) {
    const n = env.length;
    maxLag = Math.min(maxLag, n - 1);
    const ac = new Float64Array(maxLag + 1);
    for (let L = 0; L <= maxLag; L++) {
      let s = 0;
      for (let i = 0; i + L < n; i++) s += env[i] * env[i + L];
      ac[L] = s / (n - L);
    }
    const z = ac[0] || 1;
    for (let L = 0; L <= maxLag; L++) ac[L] /= z;
    return ac;
  }

  // Comb-filtered autocorrelation over 60–200 BPM (scaled by playback rate) with a
  // gentle prior near 120. Confidence = margin over the best non-octave rival.
  function tempo(acs, fps, rate = 1) {
    if (!(rate > 0)) rate = 1; // a zero/NaN rate would make the BPM sweep below loop forever
    const len = Math.min(...acs.map(a => a.length));
    const ac = new Float64Array(len);
    for (const a of acs) for (let i = 0; i < len; i++) ac[i] += a[i] / acs.length;
    const at = L => { const i = Math.floor(L), f = L - i; return i + 1 >= len ? null : ac[i] * (1 - f) + ac[i + 1] * f; };
    const ws = [1, 0.7, 0.5, 0.35], cand = [];
    let best = -Infinity, bestB = 0;
    for (let b = 60 * rate; b <= 200 * rate; b += 0.05 * rate) {
      const P = 60 * fps / b;
      let s = 0;
      for (let k = 1; k <= 4; k++) { const v = at(P * k); if (v == null) break; s += ws[k - 1] * v; }
      const sc = s * (0.6 + 0.4 * Math.exp(-0.5 * Math.pow(Math.log2(b / rate / 120), 2)));
      cand.push([b, sc]);
      if (sc > best) { best = sc; bestB = b; }
    }
    let rival = 0;
    for (const [b, sc] of cand) {
      const oct = Math.abs(Math.log2(b / bestB)), d = Math.abs(oct - Math.round(oct));
      if (d > 0.06 && sc > rival) rival = sc;
    }
    return { bpm: bestB, conf: best > 0 ? Math.max(0, Math.min(1, (1 - rival / best) * 2.5)) : 0 };
  }

  // Beat phase: offset (seconds into the analysed buffer) of the strongest beat grid.
  function beatPhase(o, bpm) {
    const P = 60 * o.fps / bpm, env = o.lowEnv;
    let best = -1, bestPhi = 0;
    for (let phi = 0; phi < P; phi += 0.25) {
      let s = 0;
      for (let t = phi; t < env.length - 1; t += P) {
        const i = Math.floor(t), f = t - i;
        s += env[i] * (1 - f) + env[i + 1] * f;
      }
      if (s > best) { best = s; bestPhi = phi; }
    }
    return bestPhi / o.fps + o.frameCenter;
  }

  function chroma(x, sr) {
    const N = 4096, H = 2048, half = N / 2, w = hann(N);
    const re = new Float32Array(N), im = new Float32Array(N);
    const map = [];
    for (let k = 1; k < half; k++) {
      const f = k * sr / N;
      if (f < 90 || f > 3000) continue;
      const midi = 69 + 12 * Math.log2(f / 440), r = Math.round(midi);
      map.push([k, ((r % 12) + 12) % 12, 1 - Math.abs(midi - r) * 1.6]);
    }
    const c = new Float64Array(12), fc = new Float64Array(12);
    for (let o = 0; o + N <= x.length; o += H) {
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
      fft(re, im);
      fc.fill(0);
      let e = 0;
      for (const [k, pc, wt] of map) { const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * wt; fc[pc] += m; e += m; }
      if (e > 1e-3) for (let p = 0; p < 12; p++) c[p] += fc[p] / e;
    }
    return c;
  }

  // Krumhansl–Kessler key profiles
  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  function key(c) {
    const mc = c.reduce((a, b) => a + b, 0) / 12;
    const res = [];
    for (const [minor, prof] of [[false, MAJ], [true, MIN]]) {
      const mp = prof.reduce((a, b) => a + b, 0) / 12;
      for (let t = 0; t < 12; t++) {
        let num = 0, dx = 0, dy = 0;
        for (let p = 0; p < 12; p++) {
          const a = c[p] - mc, b = prof[(p - t + 12) % 12] - mp;
          num += a * b; dx += a * a; dy += b * b;
        }
        res.push({ tonic: t, minor, r: num / Math.sqrt(dx * dy || 1) });
      }
    }
    res.sort((a, b) => b.r - a.r);
    return { ...res[0], conf: Math.max(0, Math.min(1, (res[0].r - res[1].r) * 5)) };
  }

  // segs: mono Float32Arrays at sampleRate sr, captured at playback `rate`.
  // Returns BPM folded into [bpmMin, 2*bpmMin), key, and (optionally) beat phase of segs[0].
  function analyze(segs, sr, { rate = 1, bpmMin = 80, phase = false } = {}) {
    bpmMin = Math.max(30, +bpmMin || 80); // a cleared or zero setting would hang the folding loops below
    if (!(rate > 0)) rate = 1; // zero/NaN playback rate would size the autocorrelation buffer to Infinity
    const acs = [], c = new Float64Array(12);
    let fps = 0, sq = 0, n = 0, first = null;
    for (const raw of segs) {
      for (let i = 0; i < raw.length; i++) sq += raw[i] * raw[i];
      n += raw.length;
      const p = prepare(raw, sr);
      const o = onsetEnv(p.x, p.sr);
      if (!first) first = o;
      fps = o.fps;
      acs.push(autocorr(o.env, Math.ceil(4 * fps / rate) + 2)); // 4 beats at 60 BPM
      const cc = chroma(p.x, p.sr);
      for (let k = 0; k < 12; k++) c[k] += cc[k];
    }
    const tm = tempo(acs, fps, rate);
    let bpm = tm.bpm / rate;
    while (bpm < bpmMin) bpm *= 2;
    while (bpm >= bpmMin * 2) bpm /= 2;
    const k = key(c);
    return {
      bpm: Math.round(bpm * 10) / 10,
      bpmConf: tm.conf,
      tonic: k.tonic, minor: k.minor, keyConf: k.conf,
      beatOffset: phase && first ? beatPhase(first, tm.bpm) : null,
      rms: Math.sqrt(sq / Math.max(1, n)),
    };
  }

  return { analyze, fft, prepare };
})();

if (typeof module !== 'undefined') module.exports = { Core, DSP };
