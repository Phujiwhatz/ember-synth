/* Ember Ultimate — mixer: channel strips, sends, master bus (reverb, delay, glue, limiter), meters. */
(function () {
  'use strict';
  var Studio = window.Studio;
  var M = Studio.mixer = { strips: [], master: null, fx: {} };

  function db2g(db) { return db <= -60 ? 0 : Math.pow(10, db / 20); }
  function g2db(g) { return g <= 0.000001 ? -120 : 20 * Math.log10(g); }
  M.db2g = db2g; M.g2db = g2db;

  /* Algorithmic stereo reverb impulse: decorrelated noise, exponential decay, darkening over time,
     a handful of early reflections and a short pre-delay. No files. */
  function makeIR(ctx, seconds, decay, predelay) {
    var sr = ctx.sampleRate, len = Math.floor(sr * seconds), pre = Math.floor(sr * predelay);
    var buf = ctx.createBuffer(2, len + pre, sr);
    for (var c = 0; c < 2; c++) {
      var d = buf.getChannelData(c), lp = 0, seed = c ? 7919 : 104729;
      var rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 1073741823.5 - 1; };
      for (var i = 0; i < len; i++) {
        var t = i / len;
        var env = Math.pow(1 - t, decay) * Math.exp(-t * 3);
        var cutoff = 0.85 - 0.75 * t;           // one-pole lowpass closes as the tail decays
        lp += cutoff * (rnd() - lp);
        d[pre + i] = lp * env;
      }
      // early reflections
      var refl = [0.011, 0.019, 0.027, 0.037, 0.049, 0.061];
      for (var r = 0; r < refl.length; r++) {
        var at = pre + Math.floor((refl[r] + (c ? 0.0031 * r : 0)) * sr);
        if (at < d.length) d[at] += (c ^ (r & 1) ? 0.5 : -0.45) * (1 - r / refl.length);
      }
    }
    // normalise energy
    var e = 0, ch0 = buf.getChannelData(0), ch1 = buf.getChannelData(1);
    for (var k = 0; k < ch0.length; k++) e += ch0[k] * ch0[k] + ch1[k] * ch1[k];
    var norm = 1.6 / Math.sqrt(e / 2 + 1e-9) ;
    for (k = 0; k < ch0.length; k++) { ch0[k] *= norm; ch1[k] *= norm; }
    return buf;
  }
  M.makeIR = makeIR;

  function softClipCurve(n) {
    var c = new Float32Array(n), ceil = 0.966; // ≈ -0.3 dBFS
    for (var i = 0; i < n; i++) {
      var x = (i / (n - 1)) * 2 - 1;
      var a = Math.abs(x) * 1.5;               // input range ±1.5
      var y = a < 0.8 ? a : 0.8 + (ceil - 0.8) * Math.tanh((a - 0.8) / (ceil - 0.8));
      c[i] = Math.sign(x) * Math.min(y, ceil);
    }
    return c;
  }

  function newAnalyser(ctx, size) { var a = ctx.createAnalyser(); a.fftSize = size || 1024; a.smoothingTimeConstant = 0.6; return a; }

  Studio._hooks.buildMixer = function (ctx) {
    var bus = ctx.createGain();                       // sum of all strips
    var revIn = ctx.createGain(), dlyIn = ctx.createGain();

    // --- reverb
    var revHP = ctx.createBiquadFilter(); revHP.type = 'highpass'; revHP.frequency.value = 220;
    var revLP = ctx.createBiquadFilter(); revLP.type = 'lowpass'; revLP.frequency.value = 9000;
    var conv = ctx.createConvolver(); conv.normalize = false; conv.buffer = makeIR(ctx, 2.6, 2.2, 0.018);
    var revRet = ctx.createGain(); revRet.gain.value = 0.55;
    revIn.connect(revHP).connect(revLP).connect(conv).connect(revRet);

    // --- tempo-synced stereo ping-pong delay (dotted 8th)
    var split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    var dIn = ctx.createGain(); dIn.gain.value = 0.7;
    var dL = ctx.createDelay(4), dR = ctx.createDelay(4);
    var fb = ctx.createGain(); fb.gain.value = 0.42;
    var dTone = ctx.createBiquadFilter(); dTone.type = 'lowpass'; dTone.frequency.value = 4200;
    var dHP = ctx.createBiquadFilter(); dHP.type = 'highpass'; dHP.frequency.value = 160;
    var dlyRet = ctx.createGain(); dlyRet.gain.value = 0.6;
    var mono = ctx.createGain(); mono.channelCount = 1; mono.channelCountMode = 'explicit';
    dlyIn.connect(dHP).connect(mono).connect(dIn).connect(dL);
    dL.connect(dR); dR.connect(dTone).connect(fb).connect(dL);
    dL.connect(merge, 0, 0); dR.connect(merge, 0, 1);
    merge.connect(dlyRet);
    function syncDelay() {
      var six = 60 / Studio.transport.bpm / 4, t = M.fx.delayDiv * six;
      var now = ctx.currentTime;
      dL.delayTime.setTargetAtTime(Math.min(t, 3.9), now, 0.05);
      dR.delayTime.setTargetAtTime(Math.min(t, 3.9), now, 0.05);
    }
    M.fx = { delayDiv: 3, syncDelay: syncDelay, revRet: revRet, dlyRet: dlyRet, fb: fb, conv: conv };
    syncDelay();
    Studio.transport.on('bpm', syncDelay);

    // --- master chain
    var sum = ctx.createGain();
    bus.connect(sum); revRet.connect(sum); dlyRet.connect(sum);
    var glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16; glue.knee.value = 10; glue.ratio.value = 2; glue.attack.value = 0.02; glue.release.value = 0.25;
    var fader = ctx.createGain(); fader.gain.value = db2g(-3);
    var lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    var clip = ctx.createWaveShaper(); clip.curve = softClipCurve(4097); clip.oversample = '4x';
    // WaveShaper input domain is ±1; the curve covers ±1.5 of real signal, so scale in by 1/1.5.
    var trim = ctx.createGain(); trim.gain.value = 1 / 1.5;
    var out = ctx.createGain();
    sum.connect(glue).connect(fader).connect(lim).connect(trim).connect(clip).connect(out);
    out.connect(ctx.destination);

    // meters / scope
    var msplit = ctx.createChannelSplitter(2);
    var aL = newAnalyser(ctx, 1024), aR = newAnalyser(ctx, 1024), spec = newAnalyser(ctx, 4096);
    spec.smoothingTimeConstant = 0.78;
    out.connect(msplit); msplit.connect(aL, 0); msplit.connect(aR, 1); out.connect(spec);

    // metronome goes straight to the speakers (not into the bounce)
    var click = ctx.createGain(); click.gain.value = 0.35; click.connect(ctx.destination);
    Studio._hooks.click = function (t, accent) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = accent ? 1760 : 1175;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.5, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      o.connect(g).connect(click); o.start(t); o.stop(t + 0.05);
    };

    M.master = { bus: bus, revIn: revIn, dlyIn: dlyIn, glue: glue, fader: fader, lim: lim, clip: clip, out: out,
      aL: aL, aR: aR, spec: spec, click: click, vol: -3, peakL: 0, peakR: 0, holdL: 0, holdR: 0, clipLed: 0 };
    M.anySolo = false;
  };

  /* per-plugin strip: input (handed to plugin) → fader → pan → mute → bus, post-fader sends */
  Studio._hooks.createStrip = function (p) {
    var ctx = Studio.ctx, m = M.master;
    var s = { id: p.id, plugin: p, vol: 0, pan: 0, mute: false, solo: false, rev: 0, dly: 0, peak: 0, hold: 0, active: 0 };
    s.input = ctx.createGain();
    s.fader = ctx.createGain();
    s.pan = 0;
    s.panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    s.gate = ctx.createGain();                  // mute/solo
    s.revSend = ctx.createGain(); s.revSend.gain.value = 0;
    s.dlySend = ctx.createGain(); s.dlySend.gain.value = 0;
    s.meter = newAnalyser(ctx, 512);
    s.input.connect(s.fader);
    var post = s.fader;
    if (s.panner) { s.fader.connect(s.panner); post = s.panner; }
    post.connect(s.gate);
    s.gate.connect(m.bus);
    s.gate.connect(s.revSend).connect(m.revIn);
    s.gate.connect(s.dlySend).connect(m.dlyIn);
    s.gate.connect(s.meter);
    s.buf = new Float32Array(s.meter.fftSize);
    M.strips.push(s);
    applyStrip(s);
    return s;
  };

  function ramp(param, v) { var t = Studio.ctx.currentTime; param.cancelScheduledValues(t); param.setTargetAtTime(v, t, 0.015); }
  function applyGates() {
    M.anySolo = M.strips.some(function (s) { return s.solo; });
    M.strips.forEach(function (s) {
      var on = !s.mute && (!M.anySolo || s.solo);
      ramp(s.gate.gain, on ? 1 : 0);
    });
  }
  function applyStrip(s) {
    ramp(s.fader.gain, db2g(s.vol));
    if (s.panner) ramp(s.panner.pan, s.pan);
    ramp(s.revSend.gain, s.rev);
    ramp(s.dlySend.gain, s.dly);
    applyGates();
  }
  M.set = function (id, key, val) {
    if (id === 'master') {
      if (key === 'vol') { M.master.vol = val; ramp(M.master.fader.gain, db2g(val)); }
      if (key === 'rev') ramp(M.fx.revRet.gain, val);
      if (key === 'dly') ramp(M.fx.dlyRet.gain, val);
      if (key === 'fb') ramp(M.fx.fb.gain, val);
      if (key === 'div') { M.fx.delayDiv = val; M.fx.syncDelay(); }
      Studio._emit('mixer', id, key, val);
      return;
    }
    var s = M.get(id); if (!s) return;
    s[key] = val; applyStrip(s);
    Studio._emit('mixer', id, key, val);
  };
  M.get = function (id) { for (var i = 0; i < M.strips.length; i++) if (M.strips[i].id === id) return M.strips[i]; return null; };

  Studio._hooks.mixerState = function () {
    var o = { master: { vol: M.master.vol, rev: M.fx.revRet.gain.value, dly: M.fx.dlyRet.gain.value, fb: M.fx.fb.gain.value, div: M.fx.delayDiv }, strips: {} };
    M.strips.forEach(function (s) { o.strips[s.id] = { vol: s.vol, pan: s.pan, mute: s.mute, solo: s.solo, rev: s.rev, dly: s.dly }; });
    // round for stable autosave diffs
    o.master.rev = +o.master.rev.toFixed(3); o.master.dly = +o.master.dly.toFixed(3); o.master.fb = +o.master.fb.toFixed(3);
    return o;
  };
  Studio._hooks.setMixerState = function (o) {
    o = o || {};
    var mm = o.master || {};
    M.set('master', 'vol', mm.vol != null ? mm.vol : -3);
    M.set('master', 'rev', mm.rev != null ? mm.rev : 0.55);
    M.set('master', 'dly', mm.dly != null ? mm.dly : 0.6);
    M.set('master', 'fb', mm.fb != null ? mm.fb : 0.42);
    M.set('master', 'div', mm.div != null ? mm.div : 3);
    M.strips.forEach(function (s) {
      var d = (o.strips || {})[s.id] || {};
      s.vol = d.vol != null ? d.vol : 0; s.pan = d.pan || 0; s.mute = !!d.mute; s.solo = !!d.solo;
      s.rev = d.rev || 0; s.dly = d.dly || 0;
      applyStrip(s);
    });
    Studio._emit('mixer', '*');
  };

  /* metering: call once per animation frame */
  function peakOf(an, buf) {
    an.getFloatTimeDomainData(buf);
    var p = 0;
    for (var i = 0; i < buf.length; i++) { var v = buf[i] < 0 ? -buf[i] : buf[i]; if (v > p) p = v; }
    return p;
  }
  var mbuf = null;
  M.updateMeters = function (dt) {
    var fall = Math.pow(0.5, dt / 0.12);           // smooth fall-off
    M.strips.forEach(function (s) {
      var p = peakOf(s.meter, s.buf);
      s.peak = p > s.peak ? p : s.peak * fall;
      s.hold = p > s.hold ? p : Math.max(0, s.hold - dt * 0.25);
      s.active = p > 0.003 ? 1 : s.active * fall;
    });
    var m = M.master;
    if (!m) return;
    if (!mbuf) mbuf = new Float32Array(m.aL.fftSize);
    var l = peakOf(m.aL, mbuf), r = peakOf(m.aR, mbuf);
    m.peakL = l > m.peakL ? l : m.peakL * fall;
    m.peakR = r > m.peakR ? r : m.peakR * fall;
    m.holdL = l > m.holdL ? l : Math.max(0, m.holdL - dt * 0.25);
    m.holdR = r > m.holdR ? r : Math.max(0, m.holdR - dt * 0.25);
    m.gr = m.lim.reduction + m.glue.reduction;  // dB (negative)
    m.limGR = m.lim.reduction;
    if (Math.max(l, r) > 0.95) m.clipLed = 1.5; else m.clipLed = Math.max(0, m.clipLed - dt);
  };
})();
