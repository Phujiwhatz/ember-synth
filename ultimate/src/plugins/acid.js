/* Ember Ultimate - Acid: TB-303-style monophonic bass synth + 16-step sequencer.
 * Plugin id 'acid'. Plain script, registers via Studio.registerPlugin. Offline-safe:
 * the ladder filter AudioWorklet is inlined as a Blob URL module (falls back to two
 * cascaded BiquadFilters if worklets are unavailable). CSS lives in acid.css (.plug-acid).
 */
(function () {
  'use strict';

  var COLOR = '#c6f432';
  var BASE_NOTE = 36;            // C2: step pitch 0, octave 0, transpose 0
  var NUM_BANKS = 8;
  var BANK_NAMES = 'ABCDEFGH';
  var MAX_LEN = 32;
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

  var SCALES = {
    'Minor':          [0, 2, 3, 5, 7, 8, 10],
    'Phrygian':       [0, 1, 3, 5, 7, 8, 10],
    'Dorian':         [0, 2, 3, 5, 7, 9, 10],
    'Minor Pent.':    [0, 3, 5, 7, 10],
    'Blues':          [0, 3, 5, 6, 7, 10],
    'Harmonic Min.':  [0, 2, 3, 5, 7, 8, 11],
    'Phrygian Dom.':  [0, 1, 4, 5, 7, 8, 10],
    'Major':          [0, 2, 4, 5, 7, 9, 11],
    'Chromatic':      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  };

  /* ------------------------------------------------------------------ worklet */
  var WORKLET_NAME = 'ember-acid-ladder-1';
  var WORKLET_SRC = [
    'var T=function(x){if(x>3)return 1;if(x<-3)return -1;var x2=x*x;return x*(27+x2)/(27+9*x2);};',
    'class AcidLadder extends AudioWorkletProcessor{',
    ' static get parameterDescriptors(){return[',
    '  {name:"cutoff",defaultValue:500,minValue:10,maxValue:22000,automationRate:"a-rate"},',
    '  {name:"mod",defaultValue:0,minValue:-12,maxValue:12,automationRate:"a-rate"},',
    '  {name:"res",defaultValue:0.6,minValue:0,maxValue:1.1,automationRate:"k-rate"},',
    '  {name:"drive",defaultValue:1.6,minValue:0.1,maxValue:8,automationRate:"k-rate"}];}',
    ' constructor(){super();this.s1=0;this.s2=0;this.s3=0;this.s4=0;this.hp=0;this.prev=0;}',
    ' process(ins,outs,p){',
    '  var o=outs[0]&&outs[0][0];if(!o)return true;var inp=ins[0]&&ins[0][0];',
    '  var N=o.length,sr2=sampleRate*2,w=2*Math.PI/sr2,fmax=sr2*0.23;',
    '  var cut=p.cutoff,mod=p.mod,cl=cut.length>1,ml=mod.length>1;',
    '  var k=p.res[0]*4.15,dr=p.drive[0],comp=(1+k*0.42)/Math.sqrt(dr);',
    '  var s1=this.s1,s2=this.s2,s3=this.s3,s4=this.s4,hp=this.hp,prev=this.prev,hc=w*90;',
    '  for(var i=0;i<N;i++){',
    '   var x=inp?inp[i]:0;',
    '   var fc=cut[cl?i:0]*Math.pow(2,mod[ml?i:0]);if(fc<8)fc=8;else if(fc>fmax)fc=fmax;',
    '   var g=1-Math.exp(-w*fc);',
    '   for(var os=0;os<2;os++){',
    '    var xi=os?x:(prev+x)*0.5;',
    '    hp+=hc*(s4-hp);',                        // diode-ish: highpassed feedback thins bass at high res
    '    var u=T(xi*dr-k*(s4-hp*0.85));',
    '    var t1=T(s1),t2=T(s2),t3=T(s3);',
    '    s1+=g*(u-t1);s2+=g*(t1-t2);s3+=g*(t2-t3);s4+=g*(t3-T(s4));',
    '   }',
    '   prev=x;o[i]=s4*comp;',
    '  }',
    '  if(!(s4===s4)||Math.abs(s4)>1e3){s1=s2=s3=s4=hp=0;}',
    '  this.s1=s1;this.s2=s2;this.s3=s3;this.s4=s4;this.hp=hp;this.prev=prev;',
    '  for(var c=1;c<outs[0].length;c++)outs[0][c].set(o);',
    '  return true;}}',
    'try{registerProcessor("' + WORKLET_NAME + '",AcidLadder);}catch(e){}'
  ].join('\n');

  var workletLoaded = new WeakMap();
  function loadWorklet(ctx) {
    if (window.__ACID_NO_WORKLET) return Promise.reject(new Error('forced fallback'));
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('no audioWorklet'));
    if (workletLoaded.has(ctx)) return workletLoaded.get(ctx);
    var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    var p = ctx.audioWorklet.addModule(url);
    workletLoaded.set(ctx, p);
    return p;
  }

  /* ------------------------------------------------------------------ helpers */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function holdAt(param, t) {
    if (param.cancelAndHoldAtTime) { try { param.cancelAndHoldAtTime(t); return; } catch (e) { /* fallthrough */ } }
    param.cancelScheduledValues(t);
  }
  function mkStep(n, o, a, s, g) { return { n: n || 0, o: o || 0, a: !!a, s: !!s, g: g !== false }; }
  function emptyPattern() {
    var st = []; for (var i = 0; i < MAX_LEN; i++) st.push(mkStep(0, 0, false, false, false));
    return { len: 16, steps: st };
  }
  function clonePattern(p) {
    return { len: p.len, steps: p.steps.map(function (s) { return mkStep(s.n, s.o, s.a, s.s, s.g); }) };
  }
  function rng(seed) {
    var s = seed >>> 0 || 1;
    return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }

  // Generate an acid line in a scale. density 0..1 = fraction of gated steps.
  function generateLine(scaleName, density, len, rand) {
    rand = rand || Math.random;
    var sc = SCALES[scaleName] || SCALES.Minor;
    var p = emptyPattern(); p.len = len;
    var last = 0;
    for (var i = 0; i < MAX_LEN; i++) {
      var s = p.steps[i];
      var downbeat = (i % 4 === 0);
      s.g = rand() < (downbeat ? Math.min(1, density + 0.25) : density);
      var r = rand(), deg;
      if (r < 0.35) deg = 0;                                   // root-heavy
      else if (r < 0.6) deg = sc[Math.floor(rand() * sc.length)];
      else { // step-wise motion from last note
        var idx = sc.indexOf(last % 12); if (idx < 0) idx = 0;
        idx = clamp(idx + (rand() < 0.5 ? -1 : 1), 0, sc.length - 1);
        deg = sc[idx];
      }
      if (rand() < 0.08) deg = 12;                             // octave root
      s.n = deg; last = deg;
      var ro = rand();
      s.o = ro < 0.2 ? 1 : (ro < 0.28 ? -1 : 0);
      s.a = rand() < 0.28;
      s.s = rand() < 0.2;
    }
    return p;
  }

  function defaultPatterns() {
    var pats = [];
    // A: classic squelchy line
    var A = emptyPattern();
    var a = [[0,0,1,0,1],[0,0,0,0,1],[12,0,0,1,1],[0,0,0,0,1],[3,0,1,0,1],[0,0,0,0,0],[7,0,0,1,1],[10,0,0,0,1],
             [0,0,1,0,1],[0,0,0,0,1],[0,1,0,1,1],[3,0,0,0,1],[5,0,1,1,1],[3,0,0,0,1],[0,-1,0,0,1],[7,0,1,0,1]];
    a.forEach(function (v, i) { A.steps[i] = mkStep(v[0], v[1], v[2], v[3], v[4]); });
    pats.push(A);
    // B: rolling phrygian
    var B = emptyPattern();
    var b = [[0,0,1,0,1],[0,0,0,1,1],[1,0,0,0,1],[0,0,0,0,1],[0,1,1,0,1],[0,0,0,0,1],[8,0,0,1,1],[7,0,0,0,1],
             [0,0,1,0,1],[0,0,0,1,1],[1,0,0,0,1],[0,0,0,0,0],[10,0,1,1,1],[8,0,0,1,1],[7,0,0,0,1],[0,1,1,0,1]];
    b.forEach(function (v, i) { B.steps[i] = mkStep(v[0], v[1], v[2], v[3], v[4]); });
    pats.push(B);
    var names = ['Minor', 'Phrygian', 'Dorian', 'Minor Pent.', 'Blues', 'Harmonic Min.'];
    for (var i = 2; i < NUM_BANKS; i++) pats.push(generateLine(names[i - 2], 0.7, 16, rng(1234 + i * 77)));
    return pats;
  }

  var PARAMS = [
    { id: 'cutoff', label: 'Cutoff', def: 0.42 },
    { id: 'res', label: 'Resonance', def: 0.72 },
    { id: 'envmod', label: 'Env Mod', def: 0.55 },
    { id: 'decay', label: 'Decay', def: 0.38 },
    { id: 'accent', label: 'Accent', def: 0.6 },
    { id: 'drive', label: 'Drive', def: 0.25 },
    { id: 'tune', label: 'Tune', def: 0.5, bipolar: true },
    { id: 'volume', label: 'Volume', def: 0.72 }
  ];
  function fmtParam(id, v) {
    switch (id) {
      case 'cutoff': var hz = cutoffHz(v); return hz >= 1000 ? (hz / 1000).toFixed(2) + ' kHz' : Math.round(hz) + ' Hz';
      case 'envmod': return (v * 5.5).toFixed(1) + ' oct';
      case 'decay': return Math.round(decayTau(v) * 1000) + ' ms';
      case 'tune': var c = (v - 0.5) * 24; return (c >= 0 ? '+' : '') + c.toFixed(1) + ' st';
      default: return Math.round(v * 100) + '%';
    }
  }
  function cutoffHz(v) { return 35 * Math.pow(2, v * 7.5); }
  function decayTau(v) { return 0.04 * Math.pow(2, v * 5); }

  /* ------------------------------------------------------------------ plugin state */
  var S = {
    p: {},                       // knob values 0..1
    wave: 'saw', sub: false,
    bank: 0, cue: -1,
    patterns: defaultPatterns(),
    run: true, keyTranspose: false, transpose: 0,
    scale: 'Minor', density: 0.7,
    sel: 0
  };
  PARAMS.forEach(function (d) { S.p[d.id] = d.def; });

  var E = null;                  // audio engine
  var ui = null;                 // UI refs
  var clipboard = null;
  var seq = { pos: 0, tied: false, lastNote: null, playing: false };
  var live = { stack: [], ch: 0, bend: 0, pressure: 0, mod: 0 };
  var acc = { peak: 0, t: -10 };
  var uiQueue = [];
  var debugLog = [];

  /* ------------------------------------------------------------------ engine */
  function buildEngine(ctx, out, useWorklet) {
    var e = { ctx: ctx, worklet: !!useWorklet };
    function cs(v) { var c = ctx.createConstantSource(); c.offset.value = v; c.start(); return c; }

    e.pitch = cs(mtof(BASE_NOTE));         // Hz
    e.detune = cs(0);                        // cents (tune + bend)
    e.osc = ctx.createOscillator(); e.osc.type = 'sawtooth'; e.osc.frequency.value = 0;
    e.sub = ctx.createOscillator(); e.sub.type = 'square'; e.sub.frequency.value = 0;
    e.pitch.connect(e.osc.frequency);
    var half = ctx.createGain(); half.gain.value = 0.5; e.pitch.connect(half); half.connect(e.sub.frequency);
    e.detune.connect(e.osc.detune); e.detune.connect(e.sub.detune);
    e.oscGain = ctx.createGain(); e.oscGain.gain.value = 0.55;
    e.subGain = ctx.createGain(); e.subGain.gain.value = 0;
    e.osc.connect(e.oscGain); e.sub.connect(e.subGain);
    e.mix = ctx.createGain();
    e.oscGain.connect(e.mix); e.subGain.connect(e.mix);

    // modulation sum in octaves -> filter
    e.env = cs(0); e.envAmt = ctx.createGain(); e.env.connect(e.envAmt);
    e.acc = cs(0); e.accAmt = ctx.createGain(); e.acc.connect(e.accAmt);
    e.press = cs(0);
    e.modSum = ctx.createGain(); e.modSum.gain.value = 1;
    e.envAmt.connect(e.modSum); e.accAmt.connect(e.modSum); e.press.connect(e.modSum);

    if (useWorklet) {
      e.filter = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1,
        outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
      e.fCut = e.filter.parameters.get('cutoff');
      e.fRes = e.filter.parameters.get('res');
      e.fMod = e.filter.parameters.get('mod');
      e.modSum.connect(e.fMod);
      e.mix.connect(e.filter);
      e.filterOut = e.filter;
    } else {
      e.bq1 = ctx.createBiquadFilter(); e.bq2 = ctx.createBiquadFilter();
      e.bq1.type = e.bq2.type = 'lowpass'; e.bq1.Q.value = 0.5;
      var cents = ctx.createGain(); cents.gain.value = 1200;
      e.modSum.connect(cents); cents.connect(e.bq1.detune); cents.connect(e.bq2.detune);
      e.bqSat = ctx.createWaveShaper(); e.bqSat.curve = satCurve(1.5); e.bqSat.oversample = '2x';
      e.mix.connect(e.bqSat); e.bqSat.connect(e.bq1); e.bq1.connect(e.bq2);
      e.fCut = { setTargetAtTime: function (v, t, k) { e.bq1.frequency.setTargetAtTime(v, t, k); e.bq2.frequency.setTargetAtTime(v, t, k); } };
      e.filterOut = e.bq2;
    }

    e.vca = ctx.createGain(); e.vca.gain.value = 0;
    e.driveIn = ctx.createGain();
    e.shaper = ctx.createWaveShaper(); e.shaper.oversample = '4x';
    e.driveOut = ctx.createGain();
    e.vol = ctx.createGain();
    e.filterOut.connect(e.vca); e.vca.connect(e.driveIn); e.driveIn.connect(e.shaper);
    e.shaper.connect(e.driveOut); e.driveOut.connect(e.vol); e.vol.connect(out);
    e.osc.start(); e.sub.start();
    return e;
  }

  function satCurve(k) {
    var n = 2048, c = new Float32Array(n), nk = Math.tanh(k);
    for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / nk; }
    return c;
  }
  function driveCurve(d) {
    // asymmetric-ish soft clip that gets harder with drive
    var n = 4096, c = new Float32Array(n), k = 1 + d * 24;
    for (var i = 0; i < n; i++) {
      var x = i / (n - 1) * 2 - 1;
      var y = Math.tanh(k * (x + 0.08 * d * x * x)) / Math.tanh(k);
      c[i] = y;
    }
    return c;
  }

  function applyParams(now) {
    if (!E) return;
    var t = now == null ? E.ctx.currentTime : now, p = S.p;
    E.fCut.setTargetAtTime(cutoffHz(p.cutoff), t, 0.012);
    if (E.worklet) E.fRes.setTargetAtTime(p.res, t, 0.02);
    else {
      E.bq2.Q.setTargetAtTime(0.7 + p.res * p.res * 22, t, 0.02);
      E.bq1.Q.setTargetAtTime(0.5 + p.res * 4, t, 0.02);
    }
    E.envAmt.gain.setTargetAtTime(p.envmod * 5.5, t, 0.02);
    E.accAmt.gain.setTargetAtTime(p.accent * 2.6, t, 0.02);
    applyDetune(t);
    E.vol.gain.setTargetAtTime(p.volume * p.volume * 1.05, t, 0.02);
    applyDrive();
    E.osc.type = S.wave === 'square' ? 'square' : 'sawtooth';
    E.oscGain.gain.setTargetAtTime(S.wave === 'square' ? 0.42 : 0.55, t, 0.01);
    E.subGain.gain.setTargetAtTime(S.sub ? 0.38 : 0, t, 0.01);
  }
  var lastDrive = -1;
  function applyDrive() {
    var d = S.p.drive;
    if (Math.abs(d - lastDrive) < 0.004) return;
    lastDrive = d;
    E.shaper.curve = driveCurve(d);
    E.driveIn.gain.value = 0.6 + d * 1.6;
    E.driveOut.gain.value = 1 / (1 + d * 1.1);
  }
  function applyDetune(t) {
    if (!E) return;
    var cents = (S.p.tune - 0.5) * 2400 + live.bend * 100;
    E.detune.offset.setTargetAtTime(cents, t == null ? E.ctx.currentTime : t, 0.006);
  }
  function applyPressure() {
    if (!E) return;
    var v = Math.max(live.pressure, 0) * 3 + live.mod * 3;
    E.press.offset.setTargetAtTime(v, E.ctx.currentTime, 0.03);
  }

  /* --- voice: trigger / glide / gate ------------------------------------- */
  function voiceTrigger(note, t, accent, vel) {
    var f = mtof(note);
    var pf = E.pitch.offset;
    holdAt(pf, t); pf.setValueAtTime(f, t);
    // filter envelope (accent forces the shortest decay, like the 303)
    var tau = accent ? decayTau(0) * 1.3 : decayTau(S.p.decay);
    var ev = E.env.offset;
    holdAt(ev, t); ev.setValueAtTime(1, t); ev.setTargetAtTime(0, t + 0.002, tau);
    // VCA: fast attack, long fixed decay until gate off
    var lvl = (0.55 + 0.25 * (vel == null ? 0.8 : vel)) * (accent ? 1 + S.p.accent * 0.75 : 1);
    var g = E.vca.gain;
    holdAt(g, t); g.setTargetAtTime(lvl, t, 0.0015); g.setTargetAtTime(lvl * 0.05, t + 0.008, accent ? 0.9 : 1.6);
    if (accent) accentSweep(t);
  }
  function voiceGlide(note, t, accent) {
    var pf = E.pitch.offset;
    holdAt(pf, t); pf.setTargetAtTime(mtof(note), t, 0.022);   // ~60ms RC slide
    if (accent) {
      var g = E.vca.gain, lvl = 0.75 * (1 + S.p.accent * 0.75);
      holdAt(g, t); g.setTargetAtTime(lvl, t, 0.01); g.setTargetAtTime(lvl * 0.05, t + 0.02, 0.9);
      accentSweep(t);
    }
  }
  // 303 accent sweep: accents go through a cap; quickly repeated accents stack up.
  function accentSweep(t) {
    var carry = acc.peak * Math.exp(-Math.max(0, t - acc.t) / 0.2);
    var peak = Math.min(1.75, 1 + carry * 0.6);
    var a = E.acc.offset;
    holdAt(a, t); a.setTargetAtTime(peak, t, 0.014); a.setTargetAtTime(0, t + 0.045, 0.11);
    acc.peak = peak; acc.t = t;
  }
  function voiceGateOff(t) {
    var g = E.vca.gain;
    holdAt(g, t); g.setTargetAtTime(0, t, 0.007);
  }

  /* --- sequencer ------------------------------------------------------- */
  function stepNote(st) { return clamp(BASE_NOTE + S.transpose + st.n + st.o * 12, 12, 108); }

  function onStep(step16, time) {
    if (!E || !S.run) return;
    var bpm = (Studio.transport && Studio.transport.bpm) || 120;
    var six = 60 / bpm / 4;
    if (seq.pos === 0 && S.cue >= 0) { S.bank = S.cue; S.cue = -1; if (ui) ui.needsRender = true; }
    var pat = S.patterns[S.bank];
    var len = clamp(pat.len, 1, MAX_LEN);
    if (seq.pos >= len) seq.pos = 0;
    var i = seq.pos, st = pat.steps[i], next = pat.steps[(i + 1) % len];
    uiQueue.push({ t: time, pos: i, bank: S.bank });
    if (st.g) {
      var note = stepNote(st);
      var glided = seq.tied;
      if (glided) voiceGlide(note, time, st.a); else voiceTrigger(note, time, st.a, 0.8);
      seq.tied = st.s && next.g;
      if (!seq.tied) voiceGateOff(time + six * (st.s ? 0.98 : 0.52));
      debugLog.push({ step16: step16, pos: i, time: time, note: note, slide: st.s, glided: glided, acc: st.a });
      if (debugLog.length > 512) debugLog.shift();
    } else {
      if (seq.tied) voiceGateOff(time);
      seq.tied = false;
    }
    seq.pos = (i + 1) % len;
  }

  function onStart() { seq.pos = 0; seq.tied = false; seq.playing = true; uiQueue.length = 0; }
  function onStop() {
    seq.playing = false; seq.tied = false; uiQueue.length = 0;
    if (E && !live.stack.length) voiceGateOff(E.ctx.currentTime);
    if (ui) { ui.playPos = -1; ui.updateLeds(); }
  }

  /* ------------------------------------------------------------------ plugin def */
  var def = {
    id: 'acid', name: 'Acid', kind: 'instrument', color: COLOR,
    icon: '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8"/><circle cx="7.2" cy="8" r="1" fill="currentColor"/><circle cx="12.8" cy="8" r="1" fill="currentColor"/><path d="M6 11.5c1.2 2 6.8 2 8 0"/></svg>',

    init: function (ctx, out, Studio) {
      var self = this;
      return loadWorklet(ctx).then(function () { return true; }, function (err) {
        console.warn('[acid] ladder worklet unavailable, using biquad fallback:', err && err.message);
        return false;
      }).then(function (ok) {
        try { E = buildEngine(ctx, out, ok); }
        catch (err) { console.warn('[acid] worklet node failed, fallback:', err && err.message); E = buildEngine(ctx, out, false); }
        lastDrive = -1;
        applyParams(ctx.currentTime);
        var tr = Studio && Studio.transport;
        if (tr && tr.on) {
          tr.on('step', onStep);
          tr.on('start', onStart);
          tr.on('stop', onStop);
        }
        self.engineType = E.worklet ? 'ladder' : 'biquad';
      });
    },

    mount: function (el) { buildUI(el); },

    noteOn: function (note, vel, time, info) {
      if (!E) return;
      var tr = Studio.transport;
      if (S.keyTranspose && tr && tr.playing && S.run) {
        S.transpose = clamp(note - 60, -24, 24);
        if (ui) ui.renderTranspose();
        return;
      }
      var t = Math.max(time || 0, E.ctx.currentTime);
      info = info || {};
      live.ch = info.ch || 0;
      var legato = live.stack.length > 0;
      live.stack = live.stack.filter(function (n) { return n !== note; });
      live.stack.push(note);
      var accent = vel > 0.82;
      if (legato) voiceGlide(note, t, false); else voiceTrigger(note, t, accent, vel);
    },
    noteOff: function (note, time) {
      if (!E) return;
      var idx = live.stack.indexOf(note);
      if (idx < 0) return;
      var wasTop = idx === live.stack.length - 1;
      live.stack.splice(idx, 1);
      var t = Math.max(time || 0, E.ctx.currentTime);
      if (!live.stack.length) voiceGateOff(t);
      else if (wasTop) voiceGlide(live.stack[live.stack.length - 1], t, false);   // last-note priority
    },
    bend: function (semis, info) {
      info = info || {};
      if (info.mpe && info.ch !== live.ch) return;      // only the sounding MPE note bends
      live.bend = semis || 0; applyDetune();
    },
    pressure: function (v, info) {
      info = info || {};
      if (info.mpe && info.ch !== live.ch) return;
      live.pressure = clamp(v || 0, 0, 1); applyPressure();
    },
    cc: function (num, v) {
      if (num === 1) { live.mod = clamp(v, 0, 1); applyPressure(); }
      else if (num === 123 || num === 120) def.allNotesOff();
    },
    allNotesOff: function () {
      live.stack = []; seq.tied = false;
      if (E) voiceGateOff(E.ctx.currentTime);
    },

    getState: function () {
      return {
        v: 1, p: Object.assign({}, S.p), wave: S.wave, sub: S.sub, bank: S.bank,
        run: S.run, keyTranspose: S.keyTranspose, transpose: S.transpose,
        scale: S.scale, density: S.density,
        patterns: S.patterns.map(function (p) {
          return { len: p.len, steps: p.steps.map(function (s) { return [s.n, s.o, s.a ? 1 : 0, s.s ? 1 : 0, s.g ? 1 : 0]; }) };
        })
      };
    },
    setState: function (st) {
      if (!st || typeof st !== 'object') return;
      if (st.p) PARAMS.forEach(function (d) { if (typeof st.p[d.id] === 'number') S.p[d.id] = clamp(st.p[d.id], 0, 1); });
      if (st.wave === 'saw' || st.wave === 'square') S.wave = st.wave;
      if (typeof st.sub === 'boolean') S.sub = st.sub;
      if (typeof st.run === 'boolean') S.run = st.run;
      if (typeof st.keyTranspose === 'boolean') S.keyTranspose = st.keyTranspose;
      if (typeof st.transpose === 'number') S.transpose = clamp(Math.round(st.transpose), -24, 24);
      if (SCALES[st.scale]) S.scale = st.scale;
      if (typeof st.density === 'number') S.density = clamp(st.density, 0, 1);
      if (Array.isArray(st.patterns)) {
        S.patterns = st.patterns.slice(0, NUM_BANKS).map(function (p) {
          var np = emptyPattern(); np.len = clamp(p.len | 0 || 16, 1, MAX_LEN);
          (p.steps || []).slice(0, MAX_LEN).forEach(function (s, i) {
            np.steps[i] = Array.isArray(s) ? mkStep(clamp(s[0] | 0, 0, 12), clamp(s[1] | 0, -1, 1), s[2], s[3], !!s[4])
                                           : mkStep(s.n, s.o, s.a, s.s, s.g);
          });
          return np;
        });
        while (S.patterns.length < NUM_BANKS) S.patterns.push(emptyPattern());
      }
      if (typeof st.bank === 'number') S.bank = clamp(st.bank | 0, 0, NUM_BANKS - 1);
      S.cue = -1; S.sel = 0;
      lastDrive = -1; applyParams();
      if (ui) ui.renderAll();
    },

    // test / debug hooks (not part of the contract)
    _debug: { log: debugLog, state: S, seq: seq, engine: function () { return E; },
              generateLine: generateLine, SCALES: SCALES }
  };

  /* ------------------------------------------------------------------ UI */
  function h(tag, cls, attrs, kids) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (attrs) for (var k in attrs) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function btn(cls, text, title) {
    var b = h('button', 'ac-btn ' + (cls || ''), { type: 'button', text: text });
    if (title) b.title = title;
    return b;
  }

  function makeKnob(d) {
    var wrap = h('div', 'ac-knob' + (d.bipolar ? ' bip' : ''));
    var dial = h('div', 'ac-dial', { role: 'slider', tabindex: '0', 'aria-label': d.label, 'aria-valuemin': '0', 'aria-valuemax': '100' });
    var ring = h('div', 'ac-ring');
    var cap = h('div', 'ac-cap', null, [h('div', 'ac-ptr')]);
    dial.appendChild(ring); dial.appendChild(cap);
    var lab = h('div', 'ac-klabel', { text: d.label });
    var val = h('div', 'ac-kval');
    wrap.appendChild(dial); wrap.appendChild(lab); wrap.appendChild(val);
    function show() {
      var v = S.p[d.id];
      wrap.style.setProperty('--v', v);
      dial.setAttribute('aria-valuenow', Math.round(v * 100));
      dial.setAttribute('aria-valuetext', fmtParam(d.id, v));
      val.textContent = fmtParam(d.id, v);
    }
    function set(v) { S.p[d.id] = clamp(v, 0, 1); show(); applyParams(); }
    var drag = null;
    dial.addEventListener('pointerdown', function (ev) {
      ev.preventDefault(); dial.setPointerCapture(ev.pointerId); dial.focus();
      drag = { y: ev.clientY, v: S.p[d.id] }; wrap.classList.add('drag');
    });
    dial.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var sens = ev.shiftKey ? 0.0012 : 0.005;
      set(drag.v + (drag.y - ev.clientY) * sens);
    });
    function end() { drag = null; wrap.classList.remove('drag'); }
    dial.addEventListener('pointerup', end); dial.addEventListener('pointercancel', end);
    dial.addEventListener('dblclick', function () { set(d.def); });
    dial.addEventListener('wheel', function (ev) { ev.preventDefault(); set(S.p[d.id] - Math.sign(ev.deltaY) * 0.02); }, { passive: false });
    dial.addEventListener('keydown', function (ev) {
      var st = ev.shiftKey ? 0.1 : 0.01;
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') { set(S.p[d.id] + st); ev.preventDefault(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') { set(S.p[d.id] - st); ev.preventDefault(); }
      ev.stopPropagation();
    });
    show();
    return { el: wrap, show: show };
  }

  function buildUI(root) {
    root.innerHTML = '';
    root.classList.add('plug-acid');
    var U = ui = { root: root, playPos: -1, needsRender: false };

    /* ---- silver synth panel ---- */
    var panel = h('div', 'ac-panel');
    var screws = ['tl', 'tr', 'bl', 'br'].map(function (p) { return h('i', 'ac-screw ' + p); });
    screws.forEach(function (s) { panel.appendChild(s); });

    var head = h('div', 'ac-head');
    var brand = h('div', 'ac-brand', null, [
      h('div', 'ac-logo', { html: 'ACID<span>·303</span>' }),
      h('div', 'ac-tag', { text: 'Computer Controlled Bass Line' })
    ]);
    var waveSw = h('div', 'ac-seg', { role: 'group', 'aria-label': 'Waveform' });
    var bSaw = btn('seg', '', 'Sawtooth'); bSaw.innerHTML = '<svg viewBox="0 0 28 14" width="28" height="14"><path d="M2 12 L13 2 L13 12 L24 2 L24 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    var bSqr = btn('seg', '', 'Square'); bSqr.innerHTML = '<svg viewBox="0 0 28 14" width="28" height="14"><path d="M2 12 L2 2 L10 2 L10 12 L18 12 L18 2 L26 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
    waveSw.appendChild(bSaw); waveSw.appendChild(bSqr);
    var bSub = btn('ac-tog', 'SUB', 'Sub oscillator (one octave down)');
    var engine = h('div', 'ac-engine', { text: E && E.worklet ? 'DIODE LADDER' : 'BIQUAD (FALLBACK)' });
    var headR = h('div', 'ac-headr', null, [
      h('div', 'ac-ctlgrp', null, [h('div', 'ac-mini', { text: 'Waveform' }), waveSw]),
      h('div', 'ac-ctlgrp', null, [h('div', 'ac-mini', { text: 'Sub Osc' }), bSub]),
      h('div', 'ac-ctlgrp', null, [h('div', 'ac-mini', { text: 'Filter' }), engine])
    ]);
    head.appendChild(brand); head.appendChild(headR);
    panel.appendChild(head);

    var knobRow = h('div', 'ac-knobs');
    U.knobs = PARAMS.map(function (d) { var k = makeKnob(d); knobRow.appendChild(k.el); return k; });
    panel.appendChild(knobRow);
    root.appendChild(panel);

    /* ---- black sequencer section ---- */
    var seqEl = h('div', 'ac-seq');
    var bar = h('div', 'ac-bar');
    var banks = h('div', 'ac-banks', { role: 'group', 'aria-label': 'Pattern bank' });
    U.bankBtns = [];
    for (var b = 0; b < NUM_BANKS; b++) {
      var bb = btn('ac-bank', BANK_NAMES[b], 'Pattern ' + BANK_NAMES[b] + ' (cued to next bar while playing)');
      bb.dataset.bank = b; banks.appendChild(bb); U.bankBtns.push(bb);
    }
    var lenDn = btn('sm', '−', 'Shorter'), lenUp = btn('sm', '+', 'Longer');
    U.lenVal = h('div', 'ac-lcd', { text: '16' });
    var lenGrp = h('div', 'ac-grp', null, [h('div', 'ac-mini', { text: 'Length' }), h('div', 'ac-row', null, [lenDn, U.lenVal, lenUp])]);
    var bRun = btn('ac-tog run', 'RUN', 'Sequencer plays with the transport');
    var bKT = btn('ac-tog', 'KEY TRANSP', 'When armed and running, play a key to transpose the line (C4 = 0)');
    U.trVal = h('div', 'ac-lcd', { text: '+0' });
    var trDn = btn('sm', '−', 'Transpose down'), trUp = btn('sm', '+', 'Transpose up');
    var trGrp = h('div', 'ac-grp', null, [h('div', 'ac-mini', { text: 'Transpose' }), h('div', 'ac-row', null, [bKT, trDn, U.trVal, trUp])]);
    var bShL = btn('sm', '◀', 'Shift pattern left'), bShR = btn('sm', '▶', 'Shift pattern right');
    var bCopy = btn('', 'COPY'), bPaste = btn('', 'PASTE'), bClear = btn('', 'CLEAR');
    var editGrp = h('div', 'ac-grp', null, [h('div', 'ac-mini', { text: 'Pattern' }), h('div', 'ac-row', null, [bShL, bShR, bCopy, bPaste, bClear])]);
    bar.appendChild(h('div', 'ac-grp', null, [h('div', 'ac-mini', { text: 'Bank' }), banks]));
    bar.appendChild(lenGrp);
    bar.appendChild(h('div', 'ac-grp', null, [h('div', 'ac-mini', { text: 'Seq' }), bRun]));
    bar.appendChild(trGrp);
    bar.appendChild(editGrp);

    var scaleSel = h('select', 'ac-sel', { 'aria-label': 'Scale' });
    Object.keys(SCALES).forEach(function (n) { scaleSel.appendChild(h('option', null, { value: n, text: n })); });
    var dens = h('input', 'ac-range', { type: 'range', min: '0', max: '100', 'aria-label': 'Density' });
    U.densVal = h('span', 'ac-dv');
    var bGen = btn('ac-gen', 'GENERATE', 'Generate an acid line into the current pattern (scale + density)');
    var genGrp = h('div', 'ac-grp gen', null, [h('div', 'ac-mini', { text: 'Acid Line Generator' }),
      h('div', 'ac-row', null, [scaleSel, h('label', 'ac-dens', null, [h('span', null, { text: 'Density' }), dens, U.densVal]), bGen])]);
    seqEl.appendChild(bar);

    // grid
    var grid = h('div', 'ac-grid');
    seqEl.appendChild(grid);
    U.grid = grid;

    // step-edit keyboard
    var edit = h('div', 'ac-edit');
    U.selLab = h('div', 'ac-sellab');
    var kb = h('div', 'ac-kb');
    U.kbKeys = [];
    var whiteIdx = 0;
    for (var n = 0; n <= 12; n++) {
      var isB = BLACK[n % 12];
      var key = h('div', 'ac-key ' + (isB ? 'blk' : 'wht'), { 'data-n': n, title: NOTE_NAMES[n % 12] + (n === 12 ? ' (octave)' : '') });
      if (isB) key.style.left = 'calc(' + whiteIdx + ' * var(--kw) - var(--bw) / 2)';
      else { key.appendChild(h('span', null, { text: NOTE_NAMES[n % 12] })); whiteIdx++; }
      kb.appendChild(key); U.kbKeys.push(key);
    }
    var selBtns = {
      dn: btn('ac-tog sm2', 'DOWN'), up: btn('ac-tog sm2', 'UP'),
      a: btn('ac-tog sm2 acc', 'ACCENT'), s: btn('ac-tog sm2', 'SLIDE'), g: btn('ac-tog sm2', 'GATE')
    };
    var prevS = btn('sm', '◀', 'Previous step'), nextS = btn('sm', '▶', 'Next step');
    edit.appendChild(h('div', 'ac-editl', null, [h('div', 'ac-mini', { text: 'Step Write' }), h('div', 'ac-row', null, [prevS, U.selLab, nextS])]));
    edit.appendChild(kb);
    edit.appendChild(h('div', 'ac-editr', null, [selBtns.up, selBtns.dn, selBtns.a, selBtns.s, selBtns.g]));
    edit.appendChild(genGrp);
    seqEl.appendChild(edit);
    root.appendChild(seqEl);

    /* ---- rendering ---- */
    function pat() { return S.patterns[S.bank]; }
    function cols() { return pat().len > 16 ? 32 : 16; }

    U.renderGrid = function () {
      var P = pat(), C = cols();
      grid.innerHTML = '';
      grid.style.setProperty('--cols', C);
      // row: labels column + C step columns
      var frag = document.createDocumentFragment();
      function lab(text, cls) { frag.appendChild(h('div', 'ac-rl ' + (cls || ''), { text: text })); }
      // LED row
      lab('', 'led');
      U.leds = [];
      for (var c = 0; c < C; c++) {
        var led = h('div', 'ac-ledc' + (c % 4 === 0 ? ' beat' : ''), null, [h('i', 'ac-led'), h('span', null, { text: c + 1 })]);
        if (c >= P.len) led.classList.add('off');
        frag.appendChild(led); U.leds.push(led);
      }
      // pitch rows (top = high C)
      U.cells = [];
      for (var n = 12; n >= 0; n--) {
        var blk = BLACK[n % 12];
        lab(NOTE_NAMES[n % 12] + (n === 12 ? "'" : ''), 'key ' + (blk ? 'blk' : 'wht') + (n === 0 || n === 12 ? ' c' : ''));
        for (var c2 = 0; c2 < C; c2++) {
          var st = P.steps[c2];
          var cell = h('div', 'ac-cell ' + (blk ? 'blk' : 'wht') + (c2 % 4 === 0 ? ' beat' : ''));
          cell.dataset.n = n; cell.dataset.s = c2;
          if (c2 >= P.len) cell.classList.add('off');
          if (st.n === n) cell.classList.add(st.g ? 'on' : 'ghost');
          if (st.n === n && st.g && st.a) cell.classList.add('acc');
          if (st.n === n && st.g && st.s) cell.classList.add('sld');
          if (c2 === S.sel) cell.classList.add('sel');
          frag.appendChild(cell);
        }
      }
      // flag rows
      var flags = [['o', 1, 'UP'], ['o', -1, 'DOWN'], ['a', true, 'ACC'], ['s', true, 'SLIDE'], ['g', true, 'GATE']];
      flags.forEach(function (f, fi) {
        lab(f[2], 'flag' + (fi === 0 ? ' first' : ''));
        for (var c3 = 0; c3 < C; c3++) {
          var s3 = P.steps[c3];
          var on = f[0] === 'o' ? s3.o === f[1] : !!s3[f[0]];
          var fc = h('div', 'ac-flag f-' + f[2].toLowerCase() + (on ? ' on' : '') + (fi === 0 ? ' first' : '') + (c3 % 4 === 0 ? ' beat' : ''));
          fc.dataset.f = f[0]; fc.dataset.v = String(f[1]); fc.dataset.s = c3;
          if (c3 >= P.len) fc.classList.add('off');
          fc.appendChild(h('i'));
          frag.appendChild(fc);
        }
      });
      grid.appendChild(frag);
      U.updateLeds();
    };

    U.renderBar = function () {
      U.bankBtns.forEach(function (b, i) {
        b.classList.toggle('on', i === S.bank);
        b.classList.toggle('cue', i === S.cue);
      });
      U.lenVal.textContent = String(pat().len);
      bRun.classList.toggle('on', S.run);
      bKT.classList.toggle('on', S.keyTranspose);
      bSaw.classList.toggle('on', S.wave === 'saw');
      bSqr.classList.toggle('on', S.wave === 'square');
      bSub.classList.toggle('on', S.sub);
      scaleSel.value = S.scale;
      dens.value = Math.round(S.density * 100);
      U.densVal.textContent = Math.round(S.density * 100) + '%';
      U.renderTranspose();
    };
    U.renderTranspose = function () {
      U.trVal.textContent = (S.transpose >= 0 ? '+' : '') + S.transpose;
    };
    U.renderEdit = function () {
      var P = pat(); S.sel = clamp(S.sel, 0, P.len - 1);
      var st = P.steps[S.sel];
      U.selLab.innerHTML = '<b>' + (S.sel + 1) + '</b><span>' + NOTE_NAMES[st.n % 12] + (st.n === 12 ? "'" : '') +
        (st.o > 0 ? ' ↑' : st.o < 0 ? ' ↓' : '') + '</span>';
      U.kbKeys.forEach(function (k, i) { k.classList.toggle('on', i === st.n && st.g); k.classList.toggle('ghost', i === st.n && !st.g); });
      selBtns.up.classList.toggle('on', st.o === 1);
      selBtns.dn.classList.toggle('on', st.o === -1);
      selBtns.a.classList.toggle('on', st.a);
      selBtns.s.classList.toggle('on', st.s);
      selBtns.g.classList.toggle('on', st.g);
    };
    U.renderAll = function () {
      U.knobs.forEach(function (k) { k.show(); });
      U.renderBar(); U.renderGrid(); U.renderEdit();
    };
    U.updateLeds = function () {
      if (!U.leds) return;
      var C = U.leds.length;
      for (var i = 0; i < C; i++) U.leds[i].classList.toggle('play', i === U.playPos);
      // highlight playing column cells
      var prev = grid.querySelectorAll('.ac-cell.pc');
      for (var j = 0; j < prev.length; j++) prev[j].classList.remove('pc');
      if (U.playPos >= 0) {
        var cur = grid.querySelectorAll('.ac-cell[data-s="' + U.playPos + '"]');
        for (var k = 0; k < cur.length; k++) cur[k].classList.add('pc');
      }
    };
    function changed() { U.renderGrid(); U.renderEdit(); U.renderBar(); }

    /* ---- events ---- */
    bSaw.onclick = function () { S.wave = 'saw'; applyParams(); U.renderBar(); };
    bSqr.onclick = function () { S.wave = 'square'; applyParams(); U.renderBar(); };
    bSub.onclick = function () { S.sub = !S.sub; applyParams(); U.renderBar(); };
    U.bankBtns.forEach(function (b) {
      b.onclick = function () {
        var i = +b.dataset.bank;
        if (seq.playing && Studio.transport && Studio.transport.playing && S.run && i !== S.bank) { S.cue = (S.cue === i ? -1 : i); }
        else { S.bank = i; S.cue = -1; S.sel = 0; changed(); }
        U.renderBar();
      };
    });
    lenDn.onclick = function () { pat().len = clamp(pat().len - 1, 1, MAX_LEN); changed(); };
    lenUp.onclick = function () { pat().len = clamp(pat().len + 1, 1, MAX_LEN); changed(); };
    bRun.onclick = function () { S.run = !S.run; if (!S.run) def.allNotesOff(); U.renderBar(); };
    bKT.onclick = function () { S.keyTranspose = !S.keyTranspose; U.renderBar(); };
    trDn.onclick = function () { S.transpose = clamp(S.transpose - 1, -24, 24); U.renderTranspose(); };
    trUp.onclick = function () { S.transpose = clamp(S.transpose + 1, -24, 24); U.renderTranspose(); };
    function shift(dir) {
      var P = pat(), L = P.len, part = P.steps.slice(0, L);
      if (dir < 0) part.push(part.shift()); else part.unshift(part.pop());
      for (var i = 0; i < L; i++) P.steps[i] = part[i];
      changed();
    }
    bShL.onclick = function () { shift(-1); };
    bShR.onclick = function () { shift(1); };
    bCopy.onclick = function () { clipboard = clonePattern(pat()); Studio.toast && Studio.toast('Acid: pattern ' + BANK_NAMES[S.bank] + ' copied'); };
    bPaste.onclick = function () {
      if (!clipboard) { Studio.toast && Studio.toast('Acid: nothing copied yet'); return; }
      S.patterns[S.bank] = clonePattern(clipboard); changed();
    };
    bClear.onclick = function () { S.patterns[S.bank] = emptyPattern(); S.patterns[S.bank].len = pat().len || 16; changed(); };
    scaleSel.onchange = function () { S.scale = scaleSel.value; };
    dens.oninput = function () { S.density = dens.value / 100; U.densVal.textContent = dens.value + '%'; };
    bGen.onclick = function () {
      S.patterns[S.bank] = generateLine(S.scale, S.density, pat().len);
      changed();
    };

    // grid painting
    var paint = null;
    function cellAt(ev) {
      var t = document.elementFromPoint(ev.clientX, ev.clientY);
      while (t && t !== grid && !(t.dataset && t.dataset.s != null)) t = t.parentNode;
      return t && t !== grid ? t : null;
    }
    function applyCell(c, first) {
      var s = +c.dataset.s, P = pat();
      if (s >= P.len) return;
      var st = P.steps[s];
      if (c.dataset.n != null) {
        var n = +c.dataset.n;
        if (first) paint = { kind: 'n', gate: !(st.n === n && st.g) };
        st.n = n; st.g = paint.gate;
      } else {
        var f = c.dataset.f;
        if (f === 'o') {
          var v = +c.dataset.v;
          if (first) paint = { kind: 'o', val: st.o === v ? 0 : v, v: v };
          if (paint.kind !== 'o' || paint.v !== v) return;
          st.o = paint.val;
        } else {
          if (first) paint = { kind: f, val: !st[f] };
          if (paint.kind !== f) return;
          st[f] = paint.val;
        }
      }
      S.sel = s;
      U.renderGrid(); U.renderEdit();
      if (first && c.dataset.n != null && st.g && E && !(Studio.transport && Studio.transport.playing)) {
        var t0 = E.ctx.currentTime + 0.01; voiceTrigger(stepNote(st), t0, st.a, 0.8); voiceGateOff(t0 + 0.18);
      }
    }
    grid.addEventListener('pointerdown', function (ev) {
      var c = cellAt(ev); if (!c) return;
      ev.preventDefault(); grid.setPointerCapture(ev.pointerId);
      paint = null; applyCell(c, true); paint && (paint.last = c.dataset.s + ':' + (c.dataset.n || c.dataset.f));
    });
    grid.addEventListener('pointermove', function (ev) {
      if (!paint) return;
      var c = cellAt(ev); if (!c) return;
      var key = c.dataset.s + ':' + (c.dataset.n || c.dataset.f);
      if (key === paint.last) return;
      paint.last = key;
      // for pitch painting stay on pitch rows; for flags only same row
      if (paint.kind === 'n' && c.dataset.n == null) return;
      if (paint.kind !== 'n' && c.dataset.n != null) return;
      applyCell(c, false);
    });
    function endPaint() { paint = null; }
    grid.addEventListener('pointerup', endPaint); grid.addEventListener('pointercancel', endPaint);

    // step-write keyboard
    kb.addEventListener('pointerdown', function (ev) {
      var k = ev.target.closest ? ev.target.closest('.ac-key') : null; if (!k) return;
      ev.preventDefault();
      var P = pat(), st = P.steps[S.sel];
      st.n = +k.dataset.n; st.g = true;
      if (E && !(Studio.transport && Studio.transport.playing)) { var t0 = E.ctx.currentTime + 0.01; voiceTrigger(stepNote(st), t0, st.a, 0.8); voiceGateOff(t0 + 0.18); }
      S.sel = (S.sel + 1) % P.len;                         // advance like 303 step-write
      U.renderGrid(); U.renderEdit();
    });
    prevS.onclick = function () { S.sel = (S.sel - 1 + pat().len) % pat().len; U.renderGrid(); U.renderEdit(); };
    nextS.onclick = function () { S.sel = (S.sel + 1) % pat().len; U.renderGrid(); U.renderEdit(); };
    function selFlag(fn) { return function () { fn(pat().steps[S.sel]); U.renderGrid(); U.renderEdit(); }; }
    selBtns.up.onclick = selFlag(function (st) { st.o = st.o === 1 ? 0 : 1; });
    selBtns.dn.onclick = selFlag(function (st) { st.o = st.o === -1 ? 0 : -1; });
    selBtns.a.onclick = selFlag(function (st) { st.a = !st.a; });
    selBtns.s.onclick = selFlag(function (st) { st.s = !st.s; });
    selBtns.g.onclick = selFlag(function (st) { st.g = !st.g; });

    /* ---- playhead LEDs synced to audio clock ---- */
    function tick() {
      if (!root.isConnected) { U.raf = null; return; }
      if (E) {
        var now = E.ctx.currentTime, moved = false;
        while (uiQueue.length && uiQueue[0].t <= now) {
          var q = uiQueue.shift();
          if (q.bank !== S.bank) { /* cued switch happened */ }
          U.playPos = q.pos; moved = true;
        }
        if (U.needsRender) { U.needsRender = false; S.sel = 0; changed(); moved = true; }
        if (moved) U.updateLeds();
      }
      U.raf = requestAnimationFrame(tick);
    }
    U.raf = requestAnimationFrame(tick);

    U.renderAll();
  }

  if (window.Studio && Studio.registerPlugin) Studio.registerPlugin(def);
  else console.error('[acid] window.Studio not found');
})();
