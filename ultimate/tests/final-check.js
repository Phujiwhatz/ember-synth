const {chromium}=require('playwright');(async()=>{
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--autoplay-policy=no-user-gesture-required']});
const p=await b.newPage({viewport:{width:1440,height:900}});const errs=[],net=[];
p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>m.type()==='error'&&errs.push(m.text()));
p.on('request',r=>{const u=r.url();if(!/^(file|data|blob):/.test(u))net.push(u)});
await p.goto('file://'+process.cwd()+'/dist/ember-ultimate.html');await p.waitForTimeout(1000);
await p.mouse.click(720,450);await p.waitForTimeout(4000);
for(const id of ['pulse16','acid','keys']){await p.evaluate(i=>Studio.arm(i),id);await p.waitForTimeout(2500);await p.screenshot({path:'tests/final-'+id+'.png'});}
const txt=await p.evaluate(()=>document.querySelector('.plug-acid')?.innerText.match(/WORKLET|BIQUAD[^\n]*/i)?.[0]);
console.log('acid filter:',txt);
// play keys grand + pulse16 via transport for a moment
await p.evaluate(()=>{Studio.arm('keys');});
console.log('errors',errs,'net',net);await b.close();})();
