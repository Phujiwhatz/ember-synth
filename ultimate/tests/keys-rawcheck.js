// Diagnostic: pitch of raw library samples vs manifest root (no Keys engine involved).
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await b.newPage();
  await page.goto('http://localhost:8765/tests/keys-harness.html');
  await page.evaluate(() => window.keysReady);
  const out = await page.evaluate(async (ids) => {
    const m = Studio.samples.manifest, res = [];
    for (const iid of ids) {
      const zs = m.instruments[iid].zones.filter((z, i, a) => a.findIndex(q => q.root === z.root) === i);
      for (const z of zs.filter((_, i) => i % 3 === 1).slice(0, 4)) {
        const buf = await Studio.samples.get(z.id);
        // FFT-free check: detector at a mid-sample window + strongest spectral peak via offline analyser
        const r = K._debug.detectPitch(buf);
        const exp = 440 * Math.pow(2, (z.root - 69) / 12);
        // spectral peak
        const oc = new OfflineAudioContext(1, Math.min(buf.length, 65536), buf.sampleRate);
        const s = oc.createBufferSource(); s.buffer = buf; const an = oc.createAnalyser(); an.fftSize = 32768;
        s.connect(an); an.connect(oc.destination); s.start(0);
        let peak = 0; oc.suspend(Math.min(buf.duration, 65536 / buf.sampleRate) * 0.9).then(() => {
          const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f);
          let bi = 0; for (let i = 5; i < f.length; i++) if (f[i] > f[bi]) bi = i; peak = bi * buf.sampleRate / an.fftSize; oc.resume(); });
        await oc.startRendering();
        res.push(`${iid} ${z.id} root ${z.root} exp ${exp.toFixed(1)} | ac ${r ? r.freq.toFixed(1) + ' (' + (1200 * Math.log2(r.freq / exp)).toFixed(0) + 'c, clarity ' + r.clarity.toFixed(2) + ')' : 'none'} | spectral peak ${peak.toFixed(1)}`);
      }
    }
    return res;
  }, ['grand', 'warm-pad', 'glass-texture', 'epiano']);
  console.log(out.join('\n'));
  await b.close();
})();
