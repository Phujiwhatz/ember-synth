// Drift plugin test: node tests/drift-test.js  (expects server on :8765 serving ultimate/)
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8765/tests/drift-harness.html';
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1240, height: 720 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/manifest\.json|404/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.goto(URL);
  await page.evaluate(() => window.__ready);
  const fails = [];
  const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails.push(msg); };
  const rmsOver = (ms) => page.evaluate(ms => new Promise(r => { let mx = 0, s = 0, n = 0; const t0 = performance.now();
    (function f() { const v = MockStudio.rms(); mx = Math.max(mx, v); s += v; n++; if (performance.now() - t0 < ms) setTimeout(f, 20); else r({ max: mx, avg: s / n }); })(); }), ms);

  ok((await page.evaluate(() => MockStudio.rms())) < 1e-4, 'silent before notes');
  await page.evaluate(() => { drift.applyPreset('Airport Lounge'); [48, 55, 60, 64].forEach(n => drift.noteOn(n, 0.9, 0, { ch: 0 })); });
  const r1 = await rmsOver(2500);
  console.log('  chord rms', r1);
  ok(r1.max > 0.02, 'non-silent chord output');
  ok(r1.max < 0.9, 'not clipping');
  await page.screenshot({ path: 'tests/drift-shot-play.png' });

  // release fade
  await page.evaluate(() => { drift.params.release = 1.0; [48, 55, 60, 64].forEach(n => drift.noteOff(n, 0, { ch: 0 })); });
  const rDuring = await rmsOver(300);
  ok(rDuring.max > 0.005, 'still audible early in release (no hard cut)');
  await page.waitForTimeout(1600);
  const st = await page.evaluate(() => drift._stats());
  console.log('  after release stats', st);
  ok(st.voices === 0 && st.active === 0, 'voices + grains retired after release');
  // reverb tail may still ring; dry grains must be gone. wait for tail
  await page.waitForTimeout(5000);
  const rEnd = await rmsOver(300);
  ok(rEnd.max < 0.01, 'tail decays to near silence (' + rEnd.max.toFixed(4) + ')');

  // grain cap stress: 8 notes at max density, small size + extra notes for stealing
  await page.evaluate(() => { drift.maxActive = 0; drift.setParam('density', 100); drift.setParam('size', 1); drift.params.pitch = 0;
    for (let i = 0; i < 10; i++) drift.noteOn(48 + i * 3, 1, 0, { ch: 0 }); drift.pressure(1, { ch: 0 }); });
  await page.waitForTimeout(2500);
  const st2 = await page.evaluate(() => drift._stats());
  console.log('  stress stats', st2);
  ok(st2.maxActive <= 120, 'grain cap holds (max ' + st2.maxActive + ')');
  ok(st2.allVoices <= 10 && st2.voices <= 8, 'polyphony capped at 8');
  const r2 = await rmsOver(500);
  ok(r2.max > 0.02 && r2.max < 1.0, 'stress output sane ' + r2.max.toFixed(3));
  await page.evaluate(() => drift.allNotesOff());
  await page.waitForTimeout(400);

  // MPE: per-note bend + pressure
  const mpe = await page.evaluate(() => { drift.noteOn(60, 0.8, 0, { ch: 2, mpe: true }); drift.noteOn(67, 0.8, 0, { ch: 3, mpe: true });
    drift.bend(2, { ch: 2, mpe: true }); drift.pressure(0.7, { ch: 3, mpe: true }); drift.cc(1, 0.6, {});
    const v = drift.voices.filter(v => !v.releasing); return v.map(x => [x.note, x.bend, x.pressure]); });
  console.log('  mpe voices', JSON.stringify(mpe));
  ok(mpe.some(x => x[0] === 60 && x[1] === 2) && mpe.some(x => x[0] === 67 && x[1] === 0 && x[2] === 0.7), 'MPE per-note bend/pressure routed');
  await page.waitForTimeout(800);
  await page.evaluate(() => { drift.noteOff(60, 0, { ch: 2, mpe: true }); drift.noteOff(67, 0, { ch: 3, mpe: true }); drift.cc(1, 0, {}); });

  // presets + state roundtrip
  const names = await page.evaluate(() => Array.from(document.querySelectorAll('.plug-drift [data-role=preset] option')).map(o => o.value));
  ok(names.length >= 11, 'preset menu has ' + names.length + ' entries');
  const rt = await page.evaluate(() => { drift.applyPreset('Glass Cathedral'); const s = JSON.stringify(drift.getState());
    drift.applyPreset('Deep Field'); drift.setState(JSON.parse(s)); return [s, JSON.stringify(drift.getState())]; });
  ok(rt[0] === rt[1], 'getState/setState roundtrip');
  await page.waitForTimeout(100);
  // each preset quick audible check
  for (const n of names.filter(n => n !== '__custom')) {
    await page.evaluate(n => { drift.allNotesOff(); drift.applyPreset(n); }, n);
    await page.waitForTimeout(150);
    await page.evaluate(() => drift.noteOn(60, 0.9, 0, { ch: 0 }));
    const r = await rmsOver(1500);
    await page.evaluate(() => drift.noteOff(60, 0, { ch: 0 }));
    ok(r.max > 0.01 && r.max < 1, 'preset ' + n + ' audible (' + r.max.toFixed(3) + ') src=' + await page.evaluate(() => drift.sourceId));
  }
  await page.evaluate(() => drift.allNotesOff());

  // real samples if present
  const cats = await page.evaluate(() => (Studio.samples.manifest.samples || []).filter(s => s.category !== 'drums').map(s => s.id));
  if (cats.length) {
    const pick = await page.evaluate(() => (Studio.samples.byCategory('textures')[0] || Studio.samples.byCategory('pads')[0] || {}).id);
    console.log('  testing real sample', pick, 'of', cats.length);
    if (pick) {
      await page.evaluate(id => drift.loadSource(id), pick);
      await page.evaluate(() => drift.noteOn(60, 0.9, 0, { ch: 0 }));
      const r = await rmsOver(1500);
      ok(r.max > 0.01, 'real sample ' + pick + ' audible (' + r.max.toFixed(3) + ')');
      await page.screenshot({ path: 'tests/drift-shot-sample.png' });
      await page.evaluate(() => drift.noteOff(60, 0, { ch: 0 }));
    }
  } else console.log('  (no samples manifest yet; built-in sources only)');

  // import via file input (generated WAV)
  const wav = (() => { const sr = 22050, n = sr * 2, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 220 * i / sr) * Math.sin(Math.PI * i / n)), 44 + i * 2); return b; })();
  await page.setInputFiles('.plug-drift [data-role=file]', { name: 'my-hum.wav', mimeType: 'audio/wav', buffer: wav });
  await page.waitForFunction(() => drift.sourceId.indexOf('user-') === 0, null, { timeout: 5000 }).catch(() => {});
  const imp = await page.evaluate(() => [drift.sourceId, drift.sourceName, document.querySelector('.plug-drift [data-role=source]').value]);
  ok(imp[0].indexOf('user-') === 0 && imp[2] === imp[0], 'import file -> selected as source ' + JSON.stringify(imp));
  await page.evaluate(() => drift.noteOn(57, 0.9, 0, { ch: 0 }));
  const ri = await rmsOver(1200);
  ok(ri.max > 0.01, 'imported source audible (' + ri.max.toFixed(3) + ')');
  await page.evaluate(() => drift.allNotesOff());

  // UI interactions: knob drag, xy click, freeze
  const kb = await page.locator('.plug-drift .dr-knob[data-k=reverb]').boundingBox();
  const before = await page.evaluate(() => drift.params.reverb);
  await page.mouse.move(kb.x + kb.width / 2, kb.y + 25); await page.mouse.down(); await page.mouse.move(kb.x + kb.width / 2, kb.y - 20, { steps: 5 }); await page.mouse.up();
  ok((await page.evaluate(() => drift.params.reverb)) > before, 'knob drag increases value');
  const xb = await page.locator('.plug-drift .dr-xy').boundingBox();
  await page.mouse.click(xb.x + xb.width * 0.8, xb.y + xb.height * 0.2);
  const pz = await page.evaluate(() => [drift.params.pos, drift.params.size]);
  ok(Math.abs(pz[0] - 0.8) < 0.03 && pz[1] > 0.2, 'xy pad sets position/size ' + pz.map(x => x.toFixed(2)));
  await page.click('.plug-drift [data-act=freeze]');
  ok(await page.evaluate(() => drift.freeze), 'freeze toggles');
  await page.evaluate(() => { drift.applyPreset('Glass Cathedral'); [57, 64, 69, 76].forEach(n => drift.noteOn(n, 0.9, 0, { ch: 0 })); });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'tests/drift-shot-ui.png' });
  await page.evaluate(() => drift.allNotesOff());

  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  console.log(fails.length ? '\n' + fails.length + ' FAILED' : '\nALL PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
