// Ember Studio plugin test: node tests/ember-test.js  (with `python3 -m http.server 8765` running in ultimate/)
// Checks: no console errors, all 5 engines + every preset make sound and release, MPE per-channel bend,
// transport bpm -> arp tempo, getState/setState round trip, audio without mount(), screenshots.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8765/tests/ember-harness.html';
const SHOTS = process.env.SHOTS || '/tmp/ember-shots';
const FULL = !process.env.QUICK;   // QUICK=1: sample presets instead of every preset
require('fs').mkdirSync(SHOTS, { recursive: true });
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };

(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const errs = [];
  pg.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text()); });
  pg.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await pg.goto(BASE); await pg.evaluate(() => window.ready);
  await pg.evaluate(() => {
    window.sleep = ms => new Promise(r => setTimeout(r, ms));
    window.peakRms = async ms => { let pk = 0; const t0 = performance.now(); while (performance.now() - t0 < ms) { pk = Math.max(pk, MockStudio.rms()); await sleep(20); } return pk; };
    window.D = P._debug;
  });

  // 1. every instrument: sound on noteOn, voices released on noteOff
  const instrs = await pg.evaluate(() => D.INSTR_ORDER.slice());
  ok(instrs.length === 5, 'five instruments: ' + instrs.join(', '));
  for (const id of instrs) {
    const r = await pg.evaluate(async id => {
      P.allNotesOff(); D.setInstrument(0, id); await sleep(300);
      const base = MockStudio.rms();
      for (const n of [60, 64, 67]) P.noteOn(n, 0.85, Studio.ctx.currentTime, { ch: 0, mpe: false });
      const pk = await peakRms(700);
      const vOn = D.slots[0].voices.filter(v => !v.rel).length;
      for (const n of [60, 64, 67]) P.noteOff(n, Studio.ctx.currentTime, { ch: 0, mpe: false });
      const P0 = D.slots[0].P, rel = id === 'fm' ? 8 : (P0.aR || P0.orgRel || 1);
      const t0 = performance.now(); while (D.slots[0].voices.length && performance.now() - t0 < rel * 2000 + 1500) await sleep(50);
      return { base, pk, vOn, left: D.slots[0].voices.length, patch: D.slots[0].cur.name, wt: id === 'wt' ? !!document.querySelector('.plug-ember') : null };
    }, id);
    ok(r.pk > 0.01 && r.vOn === 3, `${id} (${r.patch}) sounds: peak RMS ${r.pk.toFixed(4)}, ${r.vOn} voices`);
    ok(r.left === 0, `${id} releases: ${r.left} voices left after noteOff`);
    await pg.waitForTimeout(500);
    await pg.screenshot({ path: `${SHOTS}/plugin-${id}.png`, fullPage: true });
  }

  // 2. presets: every one (or a sample) must make sound
  const presetRes = await pg.evaluate(async full => {
    const out = [];
    // tap the dry voice bus (pre-FX) so reverb/delay tails of the previous preset don't mask silence
    const tapRms = an => { const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a); let s = 0; for (const x of a) s += x * x; return Math.sqrt(s / a.length); };
    for (const id of D.INSTR_ORDER) {
      D.setInstrument(0, id); await sleep(150);
      const tap = Studio.ctx.createAnalyser(); tap.fftSize = 2048; D.slots[0].inst.in.connect(tap);
      const peakTap = async ms => { let pk = 0; const t0 = performance.now(); while (performance.now() - t0 < ms) { pk = Math.max(pk, tapRms(tap)); await sleep(20); } return pk; };
      let list = D.INSTR[id].presets.map(p => p[1]);
      if (!full) list = list.filter((_, i) => i % 5 === 0);
      for (const name of list) {
        P.allNotesOff(); await sleep(60); D.loadPatch(0, name);
        const lvl = D.LEVELS[id] && D.LEVELS[id][name];
        const volOk = lvl == null || Math.abs(D.slots[0].P.volume - lvl) < 1e-9;
        const base = tapRms(tap);
        P.noteOn(60, 0.85, Studio.ctx.currentTime, { ch: 0 }); P.noteOn(67, 0.85, Studio.ctx.currentTime, { ch: 0 });
        const pk = await peakTap(Math.min(2500, 350 + (D.slots[0].P.aA || 0) * 700));
        P.noteOff(60, Studio.ctx.currentTime, { ch: 0 }); P.noteOff(67, Studio.ctx.currentTime, { ch: 0 });
        out.push({ id, name, pk, base, volOk });
      }
    }
    P.allNotesOff();
    return out;
  }, FULL);
  const silent = presetRes.filter(r => !(r.pk > 0.002 && r.pk > r.base * 2));
  ok(silent.length === 0, `${presetRes.length} presets make sound` + (silent.length ? ' — silent: ' + silent.map(r => `${r.id}/${r.name} ${r.pk.toFixed(4)}`).join(', ') : ''));
  const badVol = presetRes.filter(r => !r.volOk);
  ok(badVol.length === 0, 'LEVELS applied to preset volumes' + (badVol.length ? ': ' + badVol.map(r => r.name).join(', ') : ''));

  // 3. MPE: per-channel bend only moves its own note; pitch measured on a pure-sine organ patch
  const mpe = await pg.evaluate(async () => {
    D.setInstrument(0, 'organ'); D.loadPatch(0, 'Init Organ'); D.slots[0].P.click = 0; await sleep(1500);
    const an = MockStudio.analyser, fd = new Float32Array(an.frequencyBinCount), sr = Studio.ctx.sampleRate;
    an.fftSize = 32768; const fd2 = new Float32Array(an.frequencyBinCount);
    const peak = () => { an.getFloatFrequencyData(fd2); let bi = 0; for (let i = 5; i < fd2.length; i++) if (fd2[i] > fd2[bi]) bi = i; return bi * sr / an.fftSize; };
    const t = () => Studio.ctx.currentTime;
    P.noteOn(69, 0.9, t(), { ch: 1, mpe: true }); await sleep(900);
    const f0 = peak();
    P.bend(12, { ch: 1, mpe: true }); await sleep(900);
    const f1 = peak();
    P.noteOn(57, 0.9, t(), { ch: 2, mpe: true }); await sleep(50);
    const v1 = D.voices().find(v => v.ch === 1 && !v.rel), v2 = D.voices().find(v => v.ch === 2 && !v.rel);
    const offs = [v1.vb.offset.value, v2.vb.offset.value];
    P.noteOff(69, t(), { ch: 1, mpe: true }); P.noteOff(57, t(), { ch: 2, mpe: true }); P.bend(0, { ch: 1, mpe: true });
    await sleep(600);
    P.noteOn(69, 0.9, t(), { ch: 0, mpe: false }); await sleep(600);
    P.bend(2, { ch: 0, mpe: false }); await sleep(900);
    const fg = peak();
    P.bend(0, { ch: 0, mpe: false }); P.noteOff(69, t(), { ch: 0 });
    // raw-MIDI path (synthesised) still works: member channel 3 bend up a full range
    D.onMidi([0x93, 60, 100]); D.onMidi([0xE3, 0x7f, 0x7f]); await sleep(50);
    const vr = D.voices().find(v => v.ch === 3 && !v.rel), rawOff = vr.vb.offset.value; D.onMidi([0x83, 60, 0]);
    // pressure on a member channel reaches only that voice
    P.noteOn(62, 0.8, t(), { ch: 4, mpe: true }); P.noteOn(65, 0.8, t(), { ch: 5, mpe: true }); P.pressure(0.9, { ch: 4, mpe: true }); await sleep(150);
    const pv = [D.voices().find(v => v.ch === 4 && !v.rel).vp.offset.value, D.voices().find(v => v.ch === 5 && !v.rel).vp.offset.value];
    P.allNotesOff(); an.fftSize = 2048;
    return { f0, f1, offs, fg, rawOff, pv };
  });
  ok(Math.abs(mpe.f0 - 440) < 4, `pitch before bend ${mpe.f0.toFixed(1)} Hz (440)`);
  ok(Math.abs(mpe.f1 - 880) < 6, `MPE ch bend +12 st -> ${mpe.f1.toFixed(1)} Hz (880)`);
  ok(Math.abs(mpe.offs[0] - 1200) < 5 && Math.abs(mpe.offs[1]) < 1, `per-channel bend isolated: ch1 ${mpe.offs[0].toFixed(0)}c, ch2 ${mpe.offs[1].toFixed(0)}c`);
  ok(Math.abs(mpe.fg - 493.9) < 5, `global bend +2 st -> ${mpe.fg.toFixed(1)} Hz (493.9)`);
  ok(Math.abs(mpe.rawOff - 4800) < 5, `raw MIDI bend on member ch -> ${mpe.rawOff.toFixed(0)}c (4800 = 48 st range)`);
  ok(mpe.pv[0] > 0.8 && mpe.pv[1] < 0.05, `per-channel pressure isolated: ${mpe.pv.map(x => x.toFixed(2)).join(' / ')}`);

  // 4. arp follows transport bpm, and arp actually plays
  const arp = await pg.evaluate(async () => {
    Studio.transport.setBpm(93); await sleep(50);
    const tempo = D.slots[0].P.tempo;
    D.setInstrument(0, 'wt'); D.loadPatch(0, 'Crush Arp'); await sleep(200);
    P.noteOn(60, 0.8, Studio.ctx.currentTime, { ch: 0 }); P.noteOn(64, 0.8, Studio.ctx.currentTime, { ch: 0 });
    const pk = await peakRms(600); P.noteOff(60, Studio.ctx.currentTime, { ch: 0 }); P.noteOff(64, Studio.ctx.currentTime, { ch: 0 });
    Studio.transport.setBpm(120); P.allNotesOff();
    return { tempo, pk, running: D.slots[0].arp.running };
  });
  ok(arp.tempo === 93, `arp tempo follows Studio.transport bpm (${arp.tempo})`);
  ok(arp.pk > 0.003 && !arp.running, `arp plays (peak ${arp.pk.toFixed(4)}) and stops on release`);

  // 5. layer / split + state round trip
  const st = await pg.evaluate(async () => {
    D.setInstrument(0, 'ember'); D.loadPatch(0, 'Wall of Sound');
    const s0 = P.getState();
    s0.mode = 'split'; s0.splitNote = 55; s0.slots[1].instr = 'fm'; s0.slots[1].patch = { name: 'DX Electric Piano', user: false }; s0.slots[1].P = null;
    s0.slots[0].P.cutoff = 777; s0.slots[0].dirty = true;
    s0.user.push({ instr: 'organ', name: 'Test Organ Patch', cat: 'Jazz', p: { db1: 8, db2: 0, db3: 8 } });
    P.setState(JSON.parse(JSON.stringify(s0)));
    const s1 = JSON.parse(JSON.stringify(P.getState()));
    // split routing: low note -> slot B, high note -> slot A
    P.noteOn(48, 0.8, Studio.ctx.currentTime, { ch: 0 }); P.noteOn(72, 0.8, Studio.ctx.currentTime, { ch: 0 }); await sleep(60);
    const r = { a: D.slots[0].voices.map(v => v.key), b: D.slots[1].voices.map(v => v.key) };
    const pk = await peakRms(300); P.allNotesOff();
    // layer: one key -> both slots
    const s2 = P.getState(); s2.mode = 'layer'; P.setState(s2);
    P.noteOn(60, 0.8, Studio.ctx.currentTime, { ch: 0 }); await sleep(60);
    const layer = [D.slots[0].voices.length, D.slots[1].voices.length]; P.allNotesOff();
    const s3 = P.getState(); s3.mode = 'single'; P.setState(s3);
    return { s1, r, pk, layer, ui: document.querySelector('.plug-ember [id="emb-pname"]').textContent };
  });
  ok(st.s1.mode === 'split' && st.s1.splitNote === 55 && st.s1.slots[1].instr === 'fm' && st.s1.slots[1].patch.name === 'DX Electric Piano', 'setState/getState round trip: mode, split, slot B instrument + patch');
  ok(st.s1.slots[0].P.cutoff === 777 && st.s1.slots[0].dirty, 'edited params of slot A survive the round trip');
  ok(st.s1.user.some(u => u.name === 'Test Organ Patch'), 'user patch library in state');
  ok(st.r.a.includes(72) && !st.r.a.includes(48) && st.r.b.includes(48) && !st.r.b.includes(72) && st.pk > 0.003, `split routes notes: A ${st.r.a} / B ${st.r.b}`);
  ok(st.layer[0] === 1 && st.layer[1] === 1, `layer plays both slots (${st.layer})`);
  ok(/Wall of Sound/.test(st.ui), 'UI follows setState: ' + st.ui);

  // 6. UI: dialogs + scoped ids, then screenshots of library + split bar
  const ui = await pg.evaluate(() => ({
    ids: [...document.querySelectorAll('.plug-ember [id]')].every(e => e.id.startsWith('emb-')),
    knobs: document.querySelectorAll('.plug-ember .knob').length,
  }));
  ok(ui.ids, 'all ids inside the panel are prefixed emb-');
  ok(ui.knobs > 20, `knobs rendered (${ui.knobs})`);
  await pg.click('.plug-ember .tab[data-i="fm"]'); await pg.waitForTimeout(300);
  await pg.click('.plug-ember #emb-libBtn'); await pg.waitForTimeout(300);
  await pg.screenshot({ path: `${SHOTS}/plugin-library.png` });
  await pg.keyboard.press('Escape');
  await pg.selectOption('.plug-ember #emb-mode', 'split'); await pg.waitForTimeout(200);
  await pg.screenshot({ path: `${SHOTS}/plugin-split.png`, clip: { x: 0, y: 0, width: 1400, height: 400 } });
  await pg.selectOption('.plug-ember #emb-mode', 'single');
  // knob drag changes a param and marks the patch dirty
  const box = await pg.locator('.plug-ember .knob[data-k="tone"]').boundingBox();
  await pg.mouse.move(box.x + box.width / 2, box.y + 20); await pg.mouse.down(); await pg.mouse.move(box.x + box.width / 2, box.y - 40, { steps: 5 }); await pg.mouse.up();
  const drag = await pg.evaluate(() => ({ tone: D.slots[0].P.tone, name: document.querySelector('#emb-pname').textContent }));
  ok(/\*$/.test(drag.name), `knob drag edits param (tone ${Math.round(drag.tone)}) and marks patch dirty`);

  ok(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

  // 7. audio works without mount()
  const pg2 = await b.newPage(); const errs2 = [];
  pg2.on('pageerror', e => errs2.push(e.message)); pg2.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs2.push(m.text()); });
  await pg2.goto(BASE + '?nomount'); await pg2.evaluate(() => window.ready);
  const nm = await pg2.evaluate(async () => {
    P.noteOn(60, 0.8, Studio.ctx.currentTime, { ch: 0 }); let pk = 0; for (let i = 0; i < 30; i++) { pk = Math.max(pk, MockStudio.rms()); await new Promise(r => setTimeout(r, 20)); }
    P.cc(1, 1, { ch: 0 }); P.cc(64, 1, { ch: 0 }); P.noteOff(60, Studio.ctx.currentTime, { ch: 0 }); P.cc(64, 0, { ch: 0 });
    P.setState(P.getState());
    return { pk, mounted: !!document.querySelector('.plug-ember') };
  });
  ok(nm.pk > 0.01 && !nm.mounted, `audio without mount (peak ${nm.pk.toFixed(4)})`);
  ok(errs2.length === 0, 'no errors without mount' + (errs2.length ? ': ' + errs2.join(' | ') : ''));

  await b.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
