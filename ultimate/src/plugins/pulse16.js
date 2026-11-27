/* Ember Ultimate - Pulse 16: port of the Pulse·16 JUCE drum machine.
 * 8 tracks (synth 808/909-style voices or samples), 16-step sequencer with accents, swing and drive,
 * kit presets, a built-in sound library (samples/pulse16, category 'pulse16'), MIDI play + record and
 * MIDI learn. The DSP is a line-by-line port of DrumEngine.h + the processor's mix/drive stage; it runs
 * in an AudioWorklet loaded from a Blob URL (works from file://) or, if worklets are unavailable, in a
 * ScriptProcessorNode running the very same code. CSS lives in pulse16.css (.plug-pulse16).
 */
(function () {
  'use strict';

  var COLOR = '#ff7a2f';
  var NT = 8, NS = 16;
  var TRACK_NAMES = ['KICK', 'SNARE', 'CLAP', 'CL HAT', 'OP HAT', 'LO TOM', 'HI TOM', 'PERC'];
  var TRACK_CATEGORY = ['Kicks', 'Snares', 'Claps', 'Hats', 'Hats', 'Toms', 'Toms', 'Percussion'];
  var LIB_CATS = ['Kicks', 'Snares', 'Claps', 'Hats', 'Cymbals', 'Toms', 'Percussion', 'FX'];
  var QWERTY = ['A', 'W', 'S', 'E', 'D', 'F', 'T', 'G'];   // shell QWERTY keys for C..G (every-octave map)
  var DEF_LEVEL = [0.9, 0.8, 0.65, 0.5, 0.5, 0.7, 0.65, 0.45];
  var DEF_PAN = [0, 0, 0.1, 0.2, 0.2, -0.25, 0.25, -0.15];
  var NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var DEFAULT_PATTERN = [
    'x.....x.x.x.....',  // kick
    '....x.......x...',  // snare
    '............x...',  // clap
    'X.x.X.x.X.x.X...',  // closed hat (X = accent)
    '..............x.',  // open hat
    '................',
    '................',
    '................'
  ];

  // library/kits.json from the Pulse 16 source (verbatim: 8 kits x 8 tracks)
  var KITS = [
    { name: "808 Classic", tracks: [
      { sound: "synth", level: 0.9, tune: 0, decay: 0.65, tone: 0.4, pan: 0 },
      { sound: "builtin:Snares/Classic 808 Snare.wav", level: 0.8, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/808 Clap.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Hats/808 Closed Hat.wav", level: 0.65, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Hats/808 Open Hat.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "synth", level: 0.75, tune: 0, decay: 0.55, tone: 0.5, pan: -0.25 },
      { sound: "synth", level: 0.75, tune: 0, decay: 0.5, tone: 0.5, pan: 0.25 },
      { sound: "builtin:Percussion/808 Cowbell.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: -0.15 }
    ] },
    { name: "909 House", tracks: [
      { sound: "builtin:Kicks/Punchy 909.wav", level: 0.9, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Snares/Tight 909.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/909 Clap.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Hats/909 Closed Hat.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Hats/909 Open Hat.wav", level: 0.55, tune: 0, decay: 0.6, tone: 1, pan: 0.2 },
      { sound: "builtin:Toms/909 Low Tom.wav", level: 0.7, tune: 0, decay: 0.98, tone: 1, pan: -0.25 },
      { sound: "builtin:Toms/909 High Tom.wav", level: 0.7, tune: 0, decay: 0.98, tone: 1, pan: 0.25 },
      { sound: "builtin:Percussion/Shaker.wav", level: 0.5, tune: 0, decay: 0.98, tone: 1, pan: -0.15 }
    ] },
    { name: "Trap", tracks: [
      { sound: "builtin:Kicks/Trap Sub Kick.wav", level: 0.9, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Snares/Trap Snare.wav", level: 0.8, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/Trap Clap.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Hats/Trap Hat Tick.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Hats/Trap Open Hat.wav", level: 0.55, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Toms/808 Low Tom.wav", level: 0.7, tune: -2, decay: 0.98, tone: 1, pan: -0.25 },
      { sound: "builtin:Toms/808 High Tom.wav", level: 0.7, tune: 0, decay: 0.98, tone: 1, pan: 0.25 },
      { sound: "builtin:Percussion/808 Rimshot.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: -0.15 }
    ] },
    { name: "Lo-Fi Boom Bap", tracks: [
      { sound: "builtin:Kicks/Boom Bap Thump.wav", level: 0.9, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Snares/Boom Bap Crack.wav", level: 0.8, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/Dusty Lo-Fi Clap.wav", level: 0.7, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Hats/Dusty Lo-Fi Hat.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Hats/Dusty Lo-Fi Open Hat.wav", level: 0.55, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Toms/Dusty Lo-Fi Tom.wav", level: 0.7, tune: -3, decay: 0.98, tone: 1, pan: -0.25 },
      { sound: "builtin:Toms/Dusty Lo-Fi Tom.wav", level: 0.7, tune: 4, decay: 0.98, tone: 1, pan: 0.25 },
      { sound: "builtin:Percussion/Tambourine.wav", level: 0.5, tune: 0, decay: 0.98, tone: 0.8, pan: -0.15 }
    ] },
    { name: "Techno", tracks: [
      { sound: "builtin:Kicks/Techno Rumble.wav", level: 0.95, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Snares/Techno Snare.wav", level: 0.7, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/Techno Clap.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Hats/Techno Hat.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Hats/Techno Open Hat.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Toms/909 Low Tom.wav", level: 0.65, tune: -2, decay: 0.98, tone: 1, pan: -0.25 },
      { sound: "builtin:Toms/909 High Tom.wav", level: 0.65, tune: 2, decay: 0.98, tone: 1, pan: 0.25 },
      { sound: "builtin:Percussion/Metal Ping.wav", level: 0.5, tune: 0, decay: 0.98, tone: 1, pan: -0.15 }
    ] },
    { name: "Acoustic-ish", tracks: [
      { sound: "builtin:Kicks/Acoustic Kick.wav", level: 0.9, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Snares/Acoustic Snare.wav", level: 0.8, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/Finger Snap.wav", level: 0.65, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Hats/Acoustic Closed Hat.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Hats/Acoustic Open Hat.wav", level: 0.55, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Toms/Acoustic Floor Tom.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: -0.25 },
      { sound: "builtin:Toms/Acoustic Rack Tom.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0.25 },
      { sound: "builtin:Cymbals/Ride.wav", level: 0.5, tune: 0, decay: 0.98, tone: 1, pan: -0.15 }
    ] },
    { name: "Electro", tracks: [
      { sound: "builtin:Kicks/Electro Kick.wav", level: 0.9, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Snares/Electro Snare.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/Tight Clap.wav", level: 0.7, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Hats/Electro Hat.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Hats/Techno Open Hat.wav", level: 0.55, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Toms/Syndrum Zap Tom.wav", level: 0.7, tune: -5, decay: 0.98, tone: 1, pan: -0.25 },
      { sound: "builtin:Toms/Syndrum Zap Tom.wav", level: 0.7, tune: 5, decay: 0.98, tone: 1, pan: 0.25 },
      { sound: "builtin:FX/Laser Zap.wav", level: 0.5, tune: 0, decay: 0.98, tone: 1, pan: -0.15 }
    ] },
    { name: "Percussion Jam", tracks: [
      { sound: "builtin:Kicks/Soft Felt Kick.wav", level: 0.85, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Percussion/Woody Rimshot.wav", level: 0.75, tune: 0, decay: 0.98, tone: 1, pan: 0 },
      { sound: "builtin:Claps/Finger Snap.wav", level: 0.65, tune: 0, decay: 0.98, tone: 1, pan: 0.1 },
      { sound: "builtin:Percussion/Shaker.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Percussion/Tambourine.wav", level: 0.55, tune: 0, decay: 0.98, tone: 1, pan: 0.2 },
      { sound: "builtin:Percussion/Low Conga.wav", level: 0.8, tune: 0, decay: 0.98, tone: 1, pan: -0.25 },
      { sound: "builtin:Percussion/High Conga.wav", level: 0.8, tune: 0, decay: 0.98, tone: 1, pan: 0.25 },
      { sound: "builtin:Percussion/Agogo.wav", level: 0.6, tune: 0, decay: 0.98, tone: 1, pan: -0.15 }
    ] }
  ];

  /* ====================================================================== DSP (DrumEngine.h port)
   * Self-contained: serialised with toString() into the AudioWorklet, or called directly for the
   * ScriptProcessor fallback. Times arrive in AudioContext seconds and are converted to frames. */
  function DSP_FACTORY() {
    var PI = 3.14159265358979, TWO_PI = 6.28318530717959;
    var Kick = 0, Snare = 1, Clap = 2, ClosedHat = 3, OpenHat = 4, LowTom = 5, HighTom = 6, Cowbell = 7;
    var HAT_RATIOS = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];
    var tanh = Math.tanh, sin = Math.sin, exp = Math.exp, pow = Math.pow;

    function Noise(seed) { this.s = seed >>> 0; }
    Noise.prototype.next = function () {
      var s = this.s;
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      this.s = s;
      return (s | 0) * (1 / 2147483648);
    };

    // Zero-delay-feedback state variable filter (Cytomic / Simper)
    function SVF() { this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; this.ic1 = 0; this.ic2 = 0; this.low = 0; this.band = 0; this.high = 0; }
    SVF.prototype.set = function (cutoff, q, sr) {
      cutoff = Math.min(Math.max(cutoff, 10), sr * 0.45);
      var g = Math.tan(PI * cutoff / sr);
      this.k = 1 / q;
      this.a1 = 1 / (1 + g * (g + this.k));
      this.a2 = g * this.a1;
      this.a3 = g * this.a2;
    };
    SVF.prototype.reset = function () { this.ic1 = this.ic2 = this.low = this.band = this.high = 0; };
    SVF.prototype.process = function (v0) {
      var v3 = v0 - this.ic2;
      var v1 = this.a1 * this.ic1 + this.a2 * v3;
      var v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
      this.ic1 = 2 * v1 - this.ic1;
      this.ic2 = 2 * v2 - this.ic2;
      this.low = v2; this.band = v1; this.high = v0 - this.k * v1 - v2;
    };

    function polyBlep(t, dt) {
      if (t < dt) { t /= dt; return t + t - t * t - 1; }
      if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
      return 0;
    }
    function squareBL(phase, dt) {
      var v = phase < 0.5 ? 1 : -1;
      v += polyBlep(phase, dt);
      var p2 = phase + 0.5;
      if (p2 >= 1) p2 -= 1;
      v -= polyBlep(p2, dt);
      return v;
    }

    function Voice(sr, kind, seed) {
      this.sr = sr; this.kind = kind; this.noise = new Noise(seed); this.active = false;
      this.f1 = new SVF(); this.f2 = new SVF();
      this.sample = null; this.pos = 0; this.rate = 1; this.useLp = false;
      this.t = 0; this.vel = 1; this.gainEnv = 1; this.gainC = 1;
      this.base = 50; this.penv = 0; this.penvC = 0;
      this.env1 = 0; this.env1C = 0; this.env2 = 0; this.env2C = 0;
      this.drive = 1; this.driveNorm = 1; this.amt1 = 1; this.amt2 = 1;
      this.freq = [0, 0, 0, 0, 0, 0]; this.phase = [0, 0, 0, 0, 0, 0];
    }
    Voice.prototype.coef = function (seconds) { return exp(-1 / (Math.max(seconds, 0.0005) * this.sr)); };

    // p = {tune, decay, tone, vel}; sample = {ch:[Float32Array..], sr} or null for the synth voice
    Voice.prototype.trigger = function (p, sample) {
      var sr = this.sr;
      this.sample = sample || null;
      this.vel = p.vel; this.t = 0; this.gainEnv = 1; this.gainC = 1; this.active = true;
      this.f1.reset(); this.f2.reset();
      var k = pow(2, p.tune / 12);

      if (this.sample && this.sample.ch[0].length > 2) {
        this.pos = 0;
        this.rate = this.sample.sr / sr * k;
        this.env1 = 1;
        this.env1C = p.decay >= 0.98 ? 1 : this.coef(0.03 + p.decay * p.decay * 2.5);
        this.env2 = 0;
        this.useLp = p.tone < 0.98;
        var cut = 150 * pow(133, p.tone);
        this.f1.set(cut, 0.707, sr);
        this.f2.set(cut, 0.707, sr);
        return;
      }
      this.sample = null;
      for (var i = 0; i < 6; i++) this.phase[i] = 0;
      var d = p.decay, tone = p.tone;
      switch (this.kind) {
        case Kick:
          this.base = 46 * k;
          this.penv = 1; this.penvC = this.coef(0.028);
          this.env1 = 1; this.env1C = this.coef(0.06 + d * d * 1.0);
          this.env2 = 1; this.env2C = this.coef(0.004);              // click
          this.f1.set(3000, 0.7, sr);
          this.drive = 1 + tone * 5;
          this.driveNorm = 1 / tanh(this.drive);
          break;
        case Snare:
          this.freq[0] = 182 * k; this.freq[1] = 331 * k;
          this.penv = 1; this.penvC = this.coef(0.012);
          this.env1 = 1; this.env1C = this.coef(0.035 + d * 0.11);    // body
          this.env2 = 1; this.env2C = this.coef(0.04 + d * 0.25);     // snares
          this.f1.set(1300, 0.7, sr);
          this.f2.set(9000, 0.7, sr);
          this.amt1 = 1 - 0.55 * tone;
          this.amt2 = 0.35 + 0.8 * tone;
          break;
        case Clap:
          this.f1.set((850 + tone * 1400) * k, 1.5, sr);
          this.f2.set(350, 0.7, sr);
          this.env1 = 1;
          this.env2 = 1; this.env2C = this.coef(0.05 + d * 0.3);
          break;
        case ClosedHat:
        case OpenHat:
          for (var h = 0; h < 6; h++) {
            this.freq[h] = HAT_RATIOS[h] * k;
            this.phase[h] = Math.abs(this.noise.next());
          }
          this.f1.set(9500, 1.1, sr);
          this.f2.set(5200 + tone * 4300, 0.7, sr);
          this.env1 = 1;
          this.env1C = this.kind === ClosedHat ? this.coef(0.012 + d * 0.06) : this.coef(0.06 + d * 0.6);
          this.env2 = 0;
          break;
        case LowTom:
        case HighTom:
          this.base = (this.kind === LowTom ? 92 : 142) * k;
          this.penv = 1; this.penvC = this.coef(0.06);
          this.env1 = 1; this.env1C = this.coef(0.08 + d * 0.45);
          this.env2 = 1; this.env2C = this.coef(0.012);
          this.f1.set(this.base * 6, 1.0, sr);
          this.amt2 = 0.15 + tone * 0.7;
          break;
        case Cowbell:
          this.freq[0] = 540 * k; this.freq[1] = 800 * k;
          this.f1.set(1700 * k * (0.7 + 0.6 * tone), 1.8, sr);
          this.f2.set(450, 0.7, sr);
          this.env1 = 1; this.env1C = this.coef(0.015);
          this.env2 = 1; this.env2C = this.coef(0.05 + d * 0.35);
          break;
        default: this.active = false; break;
      }
    };
    // Fast fade-out (open hat choked by closed hat)
    Voice.prototype.choke = function () { if (this.active) this.gainC = this.coef(0.006); };

    Voice.prototype.nextSynth = function () {
      var isr = 1 / this.sr, ph = this.phase, f1 = this.f1, f2 = this.f2, x, body, f, e;
      switch (this.kind) {
        case Kick: {
          f = this.base * (1 + 3.2 * this.penv * this.penv + 0.6 * this.penv);
          ph[0] += f * isr; if (ph[0] >= 1) ph[0] -= 1;
          body = sin(TWO_PI * ph[0]) * this.env1;
          f1.process(this.noise.next());
          var click = f1.high * this.env2 * 0.45;
          this.penv *= this.penvC; this.env1 *= this.env1C; this.env2 *= this.env2C;
          return tanh((body + click) * this.drive) * this.driveNorm * 0.95;
        }
        case Snare: {
          var pm = 1 + 0.45 * this.penv;
          ph[0] += this.freq[0] * pm * isr; if (ph[0] >= 1) ph[0] -= 1;
          ph[1] += this.freq[1] * pm * isr; if (ph[1] >= 1) ph[1] -= 1;
          body = (0.65 * sin(TWO_PI * ph[0]) + 0.35 * sin(TWO_PI * ph[1])) * this.env1 * this.amt1;
          f1.process(this.noise.next());
          f2.process(f1.high);
          var snares = f2.low * this.env2 * this.amt2 * 1.4;
          this.penv *= this.penvC; this.env1 *= this.env1C; this.env2 *= this.env2C;
          return tanh((body + snares) * 1.2) * 0.85;
        }
        case Clap: {
          var ts = this.t * isr;
          if (ts < 0.033) {
            var m = ts % 0.011;
            e = exp(-m / 0.0035);
          } else {
            this.env2 *= this.env2C;
            e = this.env2;
            this.env1 = this.env2;
          }
          f1.process(this.noise.next());
          f2.process(f1.band);
          return tanh(f2.high * e * 2.6) * 0.9;
        }
        case ClosedHat:
        case OpenHat: {
          var s = 0;
          for (var i = 0; i < 6; i++) {
            var dt = this.freq[i] * isr;
            s += squareBL(ph[i], dt);
            ph[i] += dt; if (ph[i] >= 1) ph[i] -= 1;
          }
          s = s * (1 / 6) * 0.85 + this.noise.next() * 0.22;
          f1.process(s);
          f2.process(f1.band);
          x = f2.high * this.env1 * 2.4;
          this.env1 *= this.env1C;
          return tanh(x);
        }
        case LowTom:
        case HighTom: {
          f = this.base * (1 + 0.6 * this.penv);
          ph[0] += f * isr; if (ph[0] >= 1) ph[0] -= 1;
          body = sin(TWO_PI * ph[0]) * this.env1;
          f1.process(this.noise.next());
          var attack = f1.band * this.env2 * this.amt2;
          this.penv *= this.penvC; this.env1 *= this.env1C; this.env2 *= this.env2C;
          return tanh((body + attack) * 1.3) * 0.85;
        }
        case Cowbell: {
          var d0 = this.freq[0] * isr, d1 = this.freq[1] * isr;
          var sq = squareBL(ph[0], d0) + squareBL(ph[1], d1);
          ph[0] += d0; if (ph[0] >= 1) ph[0] -= 1;
          ph[1] += d1; if (ph[1] >= 1) ph[1] -= 1;
          f1.process(sq);
          f2.process(f1.band);
          x = f2.high * (0.6 * this.env1 + 0.4 * this.env2) * 0.9;
          this.env1 *= this.env1C; this.env2 *= this.env2C;
          return tanh(x);
        }
        default: return 0;
      }
    };

    Voice.prototype.render = function (L, R, start, n, gl, gr) {
      if (!this.active || n <= 0) return;
      if (this.sample) { this.renderSample(L, R, start, n, gl, gr); return; }
      var end = start + n;
      for (var i = start; i < end; i++) {
        var x = this.nextSynth() * this.vel * this.gainEnv;
        this.gainEnv *= this.gainC;
        L[i] += x * gl;
        R[i] += x * gr;
        this.t++;
        if ((this.env1 < 1e-4 && this.env2 < 1e-4) || this.gainEnv < 1e-4) { this.active = false; break; }
      }
    };
    Voice.prototype.renderSample = function (L, R, start, n, gl, gr) {
      var c0 = this.sample.ch[0], c1 = this.sample.ch.length > 1 ? this.sample.ch[1] : c0, len = c0.length;
      var end = start + n;
      for (var i = start; i < end; i++) {
        var idx = this.pos | 0;
        if (idx + 1 >= len) { this.active = false; break; }
        var frac = this.pos - idx;
        var a = c0[idx] + frac * (c0[idx + 1] - c0[idx]);
        var b = c1[idx] + frac * (c1[idx + 1] - c1[idx]);
        if (this.useLp) {
          this.f1.process(a); a = this.f1.low;
          this.f2.process(b); b = this.f2.low;
        }
        var g = this.env1 * this.gainEnv * this.vel;
        L[i] += a * g * gl;
        R[i] += b * g * gr;
        this.env1 *= this.env1C;
        this.gainEnv *= this.gainC;
        this.pos += this.rate;
        if (this.env1 < 1e-4 || this.gainEnv < 1e-4) { this.active = false; break; }
      }
    };

    // ------------------------------------------------------------------ core: 8 voices + preview + mix
    function Core(sr) {
      this.sr = sr;
      this.voices = [];
      for (var t = 0; t < 8; t++) this.voices.push(new Voice(sr, t, (0x1234567 + t * 7919) >>> 0));
      this.preview = new Voice(sr, -1, 0x2468ACE);      // kind -1: plays samples only
      this.gl = []; this.gr = [];
      for (var j = 0; j < 8; j++) { this.gl.push(0.7); this.gr.push(0.7); }
      this.dg = 1.5; this.makeup = 1 / Math.sqrt(1.5); this.gain = pow(10, -3 / 20);
      this.events = [];
      this.samples = {};
      this.hits = 0;
    }
    Core.prototype.setMix = function (t, level, pan) {
      var g = level * level * 1.4, a = (pan + 1) * PI * 0.25;
      this.gl[t] = Math.cos(a) * g; this.gr[t] = sin(a) * g;
    };
    Core.prototype.insert = function (ev) {
      var e = this.events, i = e.length;
      while (i > 0 && e[i - 1].frame > ev.frame) i--;       // stable: equal frames keep send order
      e.splice(i, 0, ev);
    };
    Core.prototype.handle = function (m) {
      if (!m) return;
      if (m.length !== undefined && typeof m !== 'string') { for (var i = 0; i < m.length; i++) this.handle(m[i]); return; }
      switch (m.type) {
        case 'trig':
          this.insert({ frame: Math.round(m.t * this.sr), track: m.track, p: { tune: m.tune, decay: m.decay, tone: m.tone, vel: m.vel }, key: m.key || null });
          break;
        case 'preview':
          this.insert({ frame: Math.round(m.t * this.sr), track: -1, p: { tune: 0, decay: 0.5, tone: 0.5, vel: 1 }, key: m.key });
          break;
        case 'cancel': {
          var f = Math.round(m.t * this.sr);
          for (var c = 0; c < this.events.length; c++) {
            var ev = this.events[c];
            if (ev.track === m.track && Math.abs(ev.frame - f) <= 2) { this.events.splice(c, 1); break; }
          }
          break;
        }
        case 'sample': this.samples[m.key] = { ch: m.ch, sr: m.sr }; break;
        case 'mix': this.setMix(m.track, m.level, m.pan); break;
        case 'master':
          this.dg = 1 + m.drive * 5; this.makeup = 1 / Math.sqrt(this.dg); this.gain = pow(10, m.db / 20);
          break;
        case 'panic':
          this.events.length = 0;
          for (var v = 0; v < 8; v++) this.voices[v].active = false;
          this.preview.active = false;
          break;
      }
    };
    Core.prototype.fire = function (ev) {
      var smp = ev.key ? this.samples[ev.key] || null : null;
      if (ev.track < 0) { if (smp) this.preview.trigger(ev.p, smp); return; }
      this.voices[ev.track].trigger(ev.p, smp);          // no sample -> synth voice
      if (ev.track === ClosedHat) this.voices[OpenHat].choke();
      this.hits++;
    };
    Core.prototype.renderVoices = function (L, R, start, n) {
      if (n <= 0) return;
      for (var t = 0; t < 8; t++) if (this.voices[t].active) this.voices[t].render(L, R, start, n, this.gl[t], this.gr[t]);
      if (this.preview.active) {
        var g = 0.8 * 0.8 * 1.4 * 0.70710678;
        this.preview.render(L, R, start, n, g, g);
      }
    };
    // L/R must be zeroed by the caller. frame0 = absolute frame of L[0].
    Core.prototype.process = function (L, R, n, frame0) {
      var pos = 0, e = this.events;
      while (e.length && e[0].frame < frame0 + n) {
        var off = Math.max(0, e[0].frame - frame0);
        if (off > pos) { this.renderVoices(L, R, pos, off - pos); pos = off; }
        this.fire(e.shift());
      }
      this.renderVoices(L, R, pos, n - pos);
      var dg = this.dg, mg = this.makeup * this.gain;
      for (var i = 0; i < n; i++) { L[i] = tanh(L[i] * dg) * mg; R[i] = tanh(R[i] * dg) * mg; }
    };
    return Core;
  }

  var WORKLET_NAME = 'ember-pulse16-1';
  var WORKLET_SRC = 'var P16Core=(' + DSP_FACTORY.toString() + ')();\n' +
    'class P16Proc extends AudioWorkletProcessor{\n' +
    ' constructor(o){super();this.core=new P16Core(sampleRate);var c=this.core;' +
    '  if(o&&o.processorOptions&&o.processorOptions.init)c.handle(o.processorOptions.init);' +
    '  this.port.onmessage=function(e){c.handle(e.data);};}\n' +
    ' process(ins,outs){var o=outs[0];if(!o||!o[0])return true;var L=o[0],R=o[1]||new Float32Array(L.length);' +
    '  L.fill(0);R.fill(0);this.core.process(L,R,L.length,currentFrame);return true;}\n' +
    '}\ntry{registerProcessor("' + WORKLET_NAME + '",P16Proc);}catch(e){}';

  var workletLoaded = new WeakMap();
  function loadWorklet(ctx) {
    if (window.__P16_NO_WORKLET) return Promise.reject(new Error('forced fallback'));
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.reject(new Error('no audioWorklet'));
    if (workletLoaded.has(ctx)) return workletLoaded.get(ctx);
    // Blob URLs fail from file:// pages (opaque origin: "blob:null/..."), data: URLs work there;
    // try the Blob first (http/https, Electron with a custom scheme), then the data: URL.
    var blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    var dataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SRC);
    var first = location.protocol === 'file:' ? dataUrl : blobUrl, second = first === dataUrl ? blobUrl : dataUrl;
    var p = ctx.audioWorklet.addModule(first).catch(function () { return ctx.audioWorklet.addModule(second); });
    workletLoaded.set(ctx, p);
    return p;
  }

  /* ====================================================================== engine wrapper (main thread) */
  // kind: 'worklet' | 'script'. opts.deferred: buffer messages until commit() (offline renders).
  function Engine(ctx, out, kind, opts) {
    this.ctx = ctx; this.out = out; this.kind = kind; this.sent = {};
    this.queue = []; this.node = null;
    if (!(opts && opts.deferred)) this.commit();
  }
  Engine.prototype.commit = function () {
    var ctx = this.ctx, q = this.queue;
    this.queue = null;
    if (this.kind === 'worklet') {
      this.node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { init: q } });
      this.port = this.node.port;
    } else {
      var Core = DSP_FACTORY(), core = this.core = new Core(ctx.sampleRate);
      core.handle(q);
      var spn = this.node = ctx.createScriptProcessor(1024, 1, 2);
      spn.onaudioprocess = function (e) {
        var ob = e.outputBuffer, L = ob.getChannelData(0), R = ob.getChannelData(1);
        L.fill(0); R.fill(0);
        core.process(L, R, L.length, Math.round(e.playbackTime * ctx.sampleRate));
      };
    }
    this.node.connect(this.out);
  };
  Engine.prototype.post = function (m) {
    if (this.queue) { this.queue.push(m); return; }
    if (this.port) this.port.postMessage(m); else this.core.handle(m);
  };
  // make sure the worklet has the sample data for `key`
  Engine.prototype.ensure = function (key, buf) {
    if (!key || !buf || this.sent[key]) return;
    this.sent[key] = true;
    var ch = [];
    for (var c = 0; c < Math.min(2, buf.numberOfChannels); c++) ch.push(new Float32Array(buf.getChannelData(c)));
    this.post({ type: 'sample', key: key, ch: ch, sr: buf.sampleRate });
  };

  /* ====================================================================== state */
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function defaultTrack(t) { return { level: DEF_LEVEL[t], tune: 0, decay: 0.5, tone: 0.5, pan: DEF_PAN[t], mode: false, sound: '' }; }
  function defaultSteps() {
    return DEFAULT_PATTERN.map(function (row) { return row.split('').map(function (c) { return c === 'X' ? 2 : c === 'x' ? 1 : 0; }); });
  }
  var S = {
    tracks: [], steps: defaultSteps(),
    swing: 0, accent: 0.5, drive: 0.1, master: -3,
    keymap: 0, quantize: true, rec: false, kit: -1,
    learned: [-1, -1, -1, -1, -1, -1, -1, -1]
  };
  for (var ti = 0; ti < NT; ti++) S.tracks.push(defaultTrack(ti));

  var E = null;                 // live engine
  var buffers = {};             // soundId -> AudioBuffer (decoded)
  var loading = {};             // soundId -> Promise<AudioBuffer|null>
  var missing = {};             // soundId -> true if it failed to load
  var uiQueue = [];             // {t, pos} playhead / {t, track, vel} pad flashes
  var ui = null;
  var learnTrack = -1;
  var seq = { log: [], skip: [null, null, null, null, null, null, null, null], lastK: -1 };
  var debugLog = [];

  /* ---------------------------------------------------------------- sounds / library */
  function manifest() { return (window.Studio && Studio.samples && Studio.samples.manifest) || { samples: [] }; }
  function libEntries() {
    var m = manifest(), out = [], kits = m.kits || {};
    (m.samples || []).forEach(function (e) {
      if (e.category === 'pulse16' && e.p16) out.push({ id: 'builtin:' + e.p16, entry: e, name: e.name || e.p16, cat: e.group || 'Pulse 16', builtIn: true });
      else if (e.user) out.push({ id: 'sample:' + e.id, entry: e, name: e.name || e.id, cat: 'User', builtIn: false });
      else if (e.category === 'drums') {
        var k = kits[e.kit] || {}, li = (k.pads || []).indexOf(e.pad);
        var nm = (k.name || e.kit || 'Kit') + ' ' + ((k.labels && k.labels[li]) || e.pad || e.id);
        out.push({ id: 'sample:' + e.id, entry: e, name: nm, cat: 'Studio Kits', builtIn: true });
      }
    });
    // Pulse 16 library first (in its category order), then the studio's kits, then the user's sounds
    var rank = function (c) { var i = LIB_CATS.indexOf(c); return i >= 0 ? i : c === 'User' ? 99 : 50; };
    return out.map(function (e, i) { e.i = i; return e; }).sort(function (a, b) { return rank(a.cat) - rank(b.cat) || a.i - b.i; });
  }
  function resolve(soundId) {
    if (!soundId) return null;
    var ms = manifest().samples || [], i;
    if (soundId.indexOf('builtin:') === 0) {
      var p = soundId.slice(8);
      for (i = 0; i < ms.length; i++) if (ms[i].p16 === p) return ms[i];
    } else if (soundId.indexOf('sample:') === 0) {
      var id = soundId.slice(7);
      for (i = 0; i < ms.length; i++) if (ms[i].id === id) return ms[i];
    }
    return null;
  }
  function displayName(soundId) {
    if (!soundId) return '';
    var e = resolve(soundId);
    if (e && e.name) return e.name;
    if (e && e.category === 'drums') { var l = libEntries().filter(function (x) { return x.id === soundId; })[0]; if (l) return l.name; }
    var s = soundId.replace(/^(builtin|sample|file):/, '');
    return s.slice(s.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  }
  function fetchSound(soundId) {
    if (buffers[soundId]) return Promise.resolve(buffers[soundId]);
    if (loading[soundId]) return loading[soundId];
    var e = resolve(soundId);
    var p = (e ? Studio.samples.get(e.id) : Promise.reject(new Error('not in library'))).then(function (buf) {
      buffers[soundId] = buf; delete missing[soundId];
      if (E) E.ensure(soundId, buf);
      return buf;
    }, function (err) {
      console.warn('[pulse16] could not load sound "' + soundId + '": ' + (err && err.message || err));
      missing[soundId] = true;
      return null;
    }).then(function (b) { delete loading[soundId]; return b; });
    loading[soundId] = p;
    return p;
  }
  // Loads a sound into a track and switches it to sample mode ("" -> synth). Resolves true/false.
  function loadSound(t, soundId) {
    var tr = S.tracks[t];
    if (!soundId) { tr.sound = ''; tr.mode = false; refreshTrack(t); return Promise.resolve(true); }
    tr.sound = soundId; tr.mode = true; refreshTrack(t);
    return fetchSound(soundId).then(function (buf) {
      if (tr.sound !== soundId) return !!buf;          // superseded meanwhile
      if (!buf) tr.mode = false;                        // missing -> synth, but keep the reference
      refreshTrack(t);
      return !!buf;
    });
  }
  function loadKit(i) {
    var kit = KITS[i]; if (!kit) return Promise.resolve();
    S.kit = i;
    var ps = kit.tracks.map(function (kt, t) {
      var tr = S.tracks[t];
      tr.level = kt.level; tr.tune = kt.tune; tr.decay = kt.decay; tr.tone = kt.tone; tr.pan = kt.pan;
      pushMix(t);
      return loadSound(t, kt.sound === 'synth' ? '' : kt.sound);
    });
    renderAll();
    return Promise.all(ps);
  }
  function trackKey(t) {
    var tr = S.tracks[t];
    return tr.mode && tr.sound && buffers[tr.sound] ? tr.sound : null;
  }

  /* ---------------------------------------------------------------- triggering */
  function pushMix(t, eng) {
    eng = eng || E; if (!eng) return;
    var tr = S.tracks[t];
    eng.post({ type: 'mix', track: t, level: tr.level, pan: tr.pan });
  }
  function pushMaster(eng) {
    eng = eng || E; if (!eng) return;
    eng.post({ type: 'master', drive: S.drive, db: S.master });
  }
  function pushAll(eng) { for (var t = 0; t < NT; t++) pushMix(t, eng); pushMaster(eng); }

  function trigger(t, vel, time, eng) {
    eng = eng || E; if (!eng) return;
    var tr = S.tracks[t], key = trackKey(t);
    if (key) eng.ensure(key, buffers[key]);
    eng.post({ type: 'trig', track: t, vel: vel, t: time, tune: tr.tune, decay: tr.decay, tone: tr.tone, key: key });
    if (eng === E) qpush({ t: time, track: t, vel: vel });
  }
  function preview(soundId) {
    if (!E || !soundId) return;
    fetchSound(soundId).then(function (buf) {
      if (!buf || !E) return;
      E.ensure(soundId, buf);
      E.post({ type: 'preview', key: soundId, t: E.ctx.currentTime });
    });
  }

  function qpush(q) {
    var i = uiQueue.length;
    while (i > 0 && uiQueue[i - 1].t > q.t) i--;
    uiQueue.splice(i, 0, q);
  }

  /* ---------------------------------------------------------------- sequencer */
  function sixteenth() { return 60 / ((Studio.transport && Studio.transport.bpm) || 120) / 4; }
  function localSwing(six) { return S.swing * 0.4 * six; }       // SWING knob: up to 0.1 quarter (as the original)
  function transportSwing() { return (Studio.transport && Studio.transport.swing) || 0; }

  function onStep(step16, time, eng) {
    eng = eng || E; if (!eng) return;
    var six = sixteenth();
    var odd = (step16 & 1) === 1;
    var t = time + (odd ? localSwing(six) : 0);
    var idx = ((step16 % NS) + NS) % NS;
    var normalVel = 1 - 0.5 * S.accent;
    for (var tr = 0; tr < NT; tr++) {
      if (seq.skip[tr] === step16) { seq.skip[tr] = null; continue; }
      var s = S.steps[tr][idx];
      if (s) trigger(tr, s === 2 ? 1 : normalVel, t, eng);
    }
    if (eng === E) {
      // base = un-swung grid time of this step (for recording)
      var base = time - (odd ? transportSwing() * six : 0);
      seq.log.push({ k: step16, time: t, base: base, six: six });
      if (seq.log.length > 32) seq.log.shift();
      seq.lastK = step16;
      qpush({ t: t, pos: idx });
      debugLog.push({ step16: step16, time: t, pos: idx });
      if (debugLog.length > 1024) debugLog.shift();
    }
  }
  function onStart() { seq.log = []; seq.lastK = -1; seq.skip = seq.skip.map(function () { return null; }); }
  function onStop() {
    seq.log = []; seq.lastK = -1; seq.skip = seq.skip.map(function () { return null; });
    uiQueue = uiQueue.filter(function (q) { return q.pos == null; });
    if (ui) { ui.setPlayhead(-1); ui.renderHeader(); }
  }

  // Which absolute step a live hit at AudioContext time h belongs to (DrumEngine::recordStepFor).
  function stepTime(k, anchor) {
    var sw = (transportSwing() * anchor.six) + localSwing(anchor.six);
    return anchor.base + (k - anchor.k) * anchor.six + ((k & 1) ? sw : 0);
  }
  function recordStepFor(h, quantize) {
    var a = seq.log[seq.log.length - 1];
    if (!a) return null;
    var k0 = a.k + Math.floor((h - a.base) / a.six), eps = 1e-9, k;
    if (!quantize) {
      for (k = k0 + 1; k >= k0 - 2; --k) if (stepTime(k, a) <= h + eps) return k;
      return k0 - 2;
    }
    var best = k0, bestD = 1e30;
    for (k = k0 - 1; k <= k0 + 2; ++k) {
      var d = Math.abs(stepTime(k, a) - h);
      if (d < bestD - eps) { bestD = d; best = k; }
    }
    return best;
  }
  function recordHit(t, vel, h) {
    if (!S.rec || !(Studio.transport && Studio.transport.playing) || !seq.log.length) return null;
    var k = recordStepFor(h, S.quantize);
    if (k == null) return null;
    var a = seq.log[seq.log.length - 1];
    var idx = ((k % NS) + NS) % NS, old = S.steps[t][idx];
    S.steps[t][idx] = vel >= 0.85 ? 2 : 1;
    // The hit already sounds now: don't let the sequencer play this step again on this pass.
    if (k > seq.lastK) seq.skip[t] = k;
    else if (old && E) {
      var st = stepTime(k, a);
      if (st > h) E.post({ type: 'cancel', track: t, t: st });   // scheduled but not yet played
    }
    if (ui) ui.renderGrid();
    return k;
  }

  // Live hit from MIDI / QWERTY / pad / mouse
  function liveHit(t, vel, time) {
    if (!E) return;
    var now = E.ctx.currentTime, at = Math.max(time || 0, now);
    trigger(t, vel, at);
    var lat = (E.ctx.outputLatency || 0) + (E.ctx.baseLatency || 0);
    recordHit(t, vel, at - lat);
  }

  /* ---------------------------------------------------------------- MIDI map */
  function noteToTrackEveryOctave(n) { if (n < 0 || n > 127) return -1; var pc = n % 12; return pc < NT ? pc : -1; }
  function noteToTrackGM(n) {
    switch (n) {
      case 35: case 36: return 0;
      case 37: case 38: case 40: return 1;
      case 39: return 2;
      case 42: case 44: return 3;
      case 46: return 4;
      case 41: case 43: case 45: return 5;
      case 47: case 48: case 50: return 6;
      case 54: case 56: case 75: case 76: return 7;
      default: return -1;
    }
  }
  function noteToTrack(n) {
    for (var t = 0; t < NT; t++) if (S.learned[t] === n) return t;
    return S.keymap === 1 ? noteToTrackGM(n) : noteToTrackEveryOctave(n);
  }
  function noteName(n) { return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 2); }   // Logic numbering: 36 = C1
  function describeKeymap(t) {
    var parts = [];
    if (S.learned[t] >= 0) parts.push(noteName(S.learned[t]));
    if (S.keymap === 1) {
      var gm = []; for (var n = 0; n < 128; n++) if (noteToTrackGM(n) === t) gm.push(noteName(n));
      parts.push(gm.join(', '));
    } else parts.push(NOTE_NAMES[t]);
    return parts.join(' / ');
  }

  /* ---------------------------------------------------------------- state (de)serialisation */
  function patternString() {
    var s = '';
    for (var t = 0; t < NT; t++) for (var i = 0; i < NS; i++) s += S.steps[t][i];
    return s;
  }
  function getState() {
    return {
      v: 1,
      tracks: S.tracks.map(function (tr) { return { level: tr.level, tune: tr.tune, decay: tr.decay, tone: tr.tone, pan: tr.pan, mode: tr.mode, sound: tr.sound }; }),
      pattern: patternString(),
      swing: S.swing, accent: S.accent, drive: S.drive, master: S.master,
      keymap: S.keymap, quantize: S.quantize, learned: S.learned.slice(), kit: S.kit
    };
  }
  function setState(st) {
    if (!st || typeof st !== 'object') return;
    if (typeof st.pattern === 'string' && st.pattern.length === NT * NS) {
      for (var t = 0; t < NT; t++) for (var i = 0; i < NS; i++) S.steps[t][i] = clamp((st.pattern.charCodeAt(t * NS + i) - 48) | 0, 0, 2);
    }
    S.swing = clamp(num(st.swing, S.swing), 0, 1);
    S.accent = clamp(num(st.accent, S.accent), 0, 1);
    S.drive = clamp(num(st.drive, S.drive), 0, 1);
    S.master = clamp(num(st.master, S.master), -36, 6);
    if (st.keymap === 0 || st.keymap === 1) S.keymap = st.keymap;
    if (typeof st.quantize === 'boolean') S.quantize = st.quantize;
    if (Array.isArray(st.learned)) for (var l = 0; l < NT; l++) S.learned[l] = clamp(num(st.learned[l], -1) | 0, -1, 127);
    S.kit = typeof st.kit === 'number' && KITS[st.kit] ? st.kit : -1;
    var ps = [];
    if (Array.isArray(st.tracks)) st.tracks.slice(0, NT).forEach(function (s, t) {
      if (!s) return;
      var tr = S.tracks[t];
      tr.level = clamp(num(s.level, tr.level), 0, 1);
      tr.tune = clamp(num(s.tune, tr.tune), -24, 24);
      tr.decay = clamp(num(s.decay, tr.decay), 0, 1);
      tr.tone = clamp(num(s.tone, tr.tone), 0, 1);
      tr.pan = clamp(num(s.pan, tr.pan), -1, 1);
      tr.sound = typeof s.sound === 'string' ? s.sound : '';
      tr.mode = !!s.mode && !!tr.sound;
      if (tr.sound) ps.push(fetchSound(tr.sound).then(function () { refreshTrack(t); }));
    });
    pushAll();
    renderAll();
    return Promise.all(ps);
  }

  /* ====================================================================== plugin definition */
  var def = {
    id: 'pulse16', name: 'Pulse 16', kind: 'drums', color: COLOR,
    icon: '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.5"/><rect x="11" y="2.5" width="6.5" height="6.5" rx="1.5" fill="currentColor"/><rect x="2.5" y="11" width="6.5" height="6.5" rx="1.5" fill="currentColor"/><rect x="11" y="11" width="6.5" height="6.5" rx="1.5"/></svg>',

    init: function (ctx, out, Studio) {
      var self = this;
      return loadWorklet(ctx).then(function () { return 'worklet'; }, function (err) {
        console.warn('[pulse16] AudioWorklet unavailable, using ScriptProcessor fallback:', err && err.message);
        return 'script';
      }).then(function (kind) {
        try { E = new Engine(ctx, out, kind); }
        catch (err) { console.warn('[pulse16] worklet node failed, fallback:', err && err.message); E = new Engine(ctx, out, 'script'); }
        self.engineType = E.kind;
        pushAll();
        Object.keys(buffers).forEach(function (k) { E.ensure(k, buffers[k]); });
        var tr = Studio && Studio.transport;
        if (tr && tr.on) {
          tr.on('step', function (s, t) { onStep(s, t); });
          tr.on('start', onStart);
          tr.on('stop', onStop);
          tr.on('bpm', function () { if (ui) ui.renderHeader(); });
        }
        if (Studio && typeof Studio.on === 'function') {
          Studio.on('samples', function () { if (ui) ui.refreshLibrary(); });
          Studio.on('start', function () { if (ui) ui.renderHeader(); });
        }
      });
    },

    mount: function (el) { buildUI(el); },

    noteOn: function (note, vel, time) {
      if (learnTrack >= 0) {
        for (var t = 0; t < NT; t++) if (S.learned[t] === note) S.learned[t] = -1;
        S.learned[learnTrack] = note;
        var lt = learnTrack; learnTrack = -1;
        liveHit(lt, vel, time);
        if (ui) { ui.renderPads(); ui.hint('MIDI learn: ' + TRACK_NAMES[lt] + ' = ' + noteName(note)); }
        return;
      }
      var tr = noteToTrack(note);
      if (tr >= 0) liveHit(tr, vel, time);
    },
    noteOff: function () {},
    bend: function () {},
    pressure: function () {},
    cc: function (n) { if (n === 120 || n === 123) def.allNotesOff(); },
    allNotesOff: function () { if (E) E.post({ type: 'panic' }); },

    getState: getState,
    setState: function (st) { setState(st); },

    // test / debug hooks (not part of the contract)
    _debug: {
      state: S, kits: KITS, log: debugLog, seq: seq,
      engine: function () { return E; },
      loadKit: loadKit, loadSound: loadSound, trigger: liveHit, recordHit: recordHit, recordStepFor: recordStepFor,
      noteToTrack: noteToTrack, libEntries: libEntries, buffers: buffers, setStateAsync: setState,
      // Render `seconds` of audio offline. fn(api) schedules: api.trigger(track, vel, time), api.step(step16, time)
      offline: function (seconds, fn, sr) {
        sr = sr || 44100;
        var oc = new OfflineAudioContext(2, Math.round(sr * seconds), sr);
        return loadWorklet(oc).then(function () { return 'worklet'; }, function () { return 'script'; }).then(function (kind) {
          var eng = new Engine(oc, oc.destination, kind, { deferred: true });
          pushAll(eng);
          fn({ trigger: function (t, v, time) { trigger(t, v, time, eng); }, step: function (s, time) { onStep(s, time, eng); }, engine: eng });
          eng.commit();
          return oc.startRendering();
        }).then(function (buf) { return [buf.getChannelData(0), buf.getChannelData(1)]; });
      }
    }
  };

  /* ====================================================================== UI */
  function h(tag, cls, attrs, kids) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null) continue;
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function btn(cls, text, title) {
    var b = h('button', 'p16-btn ' + (cls || ''), { type: 'button', text: text });
    if (title) b.title = title;
    return b;
  }
  var refreshTrack = function () {}, renderAll = function () {};

  var TRACK_KNOBS = [
    { id: 'level', label: 'LEVEL', min: 0, max: 1, fmt: function (v) { return Math.round(v * 100) + '%'; } },
    { id: 'tune', label: 'TUNE', min: -24, max: 24, bipolar: true, def: 0, fmt: function (v) { return (v > 0 ? '+' : '') + v.toFixed(2) + ' st'; } },
    { id: 'decay', label: 'DECAY', min: 0, max: 1, def: 0.5, fmt: function (v) { return Math.round(v * 100) + '%'; } },
    { id: 'tone', label: 'TONE', min: 0, max: 1, def: 0.5, fmt: function (v) { return Math.round(v * 100) + '%'; } },
    { id: 'pan', label: 'PAN', min: -1, max: 1, bipolar: true, fmt: function (v) { var p = Math.round(v * 100); return p === 0 ? 'C' : (p < 0 ? 'L ' + -p : 'R ' + p); } }
  ];
  var GLOBAL_KNOBS = [
    { id: 'tempo', label: 'TEMPO', min: 40, max: 240, def: 120, fmt: function (v) { return v.toFixed(1) + ' BPM'; },
      get: function () { return (Studio.transport && Studio.transport.bpm) || 120; },
      set: function (v) { var tr = Studio.transport; v = Math.round(v * 10) / 10; if (tr.setBpm) tr.setBpm(v); else tr.bpm = v; },
      tip: 'Studio tempo (same as the BPM in the top bar)' },
    { id: 'swing', label: 'SWING', min: 0, max: 1, def: 0, fmt: function (v) { return Math.round(v * 100) + '%'; },
      tip: 'Shuffles the off-beat 16ths (adds to the studio swing)' },
    { id: 'accent', label: 'ACCENT', min: 0, max: 1, def: 0.5, fmt: function (v) { return Math.round(v * 100) + '%'; },
      tip: 'How much louder accented steps are' },
    { id: 'drive', label: 'DRIVE', min: 0, max: 1, def: 0.1, fmt: function (v) { return Math.round(v * 100) + '%'; },
      tip: 'Saturation on the whole kit' },
    { id: 'master', label: 'MASTER', min: -36, max: 6, def: -3, fmt: function (v) { return (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'; },
      tip: 'Kit output volume' }
  ];

  // SVG rotary knob in the Pulse 16 look (dim track arc, orange value arc, light pointer)
  function makeKnob(o, size, getV, setV, bubble) {
    var A0 = -135, A1 = 135, C = size / 2, lw = size > 36 ? 3 : 2.5, R0 = C - lw / 2 - 1.5;
    function pol(a, r) { var rad = (a - 90) * Math.PI / 180; return [C + r * Math.cos(rad), C + r * Math.sin(rad)]; }
    function arc(a, b, r) { var p = pol(a, r), q = pol(b, r); return 'M' + p[0].toFixed(2) + ' ' + p[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + (b - a > 180 ? 1 : 0) + ' 1 ' + q[0].toFixed(2) + ' ' + q[1].toFixed(2); }
    var el = h('div', 'p16-knob', { tabindex: '0', role: 'slider', 'aria-label': o.label });
    el.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<circle class="cap" cx="' + C + '" cy="' + C + '" r="' + (R0 - lw - 1.5).toFixed(2) + '"/>' +
      '<path class="tr" stroke-width="' + lw + '" d="' + arc(A0, A1, R0) + '"/><path class="va" stroke-width="' + lw + '" d=""/>' +
      '<line class="ptr" x1="' + C + '" y1="' + (C - R0 * 0.2).toFixed(2) + '" x2="' + C + '" y2="' + (C - R0 + lw + 3).toFixed(2) + '"/></svg>';
    var va = el.querySelector('.va'), ptr = el.querySelector('.ptr');
    var def0 = o.def != null ? o.def : null;
    function norm(v) { return (v - o.min) / (o.max - o.min); }
    function draw() {
      var v = getV(), n = clamp(norm(v), 0, 1), a = A0 + n * (A1 - A0), from = o.bipolar ? 0 : A0;
      va.setAttribute('d', Math.abs(a - from) < 0.6 ? '' : (a > from ? arc(from, a, R0) : arc(a, from, R0)));
      ptr.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' ' + C + ' ' + C + ')');
      el.setAttribute('aria-valuetext', o.fmt(v));
    }
    function set(v) { setV(clamp(v, o.min, o.max)); draw(); bubble.show(el, o.label + '  ' + o.fmt(getV())); }
    var drag = null;
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation(); el.focus();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
      drag = { y: e.clientY, n: norm(getV()) }; el.classList.add('drag');
      bubble.show(el, o.label + '  ' + o.fmt(getV()));
    });
    el.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var n = clamp(drag.n + (drag.y - e.clientY) / (e.shiftKey ? 700 : 160), 0, 1);
      set(o.min + n * (o.max - o.min));
    });
    function end() { drag = null; el.classList.remove('drag'); bubble.hide(); }
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', function () { var d = typeof o.defFn === 'function' ? o.defFn() : def0; if (d != null) set(d); bubble.hide(); });
    el.addEventListener('pointerenter', function () { if (!drag) bubble.show(el, o.label + '  ' + o.fmt(getV())); });
    el.addEventListener('pointerleave', function () { if (!drag) bubble.hide(); });
    el.addEventListener('wheel', function (e) { e.preventDefault(); set(getV() - Math.sign(e.deltaY) * (o.max - o.min) * 0.02); }, { passive: false });
    el.addEventListener('keydown', function (e) {
      var st = (o.max - o.min) * (e.shiftKey ? 0.1 : 0.01);
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(getV() + st); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(getV() - st); e.preventDefault(); e.stopPropagation(); }
    });
    el.title = (o.tip ? o.tip + ' - ' : '') + 'drag, wheel or arrow keys; double-click to reset';
    draw();
    return { el: el, draw: draw };
  }

  function buildUI(host) {
    host.innerHTML = '';
    host.classList.add('plug-pulse16');
    var root = h('div', 'p16');
    host.appendChild(root);
    var U = ui = { sel: 0, playPos: -1, flash: [0, 0, 0, 0, 0, 0, 0, 0], cat: 'All', query: '', libSel: -1, visible: [], hintT: 0 };

    var bubble = h('div', 'p16-bubble');
    bubble.show = function (anchor, text) {
      bubble.textContent = text;
      var r = anchor.getBoundingClientRect(), rr = root.getBoundingClientRect();
      bubble.style.left = (r.left - rr.left + r.width / 2) + 'px';
      bubble.style.top = (r.top - rr.top - 6) + 'px';
      bubble.classList.add('on');
    };
    bubble.hide = function () { bubble.classList.remove('on'); };

    /* ---------------- header */
    var head = h('div', 'p16-head');
    head.appendChild(h('div', 'p16-logo', null, [h('div', 'p16-logo-t', { html: 'PULSE<span>·</span>16' }), h('div', 'p16-logo-s', { text: 'synth + sample drum machine' })]));
    var kitSel = h('select', 'p16-sel', { 'aria-label': 'Kit', title: 'Load a whole kit: sounds + settings for all 8 tracks' });
    kitSel.appendChild(h('option', null, { value: '-1', text: 'Choose a kit...' }));
    KITS.forEach(function (k, i) { kitSel.appendChild(h('option', null, { value: String(i), text: k.name })); });
    head.appendChild(h('div', 'p16-field kit', null, [h('label', 'p16-lab', { text: 'KIT' }), kitSel]));

    var recB = h('button', 'p16-rec', { type: 'button', title: 'Record (R): live hits from MIDI, pads and keys are written into the pattern while it plays', 'aria-pressed': 'false' },
      [h('span', 'p16-rec-c', null, [h('i')]), h('span', 'p16-rec-t', { text: 'REC' })]);
    var runB = btn('tog', 'RUN', 'Start / stop the studio transport (Space)');
    var clearB = btn('', 'CLEAR', 'Clear the whole pattern');
    var quantB = btn('tog', 'QUANTIZE', 'Snap recorded hits to the nearest 16th note');
    var keymapSel = h('select', 'p16-sel', { 'aria-label': 'MIDI key map',
      title: 'MIDI note map. Every octave: C C# D D# E F F# G = tracks 1-8 in every octave (QWERTY A W S E D F T G).\nGM drums: General MIDI drum notes (C1 kick, D1 snare...). Right-click a pad to learn a note.' });
    keymapSel.appendChild(h('option', null, { value: '0', text: 'Every octave' }));
    keymapSel.appendChild(h('option', null, { value: '1', text: 'GM drums' }));
    head.appendChild(recB);
    head.appendChild(h('div', 'p16-hbtns', null, [runB, clearB, quantB]));
    head.appendChild(h('div', 'p16-field keymap', null, [h('label', 'p16-lab', { text: 'MIDI KEYMAP' }), keymapSel]));
    var gk = h('div', 'p16-gknobs');
    U.gknobs = GLOBAL_KNOBS.map(function (o) {
      var getV = o.get || function () { return S[o.id]; };
      var setV = o.set || function (v) { S[o.id] = v; if (o.id === 'drive' || o.id === 'master') pushMaster(); };
      var k = makeKnob(o, 44, getV, setV, bubble);
      gk.appendChild(h('div', 'p16-gk', null, [k.el, h('div', 'p16-gk-l', { text: o.label })]));
      return k;
    });
    head.appendChild(gk);
    root.appendChild(head);

    /* ---------------- body: tracks + library */
    var body = h('div', 'p16-body');
    var main = h('div', 'p16-main');
    var cols = h('div', 'p16-row p16-cols');
    cols.appendChild(h('div', 'c-pad', { text: 'PAD (KEY)' }));
    cols.appendChild(h('div', 'c-sound', { text: 'SOUND' }));
    cols.appendChild(h('div', 'c-x'));
    cols.appendChild(h('div', 'c-smp', { text: 'SMP' }));
    TRACK_KNOBS.forEach(function (k) { cols.appendChild(h('div', 'c-knob', { text: k.label })); });
    var colSteps = h('div', 'p16-steps hdr');
    for (var s = 0; s < NS; s++) colSteps.appendChild(h('div', 'p16-num' + (s % 4 === 0 ? ' beat' : ''), { text: String(s + 1) }));
    cols.appendChild(colSteps);
    main.appendChild(cols);

    var rowsEl = h('div', 'p16-rows');
    U.rows = [];
    for (var t = 0; t < NT; t++) (function (t) {
      var row = h('div', 'p16-row p16-track', { 'data-t': String(t) });
      var pad = h('button', 'p16-pad', { type: 'button' }, [h('span', 'p16-pad-n', { text: TRACK_NAMES[t] }), h('span', 'p16-pad-k')]);
      var snd = btn('p16-snd', 'Synth');
      var x = btn('p16-x', '×', 'Back to the built-in synth voice');
      var smp = btn('p16-smp tog', 'SMP', 'Sample mode on/off (off = synth voice)');
      row.appendChild(h('div', 'c-pad', null, [pad]));
      row.appendChild(h('div', 'c-sound', null, [snd]));
      row.appendChild(h('div', 'c-x', null, [x]));
      row.appendChild(h('div', 'c-smp', null, [smp]));
      var knobs = TRACK_KNOBS.map(function (o) {
        var oo = Object.assign({}, o, { label: TRACK_NAMES[t] + ' ' + o.label });
        if (o.id === 'level') oo.def = DEF_LEVEL[t];
        if (o.id === 'pan') oo.def = DEF_PAN[t];
        var k = makeKnob(oo, 32, function () { return S.tracks[t][o.id]; }, function (v) {
          if (o.id === 'tune') v = Math.round(v * 100) / 100;
          S.tracks[t][o.id] = v;
          if (o.id === 'level' || o.id === 'pan') pushMix(t);
        }, bubble);
        row.appendChild(h('div', 'c-knob', null, [k.el]));
        return k;
      });
      var steps = h('div', 'p16-steps');
      var cells = [];
      for (var s = 0; s < NS; s++) {
        var c = h('div', 'p16-cell' + ((s >> 2) % 2 === 0 ? ' g0' : ' g1'), { 'data-t': String(t), 'data-s': String(s) });
        c.appendChild(h('i'));
        steps.appendChild(c); cells.push(c);
      }
      row.appendChild(steps);
      rowsEl.appendChild(row);
      U.rows.push({ row: row, pad: pad, snd: snd, x: x, smp: smp, knobs: knobs, cells: cells, key: pad.querySelector('.p16-pad-k') });

      pad.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        selectTrack(t);
        liveHit(t, e.shiftKey ? 1 : 0.8);
        U.flash[t] = 1; paintPad(t);
      });
      pad.addEventListener('contextmenu', function (e) { e.preventDefault(); selectTrack(t); padMenu(t, e); });
      snd.onclick = function () { selectTrack(t); focusLibrary('Pick a sound for ' + TRACK_NAMES[t] + ' from the library  →'); };
      x.onclick = function () { assignSound(t, ''); };
      smp.onclick = function () {
        selectTrack(t);
        var tr = S.tracks[t];
        if (!tr.mode && !tr.sound) {
          focusLibrary('Pick a sound from the library  →  (click to preview, double-click to load into ' + TRACK_NAMES[t] + ')');
          return;
        }
        tr.mode = !tr.mode;
        if (tr.mode && tr.sound && !buffers[tr.sound]) fetchSound(tr.sound).then(function () { refreshTrack(t); });
        refreshTrack(t);
      };
      row.addEventListener('pointerdown', function (e) { if (e.target === row || e.target.classList.contains('c-knob') || e.target.classList.contains('c-x')) selectTrack(t); });
      row.addEventListener('focusin', function () { selectTrack(t, true); });
      // drag & drop: library sounds and audio files
      row.addEventListener('dragover', function (e) {
        var types = e.dataTransfer && e.dataTransfer.types ? Array.prototype.slice.call(e.dataTransfer.types) : [];
        if (types.indexOf('Files') >= 0 || types.indexOf('text/x-p16-sound') >= 0) {
          e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragRow(t);
        }
      });
      row.addEventListener('dragleave', function (e) { if (!row.contains(e.relatedTarget)) setDragRow(-1); });
      row.addEventListener('drop', function (e) {
        e.preventDefault(); setDragRow(-1);
        var id = e.dataTransfer.getData('text/x-p16-sound');
        if (id) { assignSound(t, id); return; }
        var files = Array.prototype.filter.call(e.dataTransfer.files || [], isAudioFile);
        if (files.length) importInto(t, files[0]);
        else hint('Drop audio files (WAV, AIFF, MP3, M4A, FLAC, OGG) onto a track row', true);
      });
    })(t);
    main.appendChild(rowsEl);
    U.hintEl = h('div', 'p16-hint', { 'aria-live': 'polite' });
    main.appendChild(U.hintEl);
    body.appendChild(main);

    /* ---------------- library panel */
    var lib = h('div', 'p16-lib');
    U.libCount = h('span', 'p16-lib-n');
    lib.appendChild(h('div', 'p16-lib-h', null, [h('b', null, { text: 'SOUND LIBRARY' }), U.libCount]));
    U.libInto = h('div', 'p16-lib-into');
    lib.appendChild(U.libInto);
    var search = h('input', 'p16-search', { type: 'search', placeholder: 'Search sounds...', 'aria-label': 'Search sounds', spellcheck: 'false' });
    lib.appendChild(search);
    var lists = h('div', 'p16-lists');
    U.catList = h('div', 'p16-cats', { role: 'listbox', 'aria-label': 'Categories' });
    U.sndList = h('div', 'p16-sounds', { role: 'listbox', 'aria-label': 'Sounds', tabindex: '0' });
    lists.appendChild(U.catList); lists.appendChild(U.sndList);
    lib.appendChild(lists);
    var assignB = btn('wide', 'Assign', 'Load the selected sound into the selected track');
    var importB = btn('', 'Import Files…', 'Import audio files of your own (they are kept in this browser and saved with exported projects)');
    var synthB = btn('', 'Use Synth', 'Put the selected track back on its built-in synth voice');
    var fileIn = h('input', null, { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg,.caf', multiple: '' });
    fileIn.style.display = 'none';
    lib.appendChild(assignB);
    lib.appendChild(h('div', 'p16-lib-2', null, [importB, synthB]));
    lib.appendChild(fileIn);
    body.appendChild(lib);
    root.appendChild(body);

    root.appendChild(h('div', 'p16-foot', { html: 'Keys <kbd>A</kbd> <kbd>W</kbd> <kbd>S</kbd> <kbd>E</kbd> <kbd>D</kbd> <kbd>F</kbd> <kbd>T</kbd> <kbd>G</kbd> (or C–G on any octave) play pads · <kbd>R</kbd> + play to record · Click a sound to preview, double-click to load · Drop audio files on a row · Right-click a pad for MIDI learn' }));
    root.appendChild(bubble);

    var menu = h('div', 'p16-menu', { role: 'menu' });
    root.appendChild(menu);

    /* ---------------- render helpers */
    function selectTrack(t, quiet) {
      U.sel = clamp(t, 0, NT - 1);
      U.rows.forEach(function (r, i) { r.row.classList.toggle('sel', i === U.sel); });
      U.libInto.innerHTML = 'Loads into: <b>' + TRACK_NAMES[U.sel] + '</b>';
      if (!quiet) renderSoundList();
    }
    function paintPad(t) {
      var f = U.flash[t];
      U.rows[t].pad.style.setProperty('--f', f.toFixed(3));
      U.rows[t].pad.classList.toggle('lit', f > 0.5);
    }
    function setDragRow(t) { U.rows.forEach(function (r, i) { r.row.classList.toggle('drop', i === t); }); }
    U.renderPads = function () {
      U.rows.forEach(function (r, t) {
        var learning = learnTrack === t;
        r.pad.classList.toggle('learn', learning);
        r.pad.querySelector('.p16-pad-n').textContent = learning ? 'LEARN' : TRACK_NAMES[t];
        r.key.textContent = S.keymap === 0 ? QWERTY[t] : '';
        r.pad.title = TRACK_NAMES[t] + '  -  MIDI ' + describeKeymap(t) + (S.keymap === 0 ? '  -  key ' + QWERTY[t] : '') +
          '\nClick to play (shift = accent). Right-click: MIDI learn / load sound.';
      });
    };
    refreshTrack = function (t) {
      if (!U.rows) return;
      var r = U.rows[t], tr = S.tracks[t];
      var name = tr.sound ? displayName(tr.sound) : 'Synth';
      var miss = tr.sound && missing[tr.sound], busy = tr.sound && loading[tr.sound];
      r.snd.textContent = name + (miss ? ' (missing)' : '');
      r.snd.classList.toggle('synth', !tr.sound);
      r.snd.classList.toggle('miss', !!miss);
      r.snd.classList.toggle('busy', !!busy);
      r.snd.title = (tr.sound ? tr.sound + (miss ? '\nCould not be found - this track plays its synth voice' : '') : 'Synth voice') + '\nClick to pick another sound from the library';
      r.smp.classList.toggle('on', tr.mode);
      r.smp.setAttribute('aria-pressed', tr.mode ? 'true' : 'false');
      r.x.disabled = !tr.sound;
      r.knobs.forEach(function (k) { k.draw(); });
      if (t === U.sel) renderSoundList();
    };
    U.renderGrid = function () {
      U.rows.forEach(function (r, t) {
        for (var s = 0; s < NS; s++) {
          var v = S.steps[t][s], c = r.cells[s];
          c.classList.toggle('on', v === 1);
          c.classList.toggle('acc', v === 2);
        }
      });
    };
    U.setPlayhead = function (p) {
      if (p === U.playPos) return;
      U.rows.forEach(function (r) {
        if (U.playPos >= 0) r.cells[U.playPos].classList.remove('ph');
        if (p >= 0) r.cells[p].classList.add('ph');
      });
      var nums = colSteps.children;
      if (U.playPos >= 0) nums[U.playPos].classList.remove('ph');
      if (p >= 0) nums[p].classList.add('ph');
      U.playPos = p;
    };
    U.renderHeader = function () {
      kitSel.value = String(S.kit);
      keymapSel.value = String(S.keymap);
      recB.classList.toggle('on', S.rec); recB.setAttribute('aria-pressed', S.rec ? 'true' : 'false');
      var playing = !!(Studio.transport && Studio.transport.playing);
      runB.classList.toggle('on', playing); runB.setAttribute('aria-pressed', playing ? 'true' : 'false');
      quantB.classList.toggle('on', S.quantize); quantB.setAttribute('aria-pressed', S.quantize ? 'true' : 'false');
      U.gknobs.forEach(function (k) { k.draw(); });
    };
    renderAll = function () {
      if (!U.rows) return;
      for (var t = 0; t < NT; t++) refreshTrack(t);
      U.renderGrid(); U.renderHeader(); U.renderPads();
    };
    U.hint = hint;
    function hint(msg, important) {
      U.hintEl.textContent = msg;
      U.hintEl.classList.toggle('imp', !!important);
      U.hintEl.classList.add('on');
      U.hintT = performance.now();
    }

    /* ---------------- library */
    function categories() {
      var all = libEntries(), cats = ['All'];
      LIB_CATS.forEach(function (c) { if (all.some(function (e) { return e.cat === c; })) cats.push(c); });
      all.forEach(function (e) { if (cats.indexOf(e.cat) < 0 && e.cat !== 'User') cats.push(e.cat); });
      cats.push('User');
      return cats;
    }
    U.refreshLibrary = function () { renderCats(); renderSoundList(); };
    function renderCats() {
      var cats = categories();
      if (cats.indexOf(U.cat) < 0) U.cat = 'All';
      U.catList.innerHTML = '';
      cats.forEach(function (c) {
        var it = h('div', 'p16-cat' + (c === U.cat ? ' on' : ''), { role: 'option', text: c, 'aria-selected': c === U.cat ? 'true' : 'false' });
        it.onclick = function () { U.cat = c; U.libSel = -1; renderCats(); renderSoundList(); };
        U.catList.appendChild(it);
      });
    }
    function renderSoundList() {
      var all = libEntries(), q = U.query.toLowerCase();
      U.libCount.textContent = all.length + ' sounds';
      U.visible = all.filter(function (e) {
        if (U.cat !== 'All' && e.cat !== U.cat) return false;
        if (q && e.name.toLowerCase().indexOf(q) < 0 && e.cat.toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
      var loaded = S.tracks[U.sel].sound;
      U.sndList.innerHTML = '';
      if (!U.visible.length) {
        U.sndList.appendChild(h('div', 'p16-empty', { text: U.cat === 'User' && !q ? 'No sounds of your own yet. Use Import Files… or drop audio files here.' : 'No sounds match.' }));
      }
      U.visible.forEach(function (e, i) {
        var it = h('div', 'p16-snditem' + (i === U.libSel ? ' sel' : '') + (e.id === loaded ? ' loaded' : ''),
          { role: 'option', draggable: 'true', 'data-i': String(i), title: e.name + ' (' + e.cat + ')\nClick = preview, double-click = load, or drag onto a track row' },
          [h('i'), h('span', 'nm', { text: e.name }), U.cat === 'All' ? h('span', 'ct' + (e.builtIn ? '' : ' user'), { text: e.cat }) : null]);
        U.sndList.appendChild(it);
      });
    }
    function libSelect(i, play) {
      if (i < 0 || i >= U.visible.length) return;
      U.libSel = i;
      var items = U.sndList.querySelectorAll('.p16-snditem');
      for (var k = 0; k < items.length; k++) items[k].classList.toggle('sel', k === i);
      if (items[i] && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
      if (play) preview(U.visible[i].id);
    }
    function assignEntry(i) {
      if (i < 0 || i >= U.visible.length) { hint('Select a sound in the list first', true); return; }
      assignSound(U.sel, U.visible[i].id);
    }
    function assignSound(t, id) {
      selectTrack(t);
      if (!id) { loadSound(t, ''); hint(TRACK_NAMES[t] + ' is back on the synth voice'); return; }
      S.kit = -1; kitSel.value = '-1';
      loadSound(t, id).then(function (ok) {
        hint(ok ? 'Loaded "' + displayName(id) + '" into ' + TRACK_NAMES[t]
                : 'Couldn\'t load "' + displayName(id) + '" - is it a readable audio file?', !ok);
      });
    }
    function focusLibrary(msg) {
      var cat = TRACK_CATEGORY[U.sel];
      if (!U.query && U.cat !== cat && categories().indexOf(cat) >= 0) { U.cat = cat; U.libSel = -1; renderCats(); renderSoundList(); }
      lib.classList.remove('glow'); void lib.offsetWidth; lib.classList.add('glow');
      hint(msg, true);
      U.sndList.focus({ preventScroll: true });
    }
    function isAudioFile(f) { return /\.(wav|aiff?|flac|mp3|ogg|m4a|caf|aac|webm)$/i.test(f.name) || /^audio\//.test(f.type || ''); }
    function importFiles(files) {
      files = Array.prototype.filter.call(files || [], isAudioFile);
      if (!files.length) return Promise.resolve([]);
      return Promise.all(files.map(function (f) {
        return Studio.samples.importFile(f, { category: 'drums' }).catch(function (err) { hint(String(err && err.message || err), true); return null; });
      })).then(function (es) {
        es = es.filter(Boolean);
        U.refreshLibrary();
        return es;
      });
    }
    function importInto(t, file) {
      hint('Importing "' + file.name + '"…');
      importFiles([file]).then(function (es) { if (es[0]) assignSound(t, 'sample:' + es[0].id); });
    }

    search.addEventListener('input', function () { U.query = search.value.trim(); U.libSel = -1; renderSoundList(); });
    search.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { search.value = ''; U.query = ''; renderSoundList(); search.blur(); }
      if (e.key === 'Enter' && U.visible.length) { libSelect(0, true); U.sndList.focus(); }
    });
    U.sndList.addEventListener('click', function (e) {
      var it = e.target.closest('.p16-snditem'); if (!it) return;
      libSelect(+it.dataset.i, true);
    });
    U.sndList.addEventListener('dblclick', function (e) {
      var it = e.target.closest('.p16-snditem'); if (!it) return;
      assignEntry(+it.dataset.i);
    });
    U.sndList.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        libSelect(clamp(U.libSel + (e.key === 'ArrowDown' ? 1 : -1), 0, U.visible.length - 1), true);
      } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); assignEntry(U.libSel); }
    });
    U.sndList.addEventListener('dragstart', function (e) {
      var it = e.target.closest('.p16-snditem'); if (!it) return;
      var en = U.visible[+it.dataset.i]; if (!en) return;
      e.dataTransfer.setData('text/x-p16-sound', en.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    lib.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); lib.classList.add('drop'); }
    });
    lib.addEventListener('dragleave', function (e) { if (!lib.contains(e.relatedTarget)) lib.classList.remove('drop'); });
    lib.addEventListener('drop', function (e) {
      lib.classList.remove('drop');
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      importFiles(e.dataTransfer.files).then(function (es) {
        if (es.length) { U.cat = 'User'; U.query = ''; search.value = ''; renderCats(); renderSoundList(); hint('Imported ' + es.length + ' sound' + (es.length > 1 ? 's' : '') + ' - double-click one to load it into ' + TRACK_NAMES[U.sel]); }
      });
    });
    assignB.onclick = function () { assignEntry(U.libSel); };
    synthB.onclick = function () { assignSound(U.sel, ''); };
    importB.onclick = function () { fileIn.value = ''; fileIn.click(); };
    fileIn.onchange = function () {
      var files = Array.prototype.slice.call(fileIn.files || []);
      if (!files.length) return;
      var t = U.sel;
      importFiles(files).then(function (es) {
        if (!es.length) return;
        if (es.length === 1) { assignSound(t, 'sample:' + es[0].id); }
        else { U.cat = 'User'; renderCats(); renderSoundList(); hint('Imported ' + es.length + ' sounds into User - double-click one to load it'); }
      });
    };

    /* ---------------- header events */
    kitSel.onchange = function () {
      var i = +kitSel.value;
      if (i < 0) return;
      loadKit(i).then(function () { hint('Loaded kit "' + KITS[i].name + '"'); });
    };
    keymapSel.onchange = function () { S.keymap = +keymapSel.value; U.renderPads(); };
    function toggleRec() {
      S.rec = !S.rec; U.renderHeader();
      hint(S.rec ? 'Recording armed - press RUN (Space), then play pads / keys / MIDI' : 'Recording off', S.rec);
    }
    recB.onclick = toggleRec;
    runB.onclick = function () {
      var tr = Studio.transport;
      if (tr.playing) { if (tr.stop) tr.stop(); } else if (tr.start) tr.start();
      U.renderHeader();
    };
    clearB.onclick = function () {
      for (var t = 0; t < NT; t++) for (var s = 0; s < NS; s++) S.steps[t][s] = 0;
      U.renderGrid(); hint('Pattern cleared');
    };
    quantB.onclick = function () { S.quantize = !S.quantize; U.renderHeader(); };

    /* ---------------- step grid: click cycles off -> on -> accent; right-click toggles accent; drag paints */
    var paint = null;
    function cellFrom(e) {
      var el = document.elementFromPoint(e.clientX, e.clientY);
      return el && el.closest ? el.closest('.p16-cell') : null;
    }
    rowsEl.addEventListener('pointerdown', function (e) {
      var c = e.target.closest ? e.target.closest('.p16-cell') : null;
      if (!c) return;
      e.preventDefault();
      var t = +c.dataset.t, s = +c.dataset.s, cur = S.steps[t][s];
      var v = (e.button === 2 || e.ctrlKey) ? (cur === 2 ? 1 : 2) : (cur + 1) % 3;
      paint = { v: v, last: t + ':' + s, id: e.pointerId };
      S.steps[t][s] = v;
      try { rowsEl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
      U.renderGrid();
    });
    rowsEl.addEventListener('pointermove', function (e) {
      if (!paint || e.pointerId !== paint.id) return;
      var c = cellFrom(e); if (!c) return;
      var key = c.dataset.t + ':' + c.dataset.s;
      if (key === paint.last) return;
      paint.last = key;
      S.steps[+c.dataset.t][+c.dataset.s] = paint.v;
      U.renderGrid();
    });
    function endPaint() { paint = null; }
    rowsEl.addEventListener('pointerup', endPaint);
    rowsEl.addEventListener('pointercancel', endPaint);
    rowsEl.addEventListener('contextmenu', function (e) { if (e.target.closest('.p16-cell')) e.preventDefault(); });

    /* ---------------- pad context menu */
    function closeMenu() { menu.classList.remove('on'); }
    function padMenu(t, e) {
      menu.innerHTML = '';
      var learning = learnTrack === t;
      menu.appendChild(h('div', 'p16-mh', { text: TRACK_NAMES[t] + '  –  MIDI: ' + describeKeymap(t) }));
      function item(text, fn, enabled) {
        var it = h('button', 'p16-mi', { type: 'button', role: 'menuitem', text: text });
        if (enabled === false) it.disabled = true;
        it.onclick = function () { closeMenu(); fn(); };
        menu.appendChild(it);
      }
      item(learning ? 'Cancel MIDI Learn' : 'MIDI Learn (then play a key)', function () {
        if (learning) { learnTrack = -1; hint('MIDI learn cancelled'); }
        else { learnTrack = t; hint('MIDI learn: play a key on your keyboard for ' + TRACK_NAMES[t], true); }
        U.renderPads();
      });
      item('Clear learned note', function () { S.learned[t] = -1; U.renderPads(); hint('Learned note cleared for ' + TRACK_NAMES[t]); }, S.learned[t] >= 0);
      menu.appendChild(h('div', 'p16-msep'));
      item('Pick from library…', function () { focusLibrary('Pick a sound for ' + TRACK_NAMES[t] + ' from the library  →'); });
      item('Load sound… (file)', function () { U.sel = t; fileIn.value = ''; fileIn.click(); });
      item('Use synth', function () { assignSound(t, ''); }, !!S.tracks[t].sound);
      var rr = root.getBoundingClientRect();
      menu.style.left = Math.min(e.clientX - rr.left, rr.width - 250) + 'px';
      menu.style.top = Math.min(e.clientY - rr.top, rr.height - 200) + 'px';
      menu.classList.add('on');
    }
    root.addEventListener('pointerdown', function (e) { if (!menu.contains(e.target)) closeMenu(); }, true);

    // R toggles record while this plugin is shown (the shell's QWERTY map does not use R)
    window.addEventListener('keydown', function (e) {
      if (e.code !== 'KeyR' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!root.isConnected || !root.offsetParent) return;
      var tg = e.target && e.target.tagName;
      if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'SELECT' || (e.target && e.target.isContentEditable)) return;
      if (Studio.armed && Studio.armed !== 'pulse16') return;
      e.preventDefault(); toggleRec();
    });

    /* ---------------- animation: playhead + pad lights synced to the audio clock */
    var lastFrame = performance.now();
    function tick(now) {
      if (!root.isConnected) { U.raf = null; return; }
      var dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
      if (E) {
        var ct = E.ctx.currentTime;
        while (uiQueue.length && uiQueue[0].t <= ct) {
          var q = uiQueue.shift();
          if (q.pos != null) { if (Studio.transport && Studio.transport.playing) U.setPlayhead(q.pos); }
          else U.flash[q.track] = Math.max(U.flash[q.track], q.vel);
        }
        if (uiQueue.length > 400) uiQueue.splice(0, uiQueue.length - 400);
      }
      var k = Math.pow(0.8, dt * 30);
      for (var t = 0; t < NT; t++) {
        if (U.flash[t] > 0) { U.flash[t] = U.flash[t] < 0.01 ? 0 : U.flash[t] * k; paintPad(t); }
      }
      if (U.hintEl.classList.contains('on') && now - U.hintT > 6000) U.hintEl.classList.remove('on');
      var playing = !!(Studio.transport && Studio.transport.playing);
      if (playing !== runB.classList.contains('on')) U.renderHeader();
      if (!playing && U.playPos >= 0) U.setPlayhead(-1);
      U.raf = requestAnimationFrame(tick);
    }
    U.raf = requestAnimationFrame(tick);

    renderCats();
    selectTrack(0);
    renderAll();
  }

  if (window.Studio && Studio.registerPlugin) Studio.registerPlugin(def);
  else console.error('[pulse16] window.Studio not found');
})();
