// Playwright test for the Keys plugin. Usage: node tests/keys-test.js [fx|real]
const { chromium } = require('playwright');
const mode = process.argv[2] || 'fx';
const URL = 'http://localhost:8765/tests/keys-harness.html' + (mode === 'fx' ? '?fx=1' : '');
const shot = (n) => `/tmp/keys-${mode}-${n}.png`;
let fails = 0;
function check(ok, msg) { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; }
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1320, height: 760 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); if (m.type() === 'warning' || m.type() === 'log') console.log('  warn:', m.text()); });
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(URL);
  await page.evaluate(() => window.keysReady);
  await page.evaluate(async () => {
    const A = Studio.ctx.createAnalyser(); A.fftSize = 32768; MockStudio.master.connect(A); window.__A = A;
    window.sleep = ms => new Promise(r => setTimeout(r, ms));
    window.waitLoaded = async () => { for (let i = 0; i < 400; i++) { const p = K._debug.progress(), st = K._debug.state();
      const ids = [st.a, st.b].filter(Boolean); if (ids.every(id => p[id] && p[id].done >= p[id].total)) return true; await sleep(50); } return false; };
    window.rms = () => MockStudio.rms();
    window.pitch = () => { const d = new Float32Array(__A.fftSize); __A.getFloatTimeDomainData(d);
      const r = K._debug.detectPitch({ sampleRate: Studio.ctx.sampleRate, numberOfChannels: 1, length: d.length, getChannelData: () => d });
      return r && r.freq; };
    window.measure = async (note, vel = 0.8, info = { ch: 0, mpe: false }, hold = 450) => {
      K.noteOn(note, vel, Studio.ctx.currentTime + 0.02, info); await sleep(hold);
      const f = pitch(), r = rms();
      // engine reference: the source buffer's own pitch x playbackRate (independent of how the sample was tuned)
      const vv = K._debug.voices().filter(v => v.note === note).pop(); let ref = null;
      if (vv) { const s0 = vv.srcs.slice().sort((a, b) => b.g.gain.value - a.g.gain.value)[0].src; const d = K._debug.detectPitch(s0.buffer);
        if (d) ref = d.freq * s0.playbackRate.value * Math.pow(2, s0.detune.value / 1200); } if (window.__dbg) console.log('voices', JSON.stringify(K._debug.voices().map(v => [v.pn, v.released, v.stolen, v.srcs[0].src.playbackRate.value]))); K.noteOff(note, Studio.ctx.currentTime, info); return { f, r, ref };
    };
    window.setInst = async (a, b) => { const s = K.getState(); s.a = a; s.b = b || null; s.macros.reverb = 0; s.macros.attack = 0; K.setState(s); await waitLoaded(); };
  });
  check(await page.evaluate(() => waitLoaded()), 'initial instrument loaded: ' + await page.evaluate(() => K._debug.state().a));
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('initial') });

  const insts = await page.evaluate(() => Object.keys(Studio.samples.manifest.instruments));
  console.log('instruments:', insts.length);
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const testSet = mode === 'fx'
    ? [['fx-grand', [45, 57, 69, 76, 84]], ['fx-pad', [50, 64]], ['fx-bass', [36, 43]], ['fx-pluck', [60, 67]]]
    : insts.map(id => [id, [48, 60, 69]]);
  for (const [id, notes] of testSet) {
    await page.evaluate(id => setInst(id), id);
    for (const n of notes) { 
      const r = await page.evaluate(n => measure(n), n);
      await page.evaluate(() => { K.allNotesOff(); return sleep(750); });
      const nominal = mtof(n);
      const exp = mode === 'fx' ? nominal : (r.ref || nominal);   // real library: compare to the source sample's own pitch
      const cents = r.f ? 1200 * Math.log2(r.f / exp) : NaN;
      const vsRoot = r.f ? 1200 * Math.log2(r.f / nominal) : NaN;
      if (/texture/.test(id)) { check(r.r > 0.002, `${id} note ${n}: audible (rms ${r.r.toFixed(4)}), atonal texture so pitch not checked`); continue; }
      check(r.r > 0.005 && Math.abs(cents) < 25, `${id} note ${n}: rms ${r.r.toFixed(3)} f=${r.f ? r.f.toFixed(1) : 'none'} engine-exp ${exp.toFixed(1)} (${isNaN(cents) ? '?' : cents.toFixed(1)}c)` +
        (Math.abs(vsRoot) > 15 ? `  [sample tuning: ${vsRoot.toFixed(0)}c vs nominal ${nominal.toFixed(1)}]` : ''));
    }
  }
  const sustained = mode === 'fx' ? 'fx-pad' : (insts.find(i => /warm-pad/.test(i)) || insts.find(i => /pad|string/.test(i)) || insts[0]);
  await page.evaluate(id => setInst(id), sustained);
  // release
  const rel = await page.evaluate(async () => {
    K.noteOn(60, 0.9, Studio.ctx.currentTime, {}); await sleep(1500); const on = rms();
    K.noteOff(60, Studio.ctx.currentTime, {}); const relS = K._debug.state(); await sleep(250); const mid = rms();
    await sleep(2500); return { on, mid, after: rms(), voices: K._debug.voices().length };
  });
  check(rel.on > 0.01 && rel.after < 0.002 && rel.voices === 0, `release: on ${rel.on.toFixed(3)} mid ${rel.mid.toFixed(3)} after ${rel.after.toFixed(4)} voices ${rel.voices}`);
  // sustain pedal
  const sus = await page.evaluate(async () => {
    K.cc(64, 1, {}); K.noteOn(62, 0.9, Studio.ctx.currentTime, {}); await sleep(600); K.noteOff(62, Studio.ctx.currentTime, {});
    await sleep(1500); const held = rms(); K.cc(64, 0, {}); await sleep(3000); return { held, after: rms(), voices: K._debug.voices().length };
  });
  check(sus.held > 0.01 && sus.after < 0.002 && sus.voices === 0, `sustain: held ${sus.held.toFixed(3)} after ${sus.after.toFixed(4)} voices ${sus.voices}`);
  // MPE bend
  const bendR = await page.evaluate(async () => {
    const info = { ch: 3, mpe: true }; K.noteOn(57, 0.8, Studio.ctx.currentTime, info); K.bend(2, info);
    K.noteOn(69, 0.8, Studio.ctx.currentTime, { ch: 4, mpe: true });
    await sleep(500); const st = K._debug.voices().map(v => v.srcs[0].src.detune.value);
    K.bend(0, info); K.allNotesOff(); await sleep(300); return st;
  });
  check(bendR.length === 2 && Math.abs(bendR[0] - 200) < 2 && Math.abs(bendR[1]) < 1, 'per-note MPE bend detunes only its channel: ' + bendR.map(x => x.toFixed(1)));
  // pressure & mod
  const prs = await page.evaluate(async () => {
    const info = { ch: 2, mpe: true }; K.noteOn(60, 0.6, Studio.ctx.currentTime, info); await sleep(100);
    const v = K._debug.voices()[0], f0 = v.filter.frequency.value; K.pressure(1, info); K.cc(1, 1, {}); await sleep(400);
    const r = { f0, f1: v.filter.frequency.value, g: v.expr.gain.value, lfo: K._debug.nodes().lfoGain.gain.value };
    K.pressure(0, info); K.cc(1, 0, {}); K.allNotesOff(); await sleep(300); return r;
  });
  check(prs.f1 > prs.f0 * 1.5 && prs.g > 1.2 && prs.lfo > 20, `pressure swell f ${prs.f0.toFixed(0)}->${prs.f1.toFixed(0)} gain ${prs.g.toFixed(2)} vibrato ${prs.lfo.toFixed(1)}c`);
  // polyphony
  const poly = await page.evaluate(async () => { let mx = 0; for (let n = 30; n < 95; n++) { K.noteOn(n, 0.7, Studio.ctx.currentTime, {}); mx = Math.max(mx, K._debug.voices().length); }
    await sleep(200); const r = { mx, v: K._debug.voices().length }; K.allNotesOff(); await sleep(400); return r; });
  check(poly.mx <= 48 && poly.v <= 48, `polyphony cap: max ${poly.mx}`);
  // velocity crossfade (fixtures have 2 layers split at .55)
  if (mode === 'fx') {
    await page.evaluate(() => setInst('fx-grand'));
    const xf = await page.evaluate(async () => { const out = []; for (const v of [0.2, 0.5, 0.55, 0.62, 0.95]) {
      const s = K.getState(); K.noteOn(60, v, Studio.ctx.currentTime, {}); const vv = K._debug.voices().slice(-1)[0];
      out.push(vv.srcs.map(s => s.src.buffer.length + ':' + s.g.gain.value.toFixed(2)).join('|')); K.allNotesOff(); await sleep(80); } return out; });
    console.log('  xfade', xf.join('  '));
    check(xf[0].split('|').length === 1 && xf[2].split('|').length === 2 && xf[4].split('|').length === 1, 'velocity layer crossfade');
  }
  // layering + presets
  await page.evaluate(async () => { for (let i = 0; i < K._debug.presets.length; i++) { document.querySelector('.plug-keys .k-pn').click(); await sleep(60); } });
  await page.selectOption('.plug-keys .k-psel', '1');
  await page.evaluate(() => waitLoaded());
  const lay = await page.evaluate(async () => { K.noteOn(60, 0.8, Studio.ctx.currentTime, {}); await sleep(300); const n = K._debug.voices().map(v => v.layer); const st = K._debug.state(); K.allNotesOff(); return { n, a: st.a, b: st.b }; });
  console.log('  preset 2 layers:', JSON.stringify(lay));
  check(lay.b ? lay.n.includes(1) && lay.n.includes(0) : true, 'layer B voices start');
  await page.evaluate(() => { K.noteOn(60, 0.8, Studio.ctx.currentTime, {}); K.noteOn(64, 0.8, Studio.ctx.currentTime, {}); K.noteOn(67, 0.8, Studio.ctx.currentTime, {}); K.cc(64, 1, {}); K.cc(1, 0.6, {}); K.pressure(0.5, {}); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot('layered') });
  await page.evaluate(() => { K.cc(64, 0, {}); K.cc(1, 0, {}); K.pressure(0, {}); K.allNotesOff(); });
  // state round trip
  const rt = await page.evaluate(() => { const s = K.getState(); s.macros.tone = 0.33; K.setState(s); const s2 = K.getState(); return JSON.stringify(s2) === JSON.stringify(s) ? 'ok' : JSON.stringify([s, s2]); });
  check(rt === 'ok', 'getState/setState round trip ' + (rt === 'ok' ? '' : rt));
  // knob drag
  const kb = await page.locator('.plug-keys .k-knob[data-k="reverb"] .k-dial').boundingBox();
  const before = await page.evaluate(() => K._debug.state().macros.reverb);
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2); await page.mouse.down(); await page.mouse.move(kb.x + kb.width / 2, kb.y - 60, { steps: 6 }); await page.mouse.up();
  const after = await page.evaluate(() => K._debug.state().macros.reverb);
  check(after > before + 0.1, `knob drag reverb ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  // user import
  const fxPath = __dirname + '/keys-fixtures/import_a3.wav';
  await page.setInputFiles('.plug-keys .k-file', fxPath);
  await page.waitForFunction(() => (K._debug.state().a || '').startsWith('user:'), null, { timeout: 8000 });
  const imp = await page.evaluate(async () => { const st = K._debug.state(); const inst = st.userInstruments || K.getState().userInstruments; const u = inst[inst.length - 1];
    const s = K.getState(); s.b = null; s.macros.reverb = 0; s.transpose = 0; K.setState(s); await sleep(100); const m = await measure(57); K.allNotesOff(); return { root: u.zones[0].root, m }; });
  check(Math.abs(imp.root - 57) < 0.3 && Math.abs(1200 * Math.log2(imp.m.f / 220)) < 25, `import: root ${imp.root} plays A3 at ${imp.m.f && imp.m.f.toFixed(1)} Hz`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot('user') });
  // drag & drop via DataTransfer
  const dropped = await page.evaluate(async () => {
    const ab = await (await fetch('keys-fixtures/import_a3.wav')).arrayBuffer();
    const dt = new DataTransfer(); dt.items.add(new File([ab], 'dropped tone.wav', { type: 'audio/wav' }));
    const el = document.querySelector('.plug-keys .k-panel');
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 100; i++) { await sleep(50); const n = K.getState().userInstruments.length; if (n >= 2) return n; } return 0;
  });
  check(dropped >= 2, 'drag & drop import');
  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
