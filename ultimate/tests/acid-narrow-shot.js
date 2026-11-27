const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 940, height: 900 } });
  const errs=[]; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8791/tests/acid-harness.html');
  await p.evaluate(() => window.acidReady);
  await p.evaluate(() => { const st = acid._debug.state; st.patterns[0].len = 24; acid.setState(acid.getState()); Studio.transport.start(); });
  let peak=0; for (let i=0;i<10;i++){ await p.waitForTimeout(100); peak=Math.max(peak, await p.evaluate(()=>MockStudio.rms())); }
  console.log('rms', peak.toFixed(3), errs);
  await p.screenshot({ path: '' + __dirname + '/acid-shot-narrow32.png', fullPage: true });
  await b.close();
})();
