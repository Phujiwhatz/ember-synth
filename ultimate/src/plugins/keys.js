/* Ember Ultimate - Keys: multisample instrument player (plugin id 'keys').
 * Zones by note + velocity (crossfaded layers), playbackRate pitch-shift from the nearest root,
 * loop points, 48-voice polyphony with stealing, sustain pedal, per-voice filter,
 * MPE (per-note bend / pressure), mod-wheel vibrato, A/B layering, user sample import. */
(function () {
  'use strict';

  var MAX_VOICES = 48;
  var CATS = ['keys', 'bass', 'pads', 'plucks', 'textures', 'user'];
  var CAT_LABEL = { keys: 'Keys', bass: 'Bass', pads: 'Pads', plucks: 'Plucks', textures: 'Textures', user: 'User' };
  var CAT_TINT = { keys: '#e8b765', bass: '#d9733b', pads: '#8fa7d6', plucks: '#93c9a0', textures: '#c49ad6', user: '#e6dccb' };
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(n) { n = Math.round(n); return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var a = seed || 1; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  /* ---------------- macro definitions ---------------- */
  var MACROS = [
    { k: 'attack', l: 'Attack', min: 0, max: 1, def: 0 },
    { k: 'release', l: 'Release', min: -1, max: 1, def: 0, bi: true },
    { k: 'tone', l: 'Tone', min: 0, max: 1, def: 0.82 },
    { k: 'dyn', l: 'Dynamics', min: 0, max: 1, def: 0.5 },
    { k: 'width', l: 'Width', min: 0, max: 1.5, def: 1 },
    { k: 'reverb', l: 'Reverb', min: 0, max: 1, def: 0.2 },
    { k: 'tune', l: 'Tune', min: -100, max: 100, def: 0, bi: true },
    { k: 'expr', l: 'Expression', min: 0, max: 1, def: 0.6 }
  ];
  function defaultMacros() { var m = {}; MACROS.forEach(function (d) { m[d.k] = d.def; }); return m; }
  function attackSec(n) { return 0.0015 + 4 * n * n * n; }
  function toneHz(n) { return n >= 0.985 ? 22000 : 180 * Math.pow(2, n * 6.9); }
  function dynExp(d) { return Math.pow(2, (d - 0.5) * 2.6); }
  function fmtSec(s) { return s < 0.1 ? Math.round(s * 1000) + ' ms' : s < 10 ? s.toFixed(2) + ' s' : s.toFixed(1) + ' s'; }
  function fmtHz(f) { return f >= 21000 ? 'Open' : f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz'; }

  var PRESETS = [
    { name: 'Concert Grand', a: { cat: 'keys', m: ['grand', 'concert', 'piano'] }, m: { reverb: 0.24 } },
    { name: 'Grand + Strings', a: { cat: 'keys', m: ['grand', 'piano'] }, b: { cat: 'pads', m: ['string', 'orch', 'warm'] }, balance: -0.3, bSwell: 0.35, m: { reverb: 0.36, width: 1.2 } },
    { name: 'Late Night EP', a: { cat: 'keys', m: ['rhodes', 'epiano', 'e-piano', 'electric', 'ep', 'wurl'] }, m: { tone: 0.66, width: 1.3, reverb: 0.3, dyn: 0.62 } },
    { name: 'Felt Room', a: { cat: 'keys', m: ['felt', 'soft', 'upright', 'piano'] }, b: { cat: 'textures', m: ['air', 'tape', 'vinyl', 'noise', 'room'] }, balance: -0.55, m: { tone: 0.55, reverb: 0.42, dyn: 0.35 } },
    { name: 'Warm Pad Swell', a: { cat: 'pads', m: ['warm', 'analog', 'pad'] }, m: { attack: 0.45, release: 0.45, expr: 0.9, reverb: 0.45, width: 1.4 } },
    { name: 'Glass Pluck + Air', a: { cat: 'plucks', m: ['glass', 'bell', 'harp', 'kalimba', 'pluck'] }, b: { cat: 'pads', m: ['air', 'choir', 'shimmer', 'glass'] }, bOct: 1, balance: -0.4, bSwell: 0.25, m: { reverb: 0.48, width: 1.3 } },
    { name: 'Deep Bass', a: { cat: 'bass', m: ['sub', 'moog', 'finger', 'synth', 'bass'] }, m: { reverb: 0, width: 0.35, tone: 0.72, dyn: 0.4 } },
    { name: 'Dream Texture', a: { cat: 'textures', m: ['shimmer', 'dream', 'drone', 'texture'] }, b: { cat: 'keys', m: ['celest', 'music', 'bell', 'piano'] }, bOct: 1, balance: 0.35, m: { attack: 0.25, release: 0.6, reverb: 0.6, width: 1.5 } }
  ];

  /* ---------------- pitch detection (normalized autocorrelation, McLeod-style) ---------------- */
  function detectPitch(buf) {
    var sr = buf.sampleRate, d = buf.getChannelData(0), n = d.length;
    if (buf.numberOfChannels > 1) {
      var d2 = buf.getChannelData(1), m = new Float32Array(n);
      for (var q = 0; q < n; q++) m[q] = d[q] + d2[q];
      d = m;
    }
    // skip the transient: start ~60 ms after the peak
    var peak = 0, pk = 0, lim = Math.min(n, sr * 1.5 | 0);
    for (var i = 0; i < lim; i++) { var a = Math.abs(d[i]); if (a > peak) { peak = a; pk = i; } }
    if (peak < 1e-4) return null;
    var W = 4096, start = Math.min(pk + (sr * 0.06 | 0), Math.max(0, n - W * 2));
    if (n - start < 1200) start = 0;
    W = Math.min(W, (n - start) >> 1);
    var minLag = Math.max(2, Math.floor(sr / 2200)), maxLag = Math.min(W - 1, Math.floor(sr / 30));
    var nsdf = new Float32Array(maxLag + 2);
    for (var tau = minLag; tau <= maxLag + 1; tau++) {
      var ac = 0, e = 0;
      for (var j = 0; j < W; j++) { var x = d[start + j], y = d[start + j + tau]; ac += x * y; e += x * x + y * y; }
      nsdf[tau] = e > 0 ? 2 * ac / e : 0;
    }
    var best = 0;
    for (tau = minLag; tau <= maxLag; tau++) best = Math.max(best, nsdf[tau]);
    if (best < 0.45) return null;
    // first local maximum above 0.88 * best (avoids octave errors)
    for (tau = minLag + 1; tau <= maxLag; tau++) {
      if (nsdf[tau] >= 0.88 * best && nsdf[tau] >= nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) {
        var a0 = nsdf[tau - 1], b0 = nsdf[tau], c0 = nsdf[tau + 1], den = a0 - 2 * b0 + c0;
        var shift = den !== 0 ? 0.5 * (a0 - c0) / den : 0;
        var f = sr / (tau + clamp(shift, -1, 1));
        return { freq: f, midi: 69 + 12 * Math.log2(f / 440), clarity: b0 };
      }
    }
    return null;
  }

  function makeImpulse(ctx, secs) {
    var sr = ctx.sampleRate, len = Math.floor(sr * secs), ir = ctx.createBuffer(2, len, sr), r = rng(77);
    for (var c = 0; c < 2; c++) {
      var d = ir.getChannelData(c), lp = 0;
      for (var i = 0; i < len; i++) {
        var t = i / sr, k = 0.75 - 0.6 * Math.min(1, t / secs);     // darker as it decays
        lp += k * ((r() * 2 - 1) - lp);
        var early = t < 0.08 && r() < 0.004 ? (r() * 2 - 1) * 2.5 : 0;  // a few early reflections
        d[i] = (lp + early) * Math.exp(-t * 4.2 / secs * 1.6) * Math.min(1, t / 0.006);
      }
    }
    return ir;
  }

  /* ---------------- plugin state ---------------- */
  var S = null;          // Studio
  var ctx = null, outNode = null;
  var nodes = {};
  var buffers = {};      // sample id -> AudioBuffer
  var loading = {};      // sample id -> Promise
  var progress = {};     // inst id -> {done,total,failed}
  var voices = [];
  var userInsts = [];    // user instruments (persisted)
  var st = {
    a: null, b: null, balance: 0, bOct: 0, bSwell: 0, transpose: 0,
    macros: defaultMacros(), exprMode: 'swell', preset: null, cat: 'keys'
  };
  var sustain = false, globalBend = 0, chBend = {}, globalPress = 0, chPress = {}, notePress = {}, modWheel = 0, cc11 = 1;
  var ui = null;         // mounted UI refs
  var dirty = { keymap: true, status: true };

  function manifest() { return (S && S.samples && S.samples.manifest) || { samples: [], instruments: {} }; }
  function instruments() {
    var out = {}, mi = manifest().instruments || {};
    Object.keys(mi).forEach(function (k) { out[k] = mi[k]; });
    userInsts.forEach(function (u) { out[u.id] = u; });
    return out;
  }
  function getInst(id) { return id ? instruments()[id] || null : null; }
  function sampleEntry(id) {
    var s = manifest().samples || [];
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
    return null;
  }
  function instCat(inst) { return (inst && (inst.category || 'keys')) || 'keys'; }
  function categories() {
    var set = CATS.slice(), ins = instruments();
    Object.keys(ins).forEach(function (k) { var c = instCat(ins[k]); if (c !== 'drums' && set.indexOf(c) < 0) set.splice(set.length - 1, 0, c); });
    return set;
  }
  function instIdsIn(cat) {
    var ins = instruments();
    return Object.keys(ins).filter(function (k) { return instCat(ins[k]) === cat; })
      .sort(function (x, y) { return String(ins[x].name || x).localeCompare(String(ins[y].name || y)); });
  }

  /* ---------------- loading ---------------- */
  function loadSample(id) {
    if (buffers[id]) return Promise.resolve(buffers[id]);
    if (loading[id]) return loading[id];
    loading[id] = Promise.resolve().then(function () { return S.samples.get(id); }).then(function (b) {
      buffers[id] = b; return b;
    }, function (e) { delete loading[id]; throw e; });
    return loading[id];
  }
  function loadInstrument(id) {
    var inst = getInst(id);
    if (!inst) return Promise.resolve();
    var ids = [], seen = {};
    (inst.zones || []).slice().sort(function (x, y) { return Math.abs(x.root - 62) - Math.abs(y.root - 62) || (y.velHi || 1) - (x.velHi || 1); })
      .forEach(function (z) { if (!seen[z.id]) { seen[z.id] = 1; ids.push(z.id); } });
    var p = progress[id] = { done: 0, total: ids.length, failed: 0 };
    ids.forEach(function (sid) { if (buffers[sid]) p.done++; });
    if (p.done >= p.total) { dirty.status = true; return Promise.resolve(); }
    var queue = ids.filter(function (sid) { return !buffers[sid]; }), active = 0;
    dirty.status = true;
    return new Promise(function (resolve) {
      function pump() {
        if (!queue.length && !active) { resolve(); return; }
        while (active < 6 && queue.length) {
          var sid = queue.shift(); active++;
          loadSample(sid).then(function () { p.done++; }, function (e) {
            p.failed++; p.done++; console.warn('[keys] sample failed', e && e.message);
          }).then(function () { active--; dirty.status = true; if (ui && id === st.a) ui.drawArt(); pump(); });
        }
      }
      pump();
    });
  }

  /* ---------------- zone lookup ---------------- */
  function zoneReady(z) { return !!buffers[z.id]; }
  function pickZones(inst, note, vel) {
    var zones = inst.zones || [];
    if (!zones.length) return [];
    var c = zones.filter(function (z) { return note >= (z.lo == null ? 0 : z.lo) && note <= (z.hi == null ? 127 : z.hi) && zoneReady(z); });
    if (!c.length) {   // nothing ready/mapped here: nearest ready root
      var ready = zones.filter(zoneReady);
      if (!ready.length) return [];
      var bestD = 1e9;
      ready.forEach(function (z) { bestD = Math.min(bestD, Math.abs(z.root - note)); });
      c = ready.filter(function (z) { return Math.abs(z.root - note) === bestD; });
    }
    // group by velocity layer, choose nearest root in each
    var layers = {};
    c.forEach(function (z) {
      var lo = z.velLo == null ? 0 : z.velLo, hi = z.velHi == null ? 1 : z.velHi, key = lo + '_' + hi;
      var cur = layers[key];
      if (!cur || Math.abs(z.root - note) < Math.abs(cur.z.root - note)) layers[key] = { z: z, lo: lo, hi: hi };
    });
    var L = Object.keys(layers).map(function (k) { return layers[k]; }).sort(function (x, y) { return x.lo - y.lo; });
    if (L.length === 1) return [{ z: L[0].z, w: 1 }];
    var i = 0;
    for (var k = 0; k < L.length; k++) if (vel >= L[k].lo) i = k;
    var X = 0.12, out = [{ z: L[i].z, w: 1 }];
    if (i + 1 < L.length) {          // approaching upper boundary
      var b = L[i].hi, t = (vel - (b - X / 2)) / X;
      if (t > 0) { t = Math.min(t, 1); out = [{ z: L[i].z, w: Math.cos(t * Math.PI / 2) }, { z: L[i + 1].z, w: Math.sin(t * Math.PI / 2) }]; }
    }
    if (out.length === 1 && i > 0) {  // just above lower boundary
      var b2 = L[i].lo, t2 = (vel - (b2 - X / 2)) / X;
      if (t2 < 1) { t2 = Math.max(t2, 0); out = [{ z: L[i - 1].z, w: Math.cos(t2 * Math.PI / 2) }, { z: L[i].z, w: Math.sin(t2 * Math.PI / 2) }]; }
    }
    return out.filter(function (o) { return o.w > 0.02; });
  }
  function loopFor(z, inst, buf) {
    var lp = z.loop || (sampleEntry(z.id) || {}).loop || (inst.loop && typeof inst.loop === 'object' ? inst.loop : null);
    if (lp && lp.end > lp.start) return lp;
    if (inst.loop === true && buf && buf.duration > 0.5) return { start: buf.duration * 0.5, end: buf.duration - 0.03 };
    return null;
  }

  /* ---------------- engine ---------------- */
  function curveVel(v) { return Math.pow(clamp(v, 0.001, 1), dynExp(st.macros.dyn)); }
  function relSec(layer) {
    var inst = getInst(layer === 1 ? st.b : st.a);
    var base = inst && inst.release != null ? inst.release : 0.5;
    return clamp(base * Math.pow(2, st.macros.release * 3), 0.015, 20);
  }
  function exprAmts() {
    var e = st.macros.expr;
    if (st.exprMode === 'volume') return { vol: 1.3 * e, oct: 0 };
    if (st.exprMode === 'filter') return { vol: 0, oct: 4.5 * e };
    return { vol: 0.8 * e, oct: 2.8 * e };
  }
  function voicePressure(v) { var p = v.mpe ? (chPress[v.ch] || 0) : globalPress; return notePress[v.note] != null ? Math.max(p, notePress[v.note]) : p; }
  function voiceCutoff(v) {
    var f = toneHz(st.macros.tone);
    if (f >= 22000 && !st.macros.expr) return 22000;
    var p = voicePressure(v), ex = exprAmts();
    f *= Math.pow(2, (v.vc - 1) * 1.1);            // softer notes slightly darker
    f *= Math.pow(2, (v.pn - 60) / 48);            // gentle key tracking
    f *= Math.pow(2, ex.oct * p + modWheel * 1.2);
    return clamp(f, 40, 22000);
  }
  function voiceDetune(v) { return st.macros.tune + 100 * (globalBend + (v.mpe ? (chBend[v.ch] || 0) : 0)); }

  function killVoice(v) {
    if (v.dead) return;
    v.dead = true;
    var i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    v.srcs.forEach(function (s) {
      try { nodes.lfoGain.disconnect(s.src.detune); } catch (e) { /* already gone */ }
      try { s.src.disconnect(); } catch (e) { /* noop */ }
    });
    try { v.pan.disconnect(); } catch (e) { /* noop */ }
    dirty.keymap = dirty.status = true;
  }
  function envAt(v, t) {
    if (t <= v.t0) return 0;
    if (t < v.atkEnd) return v.amp * (t - v.t0) / (v.atkEnd - v.t0);
    return v.amp;
  }
  function holdEnv(v, t) {
    var g = v.env.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); g.setValueAtTime(envAt(v, t), t); }
  }
  function stopSrcs(v, t) { v.srcs.forEach(function (s) { try { s.src.stop(t); } catch (e) { /* noop */ } }); }
  function fastKill(v) {
    if (v.stolen) return;
    var t = ctx.currentTime;
    v.kill.gain.setValueAtTime(1, t);
    v.kill.gain.linearRampToValueAtTime(0, t + 0.012);
    stopSrcs(v, t + 0.03);
    v.released = true;
    var i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);  // free the slot now; nodes are cleaned up on 'ended'
    v.stolen = true;
  }
  function releaseVoice(v, time, relOverride) {
    if (v.released) return;
    v.released = true; v.sustained = false;
    var t = Math.max(time || 0, ctx.currentTime, v.t0);
    var rel = relOverride || relSec(v.layer);
    holdEnv(v, t);
    v.env.gain.setTargetAtTime(0, t, rel / 4.6);
    stopSrcs(v, t + rel * 1.25 + 0.05);
    dirty.keymap = true;
  }

  function startVoice(layer, note, vel, time, info) {
    var inst = getInst(layer === 1 ? st.b : st.a);
    if (!inst) return;
    var pn = note + st.transpose + (layer === 1 ? st.bOct * 12 : 0);
    if (pn < 0 || pn > 127) return;
    var vc = curveVel(vel);
    var picks = pickZones(inst, pn, vc);
    if (!picks.length) return;
    // retrigger: release previous voice of the same key quickly
    for (var i = voices.length - 1; i >= 0; i--) {
      var o = voices[i];
      if (o.note === note && o.layer === layer && !o.released && (!info.mpe || o.ch === info.ch)) releaseVoice(o, time, Math.min(0.25, relSec(layer)));
    }
    while (voices.length >= MAX_VOICES) {
      var victim = null;
      for (i = 0; i < voices.length; i++) if (voices[i].released) { victim = voices[i]; break; }
      fastKill(victim || voices[0]);
    }
    var t0 = Math.max(time || 0, ctx.currentTime);
    var v = {
      note: note, pn: pn, layer: layer, ch: info.ch || 0, mpe: !!info.mpe, vel: vel, vc: vc, t0: t0,
      released: false, sustained: false, srcs: []
    };
    var gainTrim = inst.gain != null ? inst.gain : 1;
    v.amp = (0.05 + 0.95 * Math.pow(vc, 1.15)) * 0.7 * gainTrim;
    var atk = attackSec(st.macros.attack) + (layer === 1 ? 3 * Math.pow(st.bSwell, 2) : 0);
    v.atkEnd = t0 + atk;
    v.filter = ctx.createBiquadFilter(); v.filter.type = 'lowpass'; v.filter.Q.value = 0.4;
    v.filter.frequency.value = voiceCutoff(v);
    v.expr = ctx.createGain();
    var ex = exprAmts();
    v.expr.gain.value = 1 + ex.vol * voicePressure(v);
    v.env = ctx.createGain();
    v.env.gain.setValueAtTime(0, t0);
    v.env.gain.linearRampToValueAtTime(v.amp, v.atkEnd);
    v.pan = ctx.createStereoPanner();
    v.pan.pan.value = clamp((pn - 60) / 42, -1, 1) * 0.32 * Math.min(1, st.macros.width);
    v.kill = ctx.createGain();   // separate gain for click-free steal/panic (no automation clashes with env)
    v.filter.connect(v.expr); v.expr.connect(v.env); v.env.connect(v.kill); v.kill.connect(v.pan); v.pan.connect(nodes.layerBus[layer]);
    var det = voiceDetune(v);
    picks.forEach(function (p) {
      var buf = buffers[p.z.id];
      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Math.pow(2, (pn - p.z.root) / 12);
      src.detune.value = det;
      var lp = loopFor(p.z, inst, buf);
      if (lp) { src.loop = true; src.loopStart = lp.start; src.loopEnd = Math.min(lp.end, buf.duration); }
      var g = ctx.createGain(); g.gain.value = p.w;
      src.connect(g); g.connect(v.filter);
      nodes.lfoGain.connect(src.detune);
      src.start(t0, p.z.offset || 0);
      v.srcs.push({ src: src, g: g });
    });
    v.srcs[0].src.onended = function () { killVoice(v); };
    voices.push(v);
    dirty.keymap = dirty.status = true;
  }

  function eachVoice(fn) { for (var i = 0; i < voices.length; i++) fn(voices[i]); }
  function refreshFilters(onlyCh) {
    var now = ctx.currentTime, ex = exprAmts();
    eachVoice(function (v) {
      if (onlyCh != null && !(v.mpe && v.ch === onlyCh)) return;
      v.filter.frequency.setTargetAtTime(voiceCutoff(v), now, 0.03);
      v.expr.gain.setTargetAtTime(1 + ex.vol * voicePressure(v), now, 0.04);
    });
  }
  function refreshDetune(onlyCh) {
    var now = ctx.currentTime;
    eachVoice(function (v) {
      if (onlyCh != null && !(v.mpe && v.ch === onlyCh)) return;
      var d = voiceDetune(v);
      v.srcs.forEach(function (s) { s.src.detune.setTargetAtTime(d, now, 0.008); });
    });
  }
  function applyBus() {
    if (!ctx) return;
    var now = ctx.currentTime, b = st.balance, hasB = !!getInst(st.b);
    nodes.layerBus[0].gain.setTargetAtTime(hasB ? Math.min(1, 1 - b) : 1, now, 0.02);
    nodes.layerBus[1].gain.setTargetAtTime(hasB ? Math.min(1, 1 + b) : 0, now, 0.02);
    var w = st.macros.width, same = (1 + w) / 2, cross = (1 - w) / 2;
    nodes.wLL.gain.setTargetAtTime(same, now, 0.02); nodes.wRR.gain.setTargetAtTime(same, now, 0.02);
    nodes.wLR.gain.setTargetAtTime(cross, now, 0.02); nodes.wRL.gain.setTargetAtTime(cross, now, 0.02);
    var r = st.macros.reverb;
    nodes.revSend.gain.setTargetAtTime(r * r * 1.1, now, 0.03);
    nodes.dry.gain.setTargetAtTime(1 - r * 0.3, now, 0.03);
    nodes.post.gain.setTargetAtTime(cc11, now, 0.02);
  }
  function setMacro(k, val, fromUi) {
    st.macros[k] = val;
    if (!ctx) return;
    if (k === 'tone' || k === 'expr') refreshFilters();
    else if (k === 'tune') refreshDetune();
    else if (k === 'width' || k === 'reverb') applyBus();
    else if (k === 'release' && ui) ui.R.lmeta.textContent = ui.R.lmeta.textContent.replace(/release .*$/, 'release ' + fmtSec(relSec(0)));
    if (!fromUi && ui) ui.syncKnobs();
  }

  /* ---------------- instrument selection / presets ---------------- */
  function setLayer(which, id) {
    if (which === 'a') st.a = id || null; else st.b = id || null;
    if (id) loadInstrument(id);
    applyBus();
    dirty.keymap = dirty.status = true;
    if (ui) ui.refresh();
  }
  function resolveInst(spec) {
    if (!spec) return null;
    var ins = instruments(), ids = Object.keys(ins);
    if (spec.id && ins[spec.id]) return spec.id;
    var inCat = ids.filter(function (k) { return instCat(ins[k]) === spec.cat; });
    var words = spec.m || [];
    for (var w = 0; w < words.length; w++) {
      for (var i = 0; i < inCat.length; i++) {
        var hay = (inCat[i] + ' ' + (ins[inCat[i]].name || '')).toLowerCase();
        if (hay.indexOf(words[w]) >= 0) return inCat[i];
      }
    }
    return inCat[0] || null;
  }
  function applyPreset(idx) {
    var p = PRESETS[idx];
    if (!p) return;
    st.macros = defaultMacros();
    Object.keys(p.m || {}).forEach(function (k) { st.macros[k] = p.m[k]; });
    st.balance = p.balance || 0; st.bOct = p.bOct || 0; st.bSwell = p.bSwell || 0; st.exprMode = 'swell';
    st.preset = p.name;
    var a = resolveInst(p.a), b = resolveInst(p.b);
    if (!a) { a = b || Object.keys(instruments())[0] || null; b = null; }   // library lacks this preset's main sound
    if (b === a) b = null;
    if (a) st.cat = instCat(getInst(a));
    setLayer('a', a); setLayer('b', b);
    refreshFilters(); refreshDetune(); applyBus();
    if (ui) { ui.syncKnobs(); ui.refresh(); }
  }

  /* ---------------- user import ---------------- */
  function persistUser() { if (S && S.storage) S.storage.set('keys.userInstruments', userInsts).catch(function () { }); }
  function importFile(file) {
    if (!file) return Promise.resolve();
    if (!/^audio\/|\.(wav|mp3|m4a|aif|aiff|ogg|flac)$/i.test(file.type + ' ' + file.name)) {
      S.toast && S.toast('Keys: drop a WAV or MP3 file');
      return Promise.resolve();
    }
    if (ui) ui.setBusy('Importing ' + file.name + '…');
    return S.samples.importFile(file, { category: 'user' }).then(function (entry) {
      return loadSample(entry.id).then(function (buf) {
        var det = detectPitch(buf);
        var root = det ? clamp(det.midi, 12, 120) : 60;
        var name = (entry.name || file.name).replace(/\.[^.]+$/, '');
        var u = {
          id: 'user:' + entry.id, name: name, category: 'user', user: true,
          detected: !!det, release: 0.35, loop: false,
          zones: [{ id: entry.id, root: Math.round(root * 100) / 100, lo: 0, hi: 127, velLo: 0, velHi: 1 }]
        };
        userInsts.push(u); persistUser();
        st.cat = 'user'; st.preset = null;
        setLayer('a', u.id);
        if (ui) ui.setBusy(null);
        S.toast && S.toast('Keys: "' + name + '" imported' + (det ? ', root ' + noteName(root) : ' (no clear pitch, root C4)'));
        return u;
      });
    }).catch(function (e) {
      if (ui) ui.setBusy(null);
      console.warn('[keys] import failed', e);
      S.toast && S.toast('Keys: could not import ' + file.name);
    });
  }
  function nudgeRoot(id, delta) {
    var u = userInsts.filter(function (x) { return x.id === id; })[0];
    if (!u) return;
    u.zones.forEach(function (z) { z.root = clamp(Math.round((z.root + delta) * 100) / 100, 0, 127); });
    persistUser(); dirty.keymap = true;
    if (ui) ui.refresh();
  }
  function removeUser(id) {
    userInsts = userInsts.filter(function (x) { return x.id !== id; });
    if (st.a === id) st.a = null;
    if (st.b === id) st.b = null;
    persistUser(); dirty.keymap = dirty.status = true;
    if (ui) ui.refresh();
  }

  /* =================================================================
   * UI
   * ================================================================= */
  var ICON = '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="4" width="16" height="12" rx="1.5"/><path d="M6 4v7M10 4v7M14 4v7"/><path d="M5 11h2M9 11h2M13 11h2" stroke-width="2.4"/></svg>';

  function makeKnob(def, get, set, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'k-knob' + (opts.small ? ' k-small' : '');
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', def.l);
    el.innerHTML = '<div class="k-dial"><svg viewBox="0 0 100 100"><path class="k-arcbg" d=""/><path class="k-arcv" d=""/></svg>' +
      '<div class="k-cap"><div class="k-ptr"></div></div></div><div class="k-lab">' + esc(def.l) + '</div><div class="k-val"></div>';
    var arcbg = el.querySelector('.k-arcbg'), arcv = el.querySelector('.k-arcv'), ptr = el.querySelector('.k-ptr'), val = el.querySelector('.k-val');
    var A0 = -135, A1 = 135;
    function pt(a, r) { var rad = (a - 90) * Math.PI / 180; return (50 + r * Math.cos(rad)).toFixed(2) + ' ' + (50 + r * Math.sin(rad)).toFixed(2); }
    function arc(a, b, r) { if (b < a) { var t = a; a = b; b = t; } if (b - a < 0.5) return ''; return 'M' + pt(a, r) + ' A' + r + ' ' + r + ' 0 ' + (b - a > 180 ? 1 : 0) + ' 1 ' + pt(b, r); }
    arcbg.setAttribute('d', arc(A0, A1, 44));
    function norm() { return (get() - def.min) / (def.max - def.min); }
    function draw() {
      var n = clamp(norm(), 0, 1), a = A0 + n * (A1 - A0);
      var from = def.bi ? 0 : A0;
      arcv.setAttribute('d', arc(from, a, 44));
      ptr.style.transform = 'rotate(' + a + 'deg)';
      val.textContent = opts.fmt ? opts.fmt(get()) : get().toFixed(2);
      el.setAttribute('aria-valuetext', val.textContent);
    }
    function setN(n) {
      n = clamp(n, 0, 1);
      var v = def.min + n * (def.max - def.min);
      if (def.step) v = Math.round(v / def.step) * def.step;
      set(v); draw();
    }
    var dragY = 0, dragN = 0;
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault(); el.focus();
      el.setPointerCapture(e.pointerId); dragY = e.clientY; dragN = norm(); el.classList.add('k-drag');
    });
    el.addEventListener('pointermove', function (e) {
      if (!el.hasPointerCapture || !el.hasPointerCapture(e.pointerId)) return;
      var dy = dragY - e.clientY; dragY = e.clientY;
      dragN = clamp(dragN + dy / (e.shiftKey ? 900 : 220), 0, 1); setN(dragN);
    });
    function up(e) { try { el.releasePointerCapture(e.pointerId); } catch (x) { /* noop */ } el.classList.remove('k-drag'); }
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('dblclick', function () { set(def.def); draw(); });
    el.addEventListener('wheel', function (e) { e.preventDefault(); setN(norm() - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.03)); }, { passive: false });
    el.addEventListener('keydown', function (e) {
      var d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); setN(norm() + d * (e.shiftKey ? 0.005 : 0.02)); }
    });
    draw();
    return { el: el, draw: draw };
  }

  function buildUI(root) {
    root.innerHTML =
      '<div class="k-panel">' +
      ' <aside class="k-side">' +
      '  <div class="k-brand"><span class="k-logo">' + ICON + '</span><span>KEYS</span><em>multisample player</em></div>' +
      '  <div class="k-cats"></div>' +
      '  <div class="k-list" role="listbox"></div>' +
      '  <button class="k-import" type="button"><b>+ Import sample</b><span>or drop a WAV / MP3 anywhere</span></button>' +
      '  <input class="k-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.aif,.aiff" hidden>' +
      ' </aside>' +
      ' <section class="k-main">' +
      '  <div class="k-top">' +
      '   <div class="k-preset"><span class="k-cap-l">Preset</span><button class="k-pv" type="button" aria-label="Previous preset">&#9664;</button>' +
      '    <select class="k-psel"></select><button class="k-pn" type="button" aria-label="Next preset">&#9654;</button></div>' +
      '   <div class="k-stat"><span class="k-led k-ped"></span><span class="k-cap-l">Pedal</span>' +
      '    <span class="k-meter"><i class="k-mod"></i></span><span class="k-cap-l">Mod</span>' +
      '    <span class="k-meter"><i class="k-prs"></i></span><span class="k-cap-l">Press</span>' +
      '    <span class="k-voices">0 / 48</span></div>' +
      '  </div>' +
      '  <div class="k-hero">' +
      '   <canvas class="k-art"></canvas>' +
      '   <div class="k-hero-txt"><div class="k-kicker"></div><div class="k-name"></div><div class="k-meta"></div>' +
      '    <div class="k-rootedit" hidden><span class="k-cap-l">Root</span><button type="button" class="k-rdn">&minus;</button><b class="k-root"></b><button type="button" class="k-rup">+</button><span class="k-det"></span></div></div>' +
      '   <div class="k-load"><i></i><span></span></div>' +
      '   <div class="k-dropmsg"><div>Drop audio to create an instrument</div></div>' +
      '  </div>' +
      '  <div class="k-macros"></div>' +
      '  <div class="k-layers">' +
      '   <div class="k-layer k-la"><div class="k-lh"><span class="k-tag">A</span><span class="k-cap-l">Layer</span></div><div class="k-lname"></div><div class="k-lmeta"></div></div>' +
      '   <div class="k-bal"></div>' +
      '   <div class="k-layer k-lb"><div class="k-lh"><span class="k-tag">B</span><span class="k-cap-l">Layer</span>' +
      '     <div class="k-seg k-oct"><button type="button" data-o="-1">8vb</button><button type="button" data-o="0">0</button><button type="button" data-o="1">8va</button></div></div>' +
      '     <select class="k-bsel"></select></div>' +
      '   <div class="k-bsw"></div>' +
      '   <div class="k-exp"><div class="k-cap-l">Pressure &rarr;</div><div class="k-seg k-emode"><button type="button" data-m="swell">Swell</button><button type="button" data-m="volume">Volume</button><button type="button" data-m="filter">Filter</button></div>' +
      '    <div class="k-cap-l k-tr-l">Transpose</div><div class="k-seg k-tr"><button type="button" data-t="-12">&minus;12</button><button type="button" data-t="-1">&minus;</button><b class="k-trv">0</b><button type="button" data-t="1">+</button><button type="button" data-t="12">+12</button></div></div>' +
      '  </div>' +
      '  <canvas class="k-map"></canvas>' +
      ' </section>' +
      '</div>';
    var q = function (s) { return root.querySelector(s); };
    var R = {
      panel: q('.k-panel'), cats: q('.k-cats'), list: q('.k-list'), file: q('.k-file'), art: q('.k-art'), hero: q('.k-hero'),
      kicker: q('.k-kicker'), name: q('.k-name'), meta: q('.k-meta'), load: q('.k-load'), loadBar: q('.k-load i'), loadTxt: q('.k-load span'),
      rootEdit: q('.k-rootedit'), rootV: q('.k-root'), det: q('.k-det'),
      psel: q('.k-psel'), lmeta: q('.k-lmeta'), bsel: q('.k-bsel'), lname: q('.k-lname'), oct: q('.k-oct'), emode: q('.k-emode'), trv: q('.k-trv'),
      ped: q('.k-ped'), mod: q('.k-mod'), prs: q('.k-prs'), voices: q('.k-voices'), map: q('.k-map'), macros: q('.k-macros')
    };
    var knobs = [];
    MACROS.forEach(function (d) {
      var fmt = {
        attack: function (v) { return fmtSec(attackSec(v)); },
        release: function () { return fmtSec(relSec(0)); },
        tone: function (v) { return fmtHz(toneHz(v)); },
        dyn: function (v) { return v < 0.04 ? 'Fixed-ish' : Math.round(v * 100) + '%'; },
        width: function (v) { return v < 0.02 ? 'Mono' : Math.round(v * 100) + '%'; },
        reverb: function (v) { return v < 0.01 ? 'Dry' : Math.round(v * 100) + '%'; },
        tune: function (v) { return (v > 0 ? '+' : '') + Math.round(v) + ' ct'; },
        expr: function (v) { return Math.round(v * 100) + '%'; }
      }[d.k];
      var kn = makeKnob(d, function () { return st.macros[d.k]; }, function (v) { setMacro(d.k, v, true); }, { fmt: fmt });
      kn.el.dataset.k = d.k;
      R.macros.appendChild(kn.el); knobs.push(kn);
    });
    var bal = makeKnob({ l: 'Balance', min: -1, max: 1, def: 0, bi: true }, function () { return st.balance; },
      function (v) { st.balance = v; applyBus(); }, { small: true, fmt: function (v) { return Math.abs(v) < 0.02 ? 'A = B' : v < 0 ? 'A ' + Math.round(-v * 100) + '%' : 'B ' + Math.round(v * 100) + '%'; } });
    q('.k-bal').appendChild(bal.el); knobs.push(bal);
    var bsw = makeKnob({ l: 'B Swell', min: 0, max: 1, def: 0 }, function () { return st.bSwell; },
      function (v) { st.bSwell = v; }, { small: true, fmt: function (v) { return v < 0.01 ? 'Off' : fmtSec(3 * v * v); } });
    q('.k-bsw').appendChild(bsw.el); knobs.push(bsw);

    PRESETS.forEach(function (p, i) { var o = document.createElement('option'); o.value = i; o.textContent = p.name; R.psel.appendChild(o); });
    R.psel.addEventListener('change', function () { applyPreset(+R.psel.value); });
    q('.k-pv').addEventListener('click', function () { var i = PRESETS.map(function (p) { return p.name; }).indexOf(st.preset); applyPreset((i - 1 + PRESETS.length) % PRESETS.length); });
    q('.k-pn').addEventListener('click', function () { var i = PRESETS.map(function (p) { return p.name; }).indexOf(st.preset); applyPreset((i + 1) % PRESETS.length); });
    R.bsel.addEventListener('change', function () { st.preset = null; setLayer('b', R.bsel.value || null); });
    R.oct.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { st.bOct = +b.dataset.o; refresh(); } });
    R.emode.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { st.exprMode = b.dataset.m; refreshFilters(); refresh(); } });
    q('.k-tr').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { api.allNotesOff(); st.transpose = clamp(st.transpose + +b.dataset.t, -36, 36); refresh(); dirty.keymap = true; } });
    q('.k-rdn').addEventListener('click', function () { nudgeRoot(st.a, -1); });
    q('.k-rup').addEventListener('click', function () { nudgeRoot(st.a, 1); });
    q('.k-import').addEventListener('click', function () { R.file.click(); });
    R.file.addEventListener('change', function () { if (R.file.files[0]) importFile(R.file.files[0]); R.file.value = ''; });

    var dragDepth = 0;
    R.panel.addEventListener('dragenter', function (e) { if (hasFiles(e)) { e.preventDefault(); dragDepth++; R.panel.classList.add('k-dropping'); } });
    R.panel.addEventListener('dragover', function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    R.panel.addEventListener('dragleave', function () { if (--dragDepth <= 0) { dragDepth = 0; R.panel.classList.remove('k-dropping'); } });
    R.panel.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); dragDepth = 0; R.panel.classList.remove('k-dropping');
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importFile(f);
    });
    function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; }

    R.cats.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { st.cat = b.dataset.c; refresh(); } });
    R.list.addEventListener('click', function (e) {
      var x = e.target.closest('[data-del]');
      if (x) { e.stopPropagation(); removeUser(x.dataset.del); return; }
      var bb = e.target.closest('[data-b]');
      if (bb) { e.stopPropagation(); st.preset = null; setLayer('b', st.b === bb.dataset.b ? null : bb.dataset.b); return; }
      var row = e.target.closest('[data-id]');
      if (row) { st.preset = null; setLayer('a', row.dataset.id); }
    });

    // keymap: click to audition
    var mapDown = null;
    R.map.addEventListener('pointerdown', function (e) {
      var n = mapNoteAt(e); if (n == null) return;
      R.map.setPointerCapture(e.pointerId);
      if (ctx && ctx.state === 'suspended') ctx.resume();
      mapDown = n; api.noteOn(n, 0.45 + 0.5 * mapVelAt(e), ctx.currentTime, { ch: 0, mpe: false });
    });
    function mapUp() { if (mapDown != null) { api.noteOff(mapDown, ctx.currentTime, { ch: 0, mpe: false }); mapDown = null; } }
    R.map.addEventListener('pointerup', mapUp); R.map.addEventListener('pointercancel', mapUp);

    /* ----- hero artwork ----- */
    function drawArt() {
      var c = R.art, w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      var dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      var g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      var inst = getInst(st.a), cat = inst ? instCat(inst) : 'keys', tint = CAT_TINT[cat] || '#e8b765';
      var r = rng(hash(st.a || 'none'));
      var bg = g.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, '#1d1915'); bg.addColorStop(1, '#0e0c0a');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      function glow(x, y, rad, col, a) {
        var gr = g.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, hexA(col, a)); gr.addColorStop(1, hexA(col, 0));
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
      glow(w * 0.78, h * 0.35, w * 0.5, tint, 0.28);
      glow(w * (0.45 + r() * 0.2), h * 1.1, w * 0.4, tint, 0.12);
      g.save();
      var x0 = w * 0.42;
      if (cat === 'keys') {
        // receding keyboard in perspective
        var keys = 22, vx = w * 1.05, vy = -h * 0.6;
        for (var i = 0; i < keys; i++) {
          var u0 = i / keys, u1 = (i + 0.94) / keys;
          var bx0 = x0 + (w - x0) * u0 * 1.1, bx1 = x0 + (w - x0) * u1 * 1.1, by = h + 4;
          var tx0 = bx0 + (vx - bx0) * 0.45, tx1 = bx1 + (vx - bx1) * 0.45, ty = by + (vy - by) * 0.45;
          var lg = g.createLinearGradient(0, ty, 0, by);
          lg.addColorStop(0, hexA('#f4ead8', 0.0)); lg.addColorStop(1, hexA('#f4ead8', 0.22 + 0.1 * (i % 7 === 3 ? 1 : 0)));
          g.fillStyle = lg;
          g.beginPath(); g.moveTo(bx0, by); g.lineTo(bx1, by); g.lineTo(tx1, ty); g.lineTo(tx0, ty); g.closePath(); g.fill();
          if ([1, 2, 4, 5, 6].indexOf(i % 7) >= 0) {
            var m0 = (bx0 + tx0) / 2 - 3, mt = (by + ty) / 2;
            g.fillStyle = 'rgba(8,6,4,.75)';
            g.beginPath(); g.moveTo(bx0 - 5, by - h * 0.05); g.lineTo(bx0 + 5, by - h * 0.05); g.lineTo(m0 + 10, mt); g.lineTo(m0, mt); g.closePath(); g.fill();
          }
        }
      } else if (cat === 'bass') {
        for (var j = 0; j < 7; j++) {
          g.strokeStyle = hexA(tint, 0.1 + j * 0.06); g.lineWidth = 6 - j * 0.6;
          g.beginPath();
          var amp = h * (0.08 + j * 0.035), ph = r() * 6, fq = 1.5 + j * 0.15;
          for (var x = x0 - 40; x <= w; x += 4) { var y = h * 0.62 + Math.sin(ph + (x / w) * fq * Math.PI * 2) * amp; if (x === x0 - 40) g.moveTo(x, y); else g.lineTo(x, y); }
          g.stroke();
        }
      } else if (cat === 'pads') {
        g.globalCompositeOperation = 'lighter';
        for (var k = 0; k < 9; k++) glow(x0 + r() * (w - x0), h * (0.15 + r() * 0.8), 40 + r() * 140, k % 3 ? tint : '#e8b765', 0.12 + r() * 0.12);
      } else if (cat === 'plucks') {
        for (var s2 = 0; s2 < 16; s2++) {
          var sx = x0 + (w - x0) * (s2 + 0.5) / 16, disp = (s2 % 5 === 2 ? 1 : 0.15) * (8 + r() * 10);
          g.strokeStyle = hexA(s2 % 5 === 2 ? '#f4ead8' : tint, 0.35 + r() * 0.3); g.lineWidth = 1 + (16 - s2) * 0.07;
          g.beginPath(); g.moveTo(sx, -2); g.quadraticCurveTo(sx + disp, h * 0.5, sx, h + 2); g.stroke();
        }
      } else if (cat === 'textures') {
        for (var p = 0; p < 900; p++) {
          var px = x0 - 80 + r() * (w - x0 + 80), py = r() * h, dd = Math.hypot(px - w * 0.78, py - h * 0.4) / w;
          g.fillStyle = hexA(r() < 0.2 ? '#f4ead8' : tint, Math.max(0, 0.5 - dd) * r());
          g.fillRect(px, py, 1.6, 1.6);
        }
        g.strokeStyle = hexA(tint, 0.25); g.lineWidth = 1;
        for (var cc = 1; cc < 9; cc++) { g.beginPath(); g.ellipse(w * 0.78, h * 0.4, cc * 26, cc * 14, -0.3, 0, Math.PI * 2); g.stroke(); }
      } else if (cat === 'user') {
        var z = inst && inst.zones && inst.zones[0], buf = z && buffers[z.id];
        if (buf) {
          var d = buf.getChannelData(0), bars = 110, bw = (w - x0 - 20) / bars, step = Math.max(1, Math.floor(d.length / bars));
          for (var bi = 0; bi < bars; bi++) {
            var mx = 0; for (var si = bi * step; si < Math.min(d.length, (bi + 1) * step); si += 8) mx = Math.max(mx, Math.abs(d[si]));
            var bh = Math.max(1.5, mx * h * 0.75);
            g.fillStyle = hexA(bi % 9 === 0 ? '#e8b765' : tint, 0.25 + mx * 0.6);
            g.fillRect(x0 + bi * bw, h * 0.52 - bh / 2, Math.max(1, bw - 1.2), bh);
          }
        }
      } else {
        for (var a = 0; a < 10; a++) { g.strokeStyle = hexA(tint, 0.08 + a * 0.03); g.beginPath(); g.arc(w * 0.8, h * 0.5, 20 + a * 18, 0, Math.PI * 2); g.stroke(); }
      }
      g.restore();
      // left fade for text legibility + vignette
      var lf = g.createLinearGradient(0, 0, w * 0.62, 0);
      lf.addColorStop(0, 'rgba(16,13,11,.95)'); lf.addColorStop(0.55, 'rgba(16,13,11,.6)'); lf.addColorStop(1, 'rgba(16,13,11,0)');
      g.fillStyle = lf; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(255,240,215,.05)'; g.lineWidth = 1;
      for (var ln = 0; ln < h; ln += 3) { g.beginPath(); g.moveTo(0, ln + 0.5); g.lineTo(w, ln + 0.5); g.stroke(); }
    }
    function hexA(hex, a) {
      var n = parseInt(hex.slice(1), 16);
      return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
    }

    /* ----- zone map keyboard ----- */
    var MAP_LO = 21, MAP_HI = 108;
    function whiteIdx(n) { var o = Math.floor(n / 12), pc = n % 12; return o * 7 + [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pc]; }
    function isBlack(n) { return [1, 3, 6, 8, 10].indexOf(n % 12) >= 0; }
    function mapGeom() {
      var w = R.map.clientWidth, h = R.map.clientHeight, nW = whiteIdx(MAP_HI) - whiteIdx(MAP_LO) + 1;
      return { w: w, h: h, ww: w / nW, top: 18, kh: h - 18 };
    }
    function keyRect(n, G) {
      var wi = whiteIdx(n) - whiteIdx(MAP_LO);
      if (!isBlack(n)) return { x: wi * G.ww, y: G.top, w: G.ww, h: G.kh };
      return { x: (wi + 1) * G.ww - G.ww * 0.32, y: G.top, w: G.ww * 0.64, h: G.kh * 0.6 };
    }
    function mapNoteAt(e) {
      var b = R.map.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, G = mapGeom();
      if (y < G.top) return null;
      for (var n = MAP_LO; n <= MAP_HI; n++) if (isBlack(n)) { var kr = keyRect(n, G); if (x >= kr.x && x <= kr.x + kr.w && y <= kr.y + kr.h) return n; }
      for (n = MAP_LO; n <= MAP_HI; n++) if (!isBlack(n)) { kr = keyRect(n, G); if (x >= kr.x && x < kr.x + kr.w) return n; }
      return null;
    }
    function mapVelAt(e) { var b = R.map.getBoundingClientRect(), G = mapGeom(); return clamp((e.clientY - b.top - G.top) / G.kh, 0, 1); }
    function drawMap() {
      var c = R.map, G = mapGeom();
      if (!G.w) return;
      var dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(G.w * dpr) || c.height !== Math.round(G.h * dpr)) { c.width = Math.round(G.w * dpr); c.height = Math.round(G.h * dpr); }
      var g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, G.w, G.h);
      var active = {};
      voices.forEach(function (v) { if (!v.released || v.sustained) active[v.note] = v.layer === 1 && !active[v.note] ? 2 : 1; });
      // zone bands (shifted by transpose: keys you press)
      [[st.a, 0, '#e8b765'], [st.b, 1, '#8fc3c9']].forEach(function (L) {
        var inst = getInst(L[0]); if (!inst) return;
        var off = st.transpose + (L[1] ? st.bOct * 12 : 0), y = L[1] ? 10 : 3;
        var lo = 127, hi = 0, roots = {};
        (inst.zones || []).forEach(function (z) {
          lo = Math.min(lo, z.lo == null ? 0 : z.lo); hi = Math.max(hi, z.hi == null ? 127 : z.hi); roots[Math.round(z.root)] = 1;
        });
        var a = keyRect(clamp(lo - off, MAP_LO, MAP_HI), G), b = keyRect(clamp(hi - off, MAP_LO, MAP_HI), G);
        g.fillStyle = hexA(L[2], 0.42); g.fillRect(a.x, y, b.x + b.w - a.x, 5);
        g.fillStyle = L[2];
        Object.keys(roots).forEach(function (rn) { var n = +rn - off; if (n >= MAP_LO && n <= MAP_HI) { var kr = keyRect(n, G); g.fillRect(kr.x + kr.w / 2 - 1, y, 2, 5); } });
      });
      for (var n = MAP_LO; n <= MAP_HI; n++) if (!isBlack(n)) {
        var kr = keyRect(n, G);
        g.fillStyle = active[n] === 1 ? '#f0c27a' : active[n] === 2 ? '#8fc3c9' : '#e9e1d2';
        g.fillRect(kr.x + 0.5, kr.y, kr.w - 1, kr.h - 1);
        if (n % 12 === 0) { g.fillStyle = '#7a7065'; g.font = '9px system-ui,sans-serif'; g.textAlign = 'center'; g.fillText('C' + (n / 12 - 1), kr.x + kr.w / 2, kr.y + kr.h - 4); }
      }
      for (n = MAP_LO; n <= MAP_HI; n++) if (isBlack(n)) {
        kr = keyRect(n, G);
        g.fillStyle = active[n] === 1 ? '#c8913e' : active[n] === 2 ? '#5f9aa1' : '#1b1815';
        g.fillRect(kr.x, kr.y, kr.w, kr.h);
      }
    }

    /* ----- refresh ----- */
    function instMeta(inst) {
      var z = inst.zones || [], vl = {}, lo = 127, hi = 0, rlo = 127, rhi = 0, looped = false, files = {};
      z.forEach(function (x) { vl[(x.velLo || 0) + '_' + (x.velHi == null ? 1 : x.velHi)] = 1; lo = Math.min(lo, x.lo == null ? 0 : x.lo); hi = Math.max(hi, x.hi == null ? 127 : x.hi); files[x.id] = 1; rlo = Math.min(rlo, x.root); rhi = Math.max(rhi, x.root); if (x.loop || (sampleEntry(x.id) || {}).loop) looped = true; });
      if (inst.loop) looped = true;
      var parts = [Object.keys(files).length + ' sample' + (Object.keys(files).length === 1 ? '' : 's')];
      var nv = Object.keys(vl).length;
      if (nv > 1) parts.push(nv + ' velocity layers');
      parts.push(inst.user ? 'chromatic' : rlo === rhi ? 'root ' + noteName(rlo) : 'sampled ' + noteName(rlo) + '–' + noteName(rhi));
      if (looped) parts.push('looped');
      parts.push('release ' + fmtSec(inst.release != null ? inst.release : 0.5));
      return parts.join('  ·  ');
    }
    function optionsHtml(sel) {
      var ins = instruments(), h = '<option value="">— Off —</option>';
      categories().forEach(function (c) {
        var ids = instIdsIn(c); if (!ids.length) return;
        h += '<optgroup label="' + esc(CAT_LABEL[c] || c) + '">';
        ids.forEach(function (id) { h += '<option value="' + esc(id) + '"' + (id === sel ? ' selected' : '') + '>' + esc(ins[id].name || id) + '</option>'; });
        h += '</optgroup>';
      });
      return h;
    }
    function refresh() {
      var ins = instruments(), cats = categories();
      R.cats.innerHTML = cats.map(function (c) {
        var n = instIdsIn(c).length;
        return '<button type="button" data-c="' + esc(c) + '" class="' + (c === st.cat ? 'on' : '') + '" style="--t:' + (CAT_TINT[c] || '#e8b765') + '"><i></i>' + esc(CAT_LABEL[c] || c) + '<span>' + n + '</span></button>';
      }).join('');
      if (!instIdsIn(st.cat).length && st.cat !== 'user' && getInst(st.a)) st.cat = instCat(getInst(st.a));
      var ids = instIdsIn(st.cat);
      R.list.innerHTML = ids.length ? ids.map(function (id) {
        var inst = ins[id], p = progress[id];
        var ld = p && p.done < p.total ? ' k-busy' : p ? ' k-ok' : '';
        return '<div class="k-item' + (id === st.a ? ' a' : '') + (id === st.b ? ' b' : '') + ld + '" data-id="' + esc(id) + '" role="option" aria-selected="' + (id === st.a) + '">' +
          '<i class="k-dot"></i><span class="k-in">' + esc(inst.name || id) + '</span>' +
          (inst.user ? '<button type="button" class="k-x" data-del="' + esc(id) + '" title="Remove">&times;</button>' : '') +
          '<button type="button" class="k-bbtn" data-b="' + esc(id) + '" title="' + (id === st.b ? 'Remove from layer B' : 'Load into layer B') + '">B</button></div>';
      }).join('') : '<div class="k-empty">' + (st.cat === 'user'
        ? 'Drag a WAV or MP3 onto this panel to turn it into a playable instrument.'
        : (Object.keys(ins).length ? 'No instruments in this category yet.' : 'Sample library not found.<br>Import your own sample below.')) + '</div>';
      var a = getInst(st.a);
      var cat = a ? instCat(a) : st.cat;
      R.panel.style.setProperty('--tint', CAT_TINT[cat] || '#e8b765');
      R.kicker.textContent = a ? (CAT_LABEL[cat] || cat) + (st.b && getInst(st.b) ? '  +  ' + (getInst(st.b).name || st.b) : '') : 'No instrument';
      R.name.textContent = a ? (a.name || st.a) : 'Choose an instrument';
      R.meta.textContent = a ? instMeta(a) : 'Pick one from the library on the left, choose a preset, or drop in your own sample.';
      R.rootEdit.hidden = !(a && a.user);
      if (a && a.user) {
        var rt = a.zones[0].root, cents = Math.round((rt - Math.round(rt)) * 100);
        R.rootV.textContent = noteName(rt);
        R.det.textContent = a.detected ? 'detected' + (cents ? ' (' + (cents > 0 ? '+' : '') + cents + ' ct)' : '') : 'not detected, set by ear';
      }
      R.lname.textContent = a ? a.name || st.a : '—';
      R.lmeta.textContent = a ? (CAT_LABEL[cat] || cat) + ' · ' + (a.zones || []).length + ((a.zones || []).length === 1 ? ' zone' : ' zones') + ' · release ' + fmtSec(relSec(0)) : 'Pick an instrument';
      R.bsel.innerHTML = optionsHtml(st.b);
      R.panel.classList.toggle('k-hasb', !!getInst(st.b));
      Array.prototype.forEach.call(R.oct.children, function (b) { b.classList.toggle('on', +b.dataset.o === st.bOct); });
      Array.prototype.forEach.call(R.emode.children, function (b) { b.classList.toggle('on', b.dataset.m === st.exprMode); });
      R.trv.textContent = (st.transpose > 0 ? '+' : '') + st.transpose;
      var pi = PRESETS.map(function (p) { return p.name; }).indexOf(st.preset);
      if (pi < 0) {
        if (!R.psel.querySelector('option[value="-1"]')) { var o = document.createElement('option'); o.value = -1; o.textContent = 'Custom'; o.disabled = true; R.psel.insertBefore(o, R.psel.firstChild); }
        R.psel.value = -1;
      } else {
        var c2 = R.psel.querySelector('option[value="-1"]'); if (c2) c2.remove();
        R.psel.value = pi;
      }
      syncKnobs(); drawArt(); dirty.keymap = dirty.status = true;
    }
    function syncKnobs() { knobs.forEach(function (k) { k.draw(); }); }
    function status() {
      var ids = [st.a, st.b].filter(Boolean), done = 0, total = 0;
      ids.forEach(function (id) { var p = progress[id]; if (p) { done += p.done; total += p.total; } });
      var busy = total && done < total;
      R.load.classList.toggle('on', !!busy);
      R.loadBar.style.width = total ? (100 * done / total).toFixed(1) + '%' : '0';
      if (busy) R.loadTxt.textContent = 'Loading samples ' + done + ' / ' + total;
      Array.prototype.forEach.call(R.list.children, function (row) {
        var p = progress[row.dataset.id]; if (!p) return;
        row.classList.toggle('k-busy', p.done < p.total); row.classList.toggle('k-ok', p.done >= p.total);
      });
      R.voices.textContent = voices.length + ' / ' + MAX_VOICES;
    }
    function setBusy(msg) {
      R.load.classList.toggle('on', !!msg);
      R.loadTxt.textContent = msg || '';
      R.loadBar.style.width = msg ? '35%' : '0';
    }
    var raf = 0, alive = true;
    function frame() {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      if (!root.isConnected || root.offsetParent === null) return;
      if (dirty.keymap) { dirty.keymap = false; drawMap(); }
      if (dirty.status) { dirty.status = false; status(); }
      R.ped.classList.toggle('on', sustain);
      R.mod.style.width = (modWheel * 100).toFixed(0) + '%';
      var pmax = globalPress; Object.keys(chPress).forEach(function (k) { pmax = Math.max(pmax, chPress[k]); });
      R.prs.style.width = (pmax * 100).toFixed(0) + '%';
    }
    raf = requestAnimationFrame(frame);
    if (window.ResizeObserver) new ResizeObserver(function () { drawArt(); dirty.keymap = true; }).observe(R.hero);
    var outer = { refresh: refresh, syncKnobs: syncKnobs, drawArt: drawArt, setBusy: setBusy, R: R };
    refresh();
    return outer;
  }

  /* =================================================================
   * plugin API
   * ================================================================= */
  var api = {
    id: 'keys', name: 'Keys', kind: 'instrument', color: '#f0c27a', icon: ICON,
    init: function (c, out, Studio) {
      S = Studio || window.Studio; ctx = c; outNode = out;
      nodes.layerBus = [ctx.createGain(), ctx.createGain()];
      nodes.mix = ctx.createGain();
      nodes.layerBus[0].connect(nodes.mix); nodes.layerBus[1].connect(nodes.mix);
      // stereo width matrix
      nodes.split = ctx.createChannelSplitter(2); nodes.merge = ctx.createChannelMerger(2);
      nodes.mix.connect(nodes.split);
      ['wLL', 'wLR', 'wRL', 'wRR'].forEach(function (k) { nodes[k] = ctx.createGain(); });
      nodes.split.connect(nodes.wLL, 0); nodes.split.connect(nodes.wRL, 0);
      nodes.split.connect(nodes.wRR, 1); nodes.split.connect(nodes.wLR, 1);
      nodes.wLL.connect(nodes.merge, 0, 0); nodes.wLR.connect(nodes.merge, 0, 0);
      nodes.wRR.connect(nodes.merge, 0, 1); nodes.wRL.connect(nodes.merge, 0, 1);
      nodes.post = ctx.createGain();
      nodes.merge.connect(nodes.post);
      nodes.dry = ctx.createGain(); nodes.post.connect(nodes.dry); nodes.dry.connect(out);
      nodes.revSend = ctx.createGain(); nodes.conv = ctx.createConvolver();
      nodes.conv.buffer = makeImpulse(ctx, 1.9);
      nodes.revRet = ctx.createGain(); nodes.revRet.gain.value = 0.55;
      nodes.post.connect(nodes.revSend); nodes.revSend.connect(nodes.conv); nodes.conv.connect(nodes.revRet); nodes.revRet.connect(out);
      // vibrato LFO (mod wheel)
      nodes.lfo = ctx.createOscillator(); nodes.lfo.frequency.value = 5.4;
      nodes.lfoGain = ctx.createGain(); nodes.lfoGain.gain.value = 0;
      nodes.lfo.connect(nodes.lfoGain); nodes.lfo.start();
      applyBus();
      var restore = S.storage && S.storage.get ? S.storage.get('keys.userInstruments').catch(function () { return null; }) : Promise.resolve(null);
      var ready = S.samples && S.samples.ready ? S.samples.ready() : Promise.resolve();
      return Promise.all([restore, ready]).then(function (r) {
        if (Array.isArray(r[0])) r[0].forEach(function (u) { if (!userInsts.some(function (x) { return x.id === u.id; })) userInsts.push(u); });
        if (!st.a) {
          var i = PRESETS.length ? 0 : -1;
          if (i >= 0 && resolveInst(PRESETS[0].a)) applyPreset(0);
          else { var any = Object.keys(instruments())[0]; if (any) { st.cat = instCat(getInst(any)); setLayer('a', any); } }
        } else { loadInstrument(st.a); if (st.b) loadInstrument(st.b); }
      });
    },
    mount: function (el) {
      el.classList.add('plug-keys');
      ui = buildUI(el);
    },
    noteOn: function (note, vel, time, info) {
      if (!ctx) return;
      info = info || {};
      if (vel <= 0) return api.noteOff(note, time, info);
      startVoice(0, note, vel, time, info);
      if (getInst(st.b)) startVoice(1, note, vel, time, info);
    },
    noteOff: function (note, time, info) {
      if (!ctx) return;
      info = info || {};
      for (var i = voices.length - 1; i >= 0; i--) {
        var v = voices[i];
        if (v.note !== note || v.released || v.keyUp) continue;
        if (info.mpe && v.mpe && v.ch !== info.ch) continue;
        if (sustain) { v.sustained = true; v.keyUp = true; } else releaseVoice(v, time);
      }
      dirty.keymap = true;
    },
    bend: function (semi, info) {
      if (!ctx) return;
      info = info || {};
      if (info.mpe) { chBend[info.ch] = semi; refreshDetune(info.ch); }
      else { globalBend = semi; refreshDetune(); }
    },
    pressure: function (val, info) {
      if (!ctx) return;
      info = info || {};
      if (info.poly && info.note != null) { notePress[info.note] = val; refreshFilters(); }
      else if (info.mpe) { chPress[info.ch] = val; refreshFilters(info.ch); }
      else { globalPress = val; refreshFilters(); }
    },
    cc: function (num, val, info) {
      if (!ctx) return;
      if (num === 64) {
        var on = val >= 0.5;
        if (on === sustain) return;
        sustain = on;
        if (!on) voices.slice().forEach(function (v) { if (v.sustained && !v.released) releaseVoice(v, ctx.currentTime); });
      } else if (num === 1) {
        modWheel = val;
        nodes.lfoGain.gain.setTargetAtTime(val * val * 38, ctx.currentTime, 0.05);
        refreshFilters();
      } else if (num === 11) {
        cc11 = val; applyBus();
      } else if (num === 120 || num === 123) {
        api.allNotesOff();
      }
    },
    allNotesOff: function () {
      if (!ctx) return;
      sustain = false;
      voices.slice().forEach(function (v) { fastKill(v); });
      chBend = {}; chPress = {}; notePress = {}; globalPress = 0;
    },
    getState: function () {
      return JSON.parse(JSON.stringify({
        v: 1, a: st.a, b: st.b, balance: st.balance, bOct: st.bOct, bSwell: st.bSwell, transpose: st.transpose,
        macros: st.macros, exprMode: st.exprMode, preset: st.preset, cat: st.cat, userInstruments: userInsts
      }));
    },
    setState: function (s) {
      if (!s || typeof s !== 'object') return;
      if (Array.isArray(s.userInstruments)) s.userInstruments.forEach(function (u) {
        var i = userInsts.map(function (x) { return x.id; }).indexOf(u.id);
        if (i >= 0) userInsts[i] = u; else userInsts.push(u);
      });
      st.macros = defaultMacros();
      Object.keys(s.macros || {}).forEach(function (k) { if (typeof s.macros[k] === 'number') st.macros[k] = s.macros[k]; });
      ['balance', 'bOct', 'bSwell', 'transpose'].forEach(function (k) { if (typeof s[k] === 'number') st[k] = s[k]; });
      if (s.exprMode) st.exprMode = s.exprMode;
      st.preset = s.preset || null;
      if (s.cat) st.cat = s.cat;
      st.a = null; st.b = null;
      if (s.a && getInst(s.a)) setLayer('a', s.a);
      if (s.b && getInst(s.b)) setLayer('b', s.b);
      if (ctx) { refreshFilters(); refreshDetune(); applyBus(); }
      if (ui) ui.refresh();
    },
    _debug: {
      detectPitch: detectPitch, voices: function () { return voices; }, state: function () { return st; },
      progress: function () { return progress; }, presets: PRESETS, loadInstrument: loadInstrument, importFile: importFile,
      nodes: function () { return nodes; }
    }
  };

  if (window.Studio && window.Studio.registerPlugin) window.Studio.registerPlugin(api);
  else console.error('[keys] Studio not found');
})();
