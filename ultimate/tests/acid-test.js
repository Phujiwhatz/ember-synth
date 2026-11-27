// Playwright test for the Acid plugin. Run: node tests/acid-test.js (server on :8765 serving ultimate/)
const { chromium } = require('playwright');
const BASE = process.env.ACID_BASE || 'http://localhost:8765/tests/acid-harness.html';
const OUT = __dirname + '/';
let fails = 0;
function check(ok, msg) { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; }

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('request', r => { const u = r.url(); if (!u.startsWith('http://localhost') && !u.startsWith('blob:') && !u.startsWith('data:')) errors.push('network: ' + u); });

  await page.goto(BASE);
  const engine = await page.evaluate(() => window.acidReady);
  check(engine === 'ladder', 'engine is AudioWorklet ladder (got ' + engine + ')');
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + 'acid-shot-idle.png', fullPage: true });

  // ---- sequencer timing + audio
  const bpm = 126;
  await page.evaluate((bpm) => { Studio.transport.setBpm(bpm); Studio.transport.start(); }, bpm);
  const rmsSamples = [];
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(100); rmsSamples.push(await page.evaluate(() => MockStudio.rms())); }
  await page.screenshot({ path: OUT + 'acid-shot-playing.png', fullPage: true });
  const res = await page.evaluate(() => ({ log: acid._debug.log.slice(), state: Studio.ctx.state }));
  await page.evaluate(() => Studio.transport.stop());
  const maxRms = Math.max(...rmsSamples);
  check(maxRms > 0.02, 'audio non-silent while sequencing (max RMS ' + maxRms.toFixed(3) + ', ctx ' + res.state + ')');
  const six = 60 / bpm / 4;
  const log = res.log;
  check(log.length >= 10, 'sequencer scheduled ' + log.length + ' notes');
  let maxErr = 0;
  for (let i = 1; i < log.length; i++) {
    const expect = log[0].time + (log[i].step16 - log[0].step16) * six;
    maxErr = Math.max(maxErr, Math.abs(log[i].time - expect));
  }
  check(maxErr < 1e-6, 'scheduled step times match bpm grid (max err ' + maxErr.toExponential(2) + ' s)');
  // pattern A: pos 2 has slide into pos 3, which must be a glide
  const g = log.find(e => e.pos === 3);
  check(g && g.glided, 'step after a slide step is glided (no retrigger)');
  const posOk = log.every(e => e.pos === e.step16 % 16);
  check(posOk, 'pattern position follows step16 % length');

  // ---- slide/glide measurement via tap on the pitch CV
  const glide = await page.evaluate(async () => {
    const E = acid._debug.engine(), ctx = Studio.ctx;
    const an = ctx.createAnalyser(); an.fftSize = 32768; E.pitch.connect(an);
    const t0 = ctx.currentTime + 0.05;
    acid.noteOn(48, 0.7, t0, { ch: 0 });
    acid.noteOn(55, 0.7, t0 + 0.2, { ch: 0 });      // legato -> slide
    acid.noteOff(55, t0 + 0.4); acid.noteOff(48, t0 + 0.4);
    acid.noteOn(60, 0.7, t0 + 0.45, { ch: 0 });     // non-legato -> jump
    acid.noteOff(60, t0 + 0.55);
    await new Promise(r => setTimeout(r, 750));
    const buf = new Float32Array(an.fftSize); an.getFloatTimeDomainData(buf);
    const endT = ctx.currentTime; E.pitch.disconnect(an);
    const sr = ctx.sampleRate;
    const at = t => buf[Math.round(buf.length - (endT - t) * sr)];
    return { sr, a: at(t0 + 0.19), mid: at(t0 + 0.2 + 0.02), b40: at(t0 + 0.2 + 0.06), b: at(t0 + 0.39),
             j0: at(t0 + 0.43), j1: at(t0 + 0.49) };
  });
  const f = m => 440 * Math.pow(2, (m - 69) / 12);
  check(Math.abs(glide.a - f(48)) < 0.5, 'held note at ' + glide.a.toFixed(1) + ' Hz (expect ' + f(48).toFixed(1) + ')');
  check(glide.mid > f(48) + 5 && glide.mid < f(55) - 5, 'slide is mid-glide after 20ms: ' + glide.mid.toFixed(1) + ' Hz');
  check(Math.abs(glide.b - f(55)) < 0.5, 'slide arrives at ' + glide.b.toFixed(1) + ' Hz (expect ' + f(55).toFixed(1) + ')');
  check(Math.abs(glide.j1 - f(60)) < 1, 'non-legato note jumps instantly (' + glide.j0.toFixed(1) + ' -> ' + glide.j1.toFixed(1) + ')');

  // ---- UI interactions
  const ui = await page.evaluate(async () => {
    const r = {};
    const root = document.querySelector('.plug-acid');
    const st = () => acid._debug.state;
    // click a pitch cell: step 5 (index 5), note 7
    const cell = root.querySelector('.ac-cell[data-s="5"][data-n="7"]');
    const rc = cell.getBoundingClientRect();
    const opts = { bubbles: true, clientX: rc.x + rc.width / 2, clientY: rc.y + rc.height / 2, pointerId: 1 };
    cell.dispatchEvent(new PointerEvent('pointerdown', opts)); root.querySelector('.ac-grid').dispatchEvent(new PointerEvent('pointerup', opts));
    r.cell = st().patterns[0].steps[5].n === 7 && st().patterns[0].steps[5].g;
    // bank C
    [...root.querySelectorAll('.ac-bank')][2].click(); r.bank = st().bank === 2;
    // generate
    root.querySelector('.ac-gen').click(); r.gen = st().patterns[2].steps.slice(0, 16).some(s => s.g);
    // copy C, paste to D
    const btns = [...root.querySelectorAll('.ac-btn')];
    btns.find(b => b.textContent === 'COPY').click();
    [...root.querySelectorAll('.ac-bank')][3].click();
    btns.find(b => b.textContent === 'PASTE').click();
    r.paste = JSON.stringify(st().patterns[3]) === JSON.stringify(st().patterns[2]);
    // shift right then left == identity
    const before = JSON.stringify(st().patterns[3]);
    btns.find(b => b.title === 'Shift pattern right').click();
    r.shifted = JSON.stringify(st().patterns[3]) !== before;
    btns.find(b => b.title === 'Shift pattern left').click();
    r.shiftBack = JSON.stringify(st().patterns[3]) === before;
    // length 20 -> 32 columns
    btns.find(b => b.title === 'Longer').click(); for (let i = 0; i < 3; i++) btns.find(b => b.title === 'Longer').click();
    r.len = st().patterns[3].len === 20 && root.querySelectorAll('.ac-ledc').length === 32;
    // knob via keyboard
    const dial = root.querySelector('.ac-dial'); const c0 = st().p.cutoff;
    dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    r.knob = st().p.cutoff > c0;
    // state roundtrip
    const s1 = acid.getState(); acid.setState(JSON.parse(JSON.stringify(s1)));
    r.state = JSON.stringify(acid.getState()) === JSON.stringify(s1);
    // key transpose
    st().keyTranspose = true; Studio.transport.start(); acid.noteOn(63, 1, 0, {}); r.transpose = st().transpose === 3;
    Studio.transport.stop(); st().keyTranspose = false; st().transpose = 0;
    // back to bank A
    [...root.querySelectorAll('.ac-bank')][0].click();
    return r;
  });
  Object.keys(ui).forEach(k => check(ui[k], 'ui: ' + k));

  // ---- MPE pressure -> cutoff & bend -> pitch (smoke)
  await page.evaluate(() => { acid.noteOn(48, 0.8, 0, { ch: 2, mpe: true }); acid.pressure(0.8, { ch: 2, mpe: true }); acid.bend(2, { ch: 2, mpe: true }); });
  await page.waitForTimeout(150);
  const mpe = await page.evaluate(() => { const E = acid._debug.engine(); const r = { press: E.press.offset.value, det: E.detune.offset.value }; acid.noteOff(48); acid.bend(0, { ch: 2, mpe: true }); acid.pressure(0, { ch: 2, mpe: true }); return r; });
  check(mpe.press > 1.5 && Math.abs(mpe.det - 200) < 20, 'MPE pressure->cutoff (' + mpe.press.toFixed(2) + ' oct) and bend->pitch (' + mpe.det.toFixed(0) + ' cents)');

  // ---- fallback engine
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p2.on('pageerror', e => errors.push('fallback pageerror: ' + e.message));
  p2.on('console', m => { if (m.type() === 'error') errors.push('fallback: ' + m.text()); });
  await p2.goto(BASE + '?noworklet');
  const eng2 = await p2.evaluate(() => window.acidReady);
  await p2.evaluate(() => { Studio.transport.setBpm(130); Studio.transport.start(); });
  let m2 = 0; for (let i = 0; i < 12; i++) { await p2.waitForTimeout(100); m2 = Math.max(m2, await p2.evaluate(() => MockStudio.rms())); }
  await p2.evaluate(() => Studio.transport.stop());
  check(eng2 === 'biquad' && m2 > 0.02, 'biquad fallback engine works (max RMS ' + m2.toFixed(3) + ')');

  check(errors.length === 0, 'no console errors / network requests' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
