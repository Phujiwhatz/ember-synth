// Ember Ultimate shell test: node tests/shell-test.js [--no-build] [--html path]
// Builds dist/ember-ultimate.html, opens it via file://, starts audio, mounts every plugin,
// runs the transport, checks audio output and the WAV bounce, and saves screenshots to tests/shell-shots/.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'shell-shots');
const argv = process.argv.slice(2);
fs.mkdirSync(SHOTS, { recursive: true });

let html = path.join(ROOT, 'dist', 'ember-ultimate.html');
if (argv.includes('--html')) html = path.resolve(argv[argv.indexOf('--html') + 1]);
if (!argv.includes('--no-build') && !argv.includes('--html')) {
  console.log(execSync('python3 build.py 2>&1', { cwd: ROOT }).toString());
}
// no plugins yet? build a variant with the throwaway test plugin
const built = fs.readFileSync(html, 'utf8');
if (!/<script data-plugin=/.test(built)) {
  const alt = path.join(__dirname, 'shell-out', 'ember-ultimate-test.html');
  execSync(`python3 build.py --extra tests/shell-testplugin.js --out ${alt}`, { cwd: ROOT });
  html = alt;
  console.log('no plugins in src/plugins — testing with tests/shell-testplugin.js');
}

const fails = [];
function check(ok, msg) { console.log((ok ? '  ok   ' : '  FAIL ') + msg); if (!ok) fails.push(msg); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('request', r => { const u = r.url(); if (!/^(file|data|blob):/.test(u)) errors.push('network request: ' + u); });

  await page.goto('file://' + html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '0-overlay.png') });
  const ids = await page.evaluate(() => Studio.plugins.map(p => p.id));
  console.log('plugins registered:', ids.join(', ') || '(none)');
  check(ids.length > 0, 'at least one plugin registered');

  await page.click('#eu-overlay');
  await page.waitForFunction(() => Studio._booted === true, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  check(await page.evaluate(() => Studio.ctx.state === 'running'), 'AudioContext running');

  // mount every plugin
  for (const id of ids) {
    await page.evaluate(id => Studio.arm(id), id);
    await page.waitForTimeout(400);
    const r = await page.evaluate(id => { const p = Studio.byId[id]; return { ready: p.ready, failed: p.failed, mounted: p.mounted, kids: p.el.childElementCount, h: p.el.scrollHeight }; }, id);
    check(r.ready && !r.failed && r.mounted && r.kids > 0, `plugin ${id} init+mount (children=${r.kids}, height=${r.h})`);
    await page.screenshot({ path: path.join(SHOTS, `1-plugin-${id}.png`) });
  }

  // transport timing
  const tr = await page.evaluate(async () => {
    const times = [];
    const off = Studio.transport.on('step', (s, t) => times.push([s, t]));
    Studio.transport.setBpm(120); Studio.transport.swing = 0;
    Studio.transport.start();
    await new Promise(r => setTimeout(r, 1500));
    Studio.transport.stop(); off();
    const d = []; for (let i = 1; i < times.length; i++) d.push(times[i][1] - times[i - 1][1]);
    const maxErr = Math.max(...d.map(x => Math.abs(x - 0.125)));
    return { n: times.length, first: times[0] && times[0][0], maxErr, ahead: times.length ? times[times.length - 1][1] - Studio.ctx.currentTime : 0 };
  });
  check(tr.n >= 11 && tr.n <= 15, `transport fired ${tr.n} steps in 1.5s @120 BPM`);
  check(tr.first === 0, 'step count starts at 0');
  check(tr.maxErr < 1e-6, `16th spacing exact (max err ${tr.maxErr.toExponential(1)} s)`);
  const sw = await page.evaluate(async () => {
    const times = []; const off = Studio.transport.on('step', (s, t) => times.push(t));
    Studio.transport.swing = 0.25; Studio.transport.start();
    await new Promise(r => setTimeout(r, 600)); Studio.transport.stop(); off(); Studio.transport.swing = 0;
    return [times[1] - times[0], times[2] - times[1]];
  });
  check(Math.abs(sw[0] - 0.125 * 1.25) < 1e-6 && Math.abs(sw[1] - 0.125 * 0.75) < 1e-6, `swing moves odd 16ths (${sw.map(x => x.toFixed(4)).join(', ')})`);

  const noSamples = await page.evaluate(() => !Studio.samples.manifest.samples.length);
  // audio: play a note on each instrument plugin through the armed route; measure strip + master
  for (const id of ids) {
    const r = await page.evaluate(async id => {
      Studio.arm(id);
      const p = Studio.byId[id];
      await new Promise(r => setTimeout(r, 200));
      let maxStrip = 0, maxMaster = 0;
      const notes = p.kind === 'drums' ? [36, 38] : [60, 64, 67];
      notes.forEach(n => Studio.input.noteOn(n, 0.9, { ch: 1, mpe: false }, 't'));
      const t0 = performance.now();
      while (performance.now() - t0 < 900) {
        await new Promise(r => setTimeout(r, 30));
        maxStrip = Math.max(maxStrip, p.strip.peak); maxMaster = Math.max(maxMaster, Studio.mixer.master.peakL, Studio.mixer.master.peakR);
      }
      notes.forEach(n => Studio.input.noteOff(n, { ch: 1, mpe: false }, 't'));
      await new Promise(r => setTimeout(r, 300));
      return { kind: p.kind, maxStrip, maxMaster };
    }, id);
    const ok = r.kind === 'fx' || r.maxStrip > 0.01;
    if (!ok && noSamples) { console.log(`  warn plugin ${id} silent — but samples/manifest.json has no samples yet`); continue; }
    check(ok, `plugin ${id} (${r.kind}) makes sound: strip peak ${r.maxStrip.toFixed(3)}, master ${r.maxMaster.toFixed(3)}`);
  }

  // transport-driven plugins: play transport and check master
  const tp = await page.evaluate(async () => {
    Studio.transport.start();
    let mx = 0; const t0 = performance.now();
    while (performance.now() - t0 < 2000) { await new Promise(r => setTimeout(r, 30)); mx = Math.max(mx, Studio.mixer.master.peakL); }
    return mx;
  });
  console.log('  info master peak while transport runs:', tp.toFixed(3));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOTS, '2-playing.png') });
  await page.evaluate(() => Studio.transport.stop());

  // limiter: slam master and make sure output never exceeds ceiling
  const lim = await page.evaluate(async () => {
    const ctx = Studio.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    g.gain.value = 8; o.connect(g).connect(Studio.mixer.master.bus); o.start();
    const a = Studio.mixer.master.aL, buf = new Float32Array(a.fftSize); let mx = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 600) { await new Promise(r => setTimeout(r, 20)); a.getFloatTimeDomainData(buf); for (const v of buf) mx = Math.max(mx, Math.abs(v)); }
    o.stop(); o.disconnect();
    await new Promise(r => setTimeout(r, 200));
    return mx;
  });
  check(lim <= 1.0, `limiter + soft clip hold a +18 dB overload under 0 dBFS (peak ${lim.toFixed(3)})`);

  // record → WAV
  const rec = await page.evaluate(async () => {
    const id = Studio.plugins.find(p => p.kind !== 'fx' && p.kind !== 'drums')?.id || Studio.plugins[0].id;
    Studio.arm(id);
    await Studio.recorder.start();
    Studio.input.noteOn(62, 0.9, { ch: 1, mpe: false }, 'r');
    await new Promise(r => setTimeout(r, 700));
    Studio.input.noteOff(62, { ch: 1, mpe: false }, 'r');
    await new Promise(r => setTimeout(r, 200));
    const blob = Studio.recorder.stop();
    if (!blob) return { size: 0 };
    const buf = await Studio.ctx.decodeAudioData(await blob.arrayBuffer());
    const d = buf.getChannelData(0); let mx = 0; for (const v of d) mx = Math.max(mx, Math.abs(v));
    return { size: blob.size, dur: buf.duration, ch: buf.numberOfChannels, peak: mx };
  });
  check(rec.size > 44 && rec.ch === 2 && rec.peak > 0.005, `WAV bounce: ${rec.size} bytes, ${rec.dur && rec.dur.toFixed(2)} s, peak ${rec.peak && rec.peak.toFixed(3)}`);

  // QWERTY + MPE dispatch through the input router (spy on the armed plugin)
  const inp = await page.evaluate(async () => {
    const p = Studio.byId[Studio.armed]; const log = [];
    const orig = {}; ['noteOn', 'noteOff', 'bend', 'pressure', 'cc'].forEach(k => { orig[k] = p.def[k]; p.def[k] = function () { log.push([k].concat([].slice.call(arguments))); return orig[k] && orig[k].apply(this, arguments); }; });
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', key: 'a' }));
    // fake MIDI: note on ch2 (MPE member), bend, pressure, CC74, note off
    const ev = d => ({ data: new Uint8Array(d), target: { id: 'fake' } });
    const h = Studio.input._onMessage;
    if (h) { h(ev([0x91, 64, 100])); h(ev([0xE1, 0x7f, 0x7f])); h(ev([0xD1, 64])); h(ev([0xB1, 74, 127])); h(ev([0x81, 64, 0])); h(ev([0xE0, 0, 0x40])); }
    Object.keys(orig).forEach(k => p.def[k] = orig[k]);
    return log.map(e => e.map(x => typeof x === 'object' && x ? JSON.stringify(x) : typeof x === 'number' ? +x.toFixed(3) : x).join(' '));
  });
  console.log('  info input log:\n    ' + inp.join('\n    '));
  check(inp.some(l => /^noteOn 60 0\.8/.test(l)) && inp.some(l => /^noteOff 60/.test(l)), 'QWERTY A plays C4');
  check(inp.some(l => /^noteOn 64 .*"ch":2,"mpe":true/.test(l)), 'MPE member note routed with ch=2 mpe=true');
  check(inp.some(l => /^bend 48 .*"ch":2/.test(l)), 'MPE member bend uses ±48 st');
  check(inp.some(l => /^pressure 0\.504 .*"ch":2/.test(l)), 'channel pressure → pressure()');
  check(inp.some(l => /^cc 74 1 /.test(l)), 'CC74 → cc()');
  check(inp.some(l => /^bend 0 .*"ch":1,"mpe":false/.test(l)), 'master-channel bend centre = 0');

  // project round trip + autosave
  const proj = await page.evaluate(async () => {
    Studio.transport.setBpm(97); Studio.mixer.set(Studio.plugins[0].id, 'vol', -7.5);
    const s = Studio.project.serialize();
    Studio.project.reset();
    const afterReset = Studio.transport.bpm;
    Studio.project.apply(JSON.parse(JSON.stringify(s)));
    await Studio._autosave(true);
    const saved = await Studio.storage.get('autosave');
    return { afterReset, bpm: Studio.transport.bpm, vol: Studio.mixer.get(Studio.plugins[0].id).vol, saved: saved && saved.bpm, plugins: Object.keys(s.plugins) };
  });
  check(proj.afterReset === 120 && proj.bpm === 97 && proj.vol === -7.5 && proj.saved === 97, `project serialize/reset/apply/autosave (plugins with state: ${proj.plugins.join(', ')})`);

  // keyboard dock + screenshots at 13" sizes
  await page.evaluate(() => document.querySelector('.eu-tbtn[aria-label=Keyboard]').click());
  await page.evaluate(id => Studio.arm(id), ids[0]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '3-keys-1280x800.png') });
  const ov = await page.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: innerHeight, sw: document.documentElement.scrollWidth, iw: innerWidth }));
  check(ov.sh <= ov.ih && ov.sw <= ov.iw, `no page scroll at 1280x800 (${ov.sw}x${ov.sh})`);
  await page.setViewportSize({ width: 1280, height: 700 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '4-1280x700.png') });
  const clip = await page.evaluate(() => { const r = document.querySelector('.eu-proj').getBoundingClientRect(), m = document.querySelector('#eu-master').getBoundingClientRect(); return { proj: r.right, master: m.right, w: innerWidth }; });
  check(clip.proj <= clip.w && clip.master <= clip.w, `top bar + master fit in 1280px (menu right ${Math.round(clip.proj)}, master right ${Math.round(clip.master)})`);
  await page.evaluate(() => document.querySelector('.eu-proj').click());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '5-menu.png') });

  // reload: autosave restores
  await page.reload();
  await page.click('#eu-overlay');
  await page.waitForFunction(() => Studio._booted === true, null, { timeout: 15000 });
  check(await page.evaluate(() => Studio.transport.bpm) === 97, 'autosave restored after reload');

  const real = errors.filter(e => !/MIDI/i.test(e));
  check(real.length === 0, 'no console errors' + (real.length ? ':\n      ' + real.slice(0, 15).join('\n      ') : ''));
  await browser.close();
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
