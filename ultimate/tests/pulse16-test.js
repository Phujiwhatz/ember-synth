// Playwright test for the Pulse 16 plugin.   node tests/pulse16-test.js [--shots-only]
// Serves ultimate/ with python3 -m http.server on a free port and drives tests/pulse16-harness.html.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = __dirname + '/';
const shotsOnly = process.argv.includes('--shots-only');
let fails = 0;
function check(ok, msg) { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; }

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function waitHttp(url) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

(async () => {
  const port = await freePort();
  const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const BASE = `http://127.0.0.1:${port}/tests/pulse16-harness.html`;
  let browser;
  try {
    await waitHttp(BASE);
    browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1220, height: 650 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('request', r => { const u = r.url(); if (!u.startsWith('http://127.0.0.1') && !u.startsWith('blob:') && !u.startsWith('data:')) errors.push('network: ' + u); });

    await page.goto(BASE);
    const engine = await page.evaluate(() => window.p16Ready);
    check(engine === 'worklet', 'engine runs in an AudioWorklet (got ' + engine + ')');
    await page.waitForTimeout(300);
    await page.screenshot({ path: OUT + 'pulse16-shot-idle.png' });
    if (shotsOnly) {
      await page.evaluate(() => p16._debug.loadKit(1));
      await page.evaluate(() => { Studio.transport.start(); });
      await page.waitForTimeout(900);
      await page.screenshot({ path: OUT + 'pulse16-shot-playing.png' });
      await page.evaluate(() => Studio.transport.stop());
      console.log('errors:', errors);
      return;
    }

    // ---------------------------------------------------------------- synth voices: non-silent + decay
    const synth = await page.evaluate(async () => {
      const D = p16._debug, S = D.state, res = [];
      for (let t = 0; t < 8; t++) { S.tracks[t].mode = false; }
      const env = (x, sr, a, b) => { let m = 0; for (let i = Math.round(a * sr); i < Math.round(b * sr); i++) m = Math.max(m, Math.abs(x[i])); return m; };
      for (let t = 0; t < 8; t++) {
        const out = {};
        for (const d of [0.1, 0.9]) {
          const keep = S.tracks[t].decay; S.tracks[t].decay = d;
          const [L, R] = await D.offline(10, api => api.trigger(t, 1, 0.05));
          S.tracks[t].decay = keep;
          const sr = 44100, x = L.map((v, i) => v + R[i]);
          const peak = env(x, sr, 0.05, 0.1);
          // time until the envelope stays below -40 dB of peak
          let last = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak * 0.01) last = i;
          out[d] = { peak, t40: last / sr - 0.05, tail: env(x, sr, 9.8, 10), pre: env(x, sr, 0, 0.049) };
        }
        res.push(out);
      }
      return res;
    });
    const names = ['KICK', 'SNARE', 'CLAP', 'CL HAT', 'OP HAT', 'LO TOM', 'HI TOM', 'PERC'];
    synth.forEach((o, t) => {
      const a = o[0.1], b = o[0.9];
      check(a.peak > 0.05 && b.peak > 0.05, `synth ${names[t]} sounds (peak ${a.peak.toFixed(2)} / ${b.peak.toFixed(2)})`);
      check(a.pre < 1e-6, `synth ${names[t]} silent before its trigger time`);
      // PERC (cowbell) has a fixed 15 ms first stage; its decay knob only scales the second stage.
      check(b.t40 > a.t40 * 1.25, `synth ${names[t]} decay knob lengthens the sound (-40 dB at ${(a.t40 * 1000).toFixed(0)} ms -> ${(b.t40 * 1000).toFixed(0)} ms)`);
      check(b.tail < 1e-4 && b.t40 < 9.5, `synth ${names[t]} dies away (tail ${b.tail.toExponential(1)})`);
    });

    // ---------------------------------------------------------------- sequencer timing (offline, sample accurate)
    const timing = await page.evaluate(async () => {
      const D = p16._debug, S = D.state, sr = 44100;
      const bpm = 132, six = 60 / bpm / 4, tSwing = 0.2, lSwing = 0.5;
      const save = JSON.stringify(p16.getState());
      Studio.transport.setBpm(bpm); Studio.transport.swing = tSwing;
      S.swing = lSwing;
      for (let t = 0; t < 8; t++) for (let s = 0; s < 16; s++) S.steps[t][s] = 0;
      for (let s = 0; s < 16; s++) S.steps[3][s] = 1;          // closed hat on every step
      S.tracks[3].decay = 0; S.tracks[3].mode = false;
      const t0 = 0.1, expected = [];
      const [L, R] = await D.offline(t0 + 17 * six + 0.3, api => {
        for (let k = 0; k < 16; k++) {
          const tt = t0 + k * six + (k % 2 ? tSwing * six : 0);   // what the studio transport passes
          api.step(k, tt);
          expected.push(tt + (k % 2 ? lSwing * 0.4 * six : 0));    // + the plugin's own SWING knob
        }
      });
      const x = L.map((v, i) => v + R[i]);
      const onsets = [];
      let quiet = 0;
      for (let i = 0; i < x.length; i++) {
        const a = Math.abs(x[i]);
        if (a >= 0.004 && quiet > sr * 0.004) onsets.push(i / sr);
        quiet = a < 0.004 ? quiet + 1 : 0;
      }
      p16.setState(JSON.parse(save)); Studio.transport.swing = 0; Studio.transport.setBpm(120);
      return { expected, onsets, peaks: expected.map(e => { let m = 0; for (let i = Math.round(e * sr); i < Math.round(e * sr) + 200; i++) m = Math.max(m, Math.abs(x[i])); return +m.toFixed(3); }) };
    });
    if (timing.onsets.length !== 16) console.log('  onsets', timing.onsets, 'expected', timing.expected, 'peaks', timing.peaks);
    check(timing.onsets.length === 16, 'offline render: 16 hat onsets detected (got ' + timing.onsets.length + ')');
    let maxErr = 0;
    timing.expected.forEach((e, i) => { if (timing.onsets[i] != null) maxErr = Math.max(maxErr, Math.abs(timing.onsets[i] - e)); });
    check(maxErr < 0.0005, 'step onsets match bpm + studio swing + SWING knob (max err ' + (maxErr * 1000).toFixed(3) + ' ms)');

    // ---------------------------------------------------------------- accents louder
    const acc = await page.evaluate(async () => {
      const D = p16._debug, S = D.state;
      const save = JSON.stringify(p16.getState());
      for (let t = 0; t < 8; t++) for (let s = 0; s < 16; s++) S.steps[t][s] = 0;
      S.steps[1][0] = 1; S.steps[1][4] = 2; S.accent = 0.6; S.drive = 0; S.tracks[1].mode = false;
      const six = 0.125;
      const [L] = await D.offline(1.0, api => { api.step(0, 0.05); api.step(4, 0.05 + 4 * six); });
      const pk = (a, b) => { let m = 0; for (let i = Math.round(a * 44100); i < Math.round(b * 44100); i++) m = Math.max(m, Math.abs(L[i])); return m; };
      const r = { normal: pk(0.05, 0.05 + 4 * six), accent: pk(0.05 + 4 * six, 1.0) };
      p16.setState(JSON.parse(save));
      return r;
    });
    check(acc.accent > acc.normal * 1.3, `accented step louder (${acc.normal.toFixed(3)} -> ${acc.accent.toFixed(3)}, ratio ${(acc.accent / acc.normal).toFixed(2)}, expect ~${(1 / 0.7).toFixed(2)})`);

    // ---------------------------------------------------------------- every kit loads, every track sounds
    const kits = await page.evaluate(async () => {
      const D = p16._debug, S = D.state, out = [];
      for (let k = 0; k < D.kits.length; k++) {
        await D.loadKit(k);
        const tracks = S.tracks.map(tr => ({ sound: tr.sound, mode: tr.mode, loaded: !tr.sound || !!D.buffers[tr.sound] }));
        const [L, R] = await D.offline(8 * 0.6 + 0.2, api => { for (let t = 0; t < 8; t++) api.trigger(t, 1, 0.05 + t * 0.6); });
        const rms = [];
        for (let t = 0; t < 8; t++) {
          let s = 0, n = 0;
          for (let i = Math.round((0.05 + t * 0.6) * 44100); i < Math.round((0.05 + t * 0.6 + 0.25) * 44100); i++) { s += L[i] * L[i] + R[i] * R[i]; n++; }
          rms.push(Math.sqrt(s / n));
        }
        out.push({ name: D.kits[k].name, tracks, rms, kitState: S.kit });
      }
      return out;
    });
    kits.forEach(k => {
      const unloaded = k.tracks.filter(t => !t.loaded).map(t => t.sound);
      check(unloaded.length === 0, `kit "${k.name}": all sounds loaded${unloaded.length ? ' (missing ' + unloaded.join(', ') + ')' : ''}`);
      const quiet = k.rms.map((r, i) => r < 0.01 ? names[i] : null).filter(Boolean);
      check(quiet.length === 0, `kit "${k.name}": every track sounds (min RMS ${Math.min(...k.rms).toFixed(3)})${quiet.length ? ' quiet: ' + quiet : ''}`);
    });
    check(kits[0].tracks[0].sound === '' && kits[0].tracks[1].mode === true, '808 Classic: kick on synth voice, snare on sample');

    // ---------------------------------------------------------------- sample playback starts at sample 0 (AAC priming hidden)
    const onset = await page.evaluate(async () => {
      const D = p16._debug, id = 'builtin:Kicks/Punchy 909.wav';
      await D.loadSound(0, id);
      const buf = D.buffers[id], d = buf.getChannelData(0);
      let first = -1; for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.05) { first = i; break; }
      return { first, sr: buf.sampleRate, len: buf.length };
    });
    check(onset.first >= 0 && onset.first < 40, `library sample starts immediately (first |x|>0.05 at frame ${onset.first})`);

    // ---------------------------------------------------------------- realtime transport: scheduled times + audio
    const rt = await page.evaluate(async () => {
      await p16._debug.loadKit(1);
      const S = p16._debug.state; S.swing = 0;
      p16._debug.log.length = 0;
      Studio.transport.setBpm(128); Studio.transport.swing = 0.1;
      Studio.transport.start();
      const rms = [];
      for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 100)); rms.push(MockStudio.rms()); }
      const log = p16._debug.log.slice();
      return { rms, log };
    });
    await page.screenshot({ path: OUT + 'pulse16-shot-playing.png' });
    await page.evaluate(() => Studio.transport.stop());
    check(Math.max(...rt.rms) > 0.02, 'realtime: audio non-silent while the transport runs (max RMS ' + Math.max(...rt.rms).toFixed(3) + ')');
    {
      const six = 60 / 128 / 4, l = rt.log;
      let err = 0;
      for (const e of l) {
        const exp = l[0].time + (e.step16 - l[0].step16) * six + (e.step16 % 2 ? 0.1 * six : 0);
        err = Math.max(err, Math.abs(e.time - exp));
      }
      check(l.length >= 10 && err < 1e-6, `realtime: ${l.length} steps scheduled on the 128 BPM grid with swing (max err ${err.toExponential(1)} s)`);
      check(l.every(e => e.pos === e.step16 % 16), 'realtime: pattern position = step16 % 16');
    }

    // ---------------------------------------------------------------- MIDI note mapping + live play
    const midi = await page.evaluate(() => {
      const D = p16._debug, S = D.state;
      const every = [36, 37, 38, 39, 40, 41, 42, 43, 44, 47, 60, 67].map(D.noteToTrack);
      S.keymap = 1;
      const gm = [36, 38, 39, 42, 46, 45, 48, 56, 60].map(D.noteToTrack);
      S.keymap = 0;
      return { every, gm };
    });
    check(JSON.stringify(midi.every) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, -1, -1, 0, 7]), 'every-octave map: C..G -> tracks 1-8, G#..B ignored ' + JSON.stringify(midi.every));
    check(JSON.stringify(midi.gm) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, -1]), 'GM map ' + JSON.stringify(midi.gm));

    // ---------------------------------------------------------------- MIDI record into the pattern
    const rec = await page.evaluate(async () => {
      const D = p16._debug, S = D.state;
      for (let t = 0; t < 8; t++) for (let s = 0; s < 16; s++) S.steps[t][s] = 0;
      S.rec = true; S.quantize = true; S.swing = 0;
      Studio.transport.swing = 0; Studio.transport.setBpm(120);
      Studio.transport.start();
      await new Promise(r => setTimeout(r, 400));
      const a = D.seq.log[D.seq.log.length - 1], six = a.six;
      // a hit 30% of a 16th after step k: quantized -> k; slightly before step k+1 -> k+1
      const kA = D.recordStepFor(a.base + 0.3 * six, true), kB = D.recordStepFor(a.base + 0.7 * six, true);
      const kC = D.recordStepFor(a.base + 0.7 * six, false);
      // a live MIDI note right now gets written into the pattern
      p16.noteOn(37, 0.95, Studio.ctx.currentTime, { ch: 1, mpe: false });
      const after = S.steps[1].slice();
      Studio.transport.stop();
      S.rec = false;
      return { kA, kB, kC, k: a.k, after };
    });
    check(rec.kA === rec.k && rec.kB === rec.k + 1 && rec.kC === rec.k, `record step choice: quantize nearest (${rec.kA - rec.k}, ${rec.kB - rec.k}), no-quantize floor (${rec.kC - rec.k})`);
    check(rec.after.filter(v => v === 2).length === 1, 'live MIDI hit (vel 0.95) recorded as one accented snare step: ' + rec.after.join(''));

    // ---------------------------------------------------------------- state round trip
    const st = await page.evaluate(async () => {
      const D = p16._debug;
      await D.loadKit(2);
      const S = D.state;
      S.steps[7][5] = 2; S.tracks[6].tune = -7.25; S.swing = 0.33; S.drive = 0.4; S.master = -6.5; S.keymap = 1; S.quantize = false; S.learned[2] = 61;
      S.tracks[4].mode = false;
      const a = JSON.stringify(p16.getState());
      await D.loadKit(5); S.keymap = 0;
      await D.setStateAsync(JSON.parse(a));
      const b = JSON.stringify(p16.getState());
      const loaded = S.tracks.every(tr => !tr.sound || !!D.buffers[tr.sound]);
      return { same: a === b, a, b, loaded, kit: S.kit };
    });
    check(st.same, 'getState -> setState -> getState round-trips' + (st.same ? '' : '\n  a=' + st.a + '\n  b=' + st.b));
    check(st.loaded && st.kit === 2, 'restored state reloads its library sounds');

    // ---------------------------------------------------------------- UI interactions
    const uiRes = await page.evaluate(() => {
      const root = document.querySelector('.plug-pulse16'), S = p16._debug.state, r = {};
      const cell = root.querySelector('.p16-cell[data-t="5"][data-s="9"]');
      const before = S.steps[5][9];
      const rc = cell.getBoundingClientRect();
      const o = { bubbles: true, clientX: rc.x + rc.width / 2, clientY: rc.y + rc.height / 2, pointerId: 3, button: 0 };
      cell.dispatchEvent(new PointerEvent('pointerdown', o)); cell.dispatchEvent(new PointerEvent('pointerup', o));
      r.cycle1 = [before, S.steps[5][9]];
      cell.dispatchEvent(new PointerEvent('pointerdown', o)); cell.dispatchEvent(new PointerEvent('pointerup', o));
      r.cycle2 = S.steps[5][9];
      r.cls = cell.className;
      return r;
    });
    check(uiRes.cycle1[1] === (uiRes.cycle1[0] + 1) % 3 && uiRes.cycle2 === (uiRes.cycle1[0] + 2) % 3 && /acc|on/.test(uiRes.cls), 'grid click cycles off -> on -> accent');

    await page.click('.p16-cat >> text=Snares');
    await page.click('.p16-track[data-t="1"] .p16-pad');
    await page.dblclick('.p16-snditem >> nth=2');
    await page.waitForTimeout(400);
    const snd = await page.evaluate(() => ({ s: p16._debug.state.tracks[1].sound, label: document.querySelector('.p16-track[data-t="1"] .p16-snd').textContent }));
    check(/^builtin:Snares\//.test(snd.s) && snd.label.length > 2, 'library double-click loads a snare into SNARE: ' + snd.label);

    // drag-and-drop a WAV file onto a row -> imported via Studio.samples.importFile
    const dropped = await page.evaluate(async () => {
      const sr = 44100, n = 4410, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 10) * 20000 * Math.exp(-i / 1500)), true);
      const file = new File([buf], 'My Blip.wav', { type: 'audio/wav' });
      const dt = new DataTransfer(); dt.items.add(file);
      const row = document.querySelector('.p16-track[data-t="7"]');
      row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      for (let i = 0; i < 30 && !/^sample:user-/.test(p16._debug.state.tracks[7].sound); i++) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 200));
      const tr = p16._debug.state.tracks[7];
      return { sound: tr.sound, mode: tr.mode, label: document.querySelector('.p16-track[data-t="7"] .p16-snd').textContent };
    });
    check(/^sample:user-/.test(dropped.sound) && dropped.mode && dropped.label === 'My Blip', 'dropped WAV is imported and loaded into PERC (' + dropped.label + ')');

    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT + 'pulse16-shot-ui.png' });
    // narrower stage (e.g. small laptop window)
    await page.goto(BASE + '?w=1000');
    await page.evaluate(() => window.p16Ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: OUT + 'pulse16-shot-narrow.png' });

    // ScriptProcessor fallback still makes sound
    await page.goto(BASE + '?noworklet');
    const fb = await page.evaluate(async () => {
      const type = await window.p16Ready;
      const [L] = await p16._debug.offline(0.5, api => api.trigger(0, 1, 0.05));
      let m = 0; for (const v of L) m = Math.max(m, Math.abs(v));
      return { type, m };
    });
    check(fb.type === 'script' && fb.m > 0.1, 'ScriptProcessor fallback engine works (peak ' + fb.m.toFixed(2) + ')');

    check(errors.length === 0, 'no console errors / network requests' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } catch (e) {
    console.error(e); fails++;
  } finally {
    if (browser) await browser.close();
    srv.kill();
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
