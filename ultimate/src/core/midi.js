/* Ember Ultimate — input: Web MIDI (with MPE), QWERTY keys, on-screen keyboard. Routes to the armed plugin. */
(function () {
  'use strict';
  var Studio = window.Studio;
  var I = Studio.input = {
    mpeMode: 'auto',          // 'auto' | 'on' | 'off'
    mpeSeen: false,
    devices: [],
    octave: 0,                // QWERTY octave shift
    velocity: 0.8,            // QWERTY velocity
    held: {},                 // key -> {pid, note, info}
    activity: 0
  };
  // per channel (1..16) state
  var bendRange = [], rpn = [], lastBend = [];
  for (var c = 0; c <= 16; c++) { bendRange[c] = null; rpn[c] = [127, 127]; lastBend[c] = 0; }

  function isMember(ch) {
    if (I.mpeMode === 'off') return false;
    return ch >= 2;   // lower zone: ch1 master, 2–16 members
  }
  function rangeFor(ch, mpe) { return bendRange[ch] != null ? bendRange[ch] : (mpe ? 48 : 2); }
  function armed() { var p = Studio.byId[Studio.armed]; return p && p.ready && !p.failed ? p : null; }
  function now() { return Studio.ctx ? Studio.ctx.currentTime : 0; }

  /* ------------------------------------------------------------ dispatch (used by every source) */
  I.noteOn = function (note, vel, info, src) {
    var p = armed(); if (!p || note < 0 || note > 127) return;
    info = info || { ch: 1, mpe: false };
    var key = (src || 'x') + ':' + info.ch + ':' + note;
    if (I.held[key]) I.noteOff(note, info, src);
    I.held[key] = { pid: p.id, note: note, info: info };
    Studio._call(p, 'noteOn', note, Math.max(0.01, Math.min(1, vel)), now(), info);
    I.activity = 1;
    Studio._emit('note', note, vel, true);
  };
  I.noteOff = function (note, info, src) {
    info = info || { ch: 1, mpe: false };
    var key = (src || 'x') + ':' + info.ch + ':' + note, h = I.held[key];
    var p = h ? Studio.byId[h.pid] : armed();
    delete I.held[key];
    if (p) Studio._call(p, 'noteOff', note, now(), h ? h.info : info);
    Studio._emit('note', note, 0, false);
  };
  I.panic = function () {
    I.held = {};
    Studio.plugins.forEach(function (p) { if (p.ready) Studio._call(p, 'allNotesOff'); });
    Studio._emit('panic');
  };
  // when the armed plugin changes, release held notes on the old one
  Studio.on('arm', function () {
    Object.keys(I.held).forEach(function (k) {
      var h = I.held[k], p = Studio.byId[h.pid];
      if (p && p.id !== Studio.armed) { Studio._call(p, 'noteOff', h.note, now(), h.info); delete I.held[k]; }
    });
  });

  /* ------------------------------------------------------------ Web MIDI */
  function onMessage(e) {
    var d = e.data; if (!d || !d.length) return;
    var st = d[0], cmd = st & 0xf0, ch = (st & 0x0f) + 1, d1 = d[1] || 0, d2 = d[2] || 0;
    if (st >= 0xf0) return;   // clock / sysex ignored
    var mpe = isMember(ch);
    if (mpe && cmd === 0x90 && !I.mpeSeen) { I.mpeSeen = true; Studio._emit('midi'); }
    var info = { ch: ch, mpe: mpe };
    var p = armed();
    var src = 'm' + (e.target && e.target.id || '');
    if (cmd === 0x90 && d2 > 0) I.noteOn(d1, d2 / 127, { ch: ch, mpe: mpe, note: d1 }, src);
    else if (cmd === 0x80 || cmd === 0x90) I.noteOff(d1, { ch: ch, mpe: mpe, note: d1 }, src);
    else if (cmd === 0xe0) {
      var v = ((d2 << 7) | d1) - 8192; v = v / (v < 0 ? 8192 : 8191);
      lastBend[ch] = v;
      if (p) Studio._call(p, 'bend', v * rangeFor(ch, mpe), info);
    } else if (cmd === 0xd0) {
      if (p) Studio._call(p, 'pressure', d1 / 127, info);
    } else if (cmd === 0xa0) {
      if (p) Studio._call(p, 'pressure', d2 / 127, { ch: ch, mpe: mpe, note: d1, poly: true });
    } else if (cmd === 0xb0) {
      // RPN handling (bend range, MPE configuration)
      if (d1 === 101) { rpn[ch][0] = d2; return; }
      if (d1 === 100) { rpn[ch][1] = d2; return; }
      if (d1 === 6) {
        if (rpn[ch][0] === 0 && rpn[ch][1] === 0) {
          if (mpe) { for (var k = 2; k <= 16; k++) bendRange[k] = d2; } else bendRange[ch] = d2;
        } else if (rpn[ch][0] === 0 && rpn[ch][1] === 6) {   // MPE configuration message
          I.mpeSeen = d2 > 0; Studio._emit('midi');
        }
        return;
      }
      if (d1 === 38 || d1 === 98 || d1 === 99) return;
      if (d1 === 120 || d1 === 123) { if (p) Studio._call(p, 'allNotesOff'); return; }
      if (p) Studio._call(p, 'cc', d1, d2 / 127, info);
    }
    I.activity = 1;
  }

  I._onMessage = onMessage;
  I.initMIDI = function () {
    if (!navigator.requestMIDIAccess) { I.status = 'unsupported'; Studio._emit('midi'); return; }
    navigator.requestMIDIAccess({ sysex: false }).then(function (acc) {
      I.access = acc;
      function scan() {
        var names = [];
        acc.inputs.forEach(function (inp) {
          if (inp.state === 'disconnected') return;
          inp.onmidimessage = onMessage;
          names.push(inp.name || 'MIDI input');
        });
        var added = names.filter(function (n) { return I.devices.indexOf(n) < 0; });
        I.devices = names;
        I.status = names.length ? 'ok' : 'none';
        if (added.length && I._scanned) Studio.toast('MIDI connected: ' + added.join(', '));
        I._scanned = true;
        Studio._emit('midi');
      }
      acc.onstatechange = scan;
      scan();
    }, function (err) {
      I.status = 'denied'; console.warn('[studio] MIDI access refused', err && err.message);
      Studio._emit('midi');
    });
  };

  /* ------------------------------------------------------------ QWERTY */
  var KEYMAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
    KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
  var qHeld = {};
  function typing(e) {
    var t = e.target;
    if (!t || !t.tagName) return false;
    var tag = t.tagName;
    if (t.isContentEditable) return true;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') { var ty = (t.type || 'text').toLowerCase(); return ['range', 'checkbox', 'radio', 'button', 'file', 'color'].indexOf(ty) < 0; }
    return false;
  }
  I.base = function () { return 60 + I.octave * 12; };
  window.addEventListener('keydown', function (e) {
    if (!Studio._booted || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    if (e.code === 'Space') {
      var tg = e.target && e.target.tagName;
      if (tg === 'BUTTON' || tg === 'INPUT') e.target.blur();
      e.preventDefault(); if (!e.repeat) Studio.transport.toggle(); return;
    }
    if (e.code === 'Escape') { I.panic(); return; }
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      if (e.repeat) return;
      I.octave = Math.max(-4, Math.min(4, I.octave + (e.code === 'KeyX' ? 1 : -1)));
      Studio._emit('octave', I.octave); Studio.toast('Octave ' + (I.octave > 0 ? '+' : '') + I.octave);
      return;
    }
    if (e.code === 'KeyC' || e.code === 'KeyV') {
      I.velocity = Math.max(0.1, Math.min(1, I.velocity + (e.code === 'KeyV' ? 0.1 : -0.1)));
      Studio._emit('octave', I.octave); return;
    }
    if (e.code in KEYMAP) {
      e.preventDefault();
      if (e.repeat || qHeld[e.code] != null) return;
      var n = I.base() + KEYMAP[e.code];
      qHeld[e.code] = n;
      I.noteOn(n, I.velocity, { ch: 1, mpe: false }, 'q');
    }
  });
  window.addEventListener('keyup', function (e) {
    if (qHeld[e.code] != null) { I.noteOff(qHeld[e.code], { ch: 1, mpe: false }, 'q'); delete qHeld[e.code]; }
  });
  window.addEventListener('blur', function () {
    Object.keys(qHeld).forEach(function (k) { I.noteOff(qHeld[k], { ch: 1, mpe: false }, 'q'); });
    qHeld = {};
  });

  /* ------------------------------------------------------------ on-screen keyboard */
  I.buildKeyboard = function (host) {
    host.innerHTML = '';
    var kb = document.createElement('div'); kb.className = 'eu-kb';
    host.appendChild(kb);
    var keys = {};
    function render() {
      kb.innerHTML = '';
      var lo = I.base() - 12, hi = I.base() + 24;     // 3 octaves around the QWERTY octave
      var whites = 0;
      for (var n = lo; n <= hi; n++) if ([1, 3, 6, 8, 10].indexOf(n % 12) < 0) whites++;
      var w = 100 / whites, x = 0;
      keys = {};
      for (n = lo; n <= hi; n++) {
        var black = [1, 3, 6, 8, 10].indexOf(n % 12) >= 0;
        var k = document.createElement('div');
        k.className = 'eu-key ' + (black ? 'blk' : 'wht');
        k.dataset.note = n;
        if (black) { k.style.left = (x - w * 0.32) + '%'; k.style.width = (w * 0.64) + '%'; }
        else { k.style.left = x + '%'; k.style.width = w + '%'; x += w; }
        if (n % 12 === 0) { var lb = document.createElement('span'); lb.textContent = 'C' + (Math.floor(n / 12) - 1); k.appendChild(lb); }
        if (n === I.base()) k.classList.add('qwerty');
        kb.appendChild(k); keys[n] = k;
      }
    }
    render();
    Studio.on('octave', render);
    Studio.on('note', function (n, v, on) { var k = keys[n]; if (k) k.classList.toggle('on', on); });
    Studio.on('panic', function () { Object.keys(keys).forEach(function (n) { keys[n].classList.remove('on'); }); });
    var down = null;
    function velFrom(e, k) {
      var r = k.getBoundingClientRect();
      return Math.max(0.15, Math.min(1, (e.clientY - r.top) / r.height * 1.1)); // lower on key = louder
    }
    function keyAt(e) { var el = document.elementFromPoint(e.clientX, e.clientY); return el && el.closest && el.closest('.eu-key'); }
    kb.addEventListener('pointerdown', function (e) {
      var k = e.target.closest('.eu-key'); if (!k) return;
      e.preventDefault(); kb.setPointerCapture(e.pointerId);
      down = +k.dataset.note; I.noteOn(down, velFrom(e, k), { ch: 1, mpe: false }, 'p');
    });
    kb.addEventListener('pointermove', function (e) {
      if (down == null) return;
      var k = keyAt(e); if (!k || +k.dataset.note === down) return;
      I.noteOff(down, { ch: 1, mpe: false }, 'p');
      down = +k.dataset.note; I.noteOn(down, velFrom(e, k), { ch: 1, mpe: false }, 'p');
    });
    function up() { if (down != null) { I.noteOff(down, { ch: 1, mpe: false }, 'p'); down = null; } }
    kb.addEventListener('pointerup', up);
    kb.addEventListener('pointercancel', up);
  };
})();
