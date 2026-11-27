const {chromium}=require('playwright');(async()=>{
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--autoplay-policy=no-user-gesture-required']});
const p=await b.newPage({viewport:{width:1440,height:900}});const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
const reqs=[];p.on('request',r=>{if(!r.url().startsWith('file:')&&!r.url().startsWith('data:')&&!r.url().startsWith('blob:'))reqs.push(r.url())});
await p.goto('file://'+process.cwd()+'/dist/ember-ultimate.html');await p.waitForTimeout(800);
await p.mouse.click(720,450);await p.waitForTimeout(2500);
for(const id of ['ember','keys','acid','drift']){await p.evaluate(i=>Studio.arm&&Studio.arm(i),id);await p.waitForTimeout(1500);await p.screenshot({path:'tests/final-'+id+'.png'});}
console.log('errors',errs,'net',reqs);await b.close();})();
