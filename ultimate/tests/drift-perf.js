const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage(); await p.goto('http://localhost:8765/tests/drift-harness.html'); await p.evaluate(() => window.__ready);
  console.log(await p.evaluate(() => { const o = {}; ['builtin:choir','builtin:glass','builtin:air','builtin:tape'].forEach(id => { const t = performance.now(); delete drift.builtinCache[id]; drift.getBuiltin(id); o[id] = Math.round(performance.now() - t) + 'ms'; }); return o; }));
  // main-thread cost under stress
  console.log(await p.evaluate(() => new Promise(r => { drift.setParam('density', 100); for (let i = 0; i < 8; i++) drift.noteOn(48 + i * 4, 1, 0, {ch:0});
    let busy = 0; const orig = drift.tick.bind(drift); drift.tick = function () { const t = performance.now(); orig(); busy += performance.now() - t; };
    setTimeout(() => r({ tickMsPerSec: (busy / 3).toFixed(1), max: drift.maxActive }), 3000); })));
  await b.close();
})();
