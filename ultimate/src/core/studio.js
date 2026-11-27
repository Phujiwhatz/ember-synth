/* Ember Ultimate — studio core: plugin registry, storage, samples, transport, project.
 * Load order inside the built file: studio.js, mixer.js, midi.js, recorder.js, ui.js, then plugins, then boot. */
(function () {
  'use strict';

  var listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return function () { off(evt, fn); }; }
  function off(evt, fn) { listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; }); }
  function emit(evt) {
    var a = Array.prototype.slice.call(arguments, 1), ls = (listeners[evt] || []).slice();
    for (var i = 0; i < ls.length; i++) {
      try { ls[i].apply(null, a); } catch (e) { console.error('[studio] "' + evt + '" listener failed:', e); }
    }
  }

  var Studio = window.Studio = {
    version: '1.0',
    ctx: null,
    plugins: [],          // registration order
    byId: {},
    armed: null,          // id of armed (selected) plugin
    on: on, off: off, _emit: emit,
    _hooks: {}            // core modules register internal hooks here
  };

  /* ---------------------------------------------------------------- plugins */
  Studio.registerPlugin = function (def) {
    if (!def || typeof def.id !== 'string' || !def.id) { console.error('[studio] registerPlugin: definition needs an id'); return; }
    if (Studio.byId[def.id]) { console.warn('[studio] plugin "' + def.id + '" registered twice; keeping the first'); return; }
    var p = { id: def.id, def: def, name: def.name || def.id, kind: def.kind || 'instrument',
      color: def.color || '#ec4a2c', icon: def.icon || '', ready: false, mounted: false, failed: false, el: null, strip: null };
    Studio.plugins.push(p);
    Studio.byId[def.id] = p;
    emit('register', p);
  };
  Studio.getPlugin = function (id) { var p = Studio.byId[id]; return p ? p.def : null; };

  /* call a plugin method safely */
  Studio._call = function (p, method) {
    if (!p || p.failed && method !== 'getState') return undefined;
    var fn = p.def[method];
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(p.def, Array.prototype.slice.call(arguments, 2)); }
    catch (e) { console.error('[studio] plugin "' + p.id + '".' + method + '() threw:', e); return undefined; }
  };

  /* ---------------------------------------------------------------- toast */
  Studio.toast = function (msg, kind) {
    var host = document.getElementById('eu-toasts');
    if (!host) { console.log('[toast]', msg); return; }
    var t = document.createElement('div');
    t.className = 'eu-toast' + (kind ? ' eu-toast-' + kind : '');
    t.textContent = String(msg);
    host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('in'); });
    setTimeout(function () { t.classList.remove('in'); setTimeout(function () { t.remove(); }, 300); }, 2600);
  };

  /* ---------------------------------------------------------------- storage (IndexedDB) */
  var mem = {}, dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res) {
      try {
        if (!window.indexedDB) return res(null);
        var rq = indexedDB.open('ember-ultimate', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = function () { console.warn('[studio] IndexedDB unavailable, using memory'); res(null); };
        rq.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (res, rej) {
        var t = d.transaction('kv', mode), st = t.objectStore('kv'), r = fn(st);
        t.oncomplete = function () { res(r && 'result' in r ? r.result : undefined); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }
  Studio.storage = {
    get: function (k) { return tx('readonly', function (st) { return st ? st.get(k) : { result: mem[k] }; }); },
    set: function (k, v) { return tx('readwrite', function (st) { if (st) st.put(v, k); else mem[k] = v; }); },
    del: function (k) { return tx('readwrite', function (st) { if (st) st.delete(k); else delete mem[k]; }); },
    keys: function () { return tx('readonly', function (st) { return st ? st.getAllKeys() : { result: Object.keys(mem) }; }); }
  };

  /* ---------------------------------------------------------------- samples */
  var manifest = window.__MANIFEST__ || { version: 1, samples: [], kits: {}, instruments: {} };
  manifest.samples = manifest.samples || []; manifest.kits = manifest.kits || {}; manifest.instruments = manifest.instruments || {};
  var bufCache = {}, idIndex = null;
  function entry(id) {
    if (!idIndex) { idIndex = {}; manifest.samples.forEach(function (s) { idIndex[s.id] = s; }); }
    return idIndex[id] || null;
  }
  function b64ToAb(b64) {
    var bin = atob(b64), n = bin.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  function abToB64(ab) {
    var u8 = new Uint8Array(ab), s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  Studio._b64 = { toAb: b64ToAb, fromAb: abToB64 };
  function decode(ab) {
    var ctx = Studio.ctx;
    return new Promise(function (res, rej) {
      var p = ctx.decodeAudioData(ab, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  }

  Studio.samples = {
    manifest: manifest,
    get: function (id) {
      if (bufCache[id]) return bufCache[id];
      var e = entry(id);
      var p;
      if (!e) p = Promise.reject(new Error('unknown sample id: ' + id));
      else if (!Studio.ctx) p = Promise.reject(new Error('audio not started yet'));
      else if (e.user) {
        p = Studio.storage.get('usersample:' + e.id).then(function (ab) {
          if (!ab) throw new Error('user sample missing: ' + id);
          return decode(ab.slice(0));
        });
      } else if (window.__SAMPLES__ && window.__SAMPLES__[e.file]) {
        p = Promise.resolve().then(function () { return decode(b64ToAb(window.__SAMPLES__[e.file])); });
      } else {
        p = fetch('samples/' + e.file).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(decode);
      }
      p = p.catch(function (err) { delete bufCache[id]; throw new Error('sample "' + id + '": ' + (err && err.message || err)); });
      bufCache[id] = p;
      return p;
    },
    has: function (id) { return !!entry(id); },
    byCategory: function (cat) { return manifest.samples.filter(function (s) { return s.category === cat; }); },
    importFile: function (file, opts) {
      opts = opts || {};
      if (!Studio.ctx) return Promise.reject(new Error('audio not started yet'));
      var ab0;
      return file.arrayBuffer().then(function (ab) {
        ab0 = ab;
        return decode(ab.slice(0)).catch(function () { throw new Error('Could not decode "' + file.name + '" (try WAV, MP3, M4A, AIFF or FLAC)'); });
      }).then(function (buf) {
        var id = 'user-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        var e = { id: id, file: 'user/' + file.name, name: file.name.replace(/\.[^.]+$/, ''), category: opts.category || 'user',
          tags: ['user'], user: true, root: opts.root || 60, duration: +buf.duration.toFixed(3), mime: file.type || '' };
        bufCache[id] = Promise.resolve(buf);
        return Studio.storage.set('usersample:' + id, ab0).then(function () {
          addUserEntry(e, true);
          Studio.toast('Imported "' + e.name + '"');
          return e;
        });
      });
    }
  };
  function addUserEntry(e, persist) {
    if (entry(e.id)) return;
    manifest.samples.push(e); idIndex[e.id] = e;
    if (persist) Studio.storage.set('usersamples', manifest.samples.filter(function (s) { return s.user; }));
    emit('samples', e);
  }
  Studio._restoreUserSamples = function () {
    return Studio.storage.get('usersamples').then(function (list) {
      (list || []).forEach(function (e) { addUserEntry(e, false); });
    }).catch(function (e) { console.warn('[studio] could not restore user samples', e); });
  };
  Studio._userSampleBlobs = function () { // for project export
    var users = manifest.samples.filter(function (s) { return s.user; });
    return Promise.all(users.map(function (e) {
      return Studio.storage.get('usersample:' + e.id).then(function (ab) { return ab ? { entry: e, data: abToB64(ab) } : null; });
    })).then(function (a) { return a.filter(Boolean); });
  };
  Studio._importUserSampleBlobs = function (list) {
    return Promise.all((list || []).map(function (u) {
      if (!u || !u.entry || entry(u.entry.id)) return null;
      return Studio.storage.set('usersample:' + u.entry.id, b64ToAb(u.data)).then(function () { addUserEntry(u.entry, true); });
    }));
  };

  /* ---------------------------------------------------------------- transport */
  var T = {
    _bpm: 120, _swing: 0, playing: false, metronome: false,
    step: 0,                 // next step to schedule
    startTime: 0, _next: 0, _timer: null, _worker: null,
    visualQueue: []          // [{step,time}] for UI
  };
  var tapTimes = [];
  var transport = Studio.transport = {
    on: on, off: off,
    get bpm() { return T._bpm; },
    set bpm(v) { transport.setBpm(v); },
    get swing() { return T._swing; },
    set swing(v) { v = Math.max(0, Math.min(0.5, +v || 0)); T._swing = v; emit('swing', v); },
    get playing() { return T.playing; },
    get metronome() { return T.metronome; },
    set metronome(v) { T.metronome = !!v; emit('metronome', T.metronome); },
    get position() { return T.uiStep || 0; },
    setBpm: function (v) {
      v = Math.round(Math.max(40, Math.min(240, +v || 120)) * 10) / 10;
      if (v === T._bpm) return;
      T._bpm = v; emit('bpm', v);
    },
    tap: function () {
      var now = performance.now();
      if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes = [];
      tapTimes.push(now);
      if (tapTimes.length > 5) tapTimes.shift();
      if (tapTimes.length >= 2) {
        var d = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
        transport.setBpm(Math.round(60000 / d));
      }
    },
    start: function () {
      var ctx = Studio.ctx;
      if (!ctx || T.playing) return;
      if (ctx.state !== 'running') ctx.resume();
      T.playing = true;
      T.step = 0;
      T.startTime = T._next = ctx.currentTime + 0.08;
      T.visualQueue = [];
      T._lastTick = 0; T._ahead = 0.1;
      emit('start', T.startTime);
      tick();
      startTimer();
    },
    stop: function () {
      if (!T.playing) return;
      T.playing = false;
      stopTimer();
      T.visualQueue = [];
      T.uiStep = -1;
      emit('stop');
    },
    toggle: function () { if (T.playing) transport.stop(); else transport.start(); },
    sixteenth: function () { return 60 / T._bpm / 4; }
  };
  Studio._T = T;

  function tick() {
    var ctx = Studio.ctx;
    if (!T.playing || !ctx) return;
    // Lookahead is 100 ms, stretched (up to 250 ms) when the main thread is busy so ticks arrive late.
    var nowMs = performance.now(), gap = T._lastTick ? (nowMs - T._lastTick) / 1000 : 0.025;
    T._lastTick = nowMs;
    T._ahead = Math.max(0.1, Math.min(0.25, Math.max(gap * 1.6, (T._ahead || 0.1) * 0.97)));
    var horizon = ctx.currentTime + T._ahead;
    // only if we fell very far behind (tab asleep / laptop lid) re-anchor instead of bursting
    if (T._next < ctx.currentTime - 1) T._next = ctx.currentTime + 0.02;
    while (T._next < horizon) {
      var six = 60 / T._bpm / 4;
      var t = T._next + (T.step % 2 === 1 ? T._swing * six : 0);
      emit('step', T.step, t);
      T.visualQueue.push({ step: T.step, time: t });
      if (T.metronome && T.step % 4 === 0) Studio._hooks.click && Studio._hooks.click(t, T.step % 16 === 0);
      T.step++;
      T._next += six;
    }
  }
  // Worker-driven clock keeps ticking when the tab is in the background (setInterval gets throttled).
  function startTimer() {
    stopTimer();
    try {
      if (!T._workerUrl) T._workerUrl = URL.createObjectURL(new Blob(['var i=null;onmessage=function(e){clearInterval(i);if(e.data==="start")i=setInterval(function(){postMessage(0)},25)}'], { type: 'text/javascript' }));
      if (!T._worker) { T._worker = new Worker(T._workerUrl); T._worker.onmessage = tick; }
      T._worker.postMessage('start');
    } catch (e) {
      T._worker = null;
      T._timer = setInterval(tick, 25);
    }
  }
  function stopTimer() {
    if (T._worker) T._worker.postMessage('stop');
    if (T._timer) clearInterval(T._timer);
    T._timer = null;
  }

  /* ---------------------------------------------------------------- audio start + plugin init */
  Studio.startAudio = function () {
    if (Studio._starting) return Studio._starting;
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = Studio.ctx = new AC({ latencyHint: 'interactive' });
    if (ctx.state !== 'running') ctx.resume();
    Studio._hooks.buildMixer(ctx);
    emit('audio', ctx);
    Studio._starting = Studio._restoreUserSamples().then(function () {
      return Promise.all(Studio.plugins.map(initPlugin));
    }).then(function () {
      emit('ready');
      return Studio;
    });
    return Studio._starting;
  };

  function initPlugin(p) {
    p.strip = Studio._hooks.createStrip(p);
    var r;
    try { r = p.def.init ? p.def.init(Studio.ctx, p.strip.input, Studio) : null; }
    catch (e) { p.failed = true; console.error('[studio] plugin "' + p.id + '" init() failed:', e); Studio.toast(p.name + ' failed to load', 'err'); return; }
    return Promise.resolve(r).then(function () {
      p.ready = true;
      try { p.defaults = p.def.getState ? JSON.parse(JSON.stringify(p.def.getState())) : null; } catch (e) { p.defaults = null; }
      emit('plugin-ready', p);
    }, function (e) {
      p.failed = true; console.error('[studio] plugin "' + p.id + '" init() failed:', e); Studio.toast(p.name + ' failed to load', 'err');
    });
  }

  /* ---------------------------------------------------------------- project */
  Studio.project = {
    name: 'Untitled',
    serialize: function () {
      var s = { app: 'ember-ultimate', version: 1, name: Studio.project.name, savedAt: new Date().toISOString(),
        bpm: T._bpm, swing: T._swing, metronome: T.metronome, armed: Studio.armed,
        mixer: Studio._hooks.mixerState ? Studio._hooks.mixerState() : null, plugins: {} };
      Studio.plugins.forEach(function (p) {
        if (!p.ready) return;
        var st = Studio._call(p, 'getState');
        if (st !== undefined) s.plugins[p.id] = st;
      });
      return s;
    },
    apply: function (s) {
      if (!s || s.app !== 'ember-ultimate') throw new Error('Not an Ember Ultimate project');
      Studio.plugins.forEach(function (p) { Studio._call(p, 'allNotesOff'); });
      if (s.name) Studio.project.name = s.name;
      if (s.bpm) transport.setBpm(s.bpm);
      if (s.swing != null) transport.swing = s.swing;
      if (s.metronome != null) transport.metronome = s.metronome;
      if (s.mixer && Studio._hooks.setMixerState) Studio._hooks.setMixerState(s.mixer);
      Studio.plugins.forEach(function (p) {
        if (p.ready && s.plugins && s.plugins[p.id] !== undefined) Studio._call(p, 'setState', s.plugins[p.id]);
      });
      if (s.armed && Studio.byId[s.armed]) Studio._hooks.arm && Studio._hooks.arm(s.armed);
      emit('project', s);
    },
    reset: function () {
      transport.stop();
      Studio.plugins.forEach(function (p) {
        Studio._call(p, 'allNotesOff');
        if (!p.ready) return;
        if (typeof p.def.reset === 'function') Studio._call(p, 'reset');
        else if (p.defaults) Studio._call(p, 'setState', JSON.parse(JSON.stringify(p.defaults)));
      });
      Studio.project.name = 'Untitled';
      transport.setBpm(120); transport.swing = 0; transport.metronome = false;
      Studio._hooks.setMixerState && Studio._hooks.setMixerState(null);
      emit('project', null);
    },
    exportFile: function () {
      var s = Studio.project.serialize();
      return Studio._userSampleBlobs().then(function (u) {
        if (u.length) s.userSamples = u;
        var blob = new Blob([JSON.stringify(s)], { type: 'application/json' });
        download(blob, (s.name || 'project').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.ember.json');
      });
    },
    importFile: function (file) {
      return file.text().then(function (txt) {
        var s = JSON.parse(txt);
        return Studio._importUserSampleBlobs(s.userSamples).then(function () {
          delete s.userSamples;
          Studio.project.apply(s);
          Studio.toast('Loaded "' + (s.name || file.name) + '"');
        });
      });
    },
    saveSlot: function (name) {
      var s = Studio.project.serialize(); s.name = name || s.name;
      Studio.project.name = s.name;
      return Studio.storage.get('projects').then(function (idx) {
        idx = (idx || []).filter(function (n) { return n !== s.name; }); idx.unshift(s.name);
        return Promise.all([Studio.storage.set('projects', idx), Studio.storage.set('project:' + s.name, s)]);
      }).then(function () { Studio.toast('Saved "' + s.name + '"'); emit('project', s); });
    },
    listSlots: function () { return Studio.storage.get('projects').then(function (x) { return x || []; }); },
    loadSlot: function (name) {
      return Studio.storage.get('project:' + name).then(function (s) {
        if (!s) throw new Error('No project named ' + name);
        Studio.project.apply(s); Studio.toast('Loaded "' + name + '"');
      });
    },
    deleteSlot: function (name) {
      return Studio.storage.get('projects').then(function (idx) {
        return Promise.all([Studio.storage.set('projects', (idx || []).filter(function (n) { return n !== name; })), Studio.storage.del('project:' + name)]);
      });
    }
  };
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  Studio._download = download;

  // Autosave every 4 s when something changed.
  var lastSaved = '';
  Studio._autosave = function (force) {
    if (!Studio.ctx || !Studio._booted) return Promise.resolve();
    var s;
    try { s = Studio.project.serialize(); } catch (e) { return Promise.resolve(); }
    delete s.savedAt;
    var js = JSON.stringify(s);
    if (!force && js === lastSaved) return Promise.resolve();
    lastSaved = js;
    return Studio.storage.set('autosave', s).catch(function (e) { console.warn('[studio] autosave failed', e); });
  };
  Studio._restoreAutosave = function () {
    return Studio.storage.get('autosave').then(function (s) {
      if (s && s.app === 'ember-ultimate') {
        try { Studio.project.apply(s); lastSaved = JSON.stringify(s); return true; }
        catch (e) { console.warn('[studio] autosave restore failed', e); }
      }
      return false;
    }).catch(function () { return false; });
  };
})();
