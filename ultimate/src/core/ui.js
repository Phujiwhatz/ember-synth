/* Ember Ultimate — UI chrome: top bar, plugin tabs, stage, mixer dock, keyboard, overlay, boot. */
(function () {
  'use strict';
  var Studio = window.Studio;
  var M = Studio.mixer, I = Studio.input, R = Studio.recorder;

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') { for (var sk in v) el.style.setProperty(sk.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }), v[sk]); }
      else el.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  var IC = {
    play: '<svg viewBox="0 0 20 20"><path d="M6 4l10 6-10 6z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor"/></svg>',
    rec: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="5.5" fill="currentColor"/></svg>',
    metro: '<svg viewBox="0 0 20 20"><path d="M7.5 3h5l3 14h-11z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 13l4.5-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    keys: '<svg viewBox="0 0 20 20"><rect x="2.5" y="5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 5v6M10 5v6M13.5 5v6" stroke="currentColor" stroke-width="1.5"/></svg>',
    mixer: '<svg viewBox="0 0 20 20"><path d="M5 3v14M10 3v14M15 3v14" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="10" width="4" height="3" rx="1" fill="currentColor"/><rect x="8" y="5" width="4" height="3" rx="1" fill="currentColor"/><rect x="13" y="12" width="4" height="3" rx="1" fill="currentColor"/></svg>',
    menu: '<svg viewBox="0 0 20 20"><path d="M4 6h12M4 10h12M4 14h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    panic: '<svg viewBox="0 0 20 20"><path d="M10 3l8 14H2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10 8v4M10 14.2v.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    midi: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="9" r="1" fill="currentColor"/><circle cx="13.5" cy="9" r="1" fill="currentColor"/><circle cx="8" cy="12.5" r="1" fill="currentColor"/><circle cx="12" cy="12.5" r="1" fill="currentColor"/><circle cx="10" cy="13.6" r="1" fill="currentColor"/></svg>'
  };

  /* ------------------------------------------------------------ reusable controls (also offered to plugins) */
  var ui = Studio.ui = {};
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Rotary knob. opts: {label, min, max, value, def, step, fmt(v), onChange(v), size, color, bipolar, curve:'lin'|'log'}
  ui.knob = function (o) {
    var min = o.min != null ? o.min : 0, max = o.max != null ? o.max : 1, val = o.value != null ? o.value : min;
    var def = o.def != null ? o.def : val, size = o.size || 34, fmt = o.fmt || function (v) { return v.toFixed(2); };
    var R0 = size / 2 - 3, C = size / 2, A0 = -135, A1 = 135;
    function pol(a, r) { var rad = (a - 90) * Math.PI / 180; return [C + r * Math.cos(rad), C + r * Math.sin(rad)]; }
    function arc(a, b, r) { var p = pol(a, r), q = pol(b, r); return 'M' + p[0] + ' ' + p[1] + 'A' + r + ' ' + r + ' 0 ' + (b - a > 180 ? 1 : 0) + ' 1 ' + q[0] + ' ' + q[1]; }
    var el = h('div', { class: 'eu-knob', tabindex: 0, role: 'slider', 'aria-label': o.label || '' });
    if (o.color) el.style.setProperty('--kc', o.color);
    el.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' +
      '<path class="tr" d="' + arc(A0, A1, R0) + '"/><path class="va" d=""/>' +
      '<circle class="cap" cx="' + C + '" cy="' + C + '" r="' + (R0 - 4) + '"/><line class="ptr" x1="' + C + '" y1="' + C + '" x2="' + C + '" y2="' + (C - R0 + 6) + '"/></svg>' +
      (o.label ? '<span class="kl">' + o.label + '</span>' : '') + '<span class="kv"></span>';
    var va = el.querySelector('.va'), ptr = el.querySelector('.ptr'), kv = el.querySelector('.kv');
    function norm(v) { return o.curve === 'log' ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min); }
    function den(n) { return o.curve === 'log' ? min * Math.pow(max / min, n) : min + n * (max - min); }
    function draw() {
      var n = clamp(norm(val), 0, 1), a = A0 + n * (A1 - A0);
      var from = o.bipolar ? 0 : A0;
      va.setAttribute('d', Math.abs(a - from) < 0.5 ? '' : (a > from ? arc(from, a, R0) : arc(a, from, R0)));
      ptr.setAttribute('transform', 'rotate(' + a + ' ' + C + ' ' + C + ')');
      kv.textContent = fmt(val);
      el.setAttribute('aria-valuetext', fmt(val));
    }
    function set(v, fire) {
      v = clamp(v, Math.min(min, max), Math.max(min, max));
      if (o.step) v = Math.round(v / o.step) * o.step;
      val = v; draw();
      if (fire && o.onChange) o.onChange(v);
    }
    var sy = 0, sn = 0;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault(); el.focus(); el.setPointerCapture(e.pointerId); sy = e.clientY; sn = norm(val); el.classList.add('drag');
    });
    el.addEventListener('pointermove', function (e) {
      if (!el.hasPointerCapture(e.pointerId)) return;
      var n = clamp(sn + (sy - e.clientY) / (e.shiftKey ? 600 : 150), 0, 1);
      set(den(n), true);
    });
    el.addEventListener('pointerup', function () { el.classList.remove('drag'); });
    el.addEventListener('dblclick', function () { set(def, true); });
    el.addEventListener('wheel', function (e) { e.preventDefault(); set(den(clamp(norm(val) - Math.sign(e.deltaY) * 0.03, 0, 1)), true); }, { passive: false });
    el.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); e.stopPropagation(); set(den(clamp(norm(val) + d * (e.shiftKey ? 0.01 : 0.05), 0, 1)), true); }
    });
    draw();
    return { el: el, set: function (v) { set(v, false); }, get: function () { return val; } };
  };

  // Vertical fader (dB). opts: {min:-60, max:6, value, def, onChange}
  ui.fader = function (o) {
    var min = o.min != null ? o.min : -60, max = o.max != null ? o.max : 6, val = o.value != null ? o.value : 0, def = o.def != null ? o.def : 0;
    // non-linear taper: more resolution near 0 dB
    function toN(v) { return v <= min ? 0 : Math.pow((v - min) / (max - min), 2.2); }
    function fromN(n) { return n <= 0 ? min : min + Math.pow(n, 1 / 2.2) * (max - min); }
    var el = h('div', { class: 'eu-fader', tabindex: 0, role: 'slider', 'aria-label': o.label || 'Volume' }, [h('div', { class: 'ft' }), h('div', { class: 'fz' }), h('div', { class: 'fc' })]);
    var cap = el.querySelector('.fc'), zero = el.querySelector('.fz');
    function draw() {
      var n = Math.pow(toN(val), 1 / 2.2);
      cap.style.bottom = 'calc(' + (n * 100) + '% - ' + (n * 14) + 'px)';
      zero.style.bottom = 'calc(' + (Math.pow(toN(0), 1 / 2.2) * 100) + '% - ' + (Math.pow(toN(0), 1 / 2.2) * 14 - 7) + 'px)';
      el.setAttribute('aria-valuetext', val <= min ? '-inf dB' : val.toFixed(1) + ' dB');
    }
    function set(v, fire) { val = clamp(v, min, max); if (Math.abs(val) < 0.25 && v !== min) val = 0; draw(); if (fire && o.onChange) o.onChange(val <= min + 0.01 ? -120 : val); }
    function fromEvent(e) {
      var r = el.getBoundingClientRect(), n = clamp(1 - (e.clientY - r.top - 7) / (r.height - 14), 0, 1);
      return fromN(Math.pow(n, 2.2));
    }
    var dragging = false, sy = 0, sv = 0;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault(); el.focus(); el.setPointerCapture(e.pointerId); dragging = true;
      if (e.target === cap) { sy = e.clientY; sv = Math.pow(toN(val), 1 / 2.2); }
      else { set(fromEvent(e), true); sy = e.clientY; sv = Math.pow(toN(val), 1 / 2.2); }
    });
    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var r = el.getBoundingClientRect();
      var n = clamp(sv + (sy - e.clientY) / (r.height - 14) * (e.shiftKey ? 0.25 : 1), 0, 1);
      set(fromN(Math.pow(n, 2.2)), true);
    });
    el.addEventListener('pointerup', function () { dragging = false; });
    el.addEventListener('dblclick', function () { set(def, true); });
    el.addEventListener('wheel', function (e) { e.preventDefault(); set(val - Math.sign(e.deltaY) * 1, true); }, { passive: false });
    el.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
      if (d) { e.preventDefault(); e.stopPropagation(); set(val + d * (e.shiftKey ? 0.1 : 1), true); }
    });
    draw();
    return { el: el, set: function (v) { set(v < min ? min : v, false); }, get: function () { return val; } };
  };

  /* ------------------------------------------------------------ top bar */
  var els = {};
  function fmtDb(v) { return v <= -60 ? '−∞' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1); }

  function buildTop() {
    var top = $('#eu-top');
    els.play = h('button', { class: 'eu-tbtn eu-play', title: 'Play / stop (Space)', 'aria-label': 'Play', html: IC.play, onclick: function () { Studio.transport.toggle(); } });
    els.rec = h('button', { class: 'eu-tbtn eu-rec', title: 'Record master to a WAV file', 'aria-label': 'Record', html: IC.rec, onclick: function () { R.toggle(); } });
    els.pos = h('span', { class: 'eu-pos', text: '1.1.1' });
    els.beats = h('span', { class: 'eu-beats', html: '<i></i><i></i><i></i><i></i>' });
    els.rtime = h('span', { class: 'eu-rtime', text: '' });
    var lcd = h('div', { class: 'eu-lcd' }, [h('span', { class: 'eu-lcd-k', text: 'BAR' }), els.pos, els.beats, els.rtime]);

    els.bpm = h('input', { class: 'eu-bpm-in', type: 'text', inputmode: 'decimal', value: '120', 'aria-label': 'Tempo in BPM', spellcheck: 'false' });
    els.bpm.addEventListener('change', function () { Studio.transport.setBpm(parseFloat(els.bpm.value)); els.bpm.value = Studio.transport.bpm; els.bpm.blur(); });
    els.bpm.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') els.bpm.blur();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); Studio.transport.setBpm(Studio.transport.bpm + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)); }
    });
    els.bpm.addEventListener('wheel', function (e) { e.preventDefault(); Studio.transport.setBpm(Studio.transport.bpm - Math.sign(e.deltaY)); }, { passive: false });
    // drag the BPM box vertically
    (function () {
      var sy = null, sb = 0, moved = false;
      els.bpm.addEventListener('pointerdown', function (e) { if (document.activeElement === els.bpm) return; sy = e.clientY; sb = Studio.transport.bpm; moved = false; els.bpm.setPointerCapture(e.pointerId); e.preventDefault(); });
      els.bpm.addEventListener('pointermove', function (e) { if (sy == null) return; var d = Math.round((sy - e.clientY) / 3); if (d) moved = true; Studio.transport.setBpm(sb + d); });
      els.bpm.addEventListener('pointerup', function () { if (sy != null && !moved) { els.bpm.focus(); els.bpm.select(); } sy = null; });
    })();
    var tap = h('button', { class: 'eu-chip', text: 'TAP', title: 'Tap tempo', onclick: function () { Studio.transport.tap(); } });
    var bpmBox = h('div', { class: 'eu-field' }, [h('span', { class: 'eu-fl', text: 'BPM' }), els.bpm, tap]);

    els.swing = ui.knob({ label: '', min: 0, max: 0.5, value: 0, def: 0, size: 26, fmt: function (v) { return Math.round(v * 200) + '%'; },
      onChange: function (v) { Studio.transport.swing = v; } });
    var swingBox = h('div', { class: 'eu-field eu-swing' }, [h('span', { class: 'eu-fl', text: 'SWING' }), els.swing.el]);
    els.metro = h('button', { class: 'eu-tbtn eu-metro', title: 'Metronome', 'aria-label': 'Metronome', 'aria-pressed': 'false', html: IC.metro, onclick: function () { Studio.transport.metronome = !Studio.transport.metronome; } });

    var transport = h('div', { class: 'eu-transport' }, [els.play, els.rec, lcd, bpmBox, swingBox, els.metro]);

    els.cpu = h('div', { class: 'eu-stat', title: 'Audio load / output latency' }, [h('span', { class: 'eu-fl', text: 'CPU' }), h('span', { class: 'eu-cpubar' }, [h('i')]), h('b', { class: 'eu-cpuv', text: '—' }), h('span', { class: 'eu-fl', text: 'LAT' }), h('b', { class: 'eu-lat', text: '—' })]);
    els.midi = h('button', { class: 'eu-midi', title: 'MIDI status — click to cycle MPE mode', onclick: cycleMpe }, [h('span', { class: 'eu-led' }), h('span', { class: 'eu-midi-t', text: 'MIDI' })]);

    els.keysBtn = h('button', { class: 'eu-tbtn', title: 'On-screen keyboard (QWERTY: A–K, Z/X octave)', 'aria-label': 'Keyboard', 'aria-pressed': 'false', html: IC.keys, onclick: function () { toggleDock('keys'); } });
    els.mixBtn = h('button', { class: 'eu-tbtn', title: 'Mixer', 'aria-label': 'Mixer', 'aria-pressed': 'true', html: IC.mixer, onclick: function () { toggleDock('mixer'); } });
    els.panic = h('button', { class: 'eu-tbtn eu-panic', title: 'Panic: all notes off (Esc)', 'aria-label': 'Panic', html: IC.panic, onclick: function () { I.panic(); Studio.toast('All notes off'); } });
    els.menuBtn = h('button', { class: 'eu-proj', title: 'Project', 'aria-haspopup': 'true', onclick: function (e) { e.stopPropagation(); toggleMenu(); } },
      [h('span', { class: 'eu-proj-n', text: 'Untitled' }), h('span', { html: IC.menu, class: 'eu-proj-i' })]);

    var logo = h('div', { class: 'eu-logo', html: '<b>EMBER</b><i></i><span>ULTIMATE</span>' });
    top.appendChild(logo);
    top.appendChild(transport);
    top.appendChild(h('div', { class: 'eu-sp' }));
    top.appendChild(els.cpu);
    top.appendChild(els.midi);
    top.appendChild(h('div', { class: 'eu-grp' }, [els.keysBtn, els.mixBtn, els.panic]));
    top.appendChild(els.menuBtn);
  }

  function cycleMpe() {
    var modes = ['auto', 'on', 'off'];
    I.mpeMode = modes[(modes.indexOf(I.mpeMode) + 1) % 3];
    Studio.toast('MPE: ' + (I.mpeMode === 'auto' ? 'auto (channels 2–16 are MPE voices)' : I.mpeMode));
    Studio.storage.set('pref:mpe', I.mpeMode);
    renderMidi();
  }
  function renderMidi() {
    var st = I.status, t;
    if (!Studio.ctx) t = 'MIDI';
    else if (st === 'unsupported') t = 'No Web MIDI';
    else if (st === 'denied') t = 'MIDI blocked';
    else if (st === 'none' || !st) t = 'No MIDI device';
    else t = (I.devices.length > 1 ? I.devices.length + ' devices' : I.devices[0]);
    var mpe = I.mpeMode === 'off' ? '' : (I.mpeSeen || I.mpeMode === 'on') ? ' · MPE' : '';
    $('.eu-midi-t', els.midi).textContent = t + mpe;
    els.midi.dataset.state = st || 'none';
    els.midi.title = (I.devices.join(', ') || 'No MIDI input') + '\nMPE mode: ' + I.mpeMode + ' (click to change)';
  }

  /* ------------------------------------------------------------ project menu */
  function toggleMenu(force) {
    var m = $('#eu-menu'), open = force != null ? force : m.hidden;
    m.hidden = !open;
    if (open) renderMenu();
  }
  function renderMenu() {
    var m = $('#eu-menu');
    m.innerHTML = '';
    var name = h('input', { class: 'eu-name', type: 'text', value: Studio.project.name, 'aria-label': 'Project name', spellcheck: 'false' });
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') save(); });
    function save() { Studio.project.saveSlot(name.value.trim() || 'Untitled').then(renderMenu); }
    var file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    file.addEventListener('change', function () {
      if (file.files[0]) Studio.project.importFile(file.files[0]).catch(function (e) { Studio.toast(e.message, 'err'); });
      toggleMenu(false);
    });
    var smp = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.m4a,.aif,.aiff,.flac,.ogg', multiple: true, hidden: true });
    smp.addEventListener('change', function () {
      Array.prototype.forEach.call(smp.files, function (f) { Studio.samples.importFile(f, {}).catch(function (e) { Studio.toast(e.message, 'err'); }); });
      toggleMenu(false);
    });
    function item(label, kbd, fn) { return h('button', { class: 'eu-mi', onclick: function () { fn(); } }, [h('span', { text: label }), kbd ? h('kbd', { text: kbd }) : null]); }
    m.appendChild(h('div', { class: 'eu-mh', text: 'Project' }));
    m.appendChild(h('div', { class: 'eu-mrow' }, [name, h('button', { class: 'eu-chip hot', text: 'Save', onclick: save })]));
    m.appendChild(item('New project', '', function () { if (confirmNew()) { Studio.project.reset(); toggleMenu(false); Studio.toast('New project'); } }));
    m.appendChild(item('Export project file…', '.json', function () { Studio.project.exportFile(); toggleMenu(false); }));
    m.appendChild(item('Import project file…', '', function () { file.click(); }));
    m.appendChild(item('Import audio samples…', '', function () { smp.click(); }));
    m.appendChild(file); m.appendChild(smp);
    var list = h('div', { class: 'eu-slots' });
    m.appendChild(h('div', { class: 'eu-mh', text: 'Saved in this browser' }));
    m.appendChild(list);
    Studio.project.listSlots().then(function (names) {
      if (!names.length) list.appendChild(h('div', { class: 'eu-empty', text: 'Nothing saved yet' }));
      names.forEach(function (n) {
        list.appendChild(h('div', { class: 'eu-slot' }, [
          h('button', { class: 'eu-mi', text: n, onclick: function () { Studio.project.loadSlot(n); toggleMenu(false); } }),
          h('button', { class: 'eu-x', title: 'Delete', 'aria-label': 'Delete ' + n, text: '×', onclick: function () { Studio.project.deleteSlot(n).then(renderMenu); } })
        ]));
      });
    });
    m.appendChild(h('div', { class: 'eu-mh', text: 'Shortcuts' }));
    m.appendChild(h('div', { class: 'eu-help', html: '<kbd>Space</kbd> play/stop · <kbd>A</kbd>–<kbd>K</kbd> play notes · <kbd>Z</kbd>/<kbd>X</kbd> octave · <kbd>C</kbd>/<kbd>V</kbd> velocity · <kbd>Esc</kbd> panic' }));
  }
  function confirmNew() { return window.confirm ? window.confirm('Start a new project? Unsaved changes are lost (the autosave is replaced).') : true; }
  document.addEventListener('click', function (e) { var m = $('#eu-menu'); if (m && !m.hidden && !m.contains(e.target)) toggleMenu(false); });

  /* ------------------------------------------------------------ tabs + stage */
  function buildTabs() {
    var nav = $('#eu-tabs');
    nav.innerHTML = '';
    Studio.plugins.forEach(function (p) {
      var icon = p.icon ? h('span', { class: 'eu-ti', html: p.icon }) : h('span', { class: 'eu-ti eu-ti-l', text: (p.name || p.id).charAt(0) });
      var b = h('button', { class: 'eu-tab', role: 'tab', 'aria-selected': 'false', 'data-id': p.id, title: p.name + ' (' + p.kind + ')', style: { '--pc': p.color },
        onclick: function () { Studio._hooks.arm(p.id); } }, [icon, h('span', { class: 'eu-tn', text: p.name }), h('span', { class: 'eu-tk', text: p.kind }), h('i', { class: 'eu-act' })]);
      p.tab = b;
      nav.appendChild(b);
      var el = h('div', { class: 'plug plug-' + p.id, 'data-plugin': p.id, hidden: true });
      p.el = el;
      $('#eu-stage').appendChild(el);
    });
    if (!Studio.plugins.length) {
      $('#eu-stage').appendChild(h('div', { class: 'eu-nostage', html: '<b>No plugins found</b><span>Add files to <code>src/plugins/</code> and rebuild.</span>' }));
    }
  }
  Studio._hooks.arm = function (id) {
    var p = Studio.byId[id]; if (!p) return;
    Studio.armed = id;
    Studio.plugins.forEach(function (q) {
      if (q.tab) q.tab.setAttribute('aria-selected', q === p ? 'true' : 'false');
      if (q.el) q.el.hidden = q !== p;
    });
    $('#eu-app').style.setProperty('--armed', p.color);
    armedColor = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#ec4a2c';
    if (p.ready && !p.mounted && !p.failed) {
      p.mounted = true;
      try { p.def.mount && p.def.mount(p.el); }
      catch (e) { console.error('[studio] plugin "' + p.id + '" mount() failed:', e); p.el.appendChild(h('div', { class: 'eu-nostage', html: '<b>' + p.name + ' could not draw its panel</b><span>' + String(e && e.message || e) + '</span>' })); }
    }
    if (p.failed && !p.el.childNodes.length) p.el.appendChild(h('div', { class: 'eu-nostage', html: '<b>' + p.name + ' failed to start</b><span>See the console for details.</span>' }));
    Studio._emit('arm', id);
  };
  Studio.arm = Studio._hooks.arm;

  /* ------------------------------------------------------------ dock: mixer + keyboard */
  var dock = { mixer: true, keys: false };
  function toggleDock(which, force) {
    dock[which] = force != null ? force : !dock[which];
    $('#eu-mixer').hidden = !dock.mixer;
    $('#eu-keys').hidden = !dock.keys;
    els.mixBtn.setAttribute('aria-pressed', dock.mixer);
    els.keysBtn.setAttribute('aria-pressed', dock.keys);
    Studio.storage.set('pref:dock', dock);
  }

  var stripUI = {}, armedColor = '#ec4a2c';
  function buildMixer() {
    var host = $('#eu-strips');
    host.innerHTML = '';
    M.strips.forEach(function (s) {
      var p = s.plugin;
      var u = stripUI[s.id] = {};
      u.pan = ui.knob({ label: 'PAN', min: -1, max: 1, value: s.pan, def: 0, size: 30, bipolar: true, color: p.color,
        fmt: function (v) { return Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100); }, onChange: function (v) { M.set(s.id, 'pan', v); } });
      u.rev = ui.knob({ label: 'REV', min: 0, max: 1, value: s.rev, def: 0, size: 30, color: p.color, fmt: pct, onChange: function (v) { M.set(s.id, 'rev', v); } });
      u.dly = ui.knob({ label: 'DLY', min: 0, max: 1, value: s.dly, def: 0, size: 30, color: p.color, fmt: pct, onChange: function (v) { M.set(s.id, 'dly', v); } });
      u.fader = ui.fader({ min: -60, max: 6, value: s.vol, def: 0, label: p.name + ' volume', onChange: function (v) { M.set(s.id, 'vol', v); u.db.textContent = fmtDb(v); } });
      u.mute = h('button', { class: 'eu-ms m', text: 'M', title: 'Mute', 'aria-pressed': String(s.mute), onclick: function () { M.set(s.id, 'mute', !s.mute); } });
      u.solo = h('button', { class: 'eu-ms s', text: 'S', title: 'Solo', 'aria-pressed': String(s.solo), onclick: function () { M.set(s.id, 'solo', !s.solo); } });
      u.meter = h('div', { class: 'eu-meter' }, [h('i', { class: 'lv' }), h('i', { class: 'pk' })]);
      u.db = h('span', { class: 'eu-db', text: fmtDb(s.vol) });
      u.name = h('button', { class: 'eu-sn', title: 'Show ' + p.name, onclick: function () { Studio._hooks.arm(s.id); } }, [h('i'), h('span', { text: p.name })]);
      u.el = h('div', { class: 'eu-strip', 'data-id': s.id, style: { '--pc': p.color } }, [
        h('div', { class: 'eu-sh' }, [u.name]),
        h('div', { class: 'eu-sb' }, [
          h('div', { class: 'eu-sk' }, [u.pan.el, u.rev.el, u.dly.el]),
          h('div', { class: 'eu-sf' }, [u.meter, u.fader.el])
        ]),
        h('div', { class: 'eu-sfoot' }, [u.mute, u.solo, u.db])
      ]);
      host.appendChild(u.el);
    });
    if (!M.strips.length) host.appendChild(h('div', { class: 'eu-empty', text: 'Channel strips appear here for each plugin' }));
    buildMaster();
  }
  function pct(v) { return Math.round(v * 100) + '%'; }
  var DIVS = [[2, '1/8'], [3, '1/8.'], [4, '1/4'], [6, '1/4.'], [8, '1/2'], [1, '1/16']];
  function buildMaster() {
    var host = $('#eu-master');
    host.innerHTML = '';
    var u = stripUI.master = {};
    u.canvas = h('canvas', { class: 'eu-spec', title: 'Click: spectrum / scope' });
    u.canvas.addEventListener('click', function () { u.mode = u.mode === 'scope' ? 'spec' : 'scope'; });
    u.mode = 'spec';
    u.rev = ui.knob({ label: 'REVERB', min: 0, max: 1, value: M.fx.revRet.gain.value, def: 0.55, size: 26, fmt: pct, onChange: function (v) { M.set('master', 'rev', v); } });
    u.dly = ui.knob({ label: 'DELAY', min: 0, max: 1, value: M.fx.dlyRet.gain.value, def: 0.6, size: 26, fmt: pct, onChange: function (v) { M.set('master', 'dly', v); } });
    u.fb = ui.knob({ label: 'FDBK', min: 0, max: 0.85, value: M.fx.fb.gain.value, def: 0.42, size: 26, fmt: pct, onChange: function (v) { M.set('master', 'fb', v); } });
    u.div = h('select', { class: 'eu-sel', 'aria-label': 'Delay time', title: 'Delay time (tempo-synced)' });
    DIVS.forEach(function (d) { u.div.appendChild(h('option', { value: d[0], text: d[1], selected: d[0] === M.fx.delayDiv })); });
    u.div.addEventListener('change', function () { M.set('master', 'div', +u.div.value); });
    u.fader = ui.fader({ min: -60, max: 6, value: M.master.vol, def: -3, label: 'Master volume', onChange: function (v) { M.set('master', 'vol', v); u.db.textContent = fmtDb(v); } });
    u.mL = h('div', { class: 'eu-meter' }, [h('i', { class: 'lv' }), h('i', { class: 'pk' })]);
    u.mR = h('div', { class: 'eu-meter' }, [h('i', { class: 'lv' }), h('i', { class: 'pk' })]);
    u.db = h('span', { class: 'eu-db', text: fmtDb(M.master.vol) });
    u.gr = h('span', { class: 'eu-gr', text: 'GR 0.0' });
    u.clip = h('span', { class: 'eu-clip', text: 'LIMIT' });
    var scale = h('div', { class: 'eu-scale', html: '<span style="bottom:95%">0</span><span style="bottom:79%">-6</span><span style="bottom:58%">-12</span><span style="bottom:37%">-24</span><span style="bottom:16%">-48</span>' });
    host.appendChild(h('div', { class: 'eu-sh' }, [h('div', { class: 'eu-sn master' }, [h('span', { text: 'MASTER' })]), u.gr, u.clip]));
    host.appendChild(h('div', { class: 'eu-mbody' }, [
      h('div', { class: 'eu-mviz' }, [u.canvas]),
      h('div', { class: 'eu-mfx' }, [h('div', { class: 'eu-sk' }, [u.rev.el, u.dly.el, u.fb.el]), h('div', { class: 'eu-mfx-row' }, [h('span', { class: 'eu-fl', text: 'DLY TIME' }), u.div])]),
      h('div', { class: 'eu-sf eu-mf' }, [u.mL, u.mR, scale, u.fader.el])
    ]));
    host.appendChild(h('div', { class: 'eu-sfoot' }, [h('span', { class: 'eu-fl', text: 'Glue · Limiter · Soft clip' }), u.db]));
  }
  function syncMixerUI() {
    M.strips.forEach(function (s) {
      var u = stripUI[s.id]; if (!u) return;
      u.pan.set(s.pan); u.rev.set(s.rev); u.dly.set(s.dly); u.fader.set(s.vol); u.db.textContent = fmtDb(s.vol);
      u.mute.setAttribute('aria-pressed', s.mute); u.solo.setAttribute('aria-pressed', s.solo);
      u.el.classList.toggle('dim', s.mute || (M.anySolo && !s.solo));
    });
    var m = stripUI.master;
    if (m) { m.rev.set(M.fx.revRet.gain.value); m.dly.set(M.fx.dlyRet.gain.value); m.fb.set(M.fx.fb.gain.value); m.fader.set(M.master.vol); m.db.textContent = fmtDb(M.master.vol); m.div.value = M.fx.delayDiv; }
  }
  var syncQueued = false;
  Studio.on('mixer', function (id, key) {
    if (key === 'vol' || syncQueued) return;   // fader updates its own label; avoid re-entrancy during drag
    syncQueued = true; requestAnimationFrame(function () { syncQueued = false; syncMixerUI(); });
  });

  /* ------------------------------------------------------------ animation loop: meters, LCD, scope, stats */
  function meterH(p) { var db = 20 * Math.log10(p + 1e-9); return clamp((db + 60) / 60, 0, 1); }  // -60..0 dB
  function mtr(el, peak, hold) {
    el.firstChild.style.transform = 'scaleY(' + meterH(peak) + ')';
    el.lastChild.style.bottom = (meterH(hold) * 100) + '%';
    el.classList.toggle('hot', peak > 0.89);
  }
  var last = performance.now(), frameAcc = 0, frames = 0, lastStat = 0, specBuf = null, scopeBuf = null;
  function loop(t) {
    var dt = Math.min(0.1, (t - last) / 1000); last = t;
    frames++; frameAcc += dt;
    try { frame(dt, t); } catch (e) { console.error('[studio] ui frame', e); }
    requestAnimationFrame(loop);
  }
  function frame(dt, t) {
    var ctx = Studio.ctx; if (!ctx) return;
    M.updateMeters(dt);
    M.strips.forEach(function (s) {
      var u = stripUI[s.id]; if (!u) return;
      mtr(u.meter, s.peak, s.hold);
      if (s.plugin.tab) s.plugin.tab.style.setProperty('--act', Math.min(1, s.peak * 3).toFixed(2));
    });
    var m = M.master, mu = stripUI.master;
    if (mu) {
      mtr(mu.mL, m.peakL, m.holdL); mtr(mu.mR, m.peakR, m.holdR);
      mu.gr.textContent = 'GR ' + Math.abs(m.gr || 0).toFixed(1);
      mu.clip.classList.toggle('on', (m.limGR || 0) < -0.5 || m.clipLed > 0);
      drawViz(mu);
    }
    // transport position
    var T = Studio._T, q = T.visualQueue;
    while (q.length && q[0].time <= ctx.currentTime) { T.uiStep = q.shift().step; }
    if (T.playing && T.uiStep >= 0) {
      var st = T.uiStep;
      els.pos.textContent = (Math.floor(st / 16) + 1) + '.' + (Math.floor(st % 16 / 4) + 1) + '.' + (st % 4 + 1);
      var b = Math.floor(st % 16 / 4), bs = els.beats.children;
      for (var i = 0; i < 4; i++) bs[i].className = i === b ? (st % 4 === 0 ? 'on hit' : 'on') : '';
    } else if (!T.playing && els.pos.textContent !== '1.1.1') {
      els.pos.textContent = '1.1.1';
      Array.prototype.forEach.call(els.beats.children, function (x) { x.className = ''; });
    }
    els.rtime.textContent = R.recording ? '● ' + fmtTime(R.seconds) : '';
    // stats twice a second
    if (t - lastStat > 500) {
      lastStat = t;
      var load = cpu.value != null ? cpu.value : Math.max(0, Math.min(1, (frameAcc / Math.max(frames, 1) - 1 / 60) * 20));
      frames = 0; frameAcc = 0;
      $('.eu-cpubar i', els.cpu).style.transform = 'scaleX(' + clamp(load, 0.02, 1) + ')';
      $('.eu-cpuv', els.cpu).textContent = Math.round(load * 100) + '%';
      els.cpu.classList.toggle('hot', load > 0.8);
      var lat = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
      $('.eu-lat', els.cpu).textContent = lat ? lat.toFixed(0) + ' ms' : '—';
      if (I.activity > 0) I.activity = 0;
    }
    els.midi.classList.toggle('act', I.activity > 0);
  }
  function fmtTime(s) { var m = Math.floor(s / 60); s = s - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  var cpu = { value: null };
  function setupCpu(ctx) {
    // Chrome's renderCapacity (where available) reports real audio-thread load
    try {
      if (ctx.renderCapacity && ctx.renderCapacity.start) {
        ctx.renderCapacity.addEventListener('update', function (e) { cpu.value = e.averageLoad; });
        ctx.renderCapacity.start({ updateInterval: 0.5 });
      }
    } catch (e) { /* not supported */ }
  }

  function drawViz(u) {
    var c = u.canvas, dpr = window.devicePixelRatio || 1, w = c.clientWidth, hgt = c.clientHeight;
    if (!w || !hgt) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); }
    var g = c.getContext('2d'), an = M.master.spec;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    // grid
    g.strokeStyle = 'rgba(236,231,223,0.06)'; g.lineWidth = 1;
    for (var gx = 1; gx < 4; gx++) { g.beginPath(); g.moveTo(0, Math.round(hgt * gx / 4) + 0.5); g.lineTo(w, Math.round(hgt * gx / 4) + 0.5); g.stroke(); }
    var col = armedColor;
    if (u.mode === 'scope') {
      if (!scopeBuf) scopeBuf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(scopeBuf);
      var start = 0; for (var k = 1; k < scopeBuf.length / 2; k++) if (scopeBuf[k - 1] < 0 && scopeBuf[k] >= 0) { start = k; break; }
      var n = Math.min(1024, scopeBuf.length - start);
      g.beginPath();
      for (var j = 0; j < n; j++) { var x = j / (n - 1) * w, y = hgt / 2 - scopeBuf[start + j] * hgt * 0.45; if (j) g.lineTo(x, y); else g.moveTo(x, y); }
      g.strokeStyle = col; g.lineWidth = 1.5; g.shadowColor = col; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
      return;
    }
    if (!specBuf) specBuf = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(specBuf);
    var sr = Studio.ctx.sampleRate, bins = specBuf.length, fmin = 30, fmax = 18000, cols = Math.floor(w / 3);
    var grad = g.createLinearGradient(0, hgt, 0, 0);
    grad.addColorStop(0, col + '22'); grad.addColorStop(1, col + 'cc');
    g.beginPath(); g.moveTo(0, hgt);
    for (var i = 0; i <= cols; i++) {
      var f0 = fmin * Math.pow(fmax / fmin, i / cols), f1 = fmin * Math.pow(fmax / fmin, (i + 1) / cols);
      var b0 = Math.floor(f0 / (sr / 2) * bins), b1 = Math.max(b0 + 1, Math.floor(f1 / (sr / 2) * bins)), mx = -140;
      for (var bb = b0; bb < b1 && bb < bins; bb++) if (specBuf[bb] > mx) mx = specBuf[bb];
      var tilt = 3 * Math.log2(f0 / 1000);   // +3 dB/oct tilt so music reads flat
      var v = clamp((mx + tilt + 90) / 80, 0, 1);
      g.lineTo(i / cols * w, hgt - v * hgt * 0.95);
    }
    g.lineTo(w, hgt); g.closePath();
    g.fillStyle = grad; g.fill();
    g.strokeStyle = col; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = 'rgba(236,231,223,0.28)'; g.font = '9px ui-monospace,Menlo,monospace';
    [100, 1000, 10000].forEach(function (f) { var x = Math.log(f / fmin) / Math.log(fmax / fmin) * w; g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 2, hgt - 3); });
  }

  /* ------------------------------------------------------------ transport/UI sync */
  Studio.on('bpm', function (v) { if (document.activeElement !== els.bpm) els.bpm.value = v; });
  Studio.on('swing', function (v) { els.swing.set(v); });
  Studio.on('metronome', function (v) { els.metro.setAttribute('aria-pressed', v); });
  Studio.on('start', function () { els.play.innerHTML = IC.stop; els.play.classList.add('on'); els.play.setAttribute('aria-label', 'Stop'); });
  Studio.on('stop', function () { els.play.innerHTML = IC.play; els.play.classList.remove('on'); els.play.setAttribute('aria-label', 'Play'); });
  Studio.on('record', function (on) { els.rec.classList.toggle('on', on); $('#eu-app').classList.toggle('recording', on); });
  Studio.on('midi', renderMidi);
  Studio.on('project', function () { $('.eu-proj-n', els.menuBtn).textContent = Studio.project.name; syncMixerUI(); });

  /* ------------------------------------------------------------ overlay + boot */
  function buildOverlay() {
    var ov = $('#eu-overlay');
    var chips = Studio.plugins.map(function (p) { return '<span class="eu-och" style="--pc:' + p.color + '"><i></i>' + esc(p.name) + '</span>'; }).join('');
    ov.innerHTML = '<div class="eu-ocard"><div class="eu-ologo"><b>EMBER</b><i></i><span>ULTIMATE</span></div>' +
      '<p class="eu-osub">Offline music studio · ' + Studio.plugins.length + ' instrument' + (Studio.plugins.length === 1 ? '' : 's') + ' · MIDI &amp; MPE</p>' +
      '<div class="eu-ochips">' + chips + '</div>' +
      '<button class="eu-ostart" type="button"><span>' + IC.play + '</span>Click to start</button>' +
      '<p class="eu-ohint"><kbd>Space</kbd> play · <kbd>A</kbd>–<kbd>K</kbd> notes · <kbd>Z</kbd>/<kbd>X</kbd> octave · <kbd>Esc</kbd> panic</p></div>';
    function go(e) {
      if (e && e.type === 'keydown' && (e.metaKey || e.ctrlKey)) return;
      ov.removeEventListener('pointerdown', go); window.removeEventListener('keydown', go, true);
      ov.classList.add('starting');
      $('.eu-ostart', ov).lastChild.textContent = 'Starting…';
      start().then(function () { ov.classList.add('gone'); setTimeout(function () { ov.hidden = true; }, 400); });
    }
    ov.addEventListener('pointerdown', go);
    window.addEventListener('keydown', go, true);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function start() {
    return Studio.startAudio().then(function () {
      setupCpu(Studio.ctx);
      buildMixer();
      return Promise.all([Studio.storage.get('pref:dock'), Studio.storage.get('pref:mpe')]).catch(function () { return []; });
    }).then(function (prefs) {
      if (prefs[0]) { toggleDock('mixer', !!prefs[0].mixer); toggleDock('keys', !!prefs[0].keys); }
      if (prefs[1]) I.mpeMode = prefs[1];
      return Studio._restoreAutosave();
    }).then(function (restored) {
      if (!Studio.armed || !Studio.byId[Studio.armed] || !Studio.byId[Studio.armed].mounted) {
        var first = Studio.armed && Studio.byId[Studio.armed] ? Studio.armed : (Studio.plugins[0] && Studio.plugins[0].id);
        if (first) Studio._hooks.arm(first);
      }
      syncMixerUI();
      Studio._booted = true;
      I.initMIDI();
      renderMidi();
      if (restored) Studio.toast('Restored your last session');
      setInterval(function () { Studio._autosave(); }, 4000);
      document.addEventListener('visibilitychange', function () { if (document.hidden) Studio._autosave(true); });
      window.addEventListener('pagehide', function () { Studio._autosave(true); });
      Studio._emit('booted');
    }).catch(function (e) {
      console.error('[studio] start failed', e);
      Studio.toast('Audio failed to start: ' + (e && e.message || e), 'err');
    });
  }

  Studio._boot = function () {
    buildTop();
    buildTabs();
    I.buildKeyboard($('#eu-keys'));
    $('#eu-mixer').hidden = !dock.mixer; $('#eu-keys').hidden = !dock.keys;
    buildOverlay();
    requestAnimationFrame(loop);
    // service worker (PWA build only; ignored on file://)
    if (window.__PWA__ && 'serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('[studio] service worker not registered', e); });
    }
  };
})();
