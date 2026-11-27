/* Drift: polyphonic granular texture synth for Ember Ultimate.
 * Engine: lookahead grain scheduler (AudioBufferSourceNode + Hann-windowed gain per grain),
 * shared post chain: lowpass filter -> dry + ping-pong feedback delay + convolution reverb -> soft compressor.
 * Owns: src/plugins/drift.js, src/plugins/drift.css */
(function () {
  'use strict';

  var MAX_GRAINS = 120;      // hard cap on simultaneously scheduled/playing grains
  var MAX_VOICES = 8;
  var LOOKAHEAD = 0.12;      // seconds of grains scheduled ahead
  var TICK_MS = 25;

  // ---------- params ----------
  var PARAMS = [
    { k: 'pos', l: 'Position', min: 0, max: 1, d: 0.3, fmt: pct },
    { k: 'size', l: 'Size', min: 0.01, max: 1, d: 0.18, log: true, fmt: secs },
    { k: 'scan', l: 'Scan', min: -1, max: 1, d: 0.05, bi: true, fmt: scanFmt },
    { k: 'spray', l: 'Spray', min: 0, max: 1, d: 0.15, fmt: pct },
    { k: 'density', l: 'Density', min: 2, max: 100, d: 18, log: true, fmt: function (v) { return v.toFixed(v < 10 ? 1 : 0) + '/s'; } },
    { k: 'reverse', l: 'Reverse', min: 0, max: 1, d: 0.1, fmt: pct },
    { k: 'pitch', l: 'Pitch Sprd', min: 0, max: 12, d: 0.1, fmt: function (v) { return v < 1 ? Math.round(v * 100) + 'c' : v.toFixed(1) + 'st'; } },
    { k: 'shimmer', l: 'Shimmer', min: 0, max: 1, d: 0, fmt: pct },
    { k: 'stereo', l: 'Stereo', min: 0, max: 1, d: 0.6, fmt: pct },
    { k: 'attack', l: 'Attack', min: 0.005, max: 8, d: 0.6, log: true, fmt: secs },
    { k: 'release', l: 'Release', min: 0.05, max: 12, d: 2.5, log: true, fmt: secs },
    { k: 'cutoff', l: 'Filter', min: 80, max: 18000, d: 9000, log: true, fmt: hz },
    { k: 'reso', l: 'Reso', min: 0, max: 1, d: 0.1, fmt: pct },
    { k: 'reverb', l: 'Reverb', min: 0, max: 1, d: 0.4, fmt: pct },
    { k: 'feedback', l: 'Feedback', min: 0, max: 0.9, d: 0.25, fmt: function (v) { return Math.round(v / 0.9 * 100) + '%'; } },
    { k: 'level', l: 'Level', min: 0, max: 1, d: 0.75, fmt: pct }
  ];
  var PMAP = {}; PARAMS.forEach(function (p) { PMAP[p.k] = p; });
  var GROUPS = [
    { name: 'Grain', keys: ['scan', 'spray', 'density', 'reverse'] },
    { name: 'Pitch', keys: ['pitch', 'shimmer', 'stereo'] },
    { name: 'Shape', keys: ['attack', 'release', 'cutoff', 'reso'] },
    { name: 'Space', keys: ['reverb', 'feedback', 'level'] }
  ];

  function pct(v) { return Math.round(v * 100) + '%'; }
  function secs(v) { return v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(v < 10 ? 2 : 1) + 's'; }
  function hz(v) { return v < 1000 ? Math.round(v) + 'Hz' : (v / 1000).toFixed(1) + 'k'; }
  function scanFmt(v) { var r = scanRate(v); return Math.abs(r) < 0.005 ? 'stop' : (r > 0 ? '+' : '') + r.toFixed(2) + 'x'; }
  function scanRate(v) { return (v < 0 ? -1 : 1) * v * v * 2; } // x realtime
  function toNorm(p, v) {
    if (p.log) return Math.log(v / p.min) / Math.log(p.max / p.min);
    return (v - p.min) / (p.max - p.min);
  }
  function fromNorm(p, n) {
    n = Math.max(0, Math.min(1, n));
    if (p.log) return p.min * Math.pow(p.max / p.min, n);
    return p.min + n * (p.max - p.min);
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function wrap01(x) { return ((x % 1) + 1) % 1; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- presets ----------
  // src: 'builtin:*' or 'cat:<category>' (first sample of that category if present, else fallback)
  var PRESETS = [
    { name: 'Airport Lounge', src: 'cat:pads', fb: 'builtin:choir', p: { pos: 0.25, size: 0.32, scan: 0.12, spray: 0.12, density: 14, reverse: 0.15, pitch: 0.06, shimmer: 0.1, stereo: 0.7, attack: 1.6, release: 4.5, cutoff: 5200, reso: 0.08, reverb: 0.55, feedback: 0.3, level: 0.75 } },
    { name: 'Glass Cathedral', src: 'builtin:glass', p: { pos: 0.15, size: 0.22, scan: 0.04, spray: 0.3, density: 26, reverse: 0.35, pitch: 0.02, shimmer: 0.45, stereo: 0.9, attack: 0.9, release: 7, cutoff: 14000, reso: 0.05, reverb: 0.8, feedback: 0.45, level: 0.7 } },
    { name: 'Night Flight', src: 'builtin:air', p: { pos: 0.5, size: 0.42, scan: 0.22, spray: 0.25, density: 12, reverse: 0.2, pitch: 0.15, shimmer: 0.05, stereo: 0.8, attack: 2.4, release: 6, cutoff: 2600, reso: 0.25, reverb: 0.65, feedback: 0.55, level: 0.8 } },
    { name: 'Cloud Layer', src: 'cat:textures', fb: 'builtin:choir', p: { pos: 0.55, size: 0.6, scan: 0.03, spray: 0.4, density: 22, reverse: 0.5, pitch: 0.1, shimmer: 0.2, stereo: 1, attack: 3, release: 8, cutoff: 7000, reso: 0.05, reverb: 0.7, feedback: 0.35, level: 0.72 } },
    { name: 'Frozen Lake', src: 'builtin:glass', freeze: true, p: { pos: 0.42, size: 0.09, scan: 0, spray: 0.04, density: 60, reverse: 0.5, pitch: 0, shimmer: 0.3, stereo: 0.75, attack: 0.4, release: 5, cutoff: 9000, reso: 0.15, reverb: 0.6, feedback: 0.2, level: 0.68 } },
    { name: 'Dust Choir', src: 'builtin:choir', p: { pos: 0.6, size: 0.12, scan: -0.08, spray: 0.35, density: 40, reverse: 0.3, pitch: 0.25, shimmer: 0, stereo: 0.85, attack: 1.2, release: 3.5, cutoff: 4200, reso: 0.1, reverb: 0.5, feedback: 0.2, level: 0.75 } },
    { name: 'Aurora', src: 'builtin:choir', p: { pos: 0.1, size: 0.5, scan: 0.08, spray: 0.2, density: 16, reverse: 0.1, pitch: 0.04, shimmer: 0.7, stereo: 1, attack: 2.5, release: 9, cutoff: 12000, reso: 0.05, reverb: 0.85, feedback: 0.6, level: 0.65 } },
    { name: 'Deep Field', src: 'builtin:tape', p: { pos: 0.35, size: 0.8, scan: 0.02, spray: 0.15, density: 8, reverse: 0.25, pitch: 0.03, shimmer: 0, stereo: 0.5, attack: 4, release: 10, cutoff: 1400, reso: 0.3, reverb: 0.6, feedback: 0.4, level: 0.85 } },
    { name: 'Lantern Drift', src: 'builtin:tape', p: { pos: 0.7, size: 0.2, scan: 0.35, spray: 0.1, density: 20, reverse: 0, pitch: 0.08, shimmer: 0.25, stereo: 0.65, attack: 0.25, release: 2.5, cutoff: 6500, reso: 0.2, reverb: 0.45, feedback: 0.35, level: 0.78 } },
    { name: 'Tidal Memory', src: 'builtin:air', p: { pos: 0.2, size: 0.25, scan: -0.3, spray: 0.5, density: 34, reverse: 0.6, pitch: 0.5, shimmer: 0.1, stereo: 1, attack: 1.8, release: 6, cutoff: 3800, reso: 0.2, reverb: 0.75, feedback: 0.5, level: 0.75 } },
    { name: 'Stutter Bloom', src: 'builtin:choir', p: { pos: 0.45, size: 0.035, scan: 0.15, spray: 0.06, density: 90, reverse: 0.2, pitch: 2, shimmer: 0.15, stereo: 0.9, attack: 0.05, release: 1.8, cutoff: 10000, reso: 0.1, reverb: 0.4, feedback: 0.3, level: 0.7 } },
    { name: 'Init Grains', src: 'builtin:choir', p: {} }
  ];

  // ---------- built-in sources (rendered at init so Drift works with zero samples) ----------
  var BUILTINS = [
    { id: 'builtin:choir', name: 'Ember Choir' },
    { id: 'builtin:glass', name: 'Glass Harmonics' },
    { id: 'builtin:air', name: 'Wind & Air' },
    { id: 'builtin:tape', name: 'Tape Drone' }
  ];
  var SIN_N = 4096, SIN = new Float32Array(SIN_N + 1);
  for (var si = 0; si <= SIN_N; si++) SIN[si] = Math.sin(si / SIN_N * Math.PI * 2);
  function fsin(ph) { // ph in cycles
    var x = (ph - Math.floor(ph)) * SIN_N, i = x | 0, f = x - i;
    return SIN[i] + (SIN[i + 1] - SIN[i]) * f;
  }
  function mkRand(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

  function renderBuiltin(ctx, id) {
    var sr = ctx.sampleRate, secsLen = 8, n = Math.floor(sr * secsLen);
    var buf = ctx.createBuffer(2, n, sr);
    var L = buf.getChannelData(0), R = buf.getChannelData(1);
    var C4 = 261.6256, rnd = mkRand(id.length * 7919 + 17), i, c, h;
    if (id === 'builtin:choir') {
      // open C voicing (C3, G3, C4) of formant-weighted saw stacks; vowel morphs across the buffer
      var roots = [C4 / 2, C4 * 0.749153, C4];
      for (c = 0; c < 2; c++) {
        var out = c ? R : L;
        roots.forEach(function (f0, vi) {
          var det = 1 + (c ? 0.0021 : -0.0017) * (vi + 1), phs = [], H = 14;
          for (h = 1; h <= H; h++) phs.push(rnd());
          var Hn = Math.min(H, Math.floor(7000 / f0)), W8 = new Float32Array(Hn), BLK = 128, swell = 1, inc0 = f0 * det / sr;
          for (var b0 = 0; b0 < n; b0 += BLK) {
            var u = b0 / n;
            // formants slide a -> o -> e across the buffer (weights updated per block)
            var F1 = 730 - 300 * Math.sin(u * Math.PI) + 120 * u, F2 = 1100 + 900 * u * u;
            swell = 0.55 + 0.45 * fsin(u * 1.5 + vi * 0.33);
            for (h = 1; h <= Hn; h++) { var fh0 = f0 * h; W8[h - 1] = swell * 0.16 / h * (0.25 + Math.exp(-Math.pow((fh0 - F1) / 260, 2)) + 0.7 * Math.exp(-Math.pow((fh0 - F2) / 380, 2))); }
            var b1 = Math.min(n, b0 + BLK);
            for (i = b0; i < b1; i++) {
              var vib = 1 + 0.0035 * fsin(i / sr * (4.6 + vi * 0.7) + vi * 0.3), inc = inc0 * vib, s = 0;
              for (h = 0; h < Hn; h++) { var ph = phs[h] + inc * (h + 1); ph -= Math.floor(ph); phs[h] = ph; s += W8[h] * fsin(ph); }
              out[i] += s;
            }
          }
        });
      }
      // breath
      for (c = 0; c < 2; c++) { var o = c ? R : L, lp = 0; for (i = 0; i < n; i++) { lp += 0.06 * ((rnd() * 2 - 1) - lp); o[i] += lp * 0.12; } }
    } else if (id === 'builtin:glass') {
      var ratios = [1, 2.0, 2.756, 3.0, 4.07, 5.404, 6.8, 8.93];
      var strikes = [];
      for (var st = 0; st < 11; st++) strikes.push({ t: st * 0.72 + rnd() * 0.2, f: C4 * [1, 2, 1.4983, 1, 2, 1.4983 * 2][st % 6], a: 0.5 + rnd() * 0.5, pan: rnd() });
      strikes.forEach(function (sk) {
        var i0 = Math.floor(sk.t * sr);
        for (var r = 0; r < ratios.length; r++) {
          var fr = sk.f * ratios[r] * (1 + (rnd() - 0.5) * 0.002); if (fr > 15000) continue;
          var dec = 3.2 / (1 + r * 0.6), amp = sk.a / (1 + r * 0.8) * 0.22, ph = 0, inc = fr / sr, k = Math.exp(-1 / (dec * sr)), e = amp, atk = Math.floor(sr / 400);
          var gl = Math.cos(sk.pan * Math.PI / 2), gr = Math.sin(sk.pan * Math.PI / 2);
          for (i = i0; i < n; i++) {
            e *= k; if (e < 0.0001) break;
            var j = i - i0;
            ph += inc; var v = fsin(ph) * e * (j < atk ? j / atk : 1);
            L[i] += v * gl; R[i] += v * gr;
          }
        }
      });
      // sustained bowed partial bed so freezes always have content
      var bp = 0, bp2 = 0;
      for (i = 0; i < n; i++) { bp += C4 * 2 / sr; bp2 += C4 * 3 / sr; var bb = (fsin(bp) + 0.4 * fsin(bp2)) * 0.05 * (0.6 + 0.4 * fsin(i / sr * 0.2)); L[i] += bb; R[i] += bb * 0.9; }
    } else if (id === 'builtin:air') {
      // noise through sweeping resonators tuned to C harmonics
      var freqs = [C4 / 2, C4, C4 * 1.4983, C4 * 2, C4 * 3];
      for (c = 0; c < 2; c++) {
        var o2 = c ? R : L;
        var states = freqs.map(function () { return [0, 0]; }), coss = freqs.map(function (f) { return Math.cos(2 * Math.PI * f / sr); });
        var lp2 = 0;
        for (i = 0; i < n; i++) {
          var t2 = i / sr, x = rnd() * 2 - 1;
          lp2 += 0.25 * (x - lp2);
          var acc = 0;
          for (var q = 0; q < freqs.length; q++) {
            var bw = 0.004 + 0.02 * (0.5 + 0.5 * fsin(t2 * 0.11 + q * 0.21 + c * 0.1));
            var rr = 1 - bw;
            var s2 = states[q], y = x * bw * 2 + 2 * rr * coss[q] * s2[0] - rr * rr * s2[1];
            s2[1] = s2[0]; s2[0] = y;
            acc += y * (0.6 + 0.4 * fsin(t2 * (0.07 + q * 0.03) + q * 0.4 + c * 0.25)) / (1 + q * 0.3);
          }
          var gust = 0.5 + 0.5 * fsin(t2 * 0.19 + c * 0.15);
          o2[i] = acc * 0.55 + lp2 * 0.08 * gust;
        }
      }
    } else { // tape: detuned saw stack, wow & flutter, slow lowpass breathing
      var vs = [C4 / 2, C4 / 2 * 1.0035, C4 * 0.749153, C4, C4 * 0.9968];
      for (c = 0; c < 2; c++) {
        var o3 = c ? R : L, ph3 = vs.map(function () { return rnd(); }), z = 0, z2 = 0;
        for (i = 0; i < n; i++) {
          var t3 = i / sr, wow = 1 + 0.0025 * fsin(t3 * 0.6 + c * 0.2) + 0.0008 * fsin(t3 * 7.3);
          var s3 = 0;
          for (var vv = 0; vv < vs.length; vv++) {
            ph3[vv] += vs[vv] * wow * (c ? 1.0009 : 0.9993) / sr;
            var p3 = ph3[vv] - Math.floor(ph3[vv]);
            s3 += (p3 * 2 - 1);
          }
          var cut = 0.02 + 0.06 * (0.5 + 0.5 * fsin(t3 / secsLen * 2 + c * 0.1));
          z += cut * (s3 - z); z2 += cut * (z - z2);
          o3[i] = z2 * 0.16 + (rnd() * 2 - 1) * 0.004;
        }
      }
    }
    // normalise to -3 dBFS and fade the ends
    var peak = 0;
    for (c = 0; c < 2; c++) { var d = buf.getChannelData(c); for (i = 0; i < n; i++) { var a = Math.abs(d[i]); if (a > peak) peak = a; } }
    var g = peak > 0 ? 0.7 / peak : 1, fade = Math.floor(sr * 0.05);
    for (c = 0; c < 2; c++) {
      var dd = buf.getChannelData(c);
      for (i = 0; i < n; i++) { var fg = i < fade ? i / fade : (i > n - fade ? (n - i) / fade : 1); dd[i] *= g * fg; }
    }
    return buf;
  }

  function reverseBuffer(ctx, buf) {
    var r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var s = buf.getChannelData(c), d = r.getChannelData(c), n = s.length;
      for (var i = 0; i < n; i++) d[i] = s[n - 1 - i];
    }
    return r;
  }

  function makeImpulse(ctx, secsLen) {
    var sr = ctx.sampleRate, n = Math.floor(sr * secsLen), b = ctx.createBuffer(2, n, sr), rnd = mkRand(99);
    for (var c = 0; c < 2; c++) {
      var d = b.getChannelData(c), lp = 0;
      for (var i = 0; i < n; i++) {
        var t = i / sr, k = 0.9 - 0.75 * Math.min(1, t / secsLen); // darker tail
        lp += k * ((rnd() * 2 - 1) - lp);
        var env = Math.pow(1 - i / n, 2.2) * Math.min(1, t / 0.03);
        d[i] = lp * env * 0.5;
      }
    }
    return b;
  }

  // Hann window curves (cached by length) for click-free grains
  var HANN = (function () { var N = 48, a = new Float32Array(N); for (var i = 0; i < N; i++) a[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); return a; })();
  var CURVES = {};
  function hannCurve(a) { // cached per 1/256 amplitude step so grains allocate nothing
    var q = Math.max(1, Math.round(a * 256)), c = CURVES[q];
    if (!c) { c = CURVES[q] = new Float32Array(HANN.length); for (var i = 0; i < c.length; i++) c[i] = HANN[i] * q / 256; }
    return c;
  }
  var PAN_SLOTS = [-1, -0.6, -0.25, 0.25, 0.6, 1];
  var SPAWN_RATE = 520; // max new grains per second across all voices (main-thread budget)

  // ---------- plugin ----------
  var D = {
    id: 'drift', name: 'Drift', kind: 'instrument', color: '#3fd1c4',
    icon: '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 12c2.5-5 4.5-5 7 0s4.5 5 7 0"/><circle cx="5" cy="5" r="1.2" fill="currentColor"/><circle cx="14" cy="4" r="0.9" fill="currentColor"/><circle cx="10" cy="16.5" r="0.9" fill="currentColor"/><circle cx="17.5" cy="15" r="1.1" fill="currentColor"/></svg>',

    // state
    params: {}, freeze: false, presetName: 'Airport Lounge',
    sourceId: 'builtin:choir', sourceName: 'Ember Choir', sourceRoot: 60,
    buf: null, rbuf: null, builtinCache: {}, peaks: null,
    voices: [], active: 0, maxActive: 0, dropped: 0, grainCount: 0,
    scanOff: 0, lastTick: 0, mod: 0, slide: 0, globalBend: 0, globalPressure: 0, sustain: false,
    vis: [], ui: null,

    init: function (ctx, out, Studio) {
      var self = this;
      this.ctx = ctx; this.out = out; this.Studio = Studio || window.Studio;
      PARAMS.forEach(function (p) { self.params[p.k] = p.d; });

      // post chain
      this.bus = ctx.createGain();
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass';
      this.dry = ctx.createGain();
      this.revSend = ctx.createGain(); this.conv = ctx.createConvolver(); this.conv.normalize = true;
      this.conv.buffer = makeImpulse(ctx, 5.5);
      this.revOut = ctx.createGain();
      // ping-pong feedback delay with damping in the loop
      this.dSend = ctx.createGain();
      this.dL = ctx.createDelay(2); this.dR = ctx.createDelay(2);
      this.dL.delayTime.value = 0.43; this.dR.delayTime.value = 0.61;
      this.dDamp = ctx.createBiquadFilter(); this.dDamp.type = 'lowpass'; this.dDamp.frequency.value = 3800;
      this.dFb = ctx.createGain();
      this.dMerge = ctx.createChannelMerger(2);
      this.dOut = ctx.createGain(); this.dOut.gain.value = 0.55;
      this.master = ctx.createGain();
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -12; this.comp.knee.value = 12; this.comp.ratio.value = 4;
      this.comp.attack.value = 0.01; this.comp.release.value = 0.25;

      this.bus.connect(this.filter);
      this.filter.connect(this.dry); this.dry.connect(this.master);
      this.filter.connect(this.revSend); this.revSend.connect(this.conv); this.conv.connect(this.revOut); this.revOut.connect(this.master);
      this.filter.connect(this.dSend);
      this.dSend.connect(this.dL);
      this.dL.connect(this.dDamp); this.dDamp.connect(this.dR); this.dR.connect(this.dFb); this.dFb.connect(this.dL);
      this.dL.connect(this.dMerge, 0, 0); this.dR.connect(this.dMerge, 0, 1);
      this.dMerge.connect(this.dOut); this.dOut.connect(this.master); this.dOut.connect(this.revSend);
      this.master.connect(this.comp); this.comp.connect(out);
      this.applyAll(true);

      this.setBuffer('builtin:choir', 'Ember Choir', 60, this.getBuiltin('builtin:choir'));
      this.applyPreset('Airport Lounge', true);

      this.timer = setInterval(function () { self.tick(); }, TICK_MS);
      return Promise.resolve();
    },

    // ----- params -> audio -----
    applyAll: function (instant) {
      var self = this; ['cutoff', 'reso', 'reverb', 'feedback', 'level'].forEach(function (k) { self.applyParam(k, instant); });
    },
    applyParam: function (k, instant) {
      if (!this.ctx) return;
      var p = this.params, t = this.ctx.currentTime, tc = instant ? 0.001 : 0.03;
      function set(param, v) { param.cancelScheduledValues(t); param.setTargetAtTime(v, t, tc); }
      if (k === 'cutoff' || k === 'reso') {
        set(this.filter.frequency, clamp(p.cutoff * Math.pow(2, this.slide * 2), 40, 20000));
        set(this.filter.Q, 0.5 + p.reso * p.reso * 14);
      } else if (k === 'reverb') {
        set(this.revSend.gain, Math.min(1, p.reverb * 1.3));
        set(this.revOut.gain, p.reverb * 1.1);
        set(this.dry.gain, 1 - p.reverb * 0.45);
      } else if (k === 'feedback') {
        set(this.dSend.gain, Math.min(1, p.feedback * 1.1));
        set(this.dFb.gain, p.feedback);
      } else if (k === 'level') {
        set(this.master.gain, p.level * p.level * 1.6);
      }
    },
    setParam: function (k, v, fromUI) {
      var d = PMAP[k]; if (!d) return;
      v = clamp(+v, d.min, d.max); if (isNaN(v)) return;
      this.params[k] = v;
      this.applyParam(k);
      if (this.ui && !fromUI) this.ui.sync(k);
      if (this.ui && fromUI) this.ui.markCustom();
    },
    setFreeze: function (on) {
      this.freeze = !!on;
      if (this.ui) this.ui.syncFreeze();
    },

    // ----- sources -----
    getBuiltin: function (id) {
      if (!this.builtinCache[id]) this.builtinCache[id] = renderBuiltin(this.ctx, id);
      return this.builtinCache[id];
    },
    setBuffer: function (id, name, root, buf) {
      this.sourceId = id; this.sourceName = name; this.sourceRoot = root || 60;
      this.buf = buf; this.rbuf = reverseBuffer(this.ctx, buf);
      this.peaks = null;
      if (this.ui) this.ui.onSource();
    },
    findEntry: function (id) {
      var m = this.Studio && this.Studio.samples && this.Studio.samples.manifest;
      var s = (m && m.samples) || [];
      for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
      return null;
    },
    entryName: function (e) {
      if (e.name) return e.name;
      var m = this.Studio && this.Studio.samples && this.Studio.samples.manifest, ins = e.instrument && m && m.instruments && m.instruments[e.instrument];
      if (ins && ins.name) return ins.name + (e.root != null ? ' \u00b7 ' + ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][e.root % 12] + (Math.floor(e.root / 12) - 1) : '');
      var nm = e.id.replace(/^(pads|textures|tex|pad|keys|fx|bass|plucks)-/, '').replace(/[-_]+/g, ' ');
      return nm.charAt(0).toUpperCase() + nm.slice(1);
    },
    resolveSrc: function (src, fb) {
      if (src && src.indexOf('cat:') === 0) {
        var S = this.Studio, list = (S && S.samples && S.samples.byCategory) ? S.samples.byCategory(src.slice(4)) : [];
        if (!list || !list.length) return fb || 'builtin:choir';
        // prefer the zone recorded nearest middle C so grains aren't heavily transposed
        var best = list[0];
        list.forEach(function (e) { if (Math.abs((e.root || 60) - 60) < Math.abs((best.root || 60) - 60)) best = e; });
        return best.id;
      }
      return src || 'builtin:choir';
    },
    loadSource: function (id) {
      var self = this, tok = (this._loadTok = (this._loadTok || 0) + 1);
      if (!id) id = 'builtin:choir';
      if (id.indexOf('builtin:') === 0) {
        var b = BUILTINS.filter(function (x) { return x.id === id; })[0] || BUILTINS[0];
        this.setBuffer(b.id, b.name, 60, this.getBuiltin(b.id));
        return Promise.resolve(true);
      }
      var S = this.Studio;
      if (!S || !S.samples || !S.samples.get) return this.loadSource('builtin:choir');
      if (this.ui) this.ui.setLoading(true);
      return Promise.resolve().then(function () { return S.samples.get(id); }).then(function (buf) {
        if (tok !== self._loadTok) return false;
        var e = self.findEntry(id) || { id: id };
        self.setBuffer(id, self.entryName(e), e.root || 60, buf);
        if (self.ui) self.ui.setLoading(false);
        return true;
      }).catch(function (err) {
        if (tok !== self._loadTok) return false;
        console.warn('[drift] could not load sample', id, err && err.message);
        if (self.ui) self.ui.setLoading(false);
        if (S.toast) S.toast('Drift: sample unavailable, using built-in source');
        return self.loadSource('builtin:choir').then(function () { return false; });
      });
    },
    importFile: function (file) {
      var self = this, S = this.Studio;
      if (!file) return Promise.resolve(null);
      if (!/^audio\//.test(file.type) && !/\.(wav|aiff?|mp3|m4a|aac|ogg|flac|caf|webm)$/i.test(file.name)) {
        if (S && S.toast) S.toast('Drift: drop an audio file');
        return Promise.resolve(null);
      }
      var p = (S && S.samples && S.samples.importFile)
        ? S.samples.importFile(file, { category: 'textures' }).then(function (entry) {
          return self.loadSource(entry.id).then(function () { if (!entry.name) self.sourceName = file.name.replace(/\.[^.]+$/, ''); return entry; });
        })
        : file.arrayBuffer().then(function (ab) { return self.ctx.decodeAudioData(ab); }).then(function (buf) {
          self.setBuffer('local:' + file.name, file.name.replace(/\.[^.]+$/, ''), 60, buf); return { id: self.sourceId };
        });
      return p.then(function (e) {
        if (self.ui) self.ui.populateSources();
        if (S && S.toast) S.toast('Drift: loaded ' + self.sourceName);
        return e;
      }).catch(function (err) {
        console.warn('[drift] import failed', err);
        if (S && S.toast) S.toast('Drift: could not decode that file');
        return null;
      });
    },

    // ----- presets -----
    applyPreset: function (name, silent) {
      var pr = PRESETS.filter(function (x) { return x.name === name; })[0]; if (!pr) return;
      var self = this;
      PARAMS.forEach(function (p) { self.params[p.k] = pr.p[p.k] != null ? pr.p[p.k] : p.d; });
      this.freeze = !!pr.freeze;
      this.presetName = name;
      this.applyAll();
      var src = this.resolveSrc(pr.src, pr.fb);
      if (src !== this.sourceId) this.loadSource(src);
      this.scanOff = 0;
      if (this.ui) { this.ui.syncAll(); this.ui.setPresetLabel(name); }
    },

    // ----- voices -----
    noteOn: function (note, vel, time, info) {
      var ctx = this.ctx, self = this; if (!ctx || !this.buf) return;
      info = info || {};
      var now = ctx.currentTime, t = Math.max(now, time || now);
      vel = vel == null ? 0.8 : clamp(vel, 0, 1);
      // retrigger same note on same channel
      for (var i = 0; i < this.voices.length; i++) {
        var v0 = this.voices[i];
        if (v0.note === note && v0.ch === info.ch && !v0.releasing) this.release(v0, t, 0.06);
      }
      var live = this.voices.filter(function (v) { return !v.dead; });
      if (!live.some(function (v) { return !v.releasing; }) && this.active === 0) this.scanOff = 0;
      if (live.length >= MAX_VOICES) {
        var victim = live.filter(function (v) { return v.releasing; })[0] || live[0];
        this.release(victim, t, 0.03); victim.dead = true; victim.stopAt = t + 0.04;
      }
      var env = ctx.createGain(), press = ctx.createGain();
      env.gain.value = 0; press.gain.value = 1;
      env.connect(press); press.connect(this.bus);
      var pans = PAN_SLOTS.map(function (x) {
        if (!ctx.createStereoPanner) return env;
        var pn = ctx.createStereoPanner(); pn.pan.value = x * self.params.stereo; pn.connect(env); return pn;
      });
      var amp = 0.25 + 0.75 * Math.pow(vel, 0.8);
      var A = this.params.attack;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(amp, t + A);
      var voice = {
        id: ++this.grainCount, note: note, ch: info.ch, mpe: !!info.mpe, vel: vel, amp: amp, start: t,
        nextGrain: t, env: env, press: press, pans: pans, panStereo: this.params.stereo, bend: info.mpe ? 0 : this.globalBend, pressure: info.mpe ? 0 : this.globalPressure,
        releasing: false, held: false, stopAt: Infinity, dead: false, srcs: new Set(), hue: Math.random()
      };
      this.setVoicePressure(voice, voice.pressure);
      this.voices.push(voice);
      this.tick();
    },
    noteOff: function (note, time, info) {
      var t = Math.max(this.ctx.currentTime, time || 0); info = info || {};
      for (var i = 0; i < this.voices.length; i++) {
        var v = this.voices[i];
        if (v.note === note && !v.releasing && (info.ch == null || v.ch == null || v.ch === info.ch)) {
          if (this.sustain) v.held = true; else this.release(v, t);
        }
      }
    },
    release: function (v, t, fast) {
      if (v.releasing) { if (fast && v.stopAt > t + fast) { this.fade(v, t, fast); } return; }
      v.releasing = true; v.held = false;
      this.fade(v, t, fast || this.params.release);
    },
    fade: function (v, t, R) {
      var g = v.env.gain;
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
      else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
      // exponential-ish fade that reaches silence at t+R
      g.setTargetAtTime(0, t, R / 5);
      g.setValueAtTime(0, t + R + 0.005); // no tail cut: value is already ~0.7% of start
      v.stopAt = t + R;
    },
    allNotesOff: function () {
      var t = this.ctx ? this.ctx.currentTime : 0, self = this;
      this.sustain = false;
      this.voices.forEach(function (v) { self.release(v, t, 0.08); });
    },
    setVoicePressure: function (v, p) {
      v.pressure = clamp(p, 0, 1);
      var g = 0.8 + 0.55 * v.pressure;
      v.press.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
    },
    bend: function (semis, info) {
      info = info || {};
      var t = this.ctx.currentTime, perNote = info.mpe && info.ch != null;
      if (!perNote) this.globalBend = semis;
      this.voices.forEach(function (v) {
        if (perNote ? v.ch !== info.ch : v.mpe) return;
        if (perNote && v.releasing) return;
        v.bend = semis;
        v.srcs.forEach(function (s) { s.detune.setTargetAtTime(semis * 100, t, 0.008); });
      });
    },
    pressure: function (val, info) {
      info = info || {};
      var self = this;
      if (info.mpe && info.ch != null) {
        this.voices.forEach(function (v) { if (v.ch === info.ch && !v.releasing) self.setVoicePressure(v, val); });
      } else {
        this.globalPressure = val;
        this.voices.forEach(function (v) { if (!v.releasing) self.setVoicePressure(v, val); });
      }
    },
    cc: function (num, val) {
      var self = this;
      if (num === 1) { this.mod = val; if (this.ui) this.ui.syncMod(); }
      else if (num === 64) {
        this.sustain = val >= 0.5;
        if (!this.sustain) { var t = this.ctx.currentTime; this.voices.forEach(function (v) { if (v.held) self.release(v, t); }); }
      } else if (num === 74) { this.slide = val - 0.5; this.applyParam('cutoff'); }
      else if (num === 120 || num === 123) this.allNotesOff();
    },

    // ----- grain scheduler -----
    tick: function () {
      var ctx = this.ctx; if (!ctx || !this.buf) return;
      var now = ctx.currentTime, horizon = now + LOOKAHEAD, p = this.params, self = this;
      var dt = this.lastTick ? Math.min(0.2, now - this.lastTick) : 0; this.lastTick = now;
      var bufDur = this.buf.duration;
      // global scan playhead
      if (!this.freeze) {
        var sv = clamp(p.scan + this.mod * 0.75, -1, 1);
        this.scanOff = wrap01(this.scanOff + scanRate(sv) * dt / bufDur);
      }
      // retire voices
      this.voices = this.voices.filter(function (v) {
        if (now > v.stopAt + 0.05 && v.srcs.size === 0) {
          try { v.env.disconnect(); v.press.disconnect(); v.pans.forEach(function (pn) { if (pn !== v.env) pn.disconnect(); }); } catch (e) { /* already */ }
          return false;
        }
        return true;
      });
      var live = this.voices.filter(function (v) { return now < v.stopAt; });
      if (!live.length) return;
      var perVoiceCap = Math.max(6, Math.ceil(MAX_GRAINS / live.length) + 4);
      this.budget = Math.min(SPAWN_RATE * 0.2, (this.budget == null ? SPAWN_RATE * 0.1 : this.budget) + dt * SPAWN_RATE);
      for (var vi = 0; vi < live.length; vi++) {
        var v = live[vi];
        if (v.nextGrain < now - 0.05) v.nextGrain = now; // fell behind (tab throttled): skip, don't burst
        if (v.panStereo !== p.stereo && v.pans[0] !== v.env) {
          v.panStereo = p.stereo;
          v.pans.forEach(function (pn, i) { pn.pan.setTargetAtTime(PAN_SLOTS[i] * p.stereo, now, 0.05); });
        }
      }
      // emit grains in time order across voices so the budget is shared fairly
      for (var guard = 0; guard < 600; guard++) {
        var best = null;
        for (vi = 0; vi < live.length; vi++) {
          var c = live[vi];
          if (c.nextGrain < horizon && c.nextGrain < c.stopAt && (!best || c.nextGrain < best.nextGrain)) best = c;
        }
        if (!best) break;
        var t = best.nextGrain;
        var dens = p.density * (1 + best.pressure * 1.2);
        best.nextGrain += (1 / dens) * (0.65 + Math.random() * 0.7);
        if (this.active >= MAX_GRAINS || best.srcs.size >= perVoiceCap || this.budget < 1) { this.dropped++; continue; }
        this.budget -= 1;
        this.spawnGrain(best, t, bufDur, dens);
      }
      void self;
    },
    spawnGrain: function (v, t, bufDur, dens) {
      var ctx = this.ctx, p = this.params;
      var dur = p.size * (0.85 + Math.random() * 0.3);
      var shimmer = Math.random() < p.shimmer * 0.6;
      var semis = (v.note - this.sourceRoot) + (Math.random() * 2 - 1) * p.pitch + (shimmer ? 12 : 0);
      var rate = Math.pow(2, semis / 12);
      var spanSec = dur * rate * Math.pow(2, Math.abs(v.bend) / 12);
      if (spanSec > bufDur * 0.98) { dur *= bufDur * 0.98 / spanSec; spanSec = bufDur * 0.98; }
      var span = spanSec / bufDur;
      var jitter = ((Math.random() + Math.random()) - 1) * p.spray * 0.5;
      var center = wrap01(p.pos + this.scanOff + jitter);
      var start = clamp(center - span / 2, 0, 1 - span);
      var rev = Math.random() < p.reverse;
      var src = ctx.createBufferSource();
      src.buffer = rev ? this.rbuf : this.buf;
      src.playbackRate.value = rate;
      src.detune.value = v.bend * 100;
      src.loop = true; src.loopStart = 0; src.loopEnd = bufDur; // safety net only; offsets are clamped
      var offset = rev ? (1 - start - span) * bufDur : start * bufDur;
      var g = ctx.createGain(); g.gain.value = 0;
      var overlap = Math.max(1, dens * dur);
      var a = (0.55 / Math.sqrt(overlap)) * (shimmer ? 0.6 : 1);
      g.gain.setValueCurveAtTime(hannCurve(a), t, dur);
      var slot = (Math.random() * PAN_SLOTS.length) | 0, pan = PAN_SLOTS[slot] * p.stereo;
      src.connect(g); g.connect(v.pans[slot]);
      src.start(t, Math.max(0, offset));
      src.stop(t + dur + 0.02);
      var self = this;
      v.srcs.add(src); this.active++; if (this.active > this.maxActive) this.maxActive = this.active;
      src.onended = function () {
        v.srcs.delete(src); self.active--;
        try { src.disconnect(); g.disconnect(); } catch (e) { /* ok */ }
      };
      // visual record
      if (this.vis.length < 260) this.vis.push({ t0: t, dur: dur, start: rev ? start + span : start, span: rev ? -span : span, pan: pan, jy: Math.random() * 2 - 1, a: a, kind: shimmer ? 1 : rev ? 2 : 0, hue: v.hue });
    },

    // ----- state -----
    getState: function () {
      return { v: 1, preset: this.presetName, source: this.sourceId, freeze: this.freeze, params: JSON.parse(JSON.stringify(this.params)) };
    },
    setState: function (s) {
      if (!s || typeof s !== 'object') return;
      var self = this;
      if (s.params) PARAMS.forEach(function (p) { if (s.params[p.k] != null && !isNaN(+s.params[p.k])) self.params[p.k] = clamp(+s.params[p.k], p.min, p.max); });
      this.freeze = !!s.freeze;
      if (s.preset) this.presetName = s.preset;
      this.applyAll();
      if (s.source && s.source !== this.sourceId && s.source.indexOf('local:') !== 0) this.loadSource(s.source);
      if (this.ui) { this.ui.syncAll(); this.ui.setPresetLabel(this.presetName); }
    },

    // test/diagnostic hook
    _stats: function () {
      return { active: this.active, maxActive: this.maxActive, dropped: this.dropped,
        voices: this.voices.filter(function (v) { return !v.releasing; }).length, allVoices: this.voices.length,
        source: this.sourceId, scan: this.scanOff };
    },

    // ----- UI -----
    mount: function (el) {
      this.ui = buildUI(this, el);
    }
  };

  // ======================= UI =======================
  function knobSVG(p) {
    return '<svg viewBox="0 0 60 60" class="dk-svg" aria-hidden="true">' +
      '<circle cx="30" cy="30" r="21" class="dk-body"/>' +
      '<path class="dk-track" d=""/><path class="dk-arc" d=""/>' +
      '<line x1="30" y1="30" x2="30" y2="13" class="dk-ptr"/></svg>';
  }
  function arcPath(a0, a1, r) {
    var cx = 30, cy = 30;
    var x0 = cx + r * Math.sin(a0), y0 = cy - r * Math.cos(a0), x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1);
    var large = Math.abs(a1 - a0) > Math.PI ? 1 : 0, sweep = a1 > a0 ? 1 : 0;
    if (Math.abs(a1 - a0) < 0.001) return '';
    return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + large + ' ' + sweep + ' ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
  }

  function buildUI(D, el) {
    el.classList.add('plug-drift');
    var html =
      '<div class="dr-root">' +
      '<header class="dr-head">' +
      '<div class="dr-brand"><span class="dr-logo">DRIFT</span><span class="dr-sub">granular texture engine</span></div>' +
      '<div class="dr-presets"><button type="button" class="dr-btn dr-ic" data-act="prev" aria-label="Previous preset">&#8249;</button>' +
      '<label class="dr-sel dr-preset"><span class="dr-cap">Preset</span><select data-role="preset" aria-label="Preset">' +
      PRESETS.map(function (x) { return '<option>' + esc(x.name) + '</option>'; }).join('') + '<option value="__custom" disabled>Custom</option></select></label>' +
      '<button type="button" class="dr-btn dr-ic" data-act="next" aria-label="Next preset">&#8250;</button></div>' +
      '<label class="dr-sel dr-source"><span class="dr-cap">Source</span><select data-role="source" aria-label="Grain source"></select></label>' +
      '<button type="button" class="dr-btn" data-act="import" title="Import an audio file (or drop one on the waveform)">Import</button>' +
      '<input type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.ogg,.flac" data-role="file" hidden>' +
      '<button type="button" class="dr-btn dr-freeze" data-act="freeze" aria-pressed="false"><span class="dr-led"></span>Freeze</button>' +
      '</header>' +
      '<div class="dr-main">' +
      '<div class="dr-wave" data-role="wavebox"><canvas data-role="wave"></canvas>' +
      '<div class="dr-wave-info"><span data-role="srcname"></span><span data-role="stats"></span></div>' +
      '<div class="dr-drop">Drop audio to grain it</div><div class="dr-loading">loading&hellip;</div></div>' +
      '<div class="dr-xy" data-role="xy" tabindex="0" role="group" aria-label="Position and grain size pad"><canvas data-role="xyc"></canvas>' +
      '<span class="dr-xy-lx">Position</span><span class="dr-xy-ly">Size</span><span class="dr-xy-val" data-role="xyval"></span></div>' +
      '</div>' +
      '<div class="dr-knobs">' +
      GROUPS.map(function (g) {
        return '<section class="dr-group"><h4>' + g.name + '</h4><div class="dr-row">' +
          g.keys.map(function (k) {
            var p = PMAP[k];
            return '<div class="dr-knob' + (p.bi ? ' bi' : '') + '" tabindex="0" role="slider" aria-label="' + p.l + '" data-k="' + k + '">' +
              knobSVG(p) + '<span class="dr-kv"></span><span class="dr-kl">' + p.l + '</span></div>';
          }).join('') + '</div></section>';
      }).join('') +
      '</div>' +
      '<footer class="dr-foot"><span>Play notes &middot; mod wheel scans &middot; MPE pressure swells density &amp; volume &middot; per-note bend</span>' +
      '<span class="dr-modm"><i data-role="modbar"></i></span></footer>' +
      '</div>';
    el.innerHTML = html;
    var $ = function (s) { return el.querySelector(s); };
    var presetSel = $('[data-role=preset]'), sourceSel = $('[data-role=source]'), fileIn = $('[data-role=file]');
    var wave = $('[data-role=wave]'), wbox = $('[data-role=wavebox]'), xy = $('[data-role=xy]'), xyc = $('[data-role=xyc]');
    var statsEl = $('[data-role=stats]'), srcName = $('[data-role=srcname]'), xyVal = $('[data-role=xyval]'), modbar = $('[data-role=modbar]');
    var freezeBtn = $('[data-act=freeze]');
    var knobs = {};
    Array.prototype.forEach.call(el.querySelectorAll('.dr-knob'), function (kn) { knobs[kn.dataset.k] = kn; });

    var ui = {};
    var A0 = -0.75 * Math.PI, A1 = 0.75 * Math.PI;
    ui.sync = function (k) {
      if (k === 'pos' || k === 'size') { drawXY(); }
      var kn = knobs[k]; if (!kn) return;
      var p = PMAP[k], v = D.params[k], n = toNorm(p, v), a = A0 + (A1 - A0) * n;
      var base = p.bi ? 0 : A0;
      kn.querySelector('.dk-track').setAttribute('d', arcPath(A0, A1, 25));
      kn.querySelector('.dk-arc').setAttribute('d', a >= base ? arcPath(base, a, 25) : arcPath(a, base, 25));
      kn.querySelector('.dk-ptr').setAttribute('transform', 'rotate(' + (a * 180 / Math.PI) + ' 30 30)');
      kn.querySelector('.dr-kv').textContent = p.fmt(v);
      kn.setAttribute('aria-valuetext', p.fmt(v));
      kn.setAttribute('aria-valuenow', (+v).toFixed(3));
    };
    ui.syncAll = function () { PARAMS.forEach(function (p) { ui.sync(p.k); }); ui.syncFreeze(); };
    ui.syncFreeze = function () { freezeBtn.setAttribute('aria-pressed', D.freeze ? 'true' : 'false'); wbox.classList.toggle('frozen', D.freeze); };
    ui.syncMod = function () { modbar.style.width = Math.round(D.mod * 100) + '%'; };
    ui.setPresetLabel = function (name) {
      var has = PRESETS.some(function (x) { return x.name === name; });
      if (!has) presetSel.querySelector('option[value=__custom]').textContent = name || 'Custom';
      presetSel.value = has ? name : '__custom';
    };
    ui.markCustom = function () {
      if (D.presetName.slice(-1) !== '*') D.presetName = D.presetName + '*';
      presetSel.value = '__custom';
      presetSel.querySelector('option[value=__custom]').textContent = D.presetName;
    };
    ui.setLoading = function (on) { wbox.classList.toggle('loading', !!on); };
    ui.populateSources = function () {
      var S = D.Studio, m = S && S.samples && S.samples.manifest, all = (m && m.samples) || [];
      var cats = {}, order = ['pads', 'textures', 'user', 'keys', 'plucks', 'bass', 'fx'];
      all.forEach(function (e) {
        var c = e.user ? 'user' : (e.category || 'other');
        if (c === 'drums') return;
        (cats[c] = cats[c] || []).push(e);
      });
      var keys = Object.keys(cats).sort(function (a, b) {
        var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      var label = { pads: 'Pads', textures: 'Textures', user: 'Your imports', keys: 'Keys', plucks: 'Plucks', bass: 'Bass', fx: 'FX' };
      var h = '<optgroup label="Built-in">' + BUILTINS.map(function (b) { return '<option value="' + b.id + '">' + esc(b.name) + '</option>'; }).join('') + '</optgroup>';
      keys.forEach(function (c) {
        h += '<optgroup label="' + esc(label[c] || c) + '">' + cats[c].map(function (e) {
          return '<option value="' + esc(e.id) + '">' + esc(D.entryName(e)) + '</option>';
        }).join('') + '</optgroup>';
      });
      if (D.sourceId.indexOf('local:') === 0) h += '<optgroup label="Local"><option value="' + esc(D.sourceId) + '">' + esc(D.sourceName) + '</option></optgroup>';
      sourceSel.innerHTML = h;
      sourceSel.value = D.sourceId;
      ui._srcCount = all.length;
    };
    ui.onSource = function () {
      peaksCanvas = null;
      srcName.textContent = D.sourceName;
      if (sourceSel.value !== D.sourceId) {
        sourceSel.value = D.sourceId;
        if (sourceSel.value !== D.sourceId) ui.populateSources();
      }
    };

    // ---- header events ----
    presetSel.addEventListener('change', function () { if (presetSel.value !== '__custom') D.applyPreset(presetSel.value); });
    el.querySelector('[data-act=prev]').addEventListener('click', function () { stepPreset(-1); });
    el.querySelector('[data-act=next]').addEventListener('click', function () { stepPreset(1); });
    function stepPreset(d) {
      var base = D.presetName.replace(/\*$/, ''), i = PRESETS.findIndex(function (x) { return x.name === base; });
      i = (i + d + PRESETS.length) % PRESETS.length; D.applyPreset(PRESETS[i].name);
    }
    sourceSel.addEventListener('focus', function () {
      var m = D.Studio && D.Studio.samples && D.Studio.samples.manifest;
      if (((m && m.samples) || []).length !== ui._srcCount) ui.populateSources();
    });
    sourceSel.addEventListener('change', function () { D.loadSource(sourceSel.value); ui.markCustom(); });
    el.querySelector('[data-act=import]').addEventListener('click', function () { fileIn.click(); });
    fileIn.addEventListener('change', function () { if (fileIn.files[0]) D.importFile(fileIn.files[0]); fileIn.value = ''; });
    freezeBtn.addEventListener('click', function () { D.setFreeze(!D.freeze); });
    // drag & drop
    var dragDepth = 0;
    wbox.addEventListener('dragenter', function (e) { e.preventDefault(); dragDepth++; wbox.classList.add('drag'); });
    wbox.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    wbox.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; wbox.classList.remove('drag'); } });
    wbox.addEventListener('drop', function (e) {
      e.preventDefault(); dragDepth = 0; wbox.classList.remove('drag');
      var f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) D.importFile(f);
    });
    // click waveform to set position
    wave.addEventListener('pointerdown', function (e) {
      var r = wave.getBoundingClientRect();
      var setPos = function (ev) { D.setParam('pos', clamp((ev.clientX - r.left) / r.width, 0, 1), true); drawXY(); };
      setPos(e); wave.setPointerCapture(e.pointerId);
      var mv = function (ev) { setPos(ev); }, up = function () { wave.removeEventListener('pointermove', mv); wave.removeEventListener('pointerup', up); };
      wave.addEventListener('pointermove', mv); wave.addEventListener('pointerup', up);
    });

    // ---- knobs ----
    Object.keys(knobs).forEach(function (k) {
      var kn = knobs[k], p = PMAP[k];
      kn.addEventListener('pointerdown', function (e) {
        e.preventDefault(); kn.focus(); kn.setPointerCapture(e.pointerId);
        var y0 = e.clientY, n0 = toNorm(p, D.params[k]);
        kn.classList.add('drag');
        var mv = function (ev) {
          var scale = ev.shiftKey ? 900 : 180;
          D.setParam(k, fromNorm(p, n0 + (y0 - ev.clientY) / scale), true); ui.sync(k);
        };
        var up = function () { kn.classList.remove('drag'); kn.removeEventListener('pointermove', mv); kn.removeEventListener('pointerup', up); kn.removeEventListener('pointercancel', up); };
        kn.addEventListener('pointermove', mv); kn.addEventListener('pointerup', up); kn.addEventListener('pointercancel', up);
      });
      kn.addEventListener('dblclick', function () { D.setParam(k, p.d, true); ui.sync(k); });
      kn.addEventListener('wheel', function (e) {
        e.preventDefault();
        D.setParam(k, fromNorm(p, toNorm(p, D.params[k]) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.025)), true); ui.sync(k);
      }, { passive: false });
      kn.addEventListener('keydown', function (e) {
        var d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
        if (!d) return; e.preventDefault(); e.stopPropagation();
        D.setParam(k, fromNorm(p, toNorm(p, D.params[k]) + d * (e.shiftKey ? 0.004 : 0.02)), true); ui.sync(k);
      });
    });

    // ---- XY pad ----
    xy.addEventListener('pointerdown', function (e) {
      e.preventDefault(); xy.focus(); xy.setPointerCapture(e.pointerId);
      var r = xy.getBoundingClientRect();
      var set = function (ev) {
        D.setParam('pos', clamp((ev.clientX - r.left) / r.width, 0, 1), true);
        D.setParam('size', fromNorm(PMAP.size, 1 - clamp((ev.clientY - r.top) / r.height, 0, 1)), true);
        drawXY();
      };
      set(e); xy.classList.add('drag');
      var mv = function (ev) { set(ev); }, up = function () { xy.classList.remove('drag'); xy.removeEventListener('pointermove', mv); xy.removeEventListener('pointerup', up); };
      xy.addEventListener('pointermove', mv); xy.addEventListener('pointerup', up);
    });
    xy.addEventListener('keydown', function (e) {
      var dx = { ArrowLeft: -1, ArrowRight: 1 }[e.key] || 0, dy = { ArrowUp: 1, ArrowDown: -1 }[e.key] || 0;
      if (!dx && !dy) return; e.preventDefault(); e.stopPropagation();
      if (dx) D.setParam('pos', D.params.pos + dx * 0.01, true);
      if (dy) D.setParam('size', fromNorm(PMAP.size, toNorm(PMAP.size, D.params.size) + dy * 0.02), true);
      drawXY();
    });

    // ---- canvases ----
    var dpr = 1, W = 0, H = 0, XW = 0, XH = 0, peaksCanvas = null, xyTrail = [];
    function resize() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      var r = wave.getBoundingClientRect(); W = Math.max(50, Math.round(r.width)); H = Math.max(50, Math.round(r.height));
      wave.width = W * dpr; wave.height = H * dpr;
      var r2 = xyc.getBoundingClientRect(); XW = Math.max(50, Math.round(r2.width)); XH = Math.max(50, Math.round(r2.height));
      xyc.width = XW * dpr; xyc.height = XH * dpr;
      peaksCanvas = null; drawXY();
    }
    function buildPeaks() {
      var buf = D.buf; if (!buf) return null;
      var cv = document.createElement('canvas'); cv.width = W * dpr; cv.height = H * dpr;
      var g = cv.getContext('2d'); g.scale(dpr, dpr);
      var cols = W, n = buf.length, ch0 = buf.getChannelData(0), ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
      var mid = H * 0.5, amp = H * 0.42, mins = new Float32Array(cols), maxs = new Float32Array(cols), rms = new Float32Array(cols), peak = 0.0001;
      for (var x = 0; x < cols; x++) {
        var a = Math.floor(x / cols * n), b = Math.floor((x + 1) / cols * n), mn = 1, mx = -1, s = 0, step = Math.max(1, ((b - a) / 400) | 0), cnt = 0;
        for (var i = a; i < b; i += step) { var v = (ch0[i] + ch1[i]) * 0.5; if (v < mn) mn = v; if (v > mx) mx = v; s += v * v; cnt++; }
        mins[x] = mn; maxs[x] = mx; rms[x] = Math.sqrt(s / Math.max(1, cnt));
        if (mx > peak) peak = mx; if (-mn > peak) peak = -mn;
      }
      var k = 1 / peak;
      var grd = g.createLinearGradient(0, 0, W, 0);
      grd.addColorStop(0, 'rgba(63,209,196,0.55)'); grd.addColorStop(0.55, 'rgba(110,140,255,0.5)'); grd.addColorStop(1, 'rgba(160,110,255,0.55)');
      g.fillStyle = grd;
      g.beginPath();
      for (x = 0; x < cols; x++) g.lineTo(x, mid - maxs[x] * k * amp);
      for (x = cols - 1; x >= 0; x--) g.lineTo(x, mid - mins[x] * k * amp);
      g.closePath(); g.fill();
      var grd2 = g.createLinearGradient(0, 0, W, 0);
      grd2.addColorStop(0, 'rgba(160,255,240,0.85)'); grd2.addColorStop(1, 'rgba(210,190,255,0.85)');
      g.fillStyle = grd2;
      g.beginPath();
      for (x = 0; x < cols; x++) g.lineTo(x, mid - rms[x] * k * amp);
      for (x = cols - 1; x >= 0; x--) g.lineTo(x, mid + rms[x] * k * amp);
      g.closePath(); g.fill();
      // midline + grid
      g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(0, mid, W, 1);
      for (var gx = 1; gx < 16; gx++) { g.fillStyle = gx % 4 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.07)'; g.fillRect(Math.round(gx / 16 * W), 0, 1, H); }
      return cv;
    }
    function drawWave() {
      if (!W) return;
      var g = wave.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      if (!peaksCanvas) peaksCanvas = buildPeaks();
      if (peaksCanvas) g.drawImage(peaksCanvas, 0, 0, W, H);
      var p = D.params, center = wrap01(p.pos + D.scanOff), sw = p.spray * 0.5 * W;
      // spray region
      var cx = center * W;
      var grd = g.createLinearGradient(cx - sw - 1, 0, cx + sw + 1, 0);
      grd.addColorStop(0, 'rgba(140,110,255,0)'); grd.addColorStop(0.5, 'rgba(140,110,255,0.22)'); grd.addColorStop(1, 'rgba(140,110,255,0)');
      g.fillStyle = grd;
      g.fillRect(cx - sw - 1, 0, sw * 2 + 2, H);
      if (cx - sw < 0) g.fillRect(W + (cx - sw), 0, -(cx - sw), H);
      if (cx + sw > W) g.fillRect(0, 0, cx + sw - W, H);
      // grain-size bracket
      var gsz = Math.max(2, p.size / (D.buf ? D.buf.duration : 8) * W);
      g.fillStyle = 'rgba(63,209,196,0.16)'; g.fillRect(cx - gsz / 2, H - 10, gsz, 6);
      // base position + live playhead
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(Math.round(p.pos * W), 0, 1, H);
      g.fillStyle = D.freeze ? '#9fe9ff' : '#3fd1c4';
      g.shadowColor = g.fillStyle; g.shadowBlur = 10;
      g.fillRect(Math.round(cx) - 1, 0, 2, H);
      g.beginPath(); g.moveTo(cx - 6, 0); g.lineTo(cx + 6, 0); g.lineTo(cx, 7); g.closePath(); g.fill();
      g.shadowBlur = 0;
      // particles
      var now = D.ctx.currentTime, vis = D.vis, keep = [];
      g.globalCompositeOperation = 'lighter';
      for (var i = 0; i < vis.length; i++) {
        var q = vis[i]; if (now > q.t0 + q.dur) continue; keep.push(q);
        if (now < q.t0) continue;
        var pr = (now - q.t0) / q.dur, env = Math.sin(Math.PI * pr);
        var x = wrap01(q.start + q.span * pr) * W;
        var y = H * 0.5 + q.pan * H * 0.3 + q.jy * H * 0.08 + (q.kind === 1 ? -H * 0.12 : 0);
        var r = 2 + Math.min(14, q.dur * 26) * (0.4 + env * 0.6);
        var col = q.kind === 1 ? '235,225,255' : q.kind === 2 ? '196,140,255' : (q.hue < 0.5 ? '90,240,220' : '120,200,255');
        var rg = g.createRadialGradient(x, y, 0, x, y, r * 2.2);
        rg.addColorStop(0, 'rgba(' + col + ',' + (0.85 * env).toFixed(3) + ')');
        rg.addColorStop(0.35, 'rgba(' + col + ',' + (0.3 * env).toFixed(3) + ')');
        rg.addColorStop(1, 'rgba(' + col + ',0)');
        g.fillStyle = rg; g.beginPath(); g.arc(x, y, r * 2.2, 0, Math.PI * 2); g.fill();
        // motion streak
        g.strokeStyle = 'rgba(' + col + ',' + (0.35 * env).toFixed(3) + ')'; g.lineWidth = 1;
        var x0 = wrap01(q.start) * W; if (Math.abs(x - x0) < W / 2) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x, y); g.stroke(); }
      }
      g.globalCompositeOperation = 'source-over';
      D.vis = keep;
      var st = D._stats();
      statsEl.textContent = st.voices + ' voice' + (st.voices === 1 ? '' : 's') + '  ·  ' + st.active + ' grains';
    }
    function drawXY() {
      if (!XW) return;
      var g = xyc.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, XW, XH);
      for (var i = 1; i < 8; i++) {
        g.fillStyle = i % 4 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.09)';
        g.fillRect(Math.round(i / 8 * XW), 0, 1, XH); g.fillRect(0, Math.round(i / 8 * XH), XW, 1);
      }
      var x = D.params.pos * XW, y = (1 - toNorm(PMAP.size, D.params.size)) * XH;
      if (xy.classList.contains('drag')) { var last = xyTrail[xyTrail.length - 1]; if (!last || last.x !== x || last.y !== y) { xyTrail.push({ x: x, y: y }); if (xyTrail.length > 24) xyTrail.shift(); } }
      else xyTrail = [];
      for (i = 1; i < xyTrail.length; i++) {
        g.strokeStyle = 'rgba(140,110,255,' + (i / xyTrail.length * 0.5).toFixed(3) + ')'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(xyTrail[i - 1].x, xyTrail[i - 1].y); g.lineTo(xyTrail[i].x, xyTrail[i].y); g.stroke();
      }
      g.strokeStyle = 'rgba(63,209,196,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, XH); g.moveTo(0, y); g.lineTo(XW, y); g.stroke();
      var rg = g.createRadialGradient(x, y, 0, x, y, 26);
      rg.addColorStop(0, 'rgba(63,209,196,0.55)'); rg.addColorStop(1, 'rgba(63,209,196,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, 26, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#e9fffb'; g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#3fd1c4'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 10, 0, Math.PI * 2); g.stroke();
      xyVal.textContent = pct(D.params.pos) + '  ·  ' + secs(D.params.size);
    }
    var raf = 0, visible = true;
    function loop() {
      raf = requestAnimationFrame(loop);
      if (!visible || !el.isConnected || el.offsetParent === null && el.getClientRects().length === 0) return;
      var r = wave.getBoundingClientRect();
      if (Math.round(r.width) !== W || Math.round(r.height) !== H) resize();
      drawWave();
    }
    if (window.ResizeObserver) new ResizeObserver(function () { resize(); }).observe(el);
    document.addEventListener('visibilitychange', function () { visible = !document.hidden; });

    ui.populateSources();
    ui.onSource();
    ui.syncAll();
    ui.syncMod();
    ui.setPresetLabel(D.presetName);
    requestAnimationFrame(function () { resize(); loop(); });
    void raf;
    return ui;
  }

  if (window.Studio && window.Studio.registerPlugin) window.Studio.registerPlugin(D);
  else console.error('[drift] Studio not found');
})();
