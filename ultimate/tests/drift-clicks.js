// Offline click check: renders Drift dry (no reverb/delay) and looks for discontinuities.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8765/tests/drift-harness.html'); await p.evaluate(() => window.__ready);
  const res = await p.evaluate(async (LP) => {
    const out = {}; const process_lp = LP;
    for (const [preset, note] of [['Deep Field', 48], ['Airport Lounge', 60], ['Stutter Bloom', 55], ['Glass Cathedral', 72]]) {
      drift.applyPreset(preset);
      const src = drift.sourceId, buf = drift.buf;
      const off = new OfflineAudioContext(2, 44100 * 5, 44100);
      clearInterval(drift.timer); drift.voices = []; drift.active = 0; drift.lastTick = 0;
      const saved = { ctx: drift.ctx, ui: drift.ui };
      drift.ui = null;
      await drift.init(off, off.destination, Studio);
      clearInterval(drift.timer);
      drift.applyPreset(preset); drift.setBuffer(src, 'x', 60, buf.sampleRate === 44100 ? buf : buf);
      drift.params.reverb = 0; drift.params.feedback = 0; drift.params.attack = 0.3; drift.params.release = 0.8; if (process_lp) drift.params.cutoff = 1200; drift.applyAll(true);
      for (let t = 0.05; t < 4.95; t += 0.05) off.suspend(t).then(() => { drift.tick(); if (Math.abs(off.currentTime - 0.1) < 0.026) [note, note + 7].forEach(n => drift.noteOn(n, 0.9, 0.1, { ch: 0 })); if (Math.abs(off.currentTime - 3) < 0.026) [note, note + 7].forEach(n => drift.noteOff(n, 3, { ch: 0 })); off.resume(); });
      const r = await off.startRendering();
      const d = r.getChannelData(0);
      // HF detector: 2nd difference vs local RMS of the signal
      let worst = 0, at = 0, peak = 0;
      for (let i = 2; i < d.length; i++) { peak = Math.max(peak, Math.abs(d[i])); const dd = Math.abs(d[i] - 2 * d[i - 1] + d[i - 2]); if (dd > worst) { worst = dd; at = i / 44100; } }
      let tail = 0; for (let i = Math.floor(44100 * 4.2); i < d.length; i++) tail = Math.max(tail, Math.abs(d[i]));
      out[preset] = { peak: +peak.toFixed(3), worst2ndDiff: +worst.toFixed(4), at: +at.toFixed(3), ratio: +(worst / peak).toFixed(3), tailAfterRelease: tail };
      drift.ui = saved.ui;
    }
    return out;
  }, !!process.env.LP);
  console.log(res, errs);
  await b.close();
})();
