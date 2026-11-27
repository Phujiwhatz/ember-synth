/* Ember Ultimate - mock Studio for plugin harnesses.
 * Usage in tests/<id>-harness.html:
 *   <script src="mock-studio.js"></script>
 *   <script src="../src/plugins/<id>.js"></script>
 *   <div id="host"></div>
 *   <script> MockStudio.boot('<id>', document.getElementById('host')).then(p => ...) </script>
 * Serve ultimate/ with `python3 -m http.server` so ../samples/ resolves.
 * Exposes window.Studio implementing the CONTRACT.md API, plus window.MockStudio helpers:
 *   MockStudio.boot(id, el)   -> creates ctx (if needed), init()s plugin, mounts into el
 *   MockStudio.analyser       -> AnalyserNode on the master (for RMS checks)
 *   MockStudio.rms()          -> current RMS of the master output
 *   MockStudio.samplesBase    -> base url for samples (default '../samples/')
 */
(function () {
  'use strict';
  var plugins = {};
  var listeners = {};
  var mem = {};
  var bufCache = {};
  var manifest = { version: 1, samples: [], kits: {}, instruments: {} };
  var manifestLoaded = null;
  var userBuffers = {};

  function emit(evt) {
    var args = Array.prototype.slice.call(arguments, 1);
    (listeners[evt] || []).forEach(function (fn) {
      try { fn.apply(null, args); } catch (e) { console.error('[mock] listener error', evt, e); }
    });
  }

  var MockStudio = {
    samplesBase: '../samples/',
    master: null, analyser: null,
    rms: function () {
      if (!MockStudio.analyser) return 0;
      var a = new Float32Array(MockStudio.analyser.fftSize);
      MockStudio.analyser.getFloatTimeDomainData(a);
      var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * a[i];
      return Math.sqrt(s / a.length);
    },
    ensureCtx: function () {
      if (Studio.ctx) return Studio.ctx;
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      Studio.ctx = ctx;
      MockStudio.master = ctx.createGain();
      MockStudio.master.gain.value = 0.8;
      MockStudio.analyser = ctx.createAnalyser();
      MockStudio.analyser.fftSize = 2048;
      MockStudio.master.connect(MockStudio.analyser);
      MockStudio.analyser.connect(ctx.destination);
      return ctx;
    },
    boot: function (id, el) {
      var ctx = MockStudio.ensureCtx();
      var p = plugins[id];
      if (!p) return Promise.reject(new Error('plugin not registered: ' + id));
      var out = ctx.createGain();
      out.connect(MockStudio.master);
      p._out = out;
      return loadManifest().then(function () {
        return Promise.resolve(p.init ? p.init(ctx, out, Studio) : null);
      }).then(function () {
        if (el && p.mount) {
          var wrap = document.createElement('div');
          wrap.className = 'plug plug-' + id;
          el.appendChild(wrap);
          p.mount(wrap);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return p;
      });
    },
    plugins: plugins
  };

  function loadManifest() {
    if (manifestLoaded) return manifestLoaded;
    if (window.__MANIFEST__) { manifest = window.__MANIFEST__; Studio.samples.manifest = manifest; return (manifestLoaded = Promise.resolve(manifest)); }
    manifestLoaded = fetch(MockStudio.samplesBase + 'manifest.json').then(function (r) {
      if (!r.ok) throw new Error('no manifest');
      return r.json();
    }).then(function (m) {
      manifest = m; Studio.samples.manifest = m; return m;
    }).catch(function (e) {
      console.warn('[mock] samples/manifest.json not available:', e.message);
      Studio.samples.manifest = manifest; return manifest;
    });
    return manifestLoaded;
  }

  function findEntry(id) {
    var s = (manifest.samples || []);
    for (var i = 0; i < s.length; i++) if (s[i].id === id) return s[i];
    return null;
  }

  var transport = {
    bpm: 120, playing: false, swing: 0, step: 0,
    on: function (evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    off: function (evt, fn) { listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; }); },
    _timer: null, _next: 0, _step: 0,
    start: function () {
      var ctx = MockStudio.ensureCtx();
      if (transport.playing) return;
      transport.playing = true;
      transport._step = 0;
      transport._next = ctx.currentTime + 0.06;
      emit('start', transport._next);
      transport._timer = setInterval(transport._tick, 25);
      transport._tick();
    },
    stop: function () {
      if (!transport.playing) return;
      transport.playing = false;
      clearInterval(transport._timer);
      emit('stop');
    },
    setBpm: function (b) { transport.bpm = Math.max(40, Math.min(240, b)); emit('bpm', transport.bpm); },
    _tick: function () {
      var ctx = Studio.ctx;
      while (transport._next < ctx.currentTime + 0.1) {
        var sixteenth = 60 / transport.bpm / 4;
        var t = transport._next;
        if (transport._step % 2 === 1) t += transport.swing * sixteenth;
        transport.step = transport._step;
        emit('step', transport._step, t);
        transport._step++;
        transport._next += sixteenth;
      }
    }
  };

  var Studio = {
    version: 'mock',
    ctx: null,
    registerPlugin: function (def) {
      if (!def || !def.id) { console.error('[mock] registerPlugin: missing id'); return; }
      plugins[def.id] = def;
      console.log('[mock] registered plugin', def.id);
    },
    samples: {
      manifest: manifest,
      ready: function () { return loadManifest(); },
      get: function (id) {
        if (bufCache[id]) return bufCache[id];
        var ctx = MockStudio.ensureCtx();
        bufCache[id] = loadManifest().then(function () {
          if (userBuffers[id]) return ctx.decodeAudioData(userBuffers[id].slice(0));
          var e = findEntry(id);
          if (!e) throw new Error('unknown sample id: ' + id);
          if (window.__SAMPLES__ && window.__SAMPLES__[e.file]) {
            var bin = atob(window.__SAMPLES__[e.file]);
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            return ctx.decodeAudioData(u8.buffer);
          }
          return fetch(MockStudio.samplesBase + e.file).then(function (r) {
            if (!r.ok) throw new Error('fetch failed ' + e.file);
            return r.arrayBuffer();
          }).then(function (ab) { return ctx.decodeAudioData(ab); });
        });
        bufCache[id].catch(function () { delete bufCache[id]; });
        return bufCache[id];
      },
      byCategory: function (cat) {
        return (manifest.samples || []).filter(function (s) { return s.category === cat; });
      },
      importFile: function (file, opts) {
        opts = opts || {};
        var ctx = MockStudio.ensureCtx();
        return file.arrayBuffer().then(function (ab) {
          return ctx.decodeAudioData(ab.slice(0)).then(function (buf) {
            var id = 'user-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
            var entry = { id: id, file: 'user/' + file.name, name: file.name.replace(/\.[^.]+$/, ''),
              category: opts.category || 'user', user: true, root: 60, duration: buf.duration };
            userBuffers[id] = ab;
            bufCache[id] = Promise.resolve(buf);
            (manifest.samples = manifest.samples || []).push(entry);
            return entry;
          });
        });
      }
    },
    storage: {
      get: function (k) { return Promise.resolve(mem[k]); },
      set: function (k, v) { mem[k] = v; return Promise.resolve(); },
      del: function (k) { delete mem[k]; return Promise.resolve(); }
    },
    transport: transport,
    toast: function (msg) { console.log('[toast]', msg); },
    getPlugin: function (id) { return plugins[id]; }
  };

  window.Studio = Studio;
  window.MockStudio = MockStudio;
})();
