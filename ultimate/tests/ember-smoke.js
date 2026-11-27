// quick smoke: load harness, screenshot, print console errors
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const pg = await b.newPage({ viewport: { width: 1400, height: 1100 } });
  const errs = []; pg.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); }); pg.on('pageerror', e => errs.push('pageerror: ' + e.message));
  await pg.goto('http://localhost:8765/tests/ember-harness.html'); await pg.evaluate(() => window.ready);
  await pg.evaluate(() => { for (const n of [60,64,67]) P.noteOn(n, 0.8, 0, {ch:0}); });
  await pg.waitForTimeout(800);
  console.log('rms', await pg.evaluate(() => MockStudio.rms()));
  await pg.screenshot({ path: process.argv[2] || '/tmp/emb/shots/smoke.png', fullPage: true });
  console.log(errs.join('\n') || 'no console errors');
  await b.close();
})();
