/* Ember Studio — plugin port of ../synth.html for Ember Ultimate.
   Five instruments (Ember·16, Ion FM, Prism WT, Tonewheel B3, Ensemble 70), the full patch
   library with LEVELS, two slots with layer/split, per-slot arp + FX, MPE.
   The sound engines below are copied verbatim from synth.html; only the audio context, the
   input plumbing (MIDI / QWERTY / on-screen keys now come from the shell) and the DOM scoping
   changed. */
(function(){
'use strict';
let Studio = null, OUT = null, root = null;
const F_LCD = '"VT323","Andale Mono","Menlo","Consolas",monospace';
const F_WT = '"Space Grotesk","Avenir Next","Futura","Segoe UI",sans-serif';
const F_ORG = '"Playfair Display","Didot","Bodoni 72","Georgia",serif';
/* ================= shared helpers ================= */
// scoped lookup: '#foo' means the element with id 'emb-foo' inside the mounted panel
const $ = s => root ? root.querySelector(s.replace(/#([\w-]+)/g, '#emb-$1')) : null;
const $$ = s => root ? [...root.querySelectorAll(s.replace(/#([\w-]+)/g, '#emb-$1'))] : [];
const clamp = (v,a,b) => Math.min(b, Math.max(a, v));
const mtof = n => 440*Math.pow(2,(n-69)/12);
const esc = x => String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let ctx = null;
const M = {};                       // master nodes
const gn = val => { const g = ctx.createGain(); g.gain.value = val; return g; };
const cs = val => { const c = ctx.createConstantSource(); c.offset.value = val; return c; };
function hold(p,t){ if(p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else { const v = p.value; p.cancelScheduledValues(t); p.setValueAtTime(v,t); } }
// attack-decay-sustain on an AudioParam (linear attack, exponential decay)
function adsr(p, t, peak, A, D, S, from = 0){
 p.setValueAtTime(from, t); p.linearRampToValueAtTime(peak, t + A); p.setTargetAtTime(peak*S, t + A, Math.max(0.001, D/3));
}
function relEnv(p, t, R, to = 0){ hold(p,t); p.setTargetAtTime(to, t, Math.max(0.001, R/4)); return t + R*2 + 0.05; }

const ms = v => v < 1 ? Math.round(v*1000)+' ms' : v.toFixed(2)+' s';
const pct = v => Math.round(v*100)+'%';
const hz = v => v >= 1000 ? (v/1000).toFixed(1)+' kHz' : Math.round(v)+' Hz';
const sgn = v => (v>0?'+':'')+v;

let PULSE = null;
function pulseWave(){ if(PULSE) return PULSE; const n=64,re=new Float32Array(n),im=new Float32Array(n); for(let i=1;i<n;i++) re[i]=2/(i*Math.PI)*Math.sin(i*Math.PI*0.25); return PULSE = ctx.createPeriodicWave(re,im); }
function setWave(o, type){ if(type==='pulse') o.setPeriodicWave(pulseWave()); else o.type = type; }
// sine LFO with a phase offset (radians) via a PeriodicWave
function phasedLFO(freq, phase){
 const o = ctx.createOscillator(), re = new Float32Array(2), im = new Float32Array(2);
 re[1] = Math.sin(phase); im[1] = Math.cos(phase);
 o.setPeriodicWave(ctx.createPeriodicWave(re, im, {disableNormalization:true})); o.frequency.value = freq; o.start(); return o;
}
function driveCurve(d){ const k=0.01+d*8,n=2048,c=new Float32Array(n),tk=Math.tanh(k); for(let i=0;i<n;i++){ const x=i/(n-1)*2-1; c[i]=Math.tanh(k*x)/tk; } return {c, post:0.3/(Math.tanh(0.3*k)/tk)}; }
function impulse(sec){
 const sr=ctx.sampleRate,len=Math.floor(sr*sec),pre=Math.floor(sr*0.012),b=ctx.createBuffer(2,len+pre,sr);
 for(let ch=0;ch<2;ch++){ const d=b.getChannelData(ch); let y=0; for(let i=0;i<len;i++){ const t=i/len,a=0.85-0.75*t; y+=a*((Math.random()*2-1)-y); d[i+pre]=y*Math.pow(1-t,2.2); } }
 return b;
}
let NOISE = null;
function noiseBuf(){ if(NOISE) return NOISE; const b = ctx.createBuffer(1, ctx.sampleRate*2, ctx.sampleRate), d = b.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1; return NOISE = b; }

/* ---- shared per-slot effects: drive -> chorus -> (delay, reverb sends) -> out ---- */
function buildFX(n){
 n.fxIn = gn(1);
 n.shaper = ctx.createWaveShaper(); n.shaper.oversample = '4x'; n.post = gn(1);
 n.fxIn.connect(n.shaper); n.shaper.connect(n.post);
 n.chDry = gn(1); n.chWet = gn(0); n.fx = gn(1);
 n.post.connect(n.chDry); n.chDry.connect(n.fx);
 const dL = ctx.createDelay(0.05), dR = ctx.createDelay(0.05); dL.delayTime.value = 0.011; dR.delayTime.value = 0.016;
 const cl = ctx.createOscillator(); cl.frequency.value = 0.42; cl.start();
 const gL = gn(0.0022), gR = gn(-0.0026); cl.connect(gL); cl.connect(gR); gL.connect(dL.delayTime); gR.connect(dR.delayTime);
 const cm = ctx.createChannelMerger(2); n.post.connect(dL); n.post.connect(dR);
 dL.connect(cm,0,0); dR.connect(cm,0,1); cm.connect(n.chWet); n.chWet.connect(n.fx);
 n.out = gn(1); n.fx.connect(n.out);
 n.dSend = gn(0); n.fx.connect(n.dSend);
 n.dl = ctx.createDelay(2); n.dr = ctx.createDelay(2); n.fb = gn(0);
 const lp = ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value = 3800;
 const hp = ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value = 180;
 const dm = ctx.createChannelMerger(2);
 n.dSend.connect(hp); hp.connect(n.dl); n.dl.connect(dm,0,0); n.dl.connect(n.dr); n.dr.connect(dm,0,1);
 n.dr.connect(n.fb); n.fb.connect(lp); lp.connect(n.dl);
 const dOut = gn(0.9); dm.connect(dOut); dOut.connect(n.out);
 n.rSend = gn(0); n.fx.connect(n.rSend); dOut.connect(n.rSend);
 n.conv = ctx.createConvolver(); n.rSend.connect(n.conv);
 const rOut = gn(0.9); n.conv.connect(rOut); rOut.connect(n.out);
 n.revSize = 0; n.revTimer = 0;
}
function applyFX(n, P){
 const t = ctx.currentTime, s = (p,v) => p.setTargetAtTime(v,t,0.02);
 const dc = driveCurve(P.drive); n.shaper.curve = dc.c; s(n.post.gain, dc.post);
 s(n.chWet.gain, P.chorus*0.8); s(n.chDry.gain, 1 - P.chorus*0.35);
 s(n.dl.delayTime, P.dTime); s(n.dr.delayTime, P.dTime); s(n.fb.gain, P.dFb); s(n.dSend.gain, P.dMix);
 s(n.rSend.gain, P.rMix);
 if(Math.abs(n.revSize - P.rSize) > 0.05){ clearTimeout(n.revTimer); n.revTimer = setTimeout(()=>{ n.conv.buffer = impulse(P.rSize); n.revSize = P.rSize; }, 120); }
}
const FX_SECTION = ['Effects', [
  {k:'drive',l:'Drive',min:0,max:1,fmt:pct,live:true},
  {k:'chorus',l:'Chorus',min:0,max:1,fmt:pct,live:true},
  {k:'dTime',l:'Delay',min:0.05,max:1,fmt:ms,live:true},
  {k:'dFb',l:'Feedback',min:0,max:0.85,fmt:pct,live:true},
  {k:'dMix',l:'Dly mix',min:0,max:0.8,fmt:pct,live:true},
  {k:'rSize',l:'Rev size',min:0.5,max:12,exp:1.5,fmt:v=>v.toFixed(1)+' s',live:true},
  {k:'rMix',l:'Rev mix',min:0,max:0.9,fmt:pct,live:true},
  {k:'volume',l:'Volume',min:0,max:2,fmt:pct,live:true}]];
const WAVES = [['sine','Sine'],['triangle','Triangle'],['sawtooth','Saw'],['square','Square'],['pulse','Pulse 25%']];

/* per-patch volume, measured so patches play at a similar loudness */
const LEVELS = {"fm":{"DX Electric Piano":0.73,"Rhodes Bark":0.53,"Crystal Piano":0.99,"FM Clav":0.87,"Vibraphone FM":0.97,"Harpsichord FM":0.82,"Tubular Bells":0.84,"Glass Bell":0.78,"Church Bell":0.64,"Kalimba FM":1.05,"Marimba FM":1.36,"Steel Drum FM":0.82,"Lately Bass":1.08,"Solid FM Bass":1.12,"Slap Bass FM":0.97,"Rubber FM Bass":0.96,"DX Brass":0.36,"Synth Brass FM":0.67,"FM Flute":0.9,"Sync Lead FM":0.78,"Harmonica FM":0.38,"FM Organ":0.63,"Glass Pad":0.74,"FM Strings":0.48,"Choir FM":0.54,"Metallic Pad":0.68,"Koto FM":0.74,"Sitar FM":0.73,"Harp FM":0.75,"Space Pluck":1.05,"Init FM":0.43},"wt":{"Prism Pad":0.54,"Vowel Choir":0.8,"Glass Swell":0.68,"Organ Bloom":0.65,"Sweep Cathedral":0.61,"Dark Sync Pad":0.37,"Shifting Sands":0.39,"Data Stream":0.63,"Spectral Tide":1.42,"Talking Machine":0.83,"Neon Lead":0.72,"Sync Scream":0.5,"Vocal Lead":1.23,"PWM Lead":0.5,"Bitcrush Lead":1.15,"Growl Bass":0.31,"Wobble WT":0.3,"Reese WT":0.42,"Pluck Bass WT":1.38,"Digital Sub":0.72,"Glass Keys":0.97,"Morph Pluck":1.66,"Formant Pluck":1.25,"Digital Piano":0.83,"Crush Arp":2.0,"Laser Sweep":0.48,"Robot Voice":0.64,"Init WT":0.67},"organ":{"Jimmy Smith":0.67,"Jazz Ballad":0.85,"Soul Comping":0.65,"Mellow Flutes":0.92,"Booker Groove":0.75,"Full Gospel":0.42,"Gospel Shout":0.53,"Sunday Swell":0.77,"Rock Organ":0.5,"Screaming Drawbars":0.35,"Prog Organ":0.39,"Garage Combo":0.37,"Whiter Shade":0.78,"Church Pipes":0.36,"Theatre Organ":0.37,"Reggae Bubble":0.87,"Ballpark":0.3,"Pedal Bass":0.92,"Deep Sixteen":1.34,"Init Organ":0.98},"strings":{"Solina Classic":0.99,"Disco Strings":0.79,"Oxygene Sweep":0.65,"Cello Ensemble":0.76,"Violins High":0.96,"Viola Section":0.78,"Ballad Strings":0.82,"Lo-fi Tape Strings":0.74,"Bowed Bass":1.51,"Choir Ahh":0.77,"Choir Ooh":0.55,"Strings & Choir":0.77,"Vox Humana":0.84,"Ghost Choir":0.47,"Jarre Pad":0.73,"Dark Ensemble":0.92,"Polymoog Vox":0.9,"Eno Ambience":1.15,"Glass Ensemble":0.52,"Brass Ensemble":0.61,"Init Strings":1.05}};

/* ================= core: instruments, slots, voices ================= */
const INSTR = {}, INSTR_ORDER = [];
function defineInstrument(def){
 const lv = (typeof LEVELS !== 'undefined' && LEVELS[def.id]) || {};
 def.presets = def.presets.map(([c,n,p]) => [c, n, lv[n] != null ? {...p, volume: lv[n]} : p]);
 INSTR[def.id] = def; INSTR_ORDER.push(def.id);
}

// parameters every instrument shares (merged under each instrument's own defaults)
const CORE_BASE = {playMode:'poly',glideMode:'always',glide:0,transpose:0,octave:0,
 arpMode:'off',arpRate:'1/16',arpHold:'off',arpOct:1,arpGate:0.5,tempo:120,
 mpeMode:'auto',bendRange:48,gBend:2,pressAmp:0.3,pressVib:0,
 lfoRate:5,lfoVib:0,modVib:30,velSens:0.6,
 drive:0.15,chorus:0.4,dTime:0.375,dFb:0.35,dMix:0.15,rSize:3,rMix:0.25,volume:0.8};
const DEV = ['mpeMode','bendRange','gBend','transpose','octave','tempo'];   // global, not part of patches
const DEV_DEF = {mpeMode:'auto',bendRange:48,gBend:2,transpose:0,octave:0,tempo:120};
let DEVP = {...DEV_DEF};
const baseOf = id => ({...CORE_BASE, ...INSTR[id].base, ...DEVP});

const MAXV = 16;
let sustain = false, modWheel = 0;
let mode = 'single', editSlot = 0, splitNote = 60, bVol = 0.8, bOct = 0, learnSplit = false;
const chBend = new Array(17).fill(0), chPress = new Array(17).fill(0), chTimbre = new Array(17).fill(0);
let mpeSeen = false;
// the shell tells us per event whether a channel is an MPE member channel (info.mpe);
// without that hint fall back to Ember's own rule (lower zone: master ch 1, members 2-15)
const mpeFlag = new Array(17).fill(undefined);
const isMember = ch => DEVP.mpeMode === 'auto' && (mpeFlag[ch] !== undefined ? mpeFlag[ch] : (ch !== 0 && ch !== 15));

function mkSlot(i){ return {i, instr:i?'strings':'ember', P:null, cur:null, dirty:false, voices:[], mono:{stack:[]}, lastFreq:null,
 arp:{held:[],order:0,idx:0,next:0,timer:null,running:false,fresh:false}, n:null, inst:null}; }
const slots = [mkSlot(0), mkSlot(1)];
const activeSlots = () => mode === 'single' ? [slots[0]] : slots;

/* ---------- audio graph ---------- */
async function initAudio(){
 // ctx is the studio's shared AudioContext (set by init); output goes to the shell's channel strip
 M.bend = cs(0); M.bend.start();
 M.mix = gn(1);
 const pre = gn(0.5), clip = ctx.createWaveShaper(), cn = 4096, cc = new Float32Array(cn);
 for(let i=0;i<cn;i++){ const x=(i/(cn-1)*2-1)*2, ax=Math.abs(x); cc[i]=Math.sign(x)*(ax<0.7?ax:0.7+0.28*Math.tanh((ax-0.7)/0.28)); }
 clip.curve = cc; clip.oversample = '4x';
 M.an = ctx.createAnalyser(); M.an.fftSize = 2048;
 M.mix.connect(pre); pre.connect(clip); clip.connect(M.an); M.an.connect(OUT);
 for(const id of INSTR_ORDER) if(INSTR[id].init) await INSTR[id].init();
 for(const s of slots) buildSlot(s);
}
function buildSlot(s){
 if(!ctx) return;
 if(!s.n){
  const n = s.n = {};
  n.lfo = ctx.createOscillator(); n.lfo.start(); n.vib = gn(0); n.lfo.connect(n.vib);
  n.pitch = gn(1); n.vib.connect(n.pitch); M.bend.connect(n.pitch);
  buildFX(n); n.slotGain = gn(1); n.out.connect(n.slotGain); n.slotGain.connect(M.mix);
 }
 if(s.inst){ const oldV = s.voices; s.voices = []; s.mono.stack = []; for(const v of oldV) kill(v, ctx.currentTime); const old = s.inst; setTimeout(()=>{ for(const x of old.nodes||[]){ try{ x.disconnect(); }catch(_){} try{ x.stop && x.stop(); }catch(_){} } try{ old.in.disconnect(); }catch(_){} }, 300); }
 s.inst = INSTR[s.instr].setup(s);        // {in, nodes:[...]} — instrument chain ends at s.n.fxIn
 slotLive(s);
}
function slotLive(s, k){
 if(!ctx || !s.n) return;
 const P = s.P, t = ctx.currentTime, n = s.n;
 n.lfo.frequency.setTargetAtTime(P.lfoRate, t, 0.02);
 n.vib.gain.setTargetAtTime(P.lfoVib + modWheel*P.modVib, t, 0.02);
 applyFX(n, P);
 n.out.gain.setTargetAtTime(P.volume*2.4, t, 0.02);
 n.slotGain.gain.setTargetAtTime(s.i===1 ? bVol : 1, t, 0.02);
 INSTR[s.instr].live?.(s, k);
}

/* ---------- voices ---------- */
function startVoice(s, key, vel, ch, t, overlap){
 const P = s.P;
 const note = clamp(key + P.transpose + 12*P.octave + (s.i===1 ? 12*bOct : 0), 0, 127), f = mtof(note);
 const gf = (P.glide > 0.001 && (P.glideMode === 'always' || overlap)) ? s.lastFreq : null; s.lastFreq = f;
 const v = {s, key, note, ch, vel, t0:t, srcs:[], ctl:[], tune:[], rel:false, sus:false, dead:false, mono:P.playMode !== 'poly'};
 const vdet = gn(1); s.n.pitch.connect(vdet);
 const vb = cs(isMember(ch) ? chBend[ch]*P.bendRange*100 : 0); vb.connect(vdet);
 const vp = cs(chPress[ch]), vt = cs(isMember(ch) ? chTimbre[ch] : 0);
 const vvib = gn(0); s.n.lfo.connect(vvib); vvib.connect(vdet);
 const pv = gn(P.pressVib); vp.connect(pv); pv.connect(vvib.gain);
 const vca = gn(1), pamp = gn(1 - 0.7*P.pressAmp), pa = gn(P.pressAmp*0.9);
 vp.connect(pa); pa.connect(pamp.gain); vca.connect(pamp); pamp.connect(s.inst.in);
 v.ctl.push(vb, vp, vt);
 Object.assign(v, {vdet, vb, vp, vt, vvib, vca, pamp});
 const velG = (1-P.velSens) + P.velSens*Math.pow(vel/127, 1.6);
 v.h = INSTR[s.instr].voice(s, {v, f, note, vel, velG, t, glideFrom:gf, ratio: gf ? gf/f : 1, pitch:vdet, press:vp, timbre:vt, out:vca, P});
 v.srcs.push(...(v.h.srcs||[])); v.tune.push(...(v.h.tune||[]));
 for(const c of v.ctl) c.start(t);
 s.voices.push(v);
 return v;
}
function release(v, t, fast){
 if(v.rel) return; v.rel = true;
 const end = fast ? (hold(v.vca.gain,t), v.vca.gain.setTargetAtTime(0,t,fast/4), t + fast*2 + 0.05) : v.h.release(t);
 for(const x of v.srcs.concat(v.ctl)){ try{ x.stop(end); }catch(_){} }
 clearTimeout(v.ct); v.ct = setTimeout(()=>cleanup(v), Math.max(0,(end-ctx.currentTime))*1000 + 250);
}
function kill(v, t){
 v.rel = v.killed = true;
 hold(v.vca.gain,t); v.vca.gain.setTargetAtTime(0,t,0.005);
 for(const x of v.srcs.concat(v.ctl)){ try{ x.stop(t+0.04); }catch(_){} }
 clearTimeout(v.ct); v.ct = setTimeout(()=>cleanup(v), 300);
}
function cleanup(v){
 if(v.dead) return; v.dead = true;
 const n = v.s.n;
 try{ n.pitch.disconnect(v.vdet); }catch(_){}
 try{ n.lfo.disconnect(v.vvib); }catch(_){}
 try{ v.pamp.disconnect(); }catch(_){}
 try{ v.h.cleanup?.(); }catch(_){}
 const a = v.s.voices, i = a.indexOf(v); if(i>=0) a.splice(i,1);
}
function retune(v, key, note, ch){
 const s = v.s, P = s.P, t = ctx.currentTime + 0.003, f = mtof(note);
 const g = (P.glide > 0.001 && (P.glideMode === 'always' || s.mono.stack.length > 1)) ? P.glide : 0;
 for(const [p,m] of v.tune){ hold(p,t); if(g>0) p.exponentialRampToValueAtTime(f*m, t+g); else p.setValueAtTime(f*m, t); }
 if(v.ch !== ch){ v.ch = ch; v.vb.offset.setValueAtTime(isMember(ch) ? chBend[ch]*P.bendRange*100 : 0, t); }
 v.key = key; v.note = note; v.sus = false; s.lastFreq = f;
}

/* ---------- per-slot note handling (mono, legato, arp) ---------- */
function slotNoteOn(s, key, vel, ch=0, when, at){
 if(!ctx || !s.inst) return;
 const fromArp = when !== undefined, P = s.P;
 if(!fromArp && arpActive(s)){ arpAdd(s,key,vel,ch); return; }
 const t = fromArp ? when : Math.max(ctx.currentTime + 0.003, at || 0);   // `at`: scheduled time from the studio
 let overlap = s.voices.some(v=>!v.dead && !v.rel);
 if(P.playMode !== 'poly' && !fromArp){
  s.mono.stack = s.mono.stack.filter(x=>!(x.key===key && x.ch===ch)); s.mono.stack.push({key,vel,ch});
  const cur = s.voices.find(v=>!v.dead && !v.rel && v.mono);
  if(cur && P.playMode === 'legato'){ retune(cur, key, clamp(key + P.transpose + 12*P.octave + (s.i===1?12*bOct:0),0,127), ch); return; }
  overlap = s.mono.stack.length > 1;
  for(const v of s.voices) if(v.mono && !v.rel) release(v, t, 0.008);
 }
 for(const v of s.voices) if(v.key===key && v.ch===ch && !v.rel) release(v, t, 0.02);
 const alive = s.voices.filter(v=>!v.dead && !v.killed);
 if(alive.length >= MAXV){ const old = alive.find(v=>v.rel) || alive[0]; if(old) kill(old, t); }
 return startVoice(s, key, vel, ch, t, overlap);
}
function slotNoteOff(s, key, ch=0, at){
 if(!ctx) return;
 const tOff = Math.max(ctx.currentTime, at || 0);
 if(s.arp.held.some(h=>h.key===key)){ arpRemove(s,key); return; }
 if(s.P.playMode !== 'poly'){
  s.mono.stack = s.mono.stack.filter(x=>!(x.key===key && x.ch===ch));
  const cur = s.voices.find(v=>!v.dead && !v.rel && v.mono);
  if(cur && cur.key===key && cur.ch===ch){
   if(s.mono.stack.length){ const nx = s.mono.stack[s.mono.stack.length-1]; slotNoteOn(s, nx.key, nx.vel, nx.ch); }
   else if(sustain) cur.sus = true; else release(cur, tOff);
  }
  return;
 }
 for(const v of s.voices) if(v.key===key && v.ch===ch && !v.rel){ if(sustain) v.sus = true; else release(v, tOff); }
}

/* ---------- arpeggiator (per slot) ---------- */
const RATES = {'1/1':4,'1/2':2,'1/4':1,'1/8':0.5,'1/8T':1/3,'1/16':0.25,'1/16T':1/6,'1/32':0.125};
const arpActive = s => s.P.arpMode && s.P.arpMode !== 'off';
function arpAdd(s,key,vel,ch){
 const a = s.arp;
 if(s.P.arpHold==='on' && a.fresh){ a.held = []; a.fresh = false; }
 a.held = a.held.filter(h=>h.key!==key); a.held.push({key,vel,ch,order:a.order++,down:true});
 if(!a.running) arpStart(s);
}
function arpRemove(s,key){
 const a = s.arp, h = a.held.find(x=>x.key===key); if(!h) return;
 h.down = false;
 if(s.P.arpHold==='on'){ if(!a.held.some(x=>x.down)) a.fresh = true; return; }
 if(sustain) return;
 a.held = a.held.filter(x=>x!==h); if(!a.held.length) arpStop(s);
}
function arpPedalUp(s){ if(s.P.arpHold==='on') return; s.arp.held = s.arp.held.filter(x=>x.down); if(!s.arp.held.length) arpStop(s); }
function arpClear(s){ s.arp.held = []; s.arp.fresh = false; arpStop(s); }
function arpSeq(s){
 const P = s.P, ns = P.arpMode==='played' ? [...s.arp.held].sort((a,b)=>a.order-b.order) : [...s.arp.held].sort((a,b)=>a.key-b.key);
 const seq = []; for(let o=0;o<P.arpOct;o++) for(const h of ns) seq.push({...h, key:h.key+12*o});
 if(P.arpMode==='down') seq.reverse();
 if(P.arpMode==='updown' && seq.length>2) seq.push(...seq.slice(1,-1).reverse());
 return seq;
}
function arpStart(s){ const a = s.arp; a.running = true; a.idx = 0; a.next = ctx.currentTime + 0.01; if(!a.timer) a.timer = setInterval(()=>arpTick(s), 15); arpTick(s); }
function arpStop(s){ const a = s.arp; a.running = false; clearInterval(a.timer); a.timer = null; }
function arpTick(s){
 const a = s.arp; if(!ctx || !a.running) return;
 if(!arpActive(s)){ arpClear(s); return; }
 const P = s.P, step = 60/DEVP.tempo*(RATES[P.arpRate]||0.25);
 if(a.next < ctx.currentTime - 0.2) a.next = ctx.currentTime + 0.01;
 while(a.next < ctx.currentTime + 0.06){
  const seq = arpSeq(s); if(!seq.length){ arpStop(s); return; }
  const t = a.next;
  const notes = P.arpMode==='chord' ? seq.slice(0, a.held.length) : [P.arpMode==='random' ? seq[Math.floor(Math.random()*seq.length)] : seq[a.idx % seq.length]];
  for(const n of notes){ const v = slotNoteOn(s, n.key, n.vel, n.ch, t); if(v) release(v, t + Math.max(0.02, step*P.arpGate)); }
  a.idx++; a.next += step;
  if(s.i === editSlot) arpBlink(t - ctx.currentTime);
 }
}

/* ---------- player input: routes notes to slots (single / layer / split) ---------- */
const keySlots = new Map();   // key -> slots it went to, so note-off matches note-on
function targets(key){ return mode==='single' ? [slots[0]] : mode==='layer' ? slots : [key < splitNote ? slots[1] : slots[0]]; }
function noteOn(key, vel, ch=0, at){
 if(!ctx || !slots[0].inst) return;
 if(ctx.state !== 'running'){ try{ ctx.resume(); }catch(_){} }
 if(learnSplit){ splitNote = key; learnSplit = false; saveState(); renderTop(); return; }
 if(isMember(ch)){ chPress[ch] = 0; if(!mpeSeen){ mpeSeen = true; updateMidiLabel(); } }
 const ts = targets(key); keySlots.set(key+':'+ch, ts);
 for(const s of ts) slotNoteOn(s, key, vel, ch, undefined, at);
 blink();
}
function noteOff(key, ch=0, at){
 if(!ctx) return;
 const ts = keySlots.get(key+':'+ch) || targets(key); keySlots.delete(key+':'+ch);
 for(const s of ts) slotNoteOff(s, key, ch, at);
}
function setSustain(on){
 sustain = on;
 if(!on && ctx){
  for(const s of slots){ arpPedalUp(s); for(const v of s.voices) if(v.sus && !v.rel){ v.sus = false; release(v, ctx.currentTime); } }
 }
}
function panic(){
 if(!ctx) return; sustain = false;
 for(const s of slots){ s.mono.stack = []; arpClear(s); for(const v of s.voices){ if(v.rel){ if(!v.killed) kill(v, ctx.currentTime); } else release(v, ctx.currentTime, 0.02); } }   // also cut voices already in their release tail
 chBend.fill(0); chPress.fill(0); chTimbre.fill(0); M.bend.offset.setValueAtTime(0, ctx.currentTime);
 keySlots.clear();
}
function allVoices(){ return slots.flatMap(s=>s.voices); }
function setPressure(list, x){
 if(!ctx) return; const t = ctx.currentTime;
 for(const v of list) v.vp.offset.setTargetAtTime(x,t,0.012);
}
function onBend(ch, raw){
 if(!ctx) return; const n = (raw-8192)/8192, t = ctx.currentTime;
 bendNorm(ch, n, t);
}
function bendNorm(ch, n, t){
 if(isMember(ch)){ chBend[ch] = n; for(const v of allVoices()) if(v.ch===ch && !v.dead) v.vb.offset.setTargetAtTime(n*v.s.P.bendRange*100, t, 0.004); }
 else M.bend.offset.setTargetAtTime(n*DEVP.gBend*100, t, 0.004);
}
function onModWheel(x){
 modWheel = x;
 for(const s of activeSlots()){ slotLive(s); INSTR[s.instr].modWheel?.(s, x); }
}

/* ---------- MIDI messages (the shell owns Web MIDI; these are synthesised from its events) ---------- */
function onMidi(e){
 const [st,d1,d2] = e.data, cmd = st & 0xf0, ch = st & 0x0f;
 if(cmd===0x90 && d2>0) noteOn(d1,d2,ch);
 else if(cmd===0x80 || (cmd===0x90 && d2===0)) noteOff(d1,ch);
 else if(cmd===0xE0) onBend(ch,(d2<<7)|d1);
 else if(cmd===0xD0) chanPressure(ch, d1/127);
 else if(cmd===0xA0){ setPressure(allVoices().filter(v=>v.key===d1 && !v.dead), d2/127); }
 else if(cmd===0xB0) onCC(ch, d1, d2);
}
function chanPressure(ch, x){ chPress[ch] = x; setPressure(allVoices().filter(v=>v.ch===ch && !v.dead), x); }
function onCC(ch, d1, d2){
 if(d1===74 && isMember(ch)){ chTimbre[ch]=(d2-64)/64; if(ctx) for(const v of allVoices()) if(v.ch===ch && !v.dead) v.vt.offset.setTargetAtTime(chTimbre[ch],ctx.currentTime,0.01); }
 else if(d1===1) onModWheel(d2/127);
 else if(d1===64) setSustain(d2>=64);
 else if(d1===74 || d1===71){ const s = slots[editSlot], m = INSTR[s.instr]['cc'+d1]; if(m) setParam(m[0], m[1](d2/127)); }
 else if(d1===7) setParam('volume', d2/127*2);
 else if(d1===120 || d1===123) panic();
}
function updateMidiLabel(){ const st = $('#midiStatus'); if(st) st.textContent = mpeSeen && DEVP.mpeMode==='auto' ? 'MPE active' : DEVP.mpeMode==='auto' ? 'Ready · MPE auto' : 'Ready · MPE off'; }


/* Ember: 174 factory patches (unchanged from Ember 16) */
const EMBER_PRESETS = [
 ['Walls','Wall of Sound',{o1Uni:7,o1Spread:24,width:1,o2Wave:'sawtooth',o2Oct:1,o2Uni:3,o2Level:0.45,o2Detune:4,subLevel:0.35,cutoff:3200,res:1.2,fEnv:0.8,fA:0.4,fD:3,fS:0.7,fR:3,aA:0.15,aD:2,aS:0.9,aR:3.5,velSens:0.25,lfoRate:0.15,lfoFilt:300,drive:0.4,chorus:0.85,dTime:0.42,dFb:0.5,dMix:0.28,rSize:8,rMix:0.6,pressFilt:1800,pressAmp:0.4,pressVib:12,volume:0.75}],
 ['Walls','Sunburst Wall',{o1Uni:7,o1Spread:28,width:1,o2Wave:'pulse',o2Oct:1,o2Uni:4,o2Level:0.4,o2Detune:7,subLevel:0.3,noise:0.05,cutoff:4200,res:1,fEnv:0.5,fA:0.05,fD:2,fS:0.8,fR:2.5,aA:0.08,aD:2,aS:0.9,aR:3,velSens:0.3,drive:0.5,chorus:0.9,dTime:0.36,dFb:0.55,dMix:0.32,rSize:9,rMix:0.6,pressFilt:1500,pressAmp:0.35,pressVib:12,volume:0.7}],
 ['Walls','Shoegaze Haze',{o1Uni:5,o1Spread:32,width:1,o2Wave:'pulse',o2Oct:1,o2Uni:2,o2Level:0.35,o2Detune:14,noise:0.1,cutoff:1700,res:2,fEnv:1,fA:0.8,fD:2,fS:0.6,fR:3,aA:0.6,aD:2,aS:0.9,aR:4.5,velSens:0.2,lfoRate:0.3,lfoVib:4,lfoFilt:500,drive:0.65,chorus:1,dTime:0.5,dFb:0.62,dMix:0.38,rSize:10,rMix:0.72,pressFilt:2400,pressAmp:0.35,pressVib:20,volume:0.7}],
 ['Walls','Supersaw Anthem',{o1Uni:7,o1Spread:20,width:1,o2Wave:'sawtooth',o2Oct:-1,o2Uni:3,o2Level:0.5,subLevel:0.3,cutoff:5500,res:1,fEnv:1,fA:0.002,fD:0.8,fS:0.75,fR:0.6,aA:0.01,aD:0.6,aS:0.9,aR:0.9,velSens:0.4,drive:0.35,chorus:0.6,dTime:0.375,dFb:0.35,dMix:0.22,rSize:4.5,rMix:0.4,pressFilt:1500,pressAmp:0.25,pressVib:15,volume:0.72}],
 ['Walls','Octave Cloud',{o1Uni:5,o1Spread:18,width:1,o2Wave:'sawtooth',o2Oct:2,o2Uni:3,o2Level:0.3,subLevel:0.5,cutoff:2600,res:0.9,fEnv:0.4,fA:1.5,fD:3,fS:0.8,fR:4,aA:1.2,aD:2,aS:1,aR:5,velSens:0.1,lfoRate:0.2,lfoFilt:600,drive:0.3,chorus:1,dTime:0.6,dFb:0.6,dMix:0.3,rSize:12,rMix:0.7,pressFilt:2000,pressAmp:0.5,pressVib:10,volume:0.72}],
 ['Walls','Glacier Drone',{o1Uni:5,o1Spread:18,width:1,o2Wave:'sawtooth',o2Semi:7,o2Uni:3,o2Level:0.45,subLevel:0.5,cutoff:550,res:3.5,fEnv:0.5,fA:3,fD:4,fS:0.7,fR:5,aA:3,aD:3,aS:1,aR:7,velSens:0,lfoRate:0.08,lfoFilt:1100,drive:0.45,chorus:0.8,dTime:0.75,dFb:0.6,dMix:0.3,rSize:12,rMix:0.75,pressFilt:3000,pressAmp:0.3,pressVib:8,volume:0.8}],
 ['Pads','Velvet Pad',{o1Uni:3,o1Spread:16,o2Wave:'sawtooth',o2Detune:9,o2Level:0.55,subLevel:0.25,cutoff:900,res:1.8,fEnv:1.4,fA:1.2,fD:2.5,fS:0.45,fR:2.2,aA:0.7,aD:1.5,aS:0.85,aR:2.4,velSens:0.3,lfoRate:0.25,lfoFilt:220,chorus:0.7,dTime:0.45,dFb:0.4,dMix:0.18,rSize:5,rMix:0.45}],
 ['Pads','Cathedral Swell',{o1Wave:'triangle',o1Uni:5,o1Spread:14,width:1,o2Wave:'sawtooth',o2Oct:1,o2Level:0.2,o2Uni:3,subLevel:0.4,cutoff:2200,res:0.8,fEnv:0.6,fA:2,fD:3,fS:0.8,fR:4,aA:2.2,aD:3,aS:0.95,aR:6,velSens:0.1,chorus:0.7,dTime:0.6,dFb:0.5,dMix:0.2,rSize:12,rMix:0.78,pressFilt:2400,pressAmp:0.8,pressVib:10,volume:1.15}],
 ['Pads','Dream Choir',{o1Wave:'triangle',o1Uni:5,o1Spread:16,width:1,o2Wave:'sawtooth',o2Level:0.18,o2Uni:3,o2Detune:5,noise:0.14,cutoff:1400,res:4,fEnv:0.4,keyTrack:0.8,fA:0.6,fD:2,fS:0.8,fR:2,aA:0.8,aD:2,aS:0.9,aR:3,velSens:0.2,lfoRate:0.3,lfoVib:5,lfoFilt:300,chorus:1,dTime:0.5,dFb:0.4,dMix:0.15,rSize:7,rMix:0.55}],
 ['Pads','Analog Sweep',{o1Uni:3,o1Spread:12,o2Wave:'pulse',o2Level:0.5,o2Detune:-8,cutoff:700,res:6,fEnv:0.3,fA:1,fD:3,fS:0.8,fR:3,aA:0.5,aD:2,aS:0.9,aR:2.5,velSens:0.3,lfoRate:0.07,lfoFilt:2400,drive:0.3,chorus:0.7,dTime:0.45,dFb:0.45,dMix:0.2,rSize:5,rMix:0.45}],
 ['Pads','Warm Blanket',{o1Uni:3,o1Spread:8,o2Wave:'triangle',o2Oct:-1,o2Level:0.6,subLevel:0.2,cutoff:600,res:1,fEnv:0.8,fA:0.5,fD:2,fS:0.5,fR:2,aA:0.4,aD:1.5,aS:0.9,aR:2,velSens:0.3,drive:0.25,chorus:0.6,dMix:0.1,rSize:4,rMix:0.35}],
 ['Strings & Brass','Juno Strings',{o1Uni:2,o1Spread:9,o2Wave:'pulse',o2Level:0.4,o2Detune:-5,cutoff:2600,res:0.9,fEnv:0.6,fA:0.3,fD:1.5,fS:0.7,fR:1.2,aA:0.35,aD:1,aS:0.9,aR:1.3,velSens:0.4,chorus:1,dMix:0.08,rSize:3.5,rMix:0.35}],
 ['Strings & Brass','Slow Strings',{o1Uni:4,o1Spread:12,o2Wave:'sawtooth',o2Level:0.5,o2Detune:-9,cutoff:1800,res:0.8,fEnv:0.5,fA:0.8,fD:2,fS:0.8,fR:2,aA:0.9,aD:1,aS:0.95,aR:2,velSens:0.3,lfoRate:5,lfoVib:4,chorus:0.9,dMix:0.1,rSize:5,rMix:0.45}],
 ['Strings & Brass','Warm Brass',{o2Detune:11,o2Level:0.7,cutoff:500,res:1.5,fEnv:2.4,fA:0.09,fD:0.6,fS:0.55,fR:0.3,aA:0.04,aD:0.4,aS:0.85,aR:0.3,velFilt:0.7,lfoRate:5,modVib:30,drive:0.3,chorus:0.35,dMix:0.1,rMix:0.3}],
 ['Strings & Brass','Stab 90s',{o1Uni:5,o1Spread:14,o2Wave:'square',o2Oct:1,o2Level:0.3,cutoff:3000,res:2,fEnv:1.5,fA:0.002,fD:0.35,fS:0.3,fR:0.25,aA:0.002,aD:0.4,aS:0.6,aR:0.3,velSens:0.5,drive:0.35,chorus:0.5,dTime:0.25,dFb:0.3,dMix:0.15,rSize:3,rMix:0.35}],
 ['Keys','Tine Electric Piano',{o1Wave:'sine',o1Level:0.9,o2Wave:'sine',o2Oct:2,o2Level:0.08,o2Detune:3,fmAmt:1.6,fmRatio:1,fmDecay:0.9,cutoff:7000,res:0.5,fEnv:0,keyTrack:0,velFilt:0,aA:0.002,aD:3.5,aS:0,aR:0.45,velSens:0.85,lfoRate:4.5,drive:0.25,chorus:0.6,dMix:0.06,rSize:2.2,rMix:0.28}],
 ['Keys','Warm Rhodes',{o1Wave:'sine',o1Level:0.9,o2Wave:'sine',o2Oct:1,o2Level:0.06,fmAmt:0.9,fmRatio:1,fmDecay:1.4,cutoff:4000,res:0.5,fEnv:0,keyTrack:0,velFilt:0,aA:0.002,aD:4.5,aS:0,aR:0.5,velSens:0.9,lfoRate:3.5,drive:0.4,chorus:0.35,dMix:0.04,rSize:2,rMix:0.22}],
 ['Keys','Funky Clav',{o1Wave:'pulse',o2Wave:'sawtooth',o2Oct:1,o2Level:0.3,cutoff:900,res:6,fEnv:3,keyTrack:0.8,velFilt:0.8,fA:0.001,fD:0.18,fS:0.2,fR:0.08,aA:0.001,aD:0.8,aS:0.3,aR:0.08,velSens:0.8,drive:0.4,chorus:0.2,dMix:0,rSize:1.5,rMix:0.15}],
 ['Keys','Toy Piano',{o1Wave:'sine',fmAmt:2.2,fmRatio:7,fmDecay:0.3,o2Wave:'triangle',o2Oct:1,o2Level:0.2,cutoff:9000,fEnv:0,keyTrack:0,aA:0.001,aD:1.2,aS:0,aR:0.4,velSens:0.7,chorus:0.2,dMix:0.1,rSize:2.5,rMix:0.3}],
 ['Keys','Hollow Organ',{o1Wave:'sine',o1Level:0.7,o2Wave:'sine',o2Oct:1,o2Level:0.45,subLevel:0.5,noise:0,cutoff:5000,res:0.6,fEnv:0,keyTrack:0,aA:0.008,aD:0.1,aS:1,aR:0.08,velSens:0,lfoRate:6.2,lfoVib:6,drive:0.35,chorus:0.8,dMix:0,rSize:2,rMix:0.25}],
 ['Leads','Silk Lead',{o1Uni:2,o1Spread:7,o2Wave:'sawtooth',o2Oct:1,o2Level:0.25,o2Detune:5,cutoff:1400,res:4,fEnv:1.8,fA:0.01,fD:0.6,fS:0.5,fR:0.4,aA:0.01,aD:0.3,aS:0.9,aR:0.35,lfoRate:5.5,modVib:45,glide:0.06,drive:0.3,chorus:0.3,dTime:0.33,dFb:0.4,dMix:0.25,rMix:0.25}],
 ['Leads','Portamento Lead',{playMode:'legato',glide:0.12,glideMode:'overlap',o1Uni:2,o1Spread:6,o2Wave:'square',o2Level:0.45,o2Detune:6,cutoff:1600,res:3,fEnv:1.2,fA:0.01,fD:0.6,fS:0.6,fR:0.3,aA:0.01,aD:0.3,aS:0.95,aR:0.3,lfoRate:5.5,modVib:40,drive:0.4,chorus:0.3,dTime:0.375,dFb:0.4,dMix:0.25,rMix:0.3,pressVib:30}],
 ['Leads','Theremin',{playMode:'legato',glide:0.25,glideMode:'always',o1Wave:'sine',o1Level:0.9,o2Wave:'triangle',o2Oct:1,o2Level:0.12,cutoff:8000,fEnv:0,keyTrack:0,aA:0.15,aD:0.5,aS:1,aR:0.6,velSens:0.2,lfoRate:5.8,lfoVib:18,chorus:0.2,dTime:0.4,dFb:0.35,dMix:0.2,rSize:4,rMix:0.4,pressAmp:0.6,pressVib:30}],
 ['Leads','Chiptune Square',{volume:1.1,playMode:'mono',glide:0.03,glideMode:'overlap',o1Wave:'square',o1Level:0.6,o2Level:0,cutoff:16000,res:0.5,fEnv:0,keyTrack:0,aA:0.001,aD:0.1,aS:0.85,aR:0.05,velSens:0,lfoRate:6,modVib:50,drive:0,chorus:0,dTime:0.18,dFb:0.3,dMix:0.12,rMix:0.08,rSize:1}],
 ['Bass','Fat Analog Bass',{o1Oct:-1,o2Wave:'square',o2Oct:-1,o2Level:0.55,o2Detune:4,subLevel:0.55,cutoff:180,res:5,fEnv:3.2,keyTrack:0.3,velFilt:0.6,fA:0.002,fD:0.28,fS:0.12,fR:0.15,aA:0.002,aD:0.5,aS:0.75,aR:0.12,velSens:0.6,drive:0.45,chorus:0,dMix:0,rMix:0.06,rSize:1.2}],
 ['Bass','Acid Line',{playMode:'legato',glide:0.07,glideMode:'overlap',o1Oct:-1,o2Level:0,cutoff:250,res:15,fEnv:3.5,keyTrack:0.4,velFilt:0.8,fA:0.001,fD:0.22,fS:0.05,fR:0.1,aA:0.001,aD:0.4,aS:0.8,aR:0.08,velSens:0.6,drive:0.7,chorus:0,dTime:0.375,dFb:0.3,dMix:0.12,rMix:0.05,rSize:1}],
 ['Bass','Reese',{playMode:'mono',glide:0.05,glideMode:'overlap',o1Oct:-1,o1Uni:3,o1Spread:22,o2Wave:'sawtooth',o2Oct:-1,o2Detune:-18,o2Level:0.7,subLevel:0.5,cutoff:420,res:2,fEnv:0.5,fA:0.01,fD:0.6,fS:0.8,fR:0.3,aA:0.005,aD:0.5,aS:0.95,aR:0.2,lfoRate:0.3,lfoFilt:600,drive:0.55,chorus:0.2,dMix:0,rMix:0.08,rSize:1.5}],
 ['Bass','Deep Sub',{playMode:'mono',glide:0.04,glideMode:'overlap',o1Oct:-1,o1Wave:'sine',o1Level:0.9,o2Wave:'triangle',o2Oct:-1,o2Level:0.3,subLevel:0.3,cutoff:900,res:0.5,fEnv:0,keyTrack:0,aA:0.005,aD:0.5,aS:1,aR:0.15,velSens:0.4,drive:0.3,chorus:0,dMix:0,rMix:0}],
 ['Plucks & Bells','Pluck Arp',{"arpMode":"up","arpRate":"1/8","arpOct":2,"arpGate":0.6,o1Uni:3,o1Spread:12,o2Level:0.35,o2Oct:1,cutoff:260,res:3.5,fEnv:4.2,fA:0.001,fD:0.22,fS:0,fR:0.2,aA:0.001,aD:0.7,aS:0,aR:0.35,velSens:0.6,chorus:0.4,dTime:0.375,dFb:0.45,dMix:0.3,rSize:3,rMix:0.3}],
 ['Plucks & Bells','Harp Pluck',{o1Wave:'triangle',o1Level:0.9,o2Wave:'sawtooth',o2Level:0.25,o2Oct:1,cutoff:600,res:1.5,fEnv:3,fA:0.001,fD:0.4,fS:0.1,fR:0.6,aA:0.001,aD:2.5,aS:0,aR:1.2,velSens:0.7,chorus:0.3,dTime:0.33,dFb:0.3,dMix:0.15,rSize:4,rMix:0.4}],
 ['Plucks & Bells','Glass Bells',{o1Wave:'sine',o1Level:0.85,o2Wave:'sine',o2Oct:2,o2Semi:7,o2Level:0.12,fmAmt:3.5,fmRatio:3.5,fmDecay:1.8,cutoff:12000,res:0.5,fEnv:0,keyTrack:0,aA:0.002,aD:4,aS:0,aR:2.5,velSens:0.7,chorus:0.4,dTime:0.5,dFb:0.45,dMix:0.25,rSize:6,rMix:0.5}],
 ['Plucks & Bells','Marimba',{o1Wave:'sine',o1Level:0.9,fmAmt:1.5,fmRatio:4,fmDecay:0.12,o2Wave:'sine',o2Oct:2,o2Level:0.1,cutoff:6000,fEnv:0,keyTrack:0,aA:0.001,aD:0.8,aS:0,aR:0.3,velSens:0.8,chorus:0,dMix:0.05,rSize:2,rMix:0.25}],
 ['Plucks & Bells','Music Box',{o1Wave:'sine',fmAmt:1.2,fmRatio:5,fmDecay:0.5,o2Wave:'sine',o2Oct:2,o2Level:0.15,cutoff:10000,fEnv:0,keyTrack:0,aA:0.001,aD:2.5,aS:0,aR:1.5,velSens:0.6,chorus:0.3,dTime:0.45,dFb:0.4,dMix:0.25,rSize:5,rMix:0.5}],
 ['MPE','MPE Pressure Strings',{o1Uni:3,o1Spread:10,o2Wave:'pulse',o2Level:0.4,o2Detune:-6,cutoff:900,res:1,fEnv:0.8,fA:0.3,fD:1.5,fS:0.6,fR:1,aA:0.25,aD:1,aS:0.95,aR:1.2,velSens:0.3,chorus:0.8,dMix:0.08,rSize:4,rMix:0.4,pressFilt:3000,pressAmp:0.85,pressVib:22,timbreFilt:1800}],
 ['MPE','MPE Slide Lead',{o1Uni:2,o1Spread:6,o2Wave:'square',o2Oct:-1,o2Level:0.35,cutoff:900,res:5,fEnv:1.2,fA:0.01,fD:0.5,fS:0.5,fR:0.4,aA:0.01,aD:0.3,aS:0.9,aR:0.4,lfoRate:5.5,drive:0.5,chorus:0.25,dTime:0.33,dFb:0.4,dMix:0.25,rMix:0.28,pressFilt:3600,pressAmp:0.4,pressVib:35}],
 ['MPE','MPE Growl Bass',{o1Oct:-1,o2Wave:'square',o2Oct:-1,o2Detune:6,o2Level:0.6,subLevel:0.6,cutoff:150,res:7,fEnv:2,keyTrack:0.3,fA:0.002,fD:0.3,fS:0.2,fR:0.15,aA:0.002,aD:0.5,aS:0.8,aR:0.12,drive:0.6,chorus:0,dMix:0,rMix:0.05,rSize:1.2,pressFilt:4200,pressAmp:0.2,pressVib:0}],
 ['MPE','MPE Breathing Pad',{o1Wave:'triangle',o1Uni:4,o1Spread:12,o2Wave:'sawtooth',o2Level:0.3,o2Detune:9,noise:0.12,cutoff:500,res:2,fEnv:0.3,fA:1,fD:2,fS:0.6,fR:2,aA:0.4,aD:2,aS:0.9,aR:2.5,velSens:0.2,chorus:0.8,dTime:0.5,dFb:0.45,dMix:0.2,rSize:7,rMix:0.55,pressFilt:3600,pressAmp:0.9,pressVib:15}],
 ['Utility','Init',{}],
 ['Walls','Skyline Supersaw',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sawtooth","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":3000,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"volume":0.87}],
 ['Walls','Neon Cathedral',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"pulse","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":4200,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.5,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":12,"rMix":0.7,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"volume":0.93}],
 ['Walls','Tidal Wall',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sawtooth","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":1800,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":1.2,"aD":2,"aS":0.9,"aR":5,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"lfoRate":0.12,"lfoFilt":900,"volume":0.95}],
 ['Walls','Distortion Choir',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"square","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":2200,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.85,"chorus":1,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"volume":0.46}],
 ['Walls','Glass Wall',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sine","o2Oct":2,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":7000,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.2,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.65,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"o1Wave":"triangle","volume":0.81}],
 ['Walls','Fifths Monolith',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sawtooth","o2Oct":0,"o2Uni":3,"o2Level":0.4,"subLevel":0.5,"cutoff":2400,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"o2Semi":7,"volume":0.79}],
 ['Walls','Octave Thunder',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sawtooth","o2Oct":0,"o2Uni":3,"o2Level":0.4,"subLevel":0.55,"cutoff":1600,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.6,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"o1Oct":-1,"volume":0.63}],
 ['Walls','Stadium Anthem',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sawtooth","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":5000,"res":1,"fEnv":1.2,"fA":0.002,"fD":3,"fS":0.75,"fR":3,"aA":0.01,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":5,"rMix":0.42,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"volume":0.93}],
 ['Walls','Shoegaze Blizzard',{"o1Uni":7,"o1Spread":36,"width":1,"o2Wave":"sawtooth","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":3000,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.7,"chorus":0.85,"dTime":0.42,"dFb":0.68,"dMix":0.4,"rSize":11,"rMix":0.75,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"noise":0.2,"volume":0.67}],
 ['Walls','Brass Wall',{"o1Uni":5,"o1Spread":12,"width":1,"o2Wave":"sawtooth","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":900,"res":1,"fEnv":2,"fA":0.08,"fD":3,"fS":0.7,"fR":3,"aA":0.05,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"velFilt":0.7,"volume":0.89}],
 ['Walls','Sunset Overdrive',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"pulse","o2Oct":0,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":3200,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.75,"chorus":0.85,"dTime":0.33,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"o2Semi":12,"volume":0.71}],
 ['Walls','Infinite Sustain',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sawtooth","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":3000,"res":1,"fEnv":0.6,"fA":2,"fD":3,"fS":0.7,"fR":3,"aA":1.5,"aD":2,"aS":0.9,"aR":8,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.8,"pressFilt":1800,"pressAmp":0.4,"pressVib":12,"volume":0.76}],
 ['Pads','Analog Dawn',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.45,"o2Detune":8,"cutoff":1200,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"volume":1.15}],
 ['Pads','Soft Velour',{"o1Uni":3,"o1Spread":14,"o2Wave":"triangle","o2Level":0.45,"o2Detune":8,"cutoff":800,"res":0.8,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.9,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"volume":1.06}],
 ['Pads','Polysix Glow',{"o1Uni":3,"o1Spread":14,"o2Wave":"pulse","o2Level":0.45,"o2Detune":-6,"cutoff":1600,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":1,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"volume":1.02}],
 ['Pads','Hazy Afternoon',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.45,"o2Detune":8,"cutoff":1000,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"noise":0.08,"lfoRate":0.15,"lfoFilt":500,"drive":0.3,"volume":0.97}],
 ['Pads','Brightside Pad',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.3,"o2Detune":8,"cutoff":3200,"res":1.2,"fEnv":0.4,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"o2Oct":1,"volume":1.27}],
 ['Pads','Dark Matter Pad',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.45,"o2Detune":8,"cutoff":450,"res":3,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":8,"rMix":0.55,"pressFilt":1500,"pressAmp":0.35,"o1Oct":-1,"subLevel":0.4,"volume":0.93}],
 ['Pads','Warm Felt',{"o1Uni":3,"o1Spread":14,"o2Wave":"triangle","o2Level":0.45,"o2Detune":8,"cutoff":700,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.5,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"o1Wave":"triangle","o2Oct":-1,"volume":0.94}],
 ['Pads','Sweeping Prophet',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.45,"o2Detune":8,"cutoff":350,"res":6,"fEnv":3,"fA":2.5,"fD":3,"fS":0.4,"fR":2,"aA":0.8,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"volume":0.71}],
 ['Pads','Hollow Square Pad',{"o1Uni":3,"o1Spread":14,"o2Wave":"square","o2Level":0.3,"o2Detune":8,"cutoff":1400,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"o1Wave":"square","o2Oct":1,"volume":0.76}],
 ['Pads','80s Movie Pad',{"o1Uni":4,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.45,"o2Detune":8,"cutoff":2200,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.5,"dFb":0.5,"dMix":0.25,"rSize":7,"rMix":0.55,"pressFilt":1500,"pressAmp":0.35,"volume":1.02}],
 ['Pads','Lullaby Pad',{"o1Uni":3,"o1Spread":14,"o2Wave":"triangle","o2Level":0.25,"o2Detune":8,"cutoff":2500,"res":1.2,"fEnv":0,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"o1Wave":"sine","o2Oct":1,"volume":0.94}],
 ['Pads','Vapor Pad',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.45,"o2Detune":8,"cutoff":1300,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":1,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.55,"pressFilt":1500,"pressAmp":0.35,"lfoRate":0.4,"lfoVib":8,"drive":0.25,"volume":0.95}],
 ['Pads','Nordic Light',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.3,"o2Detune":8,"cutoff":1800,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":1.2,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":9,"rMix":0.6,"pressFilt":1500,"pressAmp":0.35,"o2Semi":7,"volume":1.35}],
 ['Pads','Pulse Width Pad',{"o1Uni":3,"o1Spread":14,"o2Wave":"pulse","o2Level":0.45,"o2Detune":12,"cutoff":1700,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":1500,"pressAmp":0.35,"o1Wave":"pulse","lfoRate":0.3,"lfoFilt":400,"volume":1.17}],
 ['Atmospheres','Deep Space',{"o1Wave":"triangle","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.12,"cutoff":900,"res":3,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.08,"lfoFilt":1400,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"volume":1.09}],
 ['Atmospheres','Frozen Lake',{"o1Wave":"sine","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.18,"cutoff":2200,"res":1,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.08,"lfoFilt":600,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"volume":0.9}],
 ['Atmospheres','Desert Wind',{"o1Wave":"triangle","o1Uni":3,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.45,"cutoff":600,"res":7,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.12,"lfoFilt":2400,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"volume":1.05}],
 ['Atmospheres','Submerged',{"o1Wave":"triangle","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.12,"cutoff":350,"res":5,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.08,"lfoFilt":900,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":12,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"o1Oct":-1,"volume":0.88}],
 ['Atmospheres','Aurora',{"o1Wave":"triangle","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sine","o2Level":0.35,"o2Uni":2,"noise":0.12,"cutoff":1800,"res":3,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.2,"lfoFilt":1400,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"o2Oct":2,"lfoVib":6,"volume":1.1}],
 ['Atmospheres','Haunted Hall',{"o1Wave":"triangle","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.3,"o2Uni":2,"noise":0.12,"cutoff":700,"res":6,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.3,"lfoFilt":1400,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"o2Semi":6,"lfoVib":10,"volume":0.52}],
 ['Atmospheres','Starfield',{"o1Wave":"sine","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.12,"cutoff":6000,"res":1,"fEnv":0,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.08,"lfoFilt":1400,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"fmAmt":1.5,"fmRatio":7,"fmDecay":6,"volume":0.95}],
 ['Atmospheres','Rainforest Mist',{"o1Wave":"triangle","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.3,"cutoff":1400,"res":4,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.5,"lfoFilt":700,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"volume":1.0}],
 ['Atmospheres','Cosmic Drift',{"o1Wave":"sawtooth","o1Uni":5,"o1Spread":35,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.12,"cutoff":500,"res":8,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.05,"lfoFilt":2400,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"volume":1.25}],
 ['Atmospheres','Morning Fog',{"o1Wave":"triangle","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"triangle","o2Level":0.25,"o2Uni":2,"noise":0.06,"cutoff":1100,"res":1,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.08,"lfoFilt":300,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"volume":1.1}],
 ['Atmospheres','Event Horizon',{"o1Wave":"triangle","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.12,"cutoff":450,"res":9,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.06,"lfoFilt":2000,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"o1Oct":-1,"subLevel":0.6,"drive":0.6,"volume":0.48}],
 ['Atmospheres','Ocean Floor',{"o1Wave":"sine","o1Uni":5,"o1Spread":20,"width":1,"o2Wave":"sawtooth","o2Level":0.25,"o2Uni":2,"noise":0.25,"cutoff":300,"res":4,"fEnv":0.5,"fA":2,"fD":4,"fS":0.7,"fR":5,"aA":2.5,"aD":3,"aS":1,"aR":6,"velSens":0.1,"lfoRate":0.1,"lfoFilt":1800,"chorus":0.9,"dTime":0.62,"dFb":0.6,"dMix":0.3,"rSize":11,"rMix":0.72,"pressFilt":2400,"pressAmp":0.5,"o1Oct":-1,"volume":0.9}],
 ['Strings & Brass','Chamber Strings',{"o1Uni":4,"o1Spread":12,"o2Wave":"sawtooth","o2Level":0.5,"o2Detune":-9,"cutoff":2000,"res":0.8,"fEnv":0.5,"fA":0.6,"fD":2,"fS":0.8,"fR":1.5,"aA":0.5,"aD":1,"aS":0.95,"aR":1.6,"velSens":0.35,"lfoRate":5,"lfoVib":4,"chorus":0.85,"dMix":0.08,"rSize":4.5,"rMix":0.42,"pressFilt":2000,"pressAmp":0.5,"pressVib":18,"volume":1.2}],
 ['Strings & Brass','Solina Ensemble',{"o1Uni":2,"o1Spread":12,"o2Wave":"pulse","o2Level":0.5,"o2Detune":-9,"cutoff":2600,"res":0.8,"fEnv":0.2,"fA":0.6,"fD":2,"fS":0.8,"fR":1.5,"aA":0.5,"aD":1,"aS":0.95,"aR":1.6,"velSens":0.35,"lfoRate":5,"lfoVib":4,"chorus":1,"dMix":0.08,"rSize":4.5,"rMix":0.42,"pressFilt":2000,"pressAmp":0.5,"pressVib":18,"volume":1.24}],
 ['Strings & Brass','Cinematic Strings',{"o1Uni":6,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.5,"o2Detune":-9,"cutoff":1600,"res":0.8,"fEnv":0.5,"fA":0.6,"fD":2,"fS":0.8,"fR":1.5,"aA":0.9,"aD":1,"aS":0.95,"aR":1.6,"velSens":0.35,"lfoRate":5,"lfoVib":4,"chorus":0.85,"dMix":0.08,"rSize":8,"rMix":0.55,"pressFilt":2000,"pressAmp":0.5,"pressVib":18,"volume":1.39}],
 ['Strings & Brass','Pizzicato Synth',{"o1Uni":4,"o1Spread":12,"o2Wave":"sawtooth","o2Level":0.5,"o2Detune":-9,"cutoff":600,"res":0.8,"fEnv":2.5,"fA":0.001,"fD":0.15,"fS":0,"fR":1.5,"aA":0.002,"aD":0.35,"aS":0,"aR":0.25,"velSens":0.35,"lfoRate":5,"lfoVib":4,"chorus":0.4,"dMix":0.08,"rSize":4.5,"rMix":0.42,"pressFilt":2000,"pressAmp":0.5,"pressVib":18,"volume":2.0}],
 ['Strings & Brass','Dark Cellos',{"o1Uni":4,"o1Spread":12,"o2Wave":"sawtooth","o2Level":0.5,"o2Detune":-9,"cutoff":800,"res":1.5,"fEnv":0.5,"fA":0.6,"fD":2,"fS":0.8,"fR":1.5,"aA":0.3,"aD":1,"aS":0.95,"aR":1.6,"velSens":0.35,"lfoRate":5,"lfoVib":6,"chorus":0.85,"dMix":0.08,"rSize":4.5,"rMix":0.42,"pressFilt":2000,"pressAmp":0.5,"pressVib":18,"o1Oct":-1,"volume":1.24}],
 ['Strings & Brass','Violin Section',{"o1Uni":4,"o1Spread":12,"o2Wave":"sawtooth","o2Level":0.5,"o2Detune":-9,"cutoff":3500,"res":0.8,"fEnv":0.5,"fA":0.6,"fD":2,"fS":0.8,"fR":1.5,"aA":0.35,"aD":1,"aS":0.95,"aR":1.6,"velSens":0.35,"lfoRate":5,"lfoVib":8,"chorus":0.85,"dMix":0.08,"rSize":4.5,"rMix":0.42,"pressFilt":2000,"pressAmp":0.5,"pressVib":18,"o1Oct":1,"o2Oct":1,"volume":1.19}],
 ['Strings & Brass','Synth Horns',{"o1Uni":2,"o1Spread":6,"o2Detune":10,"o2Level":0.7,"cutoff":450,"res":1.6,"fEnv":2.6,"fA":0.07,"fD":0.6,"fS":0.55,"fR":0.3,"aA":0.03,"aD":0.4,"aS":0.85,"aR":0.3,"velFilt":0.7,"velSens":0.5,"lfoRate":5,"modVib":30,"drive":0.35,"chorus":0.35,"dMix":0.08,"rSize":3,"rMix":0.3,"volume":0.91}],
 ['Strings & Brass','Jump Brass',{"o1Uni":4,"o1Spread":10,"o2Detune":10,"o2Level":0.7,"cutoff":700,"res":1.6,"fEnv":2.2,"fA":0.07,"fD":0.6,"fS":0.55,"fR":0.3,"aA":0.03,"aD":0.4,"aS":0.85,"aR":0.2,"velFilt":0.7,"velSens":0.5,"lfoRate":5,"modVib":30,"drive":0.4,"chorus":0.35,"dMix":0.08,"rSize":3,"rMix":0.3,"volume":0.8}],
 ['Strings & Brass','Soft French Horn',{"o1Uni":2,"o1Spread":6,"o2Detune":10,"o2Level":0.4,"cutoff":380,"res":1.6,"fEnv":1.8,"fA":0.15,"fD":0.6,"fS":0.55,"fR":0.3,"aA":0.08,"aD":0.4,"aS":0.85,"aR":0.3,"velFilt":0.7,"velSens":0.5,"lfoRate":5,"modVib":30,"drive":0.35,"chorus":0.35,"dMix":0.08,"rSize":3,"rMix":0.4,"o1Wave":"triangle","o2Wave":"sawtooth","volume":0.88}],
 ['Strings & Brass','Brass Stabs',{"o1Uni":2,"o1Spread":6,"o2Detune":10,"o2Level":0.7,"cutoff":600,"res":1.6,"fEnv":2.6,"fA":0.07,"fD":0.3,"fS":0.3,"fR":0.3,"aA":0.03,"aD":0.35,"aS":0.4,"aR":0.18,"velFilt":0.7,"velSens":0.5,"lfoRate":5,"modVib":30,"drive":0.35,"chorus":0.35,"dMix":0.15,"rSize":3,"rMix":0.3,"dTime":0.25,"volume":1.17}],
 ['Strings & Brass','Funk Section',{"o1Uni":2,"o1Spread":6,"o2Detune":10,"o2Level":0.35,"cutoff":500,"res":1.6,"fEnv":3,"fA":0.07,"fD":0.6,"fS":0.55,"fR":0.3,"aA":0.03,"aD":0.4,"aS":0.85,"aR":0.12,"velFilt":0.7,"velSens":0.5,"lfoRate":5,"modVib":30,"drive":0.35,"chorus":0.35,"dMix":0.08,"rSize":3,"rMix":0.3,"o2Wave":"square","o2Oct":1,"volume":0.93}],
 ['Strings & Brass','Fanfare',{"o1Uni":5,"o1Spread":9,"o2Detune":10,"o2Level":0.7,"cutoff":1100,"res":1.6,"fEnv":2.6,"fA":0.07,"fD":0.6,"fS":0.55,"fR":0.3,"aA":0.03,"aD":0.4,"aS":0.85,"aR":0.3,"velFilt":0.7,"velSens":0.5,"lfoRate":5,"modVib":30,"drive":0.35,"chorus":0.35,"dMix":0.08,"rSize":5,"rMix":0.45,"o2Oct":1,"volume":0.87}],
 ['Keys','Suitcase EP',{"o1Wave":"sine","o1Level":0.9,"o2Wave":"sine","o2Oct":1,"o2Level":0.07,"fmAmt":1.2,"fmRatio":1,"fmDecay":1,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"velFilt":0,"aA":0.002,"aD":3.5,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":5,"drive":0.45,"chorus":0.7,"dMix":0.05,"rSize":2.2,"rMix":0.25,"volume":0.74}],
 ['Keys','Bright Tines',{"o1Wave":"sine","o1Level":0.9,"o2Wave":"sine","o2Oct":1,"o2Level":0.12,"fmAmt":2.2,"fmRatio":1,"fmDecay":0.6,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"velFilt":0,"aA":0.002,"aD":3.5,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":4.5,"drive":0.3,"chorus":0.5,"dMix":0.05,"rSize":2.2,"rMix":0.25,"volume":0.55}],
 ['Keys','Dreamy EP',{"o1Wave":"sine","o1Level":0.9,"o2Wave":"sine","o2Oct":1,"o2Level":0.07,"fmAmt":1,"fmRatio":1,"fmDecay":1,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"velFilt":0,"aA":0.002,"aD":3.5,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":4.5,"drive":0.3,"chorus":0.9,"dMix":0.25,"rSize":5,"rMix":0.45,"dTime":0.45,"dFb":0.45,"volume":0.74}],
 ['Keys','80s DX Piano',{"o1Wave":"sine","o1Level":0.9,"o2Wave":"sine","o2Oct":2,"o2Level":0.15,"fmAmt":3,"fmRatio":1,"fmDecay":0.4,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"velFilt":0,"aA":0.002,"aD":3.5,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":4.5,"drive":0.3,"chorus":0.5,"dMix":0.05,"rSize":2.2,"rMix":0.25,"volume":0.65}],
 ['Keys','Wurly Bite',{"o1Wave":"triangle","o1Level":0.9,"o2Wave":"sine","o2Oct":1,"o2Level":0.07,"fmAmt":1.8,"fmRatio":1,"fmDecay":0.7,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"velFilt":0,"aA":0.002,"aD":3.5,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":4.5,"drive":0.6,"chorus":0.3,"dMix":0.05,"rSize":2.2,"rMix":0.25,"volume":0.64}],
 ['Keys','Lo-fi Keys',{"o1Wave":"sine","o1Level":0.9,"o2Wave":"sine","o2Oct":1,"o2Level":0.07,"fmAmt":0.8,"fmRatio":1,"fmDecay":1,"cutoff":1800,"res":0.5,"fEnv":0,"keyTrack":0,"velFilt":0,"aA":0.002,"aD":3.5,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":0.6,"drive":0.4,"chorus":0.5,"dMix":0.05,"rSize":2.2,"rMix":0.3,"lfoVib":8,"volume":0.64}],
 ['Keys','Vibraphone',{"o1Wave":"sine","o1Level":0.9,"o2Wave":"sine","o2Oct":1,"o2Level":0.07,"fmAmt":1,"fmRatio":4,"fmDecay":0.4,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"velFilt":0,"aA":0.002,"aD":4,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":5,"drive":0.3,"chorus":0.2,"dMix":0.05,"rSize":2.2,"rMix":0.35,"lfoVib":0,"volume":0.77}],
 ['Keys','Celesta',{"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0.2,"fmAmt":1.2,"fmRatio":4,"fmDecay":0.6,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":1.8,"aS":0,"aR":1,"velSens":0.7,"chorus":0.4,"dTime":0.5,"dFb":0.45,"dMix":0.25,"rSize":6,"rMix":0.35,"volume":0.97}],
 ['Keys','Analog Piano',{"o1Wave":"sawtooth","o1Level":0.9,"o2Wave":"triangle","o2Oct":1,"o2Level":0.3,"fmAmt":0,"fmRatio":1,"fmDecay":1,"cutoff":500,"res":0.5,"fEnv":3,"keyTrack":0.8,"velFilt":0.8,"aA":0.002,"aD":3.5,"aS":0,"aR":0.45,"velSens":0.85,"lfoRate":4.5,"drive":0.3,"chorus":0.5,"dMix":0.05,"rSize":2.2,"rMix":0.25,"fA":0.001,"fD":1.2,"fS":0.1,"fR":0.3,"volume":1.07}],
 ['Keys','Harpsichord Synth',{"o1Uni":2,"o1Spread":10,"o2Level":0.4,"o2Oct":1,"cutoff":1500,"res":2,"fEnv":2,"fA":0.001,"fD":0.4,"fS":0,"fR":0.2,"aA":0.001,"aD":1.5,"aS":0,"aR":0.15,"velSens":0.6,"chorus":0.4,"dTime":0.375,"dFb":0.4,"dMix":0,"rSize":2,"rMix":0.3,"o1Wave":"pulse","o2Wave":"sawtooth","volume":1.5}],
 ['Organs','Drawbar Full',{"o1Wave":"sine","o1Level":0.7,"o2Wave":"sine","o2Oct":2,"o2Level":0.35,"subLevel":0.6,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.006,"aD":0.1,"aS":1,"aR":0.08,"velSens":0,"lfoRate":6.2,"lfoVib":5,"drive":0.45,"chorus":0.8,"dMix":0,"rSize":2,"rMix":0.25,"volume":0.43}],
 ['Organs','Gospel Organ',{"o1Wave":"sine","o1Level":0.7,"o2Wave":"sine","o2Oct":1,"o2Level":0.45,"subLevel":0.5,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.006,"aD":0.1,"aS":1,"aR":0.08,"velSens":0,"lfoRate":6.8,"lfoVib":8,"drive":0.6,"chorus":1,"dMix":0,"rSize":2,"rMix":0.25,"volume":0.35}],
 ['Organs','Church Pipes',{"o1Wave":"triangle","o1Level":0.7,"o2Wave":"sine","o2Oct":1,"o2Level":0.5,"subLevel":0.5,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.12,"aD":0.1,"aS":1,"aR":0.6,"velSens":0,"lfoRate":6.2,"lfoVib":0,"drive":0,"chorus":0.8,"dMix":0,"rSize":9,"rMix":0.6,"volume":0.54}],
 ['Organs','Combo Organ',{"o1Wave":"square","o1Level":0.7,"o2Wave":"square","o2Oct":1,"o2Level":0.3,"subLevel":0.5,"cutoff":3000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.006,"aD":0.1,"aS":1,"aR":0.08,"velSens":0,"lfoRate":6.2,"lfoVib":0,"drive":0.25,"chorus":0.8,"dMix":0,"rSize":2,"rMix":0.25,"volume":0.45}],
 ['Organs','Reed Organ',{"o1Wave":"pulse","o1Level":0.7,"o2Wave":"triangle","o2Oct":1,"o2Level":0.45,"subLevel":0.5,"cutoff":2200,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.05,"aD":0.1,"aS":1,"aR":0.08,"velSens":0,"lfoRate":6.2,"lfoVib":5,"drive":0.15,"chorus":0.8,"dMix":0,"rSize":2,"rMix":0.25,"volume":0.55}],
 ['Organs','Percussive Drawbar',{"o1Wave":"sine","o1Level":0.7,"o2Wave":"sine","o2Oct":1,"o2Level":0.45,"subLevel":0.5,"cutoff":6000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.006,"aD":0.1,"aS":1,"aR":0.08,"velSens":0,"lfoRate":6.2,"lfoVib":5,"drive":0.4,"chorus":0.8,"dMix":0,"rSize":2,"rMix":0.25,"fmAmt":0.8,"fmRatio":3,"fmDecay":0.2,"volume":0.45}],
 ['Leads','Classic Mono Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":6,"cutoff":1500,"res":3.5,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"playMode":"legato","glide":0.06,"glideMode":"overlap","volume":1.78}],
 ['Leads','Screaming Saw',{"o1Uni":3,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":6,"cutoff":2200,"res":7,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.8,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"playMode":"legato","glide":0.04,"glideMode":"overlap","volume":0.64}],
 ['Leads','Square Whistle',{"o1Uni":2,"o1Spread":7,"o2Wave":"square","o2Level":0.25,"o2Detune":6,"cutoff":4000,"res":1,"fEnv":0.5,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o1Wave":"square","o2Oct":1,"lfoVib":4,"volume":0.76}],
 ['Leads','Soft Sine Lead',{"o1Uni":1,"o1Spread":7,"o2Wave":"triangle","o2Level":0.2,"o2Detune":6,"cutoff":5000,"res":3.5,"fEnv":0,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.04,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o1Wave":"sine","o2Oct":1,"lfoVib":6,"playMode":"legato","glide":0.1,"volume":0.81}],
 ['Leads','Fat Unison Lead',{"o1Uni":5,"o1Spread":16,"o2Wave":"sawtooth","o2Level":0.5,"o2Detune":6,"cutoff":1800,"res":3.5,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.5,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o2Oct":-1,"volume":0.84}],
 ['Leads','Pluck Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":6,"cutoff":900,"res":3.5,"fEnv":3,"fA":0.01,"fD":0.25,"fS":0.3,"fR":0.4,"aA":0.008,"aD":0.6,"aS":0.6,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"volume":1.38}],
 ['Leads','Sync-ish Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.5,"o2Detune":6,"cutoff":1500,"res":6,"fEnv":2.5,"fA":0.01,"fD":0.4,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.55,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o2Semi":7,"o2Oct":1,"volume":0.76}],
 ['Leads','Hyper Lead',{"o1Uni":7,"o1Spread":20,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":6,"cutoff":4500,"res":2,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.4,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.3,"rSize":3,"rMix":0.35,"pressFilt":2400,"pressVib":30,"width":1,"volume":1.01}],
 ['Leads','Vintage Bend Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"pulse","o2Level":0.4,"o2Detune":6,"cutoff":1500,"res":3.5,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":60,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"glide":0.12,"glideMode":"always","playMode":"mono","volume":1.63}],
 ['Leads','Flute Lead',{"o1Uni":1,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0,"o2Detune":6,"cutoff":3000,"res":1,"fEnv":0.3,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.06,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o1Wave":"sine","noise":0.08,"lfoVib":5,"volume":0.69}],
 ['Leads','Gritty Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":-14,"cutoff":1300,"res":5,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.9,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o1Wave":"square","volume":0.43}],
 ['Leads','Chime Lead',{"o1Uni":1,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0,"o2Detune":6,"cutoff":8000,"res":0.5,"fEnv":0,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o1Wave":"sine","fmAmt":2,"fmRatio":2,"fmDecay":0.5,"volume":0.7}],
 ['Leads','Ocarina',{"o1Uni":1,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0,"o2Detune":6,"cutoff":2500,"res":0.7,"fEnv":0,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.03,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"o1Wave":"triangle","noise":0.04,"lfoVib":7,"playMode":"legato","glide":0.05,"glideMode":"overlap","volume":1.0}],
 ['Leads','Laser Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":6,"cutoff":2500,"res":9,"fEnv":1,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.6,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":2400,"pressVib":30,"glide":0.2,"glideMode":"always","playMode":"mono","volume":1.12}],
 ['Bass','Moog-style Bass',{"o1Oct":-1,"o2Wave":"sawtooth","o2Oct":-1,"o2Level":0.5,"o2Detune":7,"subLevel":0.45,"cutoff":220,"res":3,"fEnv":2.8,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"playMode":"mono","glide":0.03,"glideMode":"overlap","volume":0.82}],
 ['Bass','Rubber Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0.3,"o2Detune":4,"subLevel":0.45,"cutoff":160,"res":6,"fEnv":3.2,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.2,"fS":0.15,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Wave":"square","volume":0.48}],
 ['Bass','Plucked Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0.5,"o2Detune":4,"subLevel":0.45,"cutoff":220,"res":4,"fEnv":3.5,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.2,"fS":0,"fR":0.15,"aA":0.002,"aD":0.6,"aS":0,"aR":0.15,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"volume":0.81}],
 ['Bass','Wobble Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0.5,"o2Detune":4,"subLevel":0.45,"cutoff":180,"res":8,"fEnv":0.5,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.7,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Uni":3,"o1Spread":12,"lfoRate":3,"lfoFilt":2400,"playMode":"mono","volume":0.39}],
 ['Bass','Synthwave Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0.5,"o2Detune":4,"subLevel":0.45,"cutoff":320,"res":3,"fEnv":2.2,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.25,"fS":0.25,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0.12,"rMix":0.05,"rSize":1,"o1Uni":2,"o1Spread":8,"dTime":0.375,"volume":0.66}],
 ['Bass','Sub Sine Bass',{"o1Oct":-1,"o2Wave":"sine","o2Oct":-1,"o2Level":0.3,"o2Detune":4,"subLevel":0.4,"cutoff":600,"res":4,"fEnv":0,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.35,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Wave":"sine","playMode":"mono","glide":0.04,"glideMode":"overlap","volume":0.78}],
 ['Bass','Finger Bass',{"o1Oct":-1,"o2Wave":"sawtooth","o2Oct":-1,"o2Level":0.25,"o2Detune":4,"subLevel":0.45,"cutoff":500,"res":1.5,"fEnv":1.5,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":1.2,"aS":0.3,"aR":0.12,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Wave":"triangle","volume":0.79}],
 ['Bass','Hoover Bass',{"o1Oct":-1,"o2Wave":"pulse","o2Oct":-1,"o2Level":0.5,"o2Detune":4,"subLevel":0.45,"cutoff":900,"res":2,"fEnv":2.8,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.6,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Uni":5,"o1Spread":30,"glide":0.08,"glideMode":"always","playMode":"mono","volume":0.88}],
 ['Bass','Squelch Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0,"o2Detune":4,"subLevel":0.45,"cutoff":200,"res":14,"fEnv":4,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.18,"fS":0.05,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.7,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"playMode":"legato","glide":0.06,"glideMode":"overlap","volume":0.67}],
 ['Bass','Electro Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":0,"o2Level":0.5,"o2Detune":10,"subLevel":0.45,"cutoff":400,"res":5,"fEnv":2.5,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.12,"fS":0.2,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Wave":"square","volume":0.49}],
 ['Bass','Growl Reese',{"o1Oct":-1,"o2Wave":"sawtooth","o2Oct":-1,"o2Level":0.7,"o2Detune":-20,"subLevel":0.45,"cutoff":380,"res":3,"fEnv":0.4,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.7,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Uni":3,"o1Spread":24,"lfoRate":0.25,"lfoFilt":900,"playMode":"mono","volume":0.62}],
 ['Bass','808 Boom',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0,"o2Detune":4,"subLevel":0.3,"cutoff":2000,"res":4,"fEnv":0,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":1.8,"aS":0,"aR":0.5,"velSens":0.6,"drive":0.5,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Wave":"sine","glide":0.05,"glideMode":"overlap","playMode":"mono","volume":0.97}],
 ['Bass','Stab Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0.5,"o2Detune":4,"subLevel":0.45,"cutoff":220,"res":5,"fEnv":2.8,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.12,"fS":0.1,"fR":0.15,"aA":0.002,"aD":0.25,"aS":0.3,"aR":0.08,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Uni":2,"volume":0.95}],
 ['Bass','Deep House Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0.2,"o2Detune":4,"subLevel":0.45,"cutoff":300,"res":2,"fEnv":2,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.2,"fS":0.1,"fR":0.15,"aA":0.002,"aD":0.4,"aS":0.6,"aR":0.12,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"o1Wave":"sine","volume":0.67}],
 ['Plucks & Bells','Crystal Pluck',{"o1Uni":2,"o1Spread":10,"o2Level":0.35,"o2Oct":1,"cutoff":900,"res":3,"fEnv":3,"fA":0.001,"fD":0.25,"fS":0,"fR":0.2,"aA":0.001,"aD":0.8,"aS":0,"aR":0.4,"velSens":0.6,"chorus":0.4,"dTime":0.375,"dFb":0.4,"dMix":0.3,"rSize":3,"rMix":0.4,"o1Wave":"triangle","volume":1.95}],
 ['Plucks & Bells','Kalimba',{"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0.08,"fmAmt":1,"fmRatio":5.5,"fmDecay":0.15,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":1,"aS":0,"aR":0.4,"velSens":0.7,"chorus":0.4,"dTime":0.5,"dFb":0.45,"dMix":0.1,"rSize":6,"rMix":0.3,"volume":1.16}],
 ['Plucks & Bells','Steel Drum',{"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0,"fmAmt":1.6,"fmRatio":2.5,"fmDecay":0.3,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":1.2,"aS":0,"aR":0.4,"velSens":0.7,"chorus":0.4,"dTime":0.5,"dFb":0.45,"dMix":0.25,"rSize":6,"rMix":0.3,"volume":1.12}],
 ['Plucks & Bells','Tubular Bells',{"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0.12,"fmAmt":4,"fmRatio":3.5,"fmDecay":3,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":6,"aS":0,"aR":3,"velSens":0.7,"chorus":0.4,"dTime":0.5,"dFb":0.45,"dMix":0.25,"rSize":6,"rMix":0.5,"volume":0.83}],
 ['Plucks & Bells','Wind Chimes',{"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0.12,"fmAmt":2.5,"fmRatio":6.5,"fmDecay":2,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":4,"aS":0,"aR":2,"velSens":0.7,"chorus":0.4,"dTime":0.5,"dFb":0.45,"dMix":0.25,"rSize":9,"rMix":0.65,"o2Semi":7,"volume":0.86}],
 ['Plucks & Bells','Koto Pluck',{"o1Uni":1,"o1Spread":10,"o2Level":0.2,"o2Oct":1,"cutoff":900,"res":4,"fEnv":2.5,"fA":0.001,"fD":0.15,"fS":0,"fR":0.2,"aA":0.001,"aD":1.5,"aS":0,"aR":0.4,"velSens":0.6,"chorus":0.4,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.3,"o1Wave":"sawtooth","lfoVib":0,"volume":1.31}],
 ['Plucks & Bells','Guitar Pluck',{"o1Uni":1,"o1Spread":10,"o2Level":0.3,"o2Oct":0,"cutoff":700,"res":3,"fEnv":3,"fA":0.001,"fD":0.3,"fS":0,"fR":0.2,"aA":0.001,"aD":2,"aS":0,"aR":0.3,"velSens":0.6,"chorus":0.4,"dTime":0.375,"dFb":0.4,"dMix":0.12,"rSize":3,"rMix":0.3,"o2Wave":"square","o2Detune":6,"volume":1.03}],
 ['Plucks & Bells','Bubble Pluck',{"o1Uni":2,"o1Spread":10,"o2Level":0,"o2Oct":1,"cutoff":300,"res":12,"fEnv":4.5,"fA":0.001,"fD":0.12,"fS":0,"fR":0.2,"aA":0.001,"aD":0.8,"aS":0,"aR":0.4,"velSens":0.6,"chorus":0.4,"dTime":0.33,"dFb":0.4,"dMix":0.3,"rSize":3,"rMix":0.3,"o1Wave":"sine","volume":0.95}],
 ['Plucks & Bells','Glockenspiel',{"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0.25,"fmAmt":1.8,"fmRatio":4,"fmDecay":0.5,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":2,"aS":0,"aR":1.2,"velSens":0.7,"chorus":0.4,"dTime":0.5,"dFb":0.45,"dMix":0.25,"rSize":6,"rMix":0.4,"volume":0.92}],
 ['Plucks & Bells','Gamelan',{"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0.15,"fmAmt":3,"fmRatio":2.76,"fmDecay":1.2,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":3,"aS":0,"aR":2,"velSens":0.7,"chorus":0.4,"dTime":0.5,"dFb":0.45,"dMix":0.25,"rSize":6,"rMix":0.5,"o2Semi":5,"volume":0.9}],
 ['Plucks & Bells','Pizz Pop',{"o1Uni":2,"o1Spread":10,"o2Level":0.2,"o2Oct":1,"cutoff":500,"res":3,"fEnv":3.5,"fA":0.001,"fD":0.1,"fS":0,"fR":0.2,"aA":0.001,"aD":0.3,"aS":0,"aR":0.4,"velSens":0.6,"chorus":0.4,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.3,"o1Wave":"square","volume":1.89}],
 ['Plucks & Bells','Dream Harp',{"o1Uni":2,"o1Spread":10,"o2Level":0.35,"o2Oct":1,"cutoff":1200,"res":3,"fEnv":2,"fA":0.001,"fD":0.25,"fS":0,"fR":0.2,"aA":0.001,"aD":3,"aS":0,"aR":1.5,"velSens":0.6,"chorus":0.7,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":7,"rMix":0.55,"o1Wave":"triangle","o2Wave":"sine","volume":1.33}],
 ['Arps & Sequences','Berlin Sequence',{"arpMode":"up","arpRate":"1/16","arpOct":2,"arpGate":0.45,"o1Uni":2,"o1Spread":8,"o2Wave":"square","o2Level":0.3,"o2Oct":1,"cutoff":500,"res":5,"fEnv":3.2,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.3,"chorus":0.3,"dTime":0.25,"dFb":0.5,"dMix":0.32,"rSize":3,"rMix":0.25,"volume":1.54}],
 ['Arps & Sequences','Ping-Pong Arp',{"arpMode":"updown","arpRate":"1/8","arpOct":2,"arpGate":0.5,"o1Uni":2,"o1Spread":8,"o2Wave":"square","o2Level":0.3,"o2Oct":1,"cutoff":700,"res":5,"fEnv":3.2,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.3,"chorus":0.3,"dTime":0.375,"dFb":0.55,"dMix":0.4,"rSize":3,"rMix":0.25,"volume":1.56}],
 ['Arps & Sequences','Stranger Arp',{"arpMode":"up","arpRate":"1/8","arpOct":2,"arpGate":0.7,"o1Uni":1,"o1Spread":8,"o2Wave":"sawtooth","o2Level":0.3,"o2Oct":1,"cutoff":350,"res":7,"fEnv":3.5,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.3,"chorus":0.3,"dTime":0.33,"dFb":0.5,"dMix":0.32,"rSize":3,"rMix":0.35,"o2Detune":8,"volume":1.27}],
 ['Arps & Sequences','Trance Gate Pluck',{"arpMode":"chord","arpRate":"1/16","arpOct":1,"arpGate":0.35,"o1Uni":5,"o1Spread":16,"o2Wave":"square","o2Level":0.3,"o2Oct":1,"cutoff":1100,"res":3,"fEnv":3.2,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.3,"chorus":0.3,"dTime":0.1875,"dFb":0.35,"dMix":0.32,"rSize":3,"rMix":0.25,"width":1,"volume":1.26}],
 ['Arps & Sequences','Chip Arp',{"arpMode":"up","arpRate":"1/16","arpOct":2,"arpGate":0.8,"o1Uni":1,"o1Spread":8,"o2Wave":"square","o2Level":0,"o2Oct":1,"cutoff":12000,"res":0.5,"fEnv":0,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.15,"aS":0.4,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0,"chorus":0,"dTime":0.125,"dFb":0.3,"dMix":0.15,"rSize":3,"rMix":0.25,"o1Wave":"square","volume":1.15}],
 ['Arps & Sequences','Glass Sequence',{"arpMode":"random","arpRate":"1/16","arpOct":3,"arpGate":0.5,"o1Uni":2,"o1Spread":8,"o2Wave":"square","o2Level":0,"o2Oct":1,"cutoff":6000,"res":5,"fEnv":0,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.3,"chorus":0.3,"dTime":0.25,"dFb":0.5,"dMix":0.35,"rSize":3,"rMix":0.25,"o1Wave":"sine","fmAmt":2,"fmRatio":3,"fmDecay":0.2,"volume":1.5}],
 ['Arps & Sequences','Acid Arp',{"arpMode":"played","arpRate":"1/16","arpOct":1,"arpGate":0.6,"o1Uni":1,"o1Spread":8,"o2Wave":"square","o2Level":0,"o2Oct":1,"cutoff":500,"res":13,"fEnv":4,"fA":0.001,"fD":0.15,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.6,"chorus":0.3,"dTime":0.1875,"dFb":0.5,"dMix":0.22,"rSize":3,"rMix":0.25,"volume":0.91}],
 ['Arps & Sequences','Synthwave Arp',{"arpMode":"up","arpRate":"1/8","arpOct":2,"arpGate":0.6,"o1Uni":3,"o1Spread":8,"o2Wave":"square","o2Level":0.3,"o2Oct":1,"cutoff":900,"res":3,"fEnv":3.2,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.3,"chorus":0.6,"dTime":0.375,"dFb":0.45,"dMix":0.3,"rSize":5,"rMix":0.4,"volume":2.0}],
 ['Arps & Sequences','Marimba Run',{"arpMode":"updown","arpRate":"1/16","arpOct":2,"arpGate":0.5,"o1Wave":"sine","o1Level":0.85,"o2Wave":"sine","o2Oct":2,"o2Level":0.12,"fmAmt":1.4,"fmRatio":4,"fmDecay":0.1,"cutoff":12000,"res":0.5,"fEnv":0,"keyTrack":0,"aA":0.002,"aD":0.6,"aS":0,"aR":0.25,"velSens":0.7,"chorus":0.4,"dTime":0.25,"dFb":0.3,"dMix":0.25,"rSize":6,"rMix":0.25,"volume":1.34}],
 ['Arps & Sequences','Dark Pulse Seq',{"arpMode":"down","arpRate":"1/16","arpOct":1,"arpGate":0.5,"o1Uni":2,"o1Spread":8,"o2Wave":"square","o2Level":0.3,"o2Oct":1,"cutoff":250,"res":6,"fEnv":3,"fA":0.001,"fD":0.18,"fS":0.1,"fR":0.12,"aA":0.001,"aD":0.35,"aS":0.2,"aR":0.2,"velSens":0.6,"velFilt":0.5,"drive":0.3,"chorus":0.3,"dTime":0.5,"dFb":0.5,"dMix":0.25,"rSize":3,"rMix":0.25,"o1Wave":"pulse","o1Oct":-1,"volume":1.26}],
 ['FX & Noise','Riser Wash',{"o1Wave":"sawtooth","o1Uni":3,"o1Spread":30,"noise":0.5,"cutoff":400,"res":8,"fEnv":4,"fA":2,"fD":3,"fS":0.5,"fR":3,"aA":1,"aD":2,"aS":0.8,"aR":4,"velSens":0,"lfoRate":0.2,"lfoFilt":1800,"drive":0.5,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.7,"volume":0.65}],
 ['FX & Noise','Ocean Waves',{"o1Wave":"sawtooth","o1Uni":3,"o1Spread":30,"noise":0.9,"cutoff":500,"res":2,"fEnv":0,"fA":2,"fD":3,"fS":0.5,"fR":3,"aA":1,"aD":2,"aS":0.8,"aR":4,"velSens":0,"lfoRate":0.12,"lfoFilt":2400,"drive":0.5,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.7,"o1Level":0,"volume":0.86}],
 ['FX & Noise','Wind Tunnel',{"o1Wave":"sawtooth","o1Uni":3,"o1Spread":30,"noise":0.9,"cutoff":400,"res":12,"fEnv":0,"fA":2,"fD":3,"fS":0.5,"fR":3,"aA":1,"aD":2,"aS":0.8,"aR":4,"velSens":0,"lfoRate":0.25,"lfoFilt":2000,"drive":0.5,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.7,"o1Level":0.1,"volume":0.57}],
 ['FX & Noise','Sci-fi Drone',{"o1Wave":"sawtooth","o1Uni":3,"o1Spread":30,"noise":0.1,"cutoff":800,"res":8,"fEnv":4,"fA":2,"fD":3,"fS":0.5,"fR":3,"aA":1,"aD":2,"aS":0.8,"aR":4,"velSens":0,"lfoRate":6,"lfoFilt":1800,"drive":0.5,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.7,"o2Wave":"square","o2Semi":6,"o2Level":0.4,"lfoVib":30,"volume":0.58}],
 ['FX & Noise','Radio Static',{"o1Wave":"sawtooth","o1Uni":3,"o1Spread":30,"noise":0.7,"cutoff":2500,"res":6,"fEnv":0,"fA":2,"fD":3,"fS":0.5,"fR":3,"aA":1,"aD":2,"aS":0.8,"aR":4,"velSens":0,"lfoRate":7,"lfoFilt":1200,"drive":0.5,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.7,"o1Level":0.2,"volume":0.86}],
 ['FX & Noise','Alien Chatter',{"o1Wave":"square","o1Uni":3,"o1Spread":30,"noise":0.1,"cutoff":400,"res":10,"fEnv":4,"fA":2,"fD":3,"fS":0.5,"fR":3,"aA":1,"aD":2,"aS":0.8,"aR":4,"velSens":0,"lfoRate":9,"lfoFilt":1800,"drive":0.5,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.7,"fmAmt":5,"fmRatio":1.5,"fmDecay":4,"lfoVib":40,"volume":0.41}],
 ['FX & Noise','Thunder Rumble',{"o1Wave":"sawtooth","o1Uni":3,"o1Spread":30,"noise":0.6,"cutoff":150,"res":3,"fEnv":2,"fA":2,"fD":3,"fS":0.5,"fR":3,"aA":1,"aD":2,"aS":0.8,"aR":4,"velSens":0,"lfoRate":0.2,"lfoFilt":1800,"drive":0.8,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.35,"rSize":12,"rMix":0.7,"o1Oct":-2,"subLevel":0.5,"volume":0.49}],
 ['FX & Noise','Laser Zap',{"o1Wave":"sawtooth","o1Uni":3,"o1Spread":30,"noise":0,"cutoff":200,"res":8,"fEnv":5,"fA":0.001,"fD":0.25,"fS":0,"fR":3,"aA":0.001,"aD":0.4,"aS":0,"aR":0.2,"velSens":0,"lfoRate":0.2,"lfoFilt":0,"drive":0.5,"chorus":0.7,"dTime":0.55,"dFb":0.7,"dMix":0.2,"rSize":12,"rMix":0.3,"glide":0.15,"glideMode":"always","playMode":"mono","volume":1.71}],
 ['MPE','MPE Bowed Cello',{"o1Uni":3,"o1Spread":10,"o2Wave":"sawtooth","o2Level":0.4,"cutoff":500,"res":1.5,"fEnv":0.6,"fA":0.2,"fD":1.5,"fS":0.6,"fR":1,"aA":0.25,"aD":1,"aS":0.95,"aR":1.2,"velSens":0.3,"chorus":0.6,"dMix":0.12,"rSize":4,"rMix":0.4,"pressFilt":3200,"pressAmp":0.85,"pressVib":28,"timbreFilt":2400,"o1Oct":-1,"volume":0.97}],
 ['MPE','MPE Breath Flute',{"o1Uni":1,"o1Spread":10,"o2Wave":"sawtooth","o2Level":0,"cutoff":1800,"res":1,"fEnv":0.6,"fA":0.2,"fD":1.5,"fS":0.6,"fR":1,"aA":0.15,"aD":1,"aS":0.95,"aR":1.2,"velSens":0.3,"chorus":0.6,"dMix":0.12,"rSize":4,"rMix":0.4,"pressFilt":2400,"pressAmp":0.95,"pressVib":18,"timbreFilt":2400,"o1Wave":"sine","noise":0.15,"volume":0.63}],
 ['MPE','MPE Expressive Brass',{"o1Uni":2,"o1Spread":6,"o2Detune":10,"o2Level":0.7,"cutoff":300,"res":1.6,"fEnv":2.6,"fA":0.07,"fD":0.6,"fS":0.55,"fR":0.3,"aA":0.03,"aD":0.4,"aS":0.85,"aR":0.3,"velFilt":0.7,"velSens":0.5,"lfoRate":5,"modVib":30,"drive":0.35,"chorus":0.35,"dMix":0.08,"rSize":3,"rMix":0.3,"pressFilt":4000,"pressAmp":0.8,"pressVib":20,"volume":0.8}],
 ['MPE','MPE Glide Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":6,"cutoff":1500,"res":3.5,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":3600,"pressVib":40,"pressAmp":0.5,"timbreFilt":3000,"volume":0.96}],
 ['MPE','MPE Swell Pad',{"o1Uni":3,"o1Spread":14,"o2Wave":"sawtooth","o2Level":0.45,"o2Detune":8,"cutoff":600,"res":1.2,"fEnv":1,"fA":0.8,"fD":2,"fS":0.6,"fR":2,"aA":0.6,"aD":1.5,"aS":0.9,"aR":2.2,"velSens":0.3,"chorus":0.7,"dTime":0.45,"dFb":0.4,"dMix":0.18,"rSize":5,"rMix":0.45,"pressFilt":3000,"pressAmp":0.95,"pressVib":12,"volume":0.91}],
 ['MPE','MPE Wah Bass',{"o1Oct":-1,"o2Wave":"square","o2Oct":-1,"o2Level":0.5,"o2Detune":4,"subLevel":0.45,"cutoff":150,"res":9,"fEnv":2.8,"keyTrack":0.3,"velFilt":0.6,"fA":0.002,"fD":0.3,"fS":0.15,"fR":0.15,"aA":0.002,"aD":0.5,"aS":0.8,"aR":0.12,"velSens":0.6,"drive":0.4,"chorus":0,"dMix":0,"rMix":0.05,"rSize":1,"pressFilt":4800,"pressAmp":0.2,"volume":0.38}],
 ['MPE','MPE Singing Saw',{"o1Uni":1,"o1Spread":10,"o2Wave":"sawtooth","o2Level":0,"cutoff":4000,"res":1.5,"fEnv":0.6,"fA":0.2,"fD":1.5,"fS":0.6,"fR":1,"aA":0.15,"aD":1,"aS":0.95,"aR":1.2,"velSens":0.3,"chorus":0.6,"dMix":0.12,"rSize":4,"rMix":0.4,"pressFilt":1200,"pressAmp":0.85,"pressVib":45,"timbreFilt":2400,"o1Wave":"sine","fmAmt":0.6,"fmDecay":6,"volume":0.57}],
 ['MPE','MPE Erhu',{"o1Uni":1,"o1Spread":10,"o2Wave":"pulse","o2Level":0.3,"cutoff":1100,"res":3,"fEnv":0.6,"fA":0.2,"fD":1.5,"fS":0.6,"fR":1,"aA":0.08,"aD":1,"aS":0.95,"aR":1.2,"velSens":0.3,"chorus":0.6,"dMix":0.12,"rSize":4,"rMix":0.4,"pressFilt":2000,"pressAmp":0.85,"pressVib":50,"timbreFilt":2400,"volume":0.79}],
 ['MPE','MPE Wall Bloom',{"o1Uni":7,"o1Spread":24,"width":1,"o2Wave":"sawtooth","o2Oct":1,"o2Uni":3,"o2Level":0.4,"subLevel":0.3,"cutoff":900,"res":1,"fEnv":0.6,"fA":0.3,"fD":3,"fS":0.7,"fR":3,"aA":0.2,"aD":2,"aS":0.9,"aR":3.5,"velSens":0.25,"drive":0.4,"chorus":0.85,"dTime":0.42,"dFb":0.5,"dMix":0.28,"rSize":8,"rMix":0.6,"pressFilt":3600,"pressAmp":0.9,"pressVib":16,"volume":0.72}],
 ['MPE','MPE Harmonica',{"o1Uni":1,"o1Spread":10,"o2Wave":"sawtooth","o2Level":0.2,"cutoff":1400,"res":2,"fEnv":0.6,"fA":0.2,"fD":1.5,"fS":0.6,"fR":1,"aA":0.03,"aD":1,"aS":0.95,"aR":1.2,"velSens":0.3,"chorus":0.2,"dMix":0.12,"rSize":4,"rMix":0.4,"pressFilt":3200,"pressAmp":0.9,"pressVib":20,"timbreFilt":2400,"o1Wave":"square","volume":0.51}],
 ['MPE','MPE Theremin Air',{"o1Uni":1,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0,"o2Detune":6,"cutoff":8000,"res":3.5,"fEnv":0,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.35,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.4,"pressFilt":2400,"pressVib":35,"o1Wave":"sine","pressAmp":0.9,"playMode":"legato","glide":0.2,"glideMode":"always","volume":0.7}],
 ['MPE','MPE Growl Lead',{"o1Uni":2,"o1Spread":7,"o2Wave":"sawtooth","o2Level":0.4,"o2Detune":6,"cutoff":500,"res":6,"fEnv":1.6,"fA":0.01,"fD":0.6,"fS":0.55,"fR":0.4,"aA":0.008,"aD":0.3,"aS":0.92,"aR":0.35,"lfoRate":5.5,"modVib":45,"drive":0.8,"chorus":0.3,"dTime":0.375,"dFb":0.4,"dMix":0.25,"rSize":3,"rMix":0.28,"pressFilt":4800,"pressVib":25,"o1Wave":"square","pressAmp":0.4,"volume":0.43}]
];
const EMBER_CATS = ['Walls','Pads','Atmospheres','Strings & Brass','Keys','Organs','Leads','Bass','Plucks & Bells','Arps & Sequences','FX & Noise','MPE','Utility'];

/* ================= Ember·16 — analog-style subtractive polysynth ================= */
defineInstrument({
 id:'ember', name:'Ember·16', brand:'Ember<span>·</span>16', tag:'16-voice analog-style polysynth', theme:'ember',
 cats: EMBER_CATS, presets: EMBER_PRESETS,
 base:{o1Wave:'sawtooth',o1Oct:0,o1Level:0.8,o1Uni:1,o1Spread:12,subLevel:0,width:0.8,
  o2Wave:'sawtooth',o2Oct:0,o2Semi:0,o2Detune:7,o2Level:0.5,o2Uni:1,noise:0,
  fmAmt:0,fmRatio:1,fmDecay:1,
  cutoff:2000,res:1,fEnv:1,keyTrack:0.5,velFilt:0.3,fA:0.005,fD:0.5,fS:0.4,fR:0.5,
  aA:0.005,aD:0.5,aS:0.8,aR:0.4,lfoFilt:0,pressFilt:1200,timbreFilt:1800},
 cc74:['cutoff', x => 40*Math.pow(18000/40, x)], cc71:['res', x => 0.3+17.7*Math.pow(x,1.6)],
 sections:[
  ['Oscillator 1', [
   {k:'o1Wave',type:'sel',opts:WAVES,aria:'Oscillator 1 waveform'},
   {k:'o1Oct',l:'Octave',min:-2,max:2,step:1,fmt:sgn},
   {k:'o1Level',l:'Level',min:0,max:1,fmt:pct},
   {k:'o1Uni',l:'Unison',min:1,max:7,step:1,fmt:v=>v+'×'},
   {k:'o1Spread',l:'Spread',min:0,max:40,fmt:v=>Math.round(v)+'¢'},
   {k:'subLevel',l:'Sub',min:0,max:1,fmt:pct},
   {k:'width',l:'Width',min:0,max:1,fmt:pct}]],
  ['Oscillator 2', [
   {k:'o2Wave',type:'sel',opts:WAVES,aria:'Oscillator 2 waveform'},
   {k:'o2Oct',l:'Octave',min:-2,max:2,step:1,fmt:sgn},
   {k:'o2Semi',l:'Semi',min:-12,max:12,step:1,fmt:sgn},
   {k:'o2Detune',l:'Detune',min:-50,max:50,fmt:v=>Math.round(v)+'¢'},
   {k:'o2Level',l:'Level',min:0,max:1,fmt:pct},
   {k:'o2Uni',l:'Unison',min:1,max:5,step:1,fmt:v=>v+'×'},
   {k:'noise',l:'Noise',min:0,max:1,fmt:pct}]],
  ['FM (on osc 1)', [
   {k:'fmAmt',l:'Amount',min:0,max:8,exp:2,fmt:v=>v.toFixed(2)},
   {k:'fmRatio',l:'Ratio',min:0.5,max:8,step:0.5,fmt:v=>v.toFixed(1)},
   {k:'fmDecay',l:'Decay',min:0.02,max:6,exp:2.5,fmt:ms}]],
  ['Filter', [
   {k:'cutoff',l:'Cutoff',min:40,max:18000,log:true,fmt:hz,live:true},
   {k:'res',l:'Reso',min:0.3,max:18,exp:1.6,fmt:v=>v.toFixed(1),live:true},
   {k:'fEnv',l:'Env amt',min:-3,max:6,fmt:v=>sgn(v.toFixed(1))+' oct',live:true},
   {k:'keyTrack',l:'Key trk',min:0,max:1,fmt:pct},
   {k:'velFilt',l:'Vel→Filt',min:0,max:1,fmt:pct}]],
  ['Filter envelope', [
   {k:'fA',l:'Attack',min:0.001,max:5,exp:3,fmt:ms,live:true},
   {k:'fD',l:'Decay',min:0.01,max:6,exp:3,fmt:ms,live:true},
   {k:'fS',l:'Sustain',min:0,max:1,fmt:pct,live:true},
   {k:'fR',l:'Release',min:0.01,max:8,exp:3,fmt:ms}], 'meter'],
  ['Amp envelope', [
   {k:'aA',l:'Attack',min:0.001,max:5,exp:3,fmt:ms,live:true},
   {k:'aD',l:'Decay',min:0.01,max:8,exp:3,fmt:ms,live:true},
   {k:'aS',l:'Sustain',min:0,max:1,fmt:pct,live:true},
   {k:'aR',l:'Release',min:0.01,max:8,exp:3,fmt:ms},
   {k:'velSens',l:'Velocity',min:0,max:1,fmt:pct}]],
  ['LFO & mod', [
   {k:'lfoRate',l:'Rate',min:0.05,max:12,exp:2,fmt:v=>v.toFixed(2)+' Hz',live:true},
   {k:'lfoVib',l:'Vibrato',min:0,max:60,exp:2,fmt:v=>Math.round(v)+'¢',live:true},
   {k:'modVib',l:'Wheel vib',min:0,max:100,fmt:v=>Math.round(v)+'¢',live:true},
   {k:'lfoFilt',l:'LFO→Filt',min:0,max:2400,exp:2,fmt:v=>Math.round(v)+'¢',live:true}]],
 ],
 exprDefs:[
  {k:'pressFilt',l:'Press→Filt',min:0,max:4800,exp:1.5,fmt:v=>(v/1200).toFixed(1)+' oct'},
  {k:'timbreFilt',l:'Slide→Filt',min:0,max:4800,exp:1.5,fmt:v=>(v/1200).toFixed(1)+' oct'}],
 setup(s){
  const x = {in: gn(1)};
  x.cut = cs(0); x.cut.start(); x.lfoF = gn(0); s.n.lfo.connect(x.lfoF);
  x.filtMod = gn(1); x.cut.connect(x.filtMod); x.lfoF.connect(x.filtMod);
  x.in.connect(s.n.fxIn);
  x.nodes = [x.cut, x.lfoF, x.filtMod];
  return x;
 },
 live(s, k){
  const P = s.P, x = s.inst, t = ctx.currentTime;
  x.cut.offset.setTargetAtTime(1200*Math.log2(P.cutoff/1000), t, 0.02);
  x.lfoF.gain.setTargetAtTime(P.lfoFilt, t, 0.02);
  for(const v of s.voices) if(!v.dead){ v.h.f1.Q.setTargetAtTime(P.res,t,0.02); v.h.f2.Q.setTargetAtTime(Math.min(P.res*0.35,2),t,0.02); }
  if(['fA','fD','fS','aA','aD','aS','fEnv'].includes(k)) this.liveEnv(s);
 },
 liveEnv(s){
  const P = s.P, now = ctx.currentTime;
  for(const v of s.voices){
   if(v.rel || v.dead) continue; const h = v.h, g = h.amp.gain; hold(g,now);
   if(now < v.t0+P.aA){ g.linearRampToValueAtTime(h.pk, v.t0+P.aA); g.setTargetAtTime(h.pk*P.aS, v.t0+P.aA, P.aD/3); }
   else g.setTargetAtTime(h.pk*P.aS, now, P.aD/3);
   const envOct = P.fEnv*(1-P.velFilt+P.velFilt*v.vel/127);
   const pk2 = clamp(h.fBase*Math.pow(2,envOct),10,22000), sus = clamp(h.fBase*Math.pow(2,envOct*P.fS),10,22000);
   for(const fl of [h.f1,h.f2]){ const p = fl.frequency; hold(p,now);
    if(now < v.t0+P.fA){ p.exponentialRampToValueAtTime(pk2, v.t0+P.fA); p.setTargetAtTime(sus, v.t0+P.fA, P.fD/3); }
    else p.setTargetAtTime(sus, now, P.fD/3); }
  }
 },
 voice(s, o){
  const P = o.P, t = o.t, f = o.f, x = s.inst, h = {srcs:[], tune:[]};
  const mix = gn(0.5), f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter();
  f1.type = f2.type = 'lowpass'; f1.Q.value = P.res; f2.Q.value = Math.min(P.res*0.35,2);
  const vfilt = gn(1); x.filtMod.connect(vfilt); vfilt.connect(f1.detune); vfilt.connect(f2.detune);
  const pf = gn(P.pressFilt); o.press.connect(pf); pf.connect(vfilt);
  const tf = gn(P.timbreFilt); o.timbre.connect(tf); tf.connect(vfilt);
  const amp = gn(0);
  mix.connect(f1); f1.connect(f2); f2.connect(amp); amp.connect(o.out);
  const osc = (type, fq, det) => { const n = ctx.createOscillator(); setWave(n,type);
   if(o.glideFrom){ n.frequency.setValueAtTime(fq*o.ratio, t); n.frequency.exponentialRampToValueAtTime(fq, t+P.glide); } else n.frequency.value = fq;
   n.detune.value = det; o.pitch.connect(n.detune); h.srcs.push(n); h.tune.push([n.frequency, fq/f]); return n; };
  const f1q = f*Math.pow(2,P.o1Oct), n1 = P.o1Uni|0, o1 = [];
  for(let i=0;i<n1;i++){
   const off = n1>1 ? (i/(n1-1)-0.5)*2*P.o1Spread : 0, n = osc(P.o1Wave, f1q, off), g = gn(P.o1Level/Math.sqrt(n1));
   if(n1>1){ const pn = ctx.createStereoPanner(); pn.pan.value = (i/(n1-1)-0.5)*1.6*P.width; n.connect(g); g.connect(pn); pn.connect(mix); } else { n.connect(g); g.connect(mix); }
   o1.push(n);
  }
  if(P.fmAmt > 0){
   const m = osc('sine', f1q*P.fmRatio, 0), mg = ctx.createGain(), dev = P.fmAmt*f1q*P.fmRatio*(0.4+0.6*o.vel/127);
   mg.gain.setValueAtTime(dev,t); mg.gain.setTargetAtTime(dev*0.06,t,P.fmDecay/3); m.connect(mg); for(const n of o1) mg.connect(n.frequency);
  }
  if(P.o2Level > 0){
   const fq = f*Math.pow(2,P.o2Oct+P.o2Semi/12), n2 = P.o2Uni|0;
   for(let i=0;i<n2;i++){
    const off = n2>1 ? (i/(n2-1)-0.5)*2*P.o1Spread*0.8 : 0, n = osc(P.o2Wave, fq, P.o2Detune+off), g = gn(P.o2Level/Math.sqrt(n2));
    if(n2>1){ const pn = ctx.createStereoPanner(); pn.pan.value = -(i/(n2-1)-0.5)*1.6*P.width; n.connect(g); g.connect(pn); pn.connect(mix); } else { n.connect(g); g.connect(mix); }
   }
  }
  if(P.subLevel > 0){ const n = osc('sine', f1q/2, 0), g = gn(P.subLevel*0.9); n.connect(g); g.connect(mix); }
  if(P.noise > 0){ const n = ctx.createBufferSource(); n.buffer = noiseBuf(); n.loop = true; const g = gn(P.noise*0.35); n.connect(g); g.connect(mix); h.srcs.push(n); }
  const base = 1000*Math.pow(2,P.keyTrack*(o.note-60)/12), envOct = P.fEnv*(1-P.velFilt+P.velFilt*o.vel/127);
  const peak = clamp(base*Math.pow(2,envOct),10,22000), sus = clamp(base*Math.pow(2,envOct*P.fS),10,22000);
  for(const fl of [f1,f2]){ fl.frequency.setValueAtTime(base,t); fl.frequency.exponentialRampToValueAtTime(peak,t+P.fA); fl.frequency.setTargetAtTime(sus,t+P.fA,P.fD/3); }
  const pk = 0.2*o.velG; adsr(amp.gain, t, pk, P.aA, P.aD, P.aS);
  const rnd = n1>1 || (P.o2Uni|0)>1;
  for(const n of h.srcs) n.start(rnd ? t+Math.random()*0.004 : t);
  Object.assign(h, {f1, f2, amp, pk, fBase:base, vfilt,
   release(tr){ for(const fl of [f1,f2]) relEnv(fl.frequency, tr, P.fR, base); return relEnv(amp.gain, tr, s.P.aR); },
   cleanup(){ try{ x.filtMod.disconnect(vfilt); }catch(_){} },
   meter(){ return f1.frequency.value*s.P.cutoff/1000; }});
  return h;
 }
});

/* ================= Ion FM — 4-operator FM synth (DX7-style) ================= */
const FM_ALGS = {
 '1':{name:'Stack 4→3→2→1', mods:[[4,3],[3,2],[2,1]], car:[1]},
 '2':{name:'Two pairs', mods:[[2,1],[4,3]], car:[1,3]},
 '3':{name:'Three into one', mods:[[2,1],[3,1],[4,1]], car:[1]},
 '4':{name:'Branch', mods:[[4,3],[3,1],[2,1]], car:[1]},
 '5':{name:'One into three', mods:[[4,1],[4,2],[4,3]], car:[1,2,3]},
 '6':{name:'Stack + carrier', mods:[[3,2],[2,1]], car:[1,4]},
 '7':{name:'Pair + two carriers', mods:[[2,1]], car:[1,3,4]},
 '8':{name:'Additive (organ)', mods:[], car:[1,2,3,4]}};
const FB_CACHE = {};
function fbWave(fb){
 const q = Math.round(fb*20); if(FB_CACHE[q]) return FB_CACHE[q];
 const beta = q/20*1.6, N = 256, cyc = 6, y = new Float32Array(N*cyc); let p1 = 0, p2 = 0;
 for(let i=0;i<N*cyc;i++){ const ph = 2*Math.PI*(i%N)/N; const v = Math.sin(ph + beta*(p1+p2)/2); y[i] = v; p2 = p1; p1 = v; }
 const H = 48, re = new Float32Array(H), im = new Float32Array(H), off = N*(cyc-1);
 for(let k=1;k<H;k++){ let a=0,b=0; for(let i=0;i<N;i++){ const ph = 2*Math.PI*k*i/N; a += y[off+i]*Math.cos(ph); b += y[off+i]*Math.sin(ph); } re[k] = a*2/N; im[k] = b*2/N; }
 return FB_CACHE[q] = ctx.createPeriodicWave(re, im, {disableNormalization:true});
}
const fmOpDefs = i => [
 {k:'rat'+i,l:'Ratio',min:0.5,max:16,step:0.25,exp:1.6,fmt:v=>v.toFixed(2)},
 {k:'det'+i,l:'Detune',min:-30,max:30,fmt:v=>Math.round(v)+'¢'},
 {k:'lvl'+i,l:'Level',min:0,max:1,fmt:pct},
 {k:'atk'+i,l:'Attack',min:0.001,max:4,exp:3,fmt:ms},
 {k:'dec'+i,l:'Decay',min:0.01,max:8,exp:3,fmt:ms},
 {k:'sus'+i,l:'Sustain',min:0,max:1,fmt:pct},
 {k:'rel'+i,l:'Release',min:0.01,max:8,exp:3,fmt:ms}];
const fmBase = {alg:'1',fb:0,velMod:0.6,keyScale:0.3,tone:12000,pressMod:0.4,velSens:0.7,lfoVib:0,chorus:0.2,dMix:0.08,rMix:0.22,rSize:2.5,drive:0.05};
for(let i=1;i<=4;i++) Object.assign(fmBase, {['rat'+i]:1,['det'+i]:0,['lvl'+i]:i===1?0.9:0.4,['atk'+i]:0.002,['dec'+i]:1,['sus'+i]:i===1?0.7:0.3,['rel'+i]:0.4});
function FMP(cat, name, alg, ops, extra = {}){
 const p = {alg:String(alg)};
 ops.forEach((o,i)=>{ const n = i+1, [r,l,a,d,s,rl,dt=0] = o; Object.assign(p, {['rat'+n]:r,['lvl'+n]:l,['atk'+n]:a,['dec'+n]:d,['sus'+n]:s,['rel'+n]:rl,['det'+n]:dt}); });
 return [cat, name, Object.assign(p, extra)];
}
const FM_PRESETS = [
 FMP('Keys','DX Electric Piano',2,[[1,0.9,0.002,3.2,0,0.45],[14,0.22,0.001,0.4,0,0.3],[1,0.75,0.002,4,0,0.5,4],[1,0.42,0.001,1.4,0.08,0.4]],{velMod:0.85,tone:9000,chorus:0.55}),
 FMP('Keys','Rhodes Bark',2,[[1,0.9,0.002,3.5,0,0.4],[1,0.55,0.001,0.9,0.05,0.3],[1,0.6,0.002,4,0,0.45,-3],[14,0.18,0.001,0.25,0,0.2]],{velMod:1,tone:7000,chorus:0.45,drive:0.25}),
 FMP('Keys','Crystal Piano',2,[[1,0.9,0.002,2.5,0,0.4],[3,0.3,0.001,0.8,0,0.3],[2,0.5,0.002,2,0,0.4],[7,0.18,0.001,0.4,0,0.2]],{velMod:0.7,tone:11000,rMix:0.3}),
 FMP('Keys','FM Clav',4,[[1,0.85,0.001,1.2,0.15,0.08],[3,0.55,0.001,0.4,0.1,0.06],[1,0.35,0.001,0.3,0,0.05],[5,0.4,0.001,0.25,0,0.05]],{velMod:0.9,tone:8000,chorus:0.1,fb:0.3}),
 FMP('Keys','Vibraphone FM',2,[[1,0.9,0.002,4,0,0.6],[4,0.28,0.001,0.5,0,0.3],[1,0.5,0.002,3,0,0.5,2],[10,0.12,0.001,0.2,0,0.2]],{velMod:0.6,lfoRate:5.5,lfoVib:3,rMix:0.3}),
 FMP('Keys','Harpsichord FM',1,[[1,0.85,0.001,1.8,0,0.15],[3,0.45,0.001,1.2,0.1,0.1],[5,0.3,0.001,0.6,0,0.1],[1,0.25,0.001,0.4,0,0.1]],{fb:0.45,velMod:0.3,tone:10000,rMix:0.25}),
 FMP('Bells','Tubular Bells',2,[[1,0.9,0.002,7,0,4],[3.5,0.5,0.002,5,0,3],[2,0.55,0.002,6,0,3.5],[5,0.3,0.002,3,0,2.5]],{velMod:0.5,rSize:7,rMix:0.5}),
 FMP('Bells','Glass Bell',2,[[1,0.9,0.002,4,0,2.5],[7,0.4,0.002,2.5,0,2],[1,0.5,0.002,5,0,3,7],[11,0.2,0.002,1.5,0,1.5]],{velMod:0.6,rSize:6,rMix:0.5,dMix:0.2}),
 FMP('Bells','Church Bell',3,[[1,0.9,0.002,8,0,5],[1.41,0.6,0.002,6,0,4],[2.82,0.35,0.002,4,0,3],[5.4,0.2,0.002,2,0,2]],{velMod:0.4,rSize:10,rMix:0.6}),
 FMP('Bells','Kalimba FM',2,[[1,0.9,0.001,1.2,0,0.4],[5.5,0.3,0.001,0.15,0,0.1],[1,0.4,0.001,0.8,0,0.3,3],[3,0.15,0.001,0.1,0,0.1]],{velMod:0.8,rMix:0.3}),
 FMP('Bells','Marimba FM',2,[[1,0.9,0.001,0.9,0,0.3],[4,0.32,0.001,0.08,0,0.05],[1,0.4,0.001,0.6,0,0.3],[10,0.1,0.001,0.04,0,0.03]],{velMod:0.9,rMix:0.25}),
 FMP('Bells','Steel Drum FM',3,[[1,0.9,0.001,1.4,0,0.4],[2.4,0.35,0.001,0.5,0,0.2],[1.5,0.2,0.001,0.3,0,0.2],[4,0.1,0.001,0.15,0,0.1]],{velMod:0.6,rMix:0.3}),
 FMP('Bass','Lately Bass',1,[[1,0.9,0.002,1.5,0.35,0.15],[1,0.55,0.001,0.5,0.15,0.12],[1,0.35,0.001,0.35,0.05,0.1],[1,0.3,0.001,0.25,0,0.1]],{fb:0.55,velMod:0.8,tone:6000,chorus:0,rMix:0.05,playMode:'mono',glide:0.02,glideMode:'overlap'}),
 FMP('Bass','Solid FM Bass',2,[[0.5,0.95,0.002,2,0.5,0.15],[0.5,0.45,0.001,0.6,0.2,0.1],[1,0.4,0.002,1.2,0.3,0.12],[2,0.25,0.001,0.3,0,0.1]],{velMod:0.7,tone:5000,chorus:0,rMix:0.04}),
 FMP('Bass','Slap Bass FM',3,[[1,0.9,0.001,0.9,0.2,0.1],[1,0.5,0.001,0.15,0.05,0.08],[3,0.3,0.001,0.06,0,0.05],[7,0.15,0.001,0.03,0,0.03]],{velMod:1,tone:7000,chorus:0,rMix:0.04}),
 FMP('Bass','Rubber FM Bass',1,[[0.5,0.95,0.002,1.2,0.5,0.12],[0.5,0.6,0.001,0.25,0.1,0.1],[1,0.2,0.001,0.2,0,0.1],[1,0.2,0.001,0.2,0,0.1]],{fb:0.2,velMod:0.9,tone:3500,chorus:0,rMix:0.04,playMode:'legato',glide:0.06,glideMode:'overlap'}),
 FMP('Brass & Leads','DX Brass',3,[[1,0.9,0.03,1,0.85,0.25],[1,0.55,0.08,0.8,0.5,0.25],[1,0.4,0.1,0.6,0.4,0.25,7],[2,0.2,0.1,0.5,0.3,0.2]],{velMod:0.6,tone:6000,chorus:0.4,rMix:0.3,lfoRate:5,modVib:30}),
 FMP('Brass & Leads','Synth Brass FM',4,[[1,0.9,0.04,1.2,0.8,0.3],[1,0.6,0.12,1,0.55,0.3],[1,0.5,0.15,1,0.5,0.3,-7],[1,0.4,0.15,1,0.5,0.3,5]],{fb:0.3,velMod:0.5,tone:5000,chorus:0.6,rMix:0.3}),
 FMP('Brass & Leads','FM Flute',1,[[1,0.9,0.06,1,0.9,0.2],[1,0.15,0.08,1,0.6,0.2],[2,0.08,0.1,1,0.5,0.2],[1,0.1,0.05,1,0.3,0.2]],{fb:0.6,velMod:0.3,lfoRate:5,lfoVib:6,tone:7000,rMix:0.3,playMode:'legato',glide:0.04,glideMode:'overlap'}),
 FMP('Brass & Leads','Sync Lead FM',1,[[1,0.9,0.005,1,0.85,0.25],[1,0.6,0.005,1,0.7,0.2],[2,0.4,0.005,1,0.6,0.2],[1,0.5,0.005,1,0.7,0.2]],{fb:0.9,velMod:0.3,tone:7000,drive:0.4,dMix:0.25,rMix:0.25,playMode:'legato',glide:0.05,glideMode:'overlap',modVib:45}),
 FMP('Brass & Leads','Harmonica FM',3,[[1,0.9,0.04,1,0.85,0.15],[1,0.45,0.05,1,0.6,0.15],[3,0.25,0.05,1,0.5,0.15],[5,0.1,0.05,1,0.4,0.15]],{velMod:0.5,lfoRate:6,lfoVib:8,tone:6000,rMix:0.2}),
 FMP('Organs & Pads','FM Organ',8,[[1,0.8,0.005,0.1,1,0.08],[2,0.55,0.005,0.1,1,0.08],[3,0.35,0.005,0.1,1,0.08],[0.5,0.6,0.005,0.1,1,0.08]],{velSens:0,velMod:0,chorus:0.6,rMix:0.25}),
 FMP('Organs & Pads','Glass Pad',5,[[1,0.8,0.8,2,0.8,2],[2,0.5,1,2,0.7,2,6],[1,0.6,0.9,2,0.8,2,-6],[3,0.25,1.5,3,0.4,2]],{velMod:0.2,chorus:0.8,dMix:0.25,rSize:7,rMix:0.6}),
 FMP('Organs & Pads','FM Strings',3,[[1,0.9,0.5,1,0.9,1.2],[1,0.3,0.6,1,0.8,1.2,7],[2,0.2,0.6,1,0.7,1.2,-7],[3,0.1,0.6,1,0.6,1.2]],{velMod:0.3,lfoRate:5,lfoVib:5,chorus:0.9,rMix:0.45,rSize:5}),
 FMP('Organs & Pads','Choir FM',3,[[1,0.9,0.4,1,0.9,1],[2,0.2,0.4,1,0.8,1],[3,0.15,0.4,1,0.8,1],[5,0.08,0.4,1,0.7,1]],{velMod:0.2,lfoRate:5,lfoVib:6,chorus:1,rMix:0.5,rSize:6,tone:5000}),
 FMP('Organs & Pads','Metallic Pad',4,[[1,0.8,1,3,0.6,2.5],[1.41,0.45,1.5,3,0.5,2.5],[1,0.6,1,3,0.6,2.5,9],[3.5,0.3,2,4,0.4,2.5]],{velMod:0.2,chorus:0.7,dMix:0.3,dFb:0.5,rSize:9,rMix:0.6}),
 FMP('Plucks','Koto FM',1,[[1,0.9,0.001,1.6,0,0.3],[3,0.5,0.001,0.5,0,0.2],[1,0.3,0.001,0.3,0,0.2],[2,0.25,0.001,0.2,0,0.1]],{fb:0.4,velMod:0.8,rMix:0.3}),
 FMP('Plucks','Sitar FM',1,[[1,0.9,0.001,2.5,0.1,0.4],[1,0.5,0.001,1.5,0.2,0.3],[3,0.35,0.001,1,0.1,0.3],[1,0.6,0.001,2,0.2,0.3]],{fb:1,velMod:0.5,rMix:0.3,tone:9000}),
 FMP('Plucks','Harp FM',2,[[1,0.9,0.001,3,0,1.2],[2,0.25,0.001,0.4,0,0.3],[1,0.5,0.001,2.5,0,1,3],[4,0.12,0.001,0.2,0,0.2]],{velMod:0.6,rSize:5,rMix:0.45}),
 FMP('Plucks','Space Pluck',6,[[1,0.9,0.001,1.5,0,1],[3,0.4,0.001,0.6,0,0.5],[7,0.25,0.001,0.3,0,0.3],[0.5,0.4,0.001,2,0,1]],{velMod:0.6,dTime:0.375,dFb:0.55,dMix:0.35,rSize:6,rMix:0.5}),
 FMP('Init','Init FM',1,[[1,0.9,0.002,1,0.7,0.4],[1,0.4,0.002,1,0.3,0.4],[1,0,0.002,1,0.3,0.4],[1,0,0.002,1,0.3,0.4]],{}),
];
defineInstrument({
 id:'fm', name:'Ion FM', brand:'ION<span>·</span>FM', tag:'4-operator digital FM synthesizer', theme:'fm',
 cats:['Keys','Bells','Bass','Brass & Leads','Organs & Pads','Plucks','Init'], presets: FM_PRESETS, base: fmBase,
 cc74:['tone', x => 300*Math.pow(60, x)], cc71:['fb', x => x],
 sections:[
  ['Algorithm', [
   {k:'alg',type:'sel',opts:Object.entries(FM_ALGS).map(([k,a])=>[k, k+' · '+a.name]),aria:'Algorithm'},
   {k:'fb',l:'Feedback',min:0,max:1,fmt:pct},
   {k:'velMod',l:'Vel→Bright',min:0,max:1,fmt:pct},
   {k:'keyScale',l:'Key scale',min:0,max:1,fmt:pct},
   {k:'tone',l:'Tone',min:300,max:18000,log:true,fmt:hz,live:true},
   {k:'velSens',l:'Velocity',min:0,max:1,fmt:pct}]],
  ['Operator 1', fmOpDefs(1)], ['Operator 2', fmOpDefs(2)], ['Operator 3', fmOpDefs(3)], ['Operator 4', fmOpDefs(4)],
  ['LFO', [
   {k:'lfoRate',l:'Rate',min:0.05,max:12,exp:2,fmt:v=>v.toFixed(2)+' Hz',live:true},
   {k:'lfoVib',l:'Vibrato',min:0,max:60,exp:2,fmt:v=>Math.round(v)+'¢',live:true},
   {k:'modVib',l:'Wheel vib',min:0,max:100,fmt:v=>Math.round(v)+'¢',live:true}]],
 ],
 exprDefs:[{k:'pressMod',l:'Press→Bright',min:0,max:1,fmt:pct}],
 setup(s){
  const x = {in: gn(1)}; x.tone = ctx.createBiquadFilter(); x.tone.type = 'lowpass'; x.tone.Q.value = 0.5;
  x.in.connect(x.tone); x.tone.connect(s.n.fxIn); x.nodes = [x.tone]; return x;
 },
 live(s){ s.inst.tone.frequency.setTargetAtTime(s.P.tone, ctx.currentTime, 0.02); },
 voice(s, o){
  const P = o.P, t = o.t, f = o.f, A = FM_ALGS[P.alg] || FM_ALGS['1'], h = {srcs:[], tune:[], envs:[]};
  const hi = Math.max(0, o.note-60), ks = Math.pow(2, -P.keyScale*hi/24), velM = 1 - P.velMod + P.velMod*o.vel/127;
  const ops = [], out = gn(1); out.connect(o.out);
  for(let i=1;i<=4;i++){
   const n = ctx.createOscillator(), fq = f*P['rat'+i];
   if(i===4 && P.fb > 0.02) n.setPeriodicWave(fbWave(P.fb)); else n.type = 'sine';
   if(o.glideFrom){ n.frequency.setValueAtTime(fq*o.ratio, t); n.frequency.exponentialRampToValueAtTime(fq, t+P.glide); } else n.frequency.value = fq;
   n.detune.value = P['det'+i]; o.pitch.connect(n.detune);
   const g = ctx.createGain(); g.gain.value = 0; n.connect(g);
   ops[i] = {n, g, fq}; h.srcs.push(n); h.tune.push([n.frequency, P['rat'+i]]);
  }
  const isCar = i => A.car.includes(i);
  for(let i=1;i<=4;i++){
   const op = ops[i], L = P['lvl'+i], D = P['dec'+i]*(isCar(i)?ks:Math.sqrt(ks));
   let peak;
   if(isCar(i)) peak = L*0.13/Math.sqrt(A.car.length)*o.velG;
   else peak = Math.pow(L,1.5)*9*op.fq*velM*Math.pow(ks,0.6);
   adsr(op.g.gain, t, peak, P['atk'+i], D, P['sus'+i]);
   h.envs.push([op.g.gain, P['rel'+i]]);
   if(!isCar(i) && P.pressMod > 0){ const pg = gn(op.fq*4*P.pressMod*Math.max(0.15,L)); o.press.connect(pg); pg.connect(op.g.gain); const tg = gn(op.fq*2*P.pressMod*Math.max(0.15,L)); o.timbre.connect(tg); tg.connect(op.g.gain); }
  }
  for(const [m,c] of A.mods) ops[m].g.connect(ops[c].n.frequency);
  for(const c of A.car) ops[c].g.connect(out);
  for(const n of h.srcs) n.start(t);
  h.release = tr => { let end = tr; for(const [p,R] of h.envs) end = Math.max(end, relEnv(p, tr, R)); return end; };
  return h;
 },
 screen(cx, w, h, s){
  const P = s.P, A = FM_ALGS[P.alg] || FM_ALGS['1'];
  cx.fillStyle = '#0b2b2c'; cx.fillRect(0,0,w,h);
  cx.fillStyle = '#7ff0dd'; cx.font = '600 '+Math.max(16,Math.min(26,h/6))+'px '+F_LCD+'';
  cx.fillText('ALG '+P.alg+'  '+A.name.toUpperCase(), 12, Math.max(22,h/5));
  // operator diagram: carriers bottom row, modulators stacked above their targets
  const depth = {}; const d = i => depth[i] ?? (depth[i] = A.car.includes(i) ? 0 : 1 + Math.max(...A.mods.filter(m=>m[0]===i).map(m=>d(m[1]))));
  for(let i=1;i<=4;i++) d(i);
  const maxD = Math.max(...Object.values(depth)), cols = {}, pos = {};
  const bw = Math.min(46, w/9), bh = Math.min(26, h/6), top = h*0.32, rowH = Math.min(36,(h-top-10)/(maxD+1));
  for(let i=1;i<=4;i++){ const r = depth[i]; cols[r] = (cols[r]||0)+1; }
  const seen = {};
  for(let i=1;i<=4;i++){ const r = depth[i], k = seen[r] = (seen[r]||0)+1, n = cols[r];
   pos[i] = [w*0.55 + (k-(n+1)/2)*(bw+14), top + (maxD-r)*rowH]; }
  cx.strokeStyle = '#7ff0dd'; cx.lineWidth = 1.5;
  for(const [m,c] of A.mods){ cx.beginPath(); cx.moveTo(pos[m][0], pos[m][1]+bh/2); cx.lineTo(pos[c][0], pos[c][1]-bh/2); cx.stroke(); }
  for(let i=1;i<=4;i++){ const [x,y] = pos[i];
   cx.fillStyle = A.car.includes(i) ? '#7ff0dd' : '#0b2b2c'; cx.fillRect(x-bw/2, y-bh/2, bw, bh); cx.strokeRect(x-bw/2, y-bh/2, bw, bh);
   cx.fillStyle = A.car.includes(i) ? '#0b2b2c' : '#7ff0dd'; cx.font = '600 '+Math.round(bh*0.8)+'px '+F_LCD+''; cx.textAlign = 'center'; cx.fillText(i, x, y+bh*0.3); cx.textAlign = 'left';
   if(i===4 && P.fb>0.02){ cx.beginPath(); cx.arc(x+bw/2+6, y, 7, -Math.PI/2, Math.PI/2); cx.stroke(); } }
  cx.fillStyle = '#4fb3a6'; cx.font = '500 '+Math.max(14,Math.min(20,h/8))+'px '+F_LCD+'';
  cx.fillText('CARRIERS = FILLED', 12, h-10);
  return {scope:[w*0.04, h*0.36, w*0.36, h*0.5], color:'#7ff0dd'};
 }
});

/* ================= Prism WT — morphing wavetable synth ================= */
const WT_F = 32, WT_N = 1024, WT_M = 9;      // frames per table, samples per frame, band-limited mip levels
const WORKLET_SRC = `
const T = globalThis.__WT || (globalThis.__WT = {});
class L extends AudioWorkletProcessor{ constructor(){ super(); this.port.onmessage = e => { const d = e.data; T[d.id] = d; this.port.postMessage({loaded:d.id}); }; } process(){ return true; } }
registerProcessor('wt-loader', L);
class O extends AudioWorkletProcessor{
 static get parameterDescriptors(){ return [{name:'frequency',defaultValue:440,minValue:0,maxValue:22000,automationRate:'a-rate'},{name:'detune',defaultValue:0,automationRate:'a-rate'},{name:'position',defaultValue:0,automationRate:'a-rate'}]; }
 constructor(o){ super(); const p = o.processorOptions; this.id = p.id; const U = this.U = p.uni;
  this.ph = new Float64Array(U); this.mul = new Float64Array(U); this.gl = new Float32Array(U); this.gr = new Float32Array(U);
  for(let u=0;u<U;u++){ const r = U>1 ? (u/(U-1)-0.5)*2 : 0; this.ph[u] = U>1 ? Math.random() : 0; this.mul[u] = Math.pow(2, r*p.spread/1200);
   const pan = r*p.width, a = (pan+1)*Math.PI/4; this.gl[u] = Math.cos(a)/Math.sqrt(U); this.gr[u] = Math.sin(a)/Math.sqrt(U); }
  this.stopAt = Infinity; this.port.onmessage = e => { if(e.data.stopAt !== undefined) this.stopAt = e.data.stopAt; };
 }
 process(_, outs, par){
  if(currentTime >= this.stopAt) return false;
  const tb = T[this.id], o = outs[0], Lc = o[0], Rc = o[1] || o[0]; if(!tb) return true;
  const D = tb.data, F = tb.F, M = tb.M, N = tb.N, fr = par.frequency, dt = par.detune, ps = par.position, n = Lc.length, U = this.U;
  const k1 = fr.length === 1 && dt.length === 1; let fK = k1 ? fr[0]*Math.pow(2, dt[0]/1200) : 0;
  for(let i=0;i<n;i++){
   const f = k1 ? fK : (fr.length>1?fr[i]:fr[0])*Math.pow(2,(dt.length>1?dt[i]:dt[0])/1200);
   let pos = ps.length>1 ? ps[i] : ps[0]; pos = pos<0 ? 0 : pos>1 ? 1 : pos;
   const fp = pos*(F-1), f0 = Math.floor(fp), f1 = f0+1 < F ? f0+1 : F-1, fx = fp-f0;
   let l = 0, r = 0;
   for(let u=0;u<U;u++){
    const inc = f*this.mul[u]/sampleRate, allowed = 0.5/inc; let m = 0; while(m < M-1 && (512>>m) > allowed) m++;
    const p = this.ph[u]*N, i0 = p|0, i1 = (i0+1)&(N-1), px = p-i0, b0 = (f0*M+m)*N, b1 = (f1*M+m)*N;
    const a = D[b0+i0] + (D[b0+i1]-D[b0+i0])*px, b = D[b1+i0] + (D[b1+i1]-D[b1+i0])*px, s = a + (b-a)*fx;
    l += s*this.gl[u]; r += s*this.gr[u];
    let q = this.ph[u] + inc; if(q >= 1) q -= 1; this.ph[u] = q;
   }
   Lc[i] = l; if(Rc !== Lc) Rc[i] = r;
  }
  return true;
 }
}
registerProcessor('wt-osc', O);`;
// --- tiny FFT (radix-2, in place) ---
function fft(re, im, inv){
 const n = re.length;
 for(let i=1,j=0;i<n;i++){ let b = n>>1; for(; j & b; b >>= 1) j ^= b; j ^= b; if(i<j){ [re[i],re[j]] = [re[j],re[i]]; [im[i],im[j]] = [im[j],im[i]]; } }
 for(let len=2; len<=n; len<<=1){
  const ang = (inv?2:-2)*Math.PI/len, wr = Math.cos(ang), wi = Math.sin(ang);
  for(let i=0;i<n;i+=len){ let cr = 1, ci = 0;
   for(let j=0;j<len/2;j++){ const a = i+j, b = a+len/2, tr = re[b]*cr - im[b]*ci, ti = re[b]*ci + im[b]*cr;
    re[b] = re[a]-tr; im[b] = im[a]-ti; re[a] += tr; im[a] += ti; const ncr = cr*wr - ci*wi; ci = cr*wi + ci*wr; cr = ncr; } }
 }
}
const VOWELS = [[800,1150,2900],[400,1600,2700],[270,2300,3000],[450,800,2830],[325,700,2530]];
const WT_TABLES = {
 basic:{name:'Basic shapes', time:(p,x)=>{ const sh=[Math.sin(2*Math.PI*p), p<0.25?4*p:p<0.75?2-4*p:4*p-4, p<0.5?2*p:2*p-2, p<0.5?1:-1], s=x*3, i=Math.min(2,Math.floor(s)), f=s-i; return sh[i]*(1-f)+sh[i+1]*f; }},
 pwm:{name:'Pulse width', time:(p,x)=>p < 0.5-0.46*x ? 1 : -1},
 vocal:{name:'Vocal', spec:(k,x)=>{ const s=x*4, i=Math.min(3,Math.floor(s)), f=s-i, fq=k*130; let a=0; for(let j=0;j<3;j++){ const F=VOWELS[i][j]*(1-f)+VOWELS[i+1][j]*f, bw=[90,120,170][j]; a += [1,0.5,0.25][j]*Math.exp(-((fq-F)**2)/(2*bw*bw)); } return a/Math.sqrt(k)*0.9 + (k===1?0.2:0); }},
 sync:{name:'Hard sync', time:(p,x)=>Math.sin(2*Math.PI*p*(1+7*x))},
 growl:{name:'FM growl', time:(p,x)=>Math.sin(2*Math.PI*p + 6*x*Math.sin(4*Math.PI*p))},
 sweep:{name:'Harmonic sweep', spec:(k,x)=>{ const c = 1+38*x; return Math.exp(-((k-c)**2)/18) + (k===1?0.45:0); }},
 bells:{name:'Digital bells', spec:(k,x)=>{ const P=[1,3,5,9,13,17,23,29], j=P.indexOf(k); return j<0 ? 0 : (0.55+0.45*Math.cos(2*Math.PI*(x*1.5 + j*0.17)))/Math.sqrt(j+1); }},
 crush:{name:'Bit crush', time:(p,x)=>{ const L = Math.round(64*Math.pow(1-x,2))+2, s = p<0.5?2*p:2*p-2; return Math.round(s*L)/L; }},
 organ:{name:'Organ morph', spec:(k,x)=>{ const A={1:[1,0.6],2:[0.8,0.2],3:[0.6,0.9],4:[0.5,0.3],6:[0.15,0.7],8:[0.1,0.6],10:[0,0.4],12:[0,0.35],16:[0,0.3]}; const a=A[k]; return a ? a[0]*(1-x)+a[1]*x : 0; }},
};
const WT_DATA = {}; let WT_NODE = null, WT_OK = false; const WT_WAIT = {};
function buildTable(id){
 if(WT_DATA[id]) return WT_DATA[id];
 const def = WT_TABLES[id], data = new Float32Array(WT_F*WT_M*WT_N), S = 2048, spec = [];
 for(let fr=0; fr<WT_F; fr++){
  const x = fr/(WT_F-1), hr = new Float32Array(513), hi = new Float32Array(513);
  if(def.time){ const re = new Float32Array(S), im = new Float32Array(S); for(let i=0;i<S;i++) re[i] = def.time(i/S, x); fft(re, im, false); for(let k=1;k<=512;k++){ hr[k] = re[k]*2/S; hi[k] = im[k]*2/S; } }
  else for(let k=1;k<=512;k++){ hi[k] = -def.spec(k, x); }
  spec.push([hr,hi]);
  let norm = 0;
  for(let m=0;m<WT_M;m++){
   const cap = 512>>m, re = new Float32Array(WT_N), im = new Float32Array(WT_N);
   for(let k=1;k<=Math.min(cap,511);k++){ re[k] = hr[k]/2; im[k] = hi[k]/2; re[WT_N-k] = hr[k]/2; im[WT_N-k] = -hi[k]/2; }
   fft(re, im, true);
   const off = (fr*WT_M+m)*WT_N;
   if(m===0){ let pk = 0; for(let i=0;i<WT_N;i++) pk = Math.max(pk, Math.abs(re[i])); norm = pk > 1e-6 ? 0.9/pk : 1; }
   for(let i=0;i<WT_N;i++) data[off+i] = re[i]*norm;
  }
 }
 return WT_DATA[id] = {data, spec};
}
function ensureTable(id){
 if(!WT_TABLES[id]) id = 'basic';
 const t = buildTable(id);
 if(WT_OK && !WT_WAIT[id]){ WT_WAIT[id] = true; const copy = t.data.slice(); WT_NODE.port.postMessage({id, data:copy, F:WT_F, M:WT_M, N:WT_N}, [copy.buffer]); }
 return t;
}
const PW_CACHE = {};
function framePW(id, pos){   // fallback when AudioWorklet isn't available: static PeriodicWave of one frame
 const fr = Math.round(clamp(pos,0,1)*(WT_F-1)), key = id+':'+fr; if(PW_CACHE[key]) return PW_CACHE[key];
 const [hr,hi] = buildTable(id).spec[fr], re = new Float32Array(160), im = new Float32Array(160);
 for(let k=1;k<160;k++){ re[k] = hr[k]; im[k] = -hi[k]; }
 return PW_CACHE[key] = ctx.createPeriodicWave(re, im);
}
const TABLE_OPTS = Object.entries(WT_TABLES).map(([k,v])=>[k,v.name]);
const wtBase = {wtTable:'basic',wtPos:0.3,uni:3,spread:14,width:0.8,pEnv:0,pA:0.5,pD:1.5,pS:0.5,lfoPos:0,
 bTable:'basic',bLevel:0,bPos:0.5,bSemi:12,bDet:5,subLevel:0,noise:0,
 fType:'lp24',cutoff:4000,res:1.2,fEnv:1,keyTrack:0.5,velFilt:0.3,fA:0.005,fD:0.6,fS:0.5,fR:0.6,
 aA:0.005,aD:0.6,aS:0.85,aR:0.5,lfoRate:0.5,lfoFilt:0,pressPos:0.3,pressFilt:900,chorus:0.3,rMix:0.3,rSize:3.5};
const W = (cat, name, p) => [cat, name, p];
const WT_PRESETS = [
 W('Pads','Prism Pad',{wtTable:'basic',wtPos:0.45,uni:5,spread:18,width:1,pEnv:0.35,pA:2,pD:3,pS:0.6,lfoPos:0.12,lfoRate:0.2,cutoff:2400,fEnv:0.4,aA:0.8,aD:2,aS:0.9,aR:2.5,chorus:0.7,dMix:0.2,rSize:7,rMix:0.55}),
 W('Pads','Vowel Choir',{wtTable:'vocal',wtPos:0,uni:5,spread:12,width:1,pEnv:0.8,pA:3,pD:4,pS:0.6,lfoPos:0.1,lfoRate:0.15,cutoff:5000,fEnv:0,aA:0.7,aD:2,aS:0.95,aR:2.5,lfoVib:5,lfoRate:0.2,chorus:0.8,rSize:8,rMix:0.6}),
 W('Pads','Glass Swell',{wtTable:'bells',wtPos:0.2,uni:4,spread:10,pEnv:0.6,pA:2.5,pD:3,pS:0.7,cutoff:6000,fEnv:0,aA:1.5,aD:2,aS:0.9,aR:3,chorus:0.6,dMix:0.25,dFb:0.5,rSize:9,rMix:0.6}),
 W('Pads','Organ Bloom',{wtTable:'organ',wtPos:0,uni:3,spread:8,pEnv:1,pA:3,pD:3,pS:1,cutoff:6000,fEnv:0,aA:0.4,aD:1,aS:1,aR:1.5,chorus:0.8,rMix:0.45,rSize:5}),
 W('Pads','Sweep Cathedral',{wtTable:'sweep',wtPos:0.05,uni:6,spread:16,width:1,lfoPos:0.3,lfoRate:0.07,cutoff:5000,fEnv:0,aA:1.2,aD:2,aS:1,aR:4,chorus:0.8,dMix:0.3,dFb:0.55,rSize:11,rMix:0.7}),
 W('Pads','Dark Sync Pad',{wtTable:'sync',wtPos:0.25,uni:5,spread:20,width:1,lfoPos:0.15,lfoRate:0.12,cutoff:900,res:3,fEnv:0.8,fA:1.5,fD:3,aA:0.9,aD:2,aS:0.9,aR:3,drive:0.3,chorus:0.6,rSize:8,rMix:0.55}),
 W('Evolving','Shifting Sands',{wtTable:'growl',wtPos:0.1,uni:5,spread:22,width:1,lfoPos:0.4,lfoRate:0.06,cutoff:1600,res:4,lfoFilt:900,fEnv:0.3,aA:1.5,aD:3,aS:1,aR:5,chorus:0.7,dMix:0.3,dFb:0.6,rSize:11,rMix:0.7}),
 W('Evolving','Data Stream',{wtTable:'crush',wtPos:0.2,uni:3,spread:10,lfoPos:0.35,lfoRate:0.25,cutoff:3000,res:2,aA:0.6,aD:2,aS:0.9,aR:3,dTime:0.375,dFb:0.6,dMix:0.35,rSize:7,rMix:0.5}),
 W('Evolving','Spectral Tide',{wtTable:'sweep',wtPos:0,uni:4,spread:12,pEnv:1,pA:6,pD:6,pS:0.2,lfoPos:0.1,lfoRate:0.1,cutoff:8000,fEnv:0,aA:2,aD:3,aS:1,aR:5,chorus:0.6,rSize:12,rMix:0.75}),
 W('Evolving','Talking Machine',{wtTable:'vocal',wtPos:0,uni:2,spread:6,lfoPos:0.5,lfoRate:0.9,cutoff:6000,fEnv:0,aA:0.05,aS:1,aR:0.6,dMix:0.2,rMix:0.3}),
 W('Leads','Neon Lead',{wtTable:'basic',wtPos:0.66,uni:3,spread:9,pEnv:0.25,pA:0.01,pD:0.4,pS:0,cutoff:3500,res:3,fEnv:1.5,fD:0.5,aA:0.005,aS:0.95,aR:0.3,playMode:'legato',glide:0.05,glideMode:'overlap',modVib:45,drive:0.35,dMix:0.25,rMix:0.25}),
 W('Leads','Sync Scream',{wtTable:'sync',wtPos:0.2,uni:2,spread:8,pEnv:0.6,pA:0.005,pD:0.8,pS:0.3,cutoff:5000,res:2,fEnv:0.5,aA:0.005,aS:0.95,aR:0.3,playMode:'legato',glide:0.04,glideMode:'overlap',drive:0.6,dMix:0.25,rMix:0.25,modVib:50}),
 W('Leads','Vocal Lead',{wtTable:'vocal',wtPos:0.3,uni:2,spread:5,pEnv:0.4,pA:0.3,pD:0.8,pS:0.6,cutoff:6000,fEnv:0,aA:0.03,aS:1,aR:0.4,lfoRate:5.5,lfoVib:8,playMode:'legato',glide:0.08,glideMode:'overlap',dMix:0.2,rMix:0.35}),
 W('Leads','PWM Lead',{wtTable:'pwm',wtPos:0.2,uni:2,spread:7,lfoPos:0.25,lfoRate:4,cutoff:3000,res:2,fEnv:1,aA:0.005,aS:0.9,aR:0.25,modVib:40,dMix:0.2,rMix:0.2}),
 W('Leads','Bitcrush Lead',{wtTable:'crush',wtPos:0.6,uni:1,cutoff:9000,fEnv:0,aA:0.002,aS:0.9,aR:0.15,playMode:'mono',glide:0.03,glideMode:'overlap',dTime:0.25,dMix:0.2,rMix:0.15,chorus:0}),
 W('Bass','Growl Bass',{wtTable:'growl',wtPos:0.2,uni:3,spread:10,subLevel:0.5,pEnv:0.5,pA:0.005,pD:0.5,pS:0.3,cutoff:600,res:4,fEnv:2.5,fD:0.3,fS:0.2,aA:0.002,aS:0.9,aR:0.12,playMode:'mono',glide:0.03,glideMode:'overlap',drive:0.6,chorus:0,dMix:0,rMix:0.05}),
 W('Bass','Wobble WT',{wtTable:'growl',wtPos:0.3,uni:3,spread:12,subLevel:0.5,lfoPos:0.5,lfoRate:3,lfoFilt:1800,cutoff:500,res:6,fEnv:0.5,aA:0.002,aS:1,aR:0.1,playMode:'mono',drive:0.7,chorus:0,dMix:0,rMix:0.05}),
 W('Bass','Reese WT',{wtTable:'basic',wtPos:0.66,uni:5,spread:24,width:0.6,subLevel:0.6,cutoff:450,res:2,fEnv:0.4,lfoFilt:500,lfoRate:0.2,aA:0.005,aS:1,aR:0.2,playMode:'mono',glide:0.04,glideMode:'overlap',drive:0.5,chorus:0.1,dMix:0,rMix:0.05}),
 W('Bass','Pluck Bass WT',{wtTable:'sweep',wtPos:0.1,uni:1,subLevel:0.4,pEnv:0.6,pA:0.002,pD:0.25,pS:0,cutoff:1500,res:2,fEnv:2,fD:0.25,fS:0.1,aA:0.002,aD:0.6,aS:0.4,aR:0.15,chorus:0,dMix:0,rMix:0.05}),
 W('Bass','Digital Sub',{wtTable:'organ',wtPos:0,uni:1,subLevel:0.6,cutoff:1200,fEnv:0.5,aA:0.003,aS:1,aR:0.12,playMode:'mono',glide:0.03,glideMode:'overlap',chorus:0,dMix:0,rMix:0.03}),
 W('Keys & Plucks','Glass Keys',{wtTable:'bells',wtPos:0.5,uni:2,spread:6,pEnv:-0.4,pA:0.002,pD:1.5,pS:0,cutoff:8000,fEnv:0,aA:0.002,aD:2.5,aS:0,aR:0.6,chorus:0.5,rMix:0.35}),
 W('Keys & Plucks','Morph Pluck',{wtTable:'sweep',wtPos:0,uni:3,spread:10,pEnv:0.7,pA:0.002,pD:0.3,pS:0,cutoff:2500,res:3,fEnv:2,fD:0.3,fS:0,aA:0.002,aD:0.8,aS:0,aR:0.4,dTime:0.375,dFb:0.45,dMix:0.3,rMix:0.35}),
 W('Keys & Plucks','Formant Pluck',{wtTable:'vocal',wtPos:0.9,uni:2,spread:8,pEnv:-0.9,pA:0.002,pD:0.6,pS:0,cutoff:6000,fEnv:0,aA:0.002,aD:0.9,aS:0,aR:0.3,dTime:0.25,dMix:0.25,rMix:0.3}),
 W('Keys & Plucks','Digital Piano',{wtTable:'organ',wtPos:0.6,uni:2,spread:5,pEnv:-0.6,pA:0.002,pD:1,pS:0,cutoff:3000,fEnv:1.5,fD:1.5,fS:0.2,aA:0.002,aD:3,aS:0,aR:0.4,velFilt:0.7,chorus:0.5,rMix:0.3}),
 W('Keys & Plucks','Crush Arp',{wtTable:'crush',wtPos:0.4,uni:1,cutoff:5000,fEnv:1,fD:0.2,fS:0,aA:0.001,aD:0.3,aS:0,aR:0.15,arpMode:'up',arpRate:'1/16',arpOct:2,arpGate:0.5,dTime:0.1875,dFb:0.4,dMix:0.25,rMix:0.2}),
 W('FX','Laser Sweep',{wtTable:'sync',wtPos:0,uni:3,spread:20,pEnv:1,pA:1.5,pD:1,pS:1,cutoff:9000,fEnv:0,aA:0.02,aS:1,aR:1.5,dTime:0.33,dFb:0.6,dMix:0.4,rSize:8,rMix:0.55}),
 W('FX','Robot Voice',{wtTable:'vocal',wtPos:0.5,uni:1,lfoPos:0.5,lfoRate:7,noise:0.05,cutoff:5000,fEnv:0,aA:0.01,aS:1,aR:0.3,drive:0.4,rMix:0.2}),
 W('Init','Init WT',{}),
];
defineInstrument({
 id:'wt', name:'Prism WT', brand:'PRISM<span>/</span>WT', tag:'morphing wavetable synthesizer', theme:'wt',
 cats:['Pads','Evolving','Leads','Bass','Keys & Plucks','FX','Init'], presets: WT_PRESETS, base: wtBase,
 cc74:['wtPos', x => x], cc71:['res', x => 0.3+17.7*Math.pow(x,1.6)],
 async init(){
  try{
   if(!ctx.audioWorklet) throw 0;
   try{ await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET_SRC], {type:'application/javascript'}))); }
   catch(_){ await ctx.audioWorklet.addModule('data:application/javascript;charset=utf-8,' + encodeURIComponent(WORKLET_SRC)); }   // file:// pages can't load blob: modules
   WT_NODE = new AudioWorkletNode(ctx, 'wt-loader', {numberOfInputs:0, numberOfOutputs:1});
   WT_OK = true;
  }catch(e){ WT_OK = false; }
 },
 sections:[
  ['Wavetable A', [
   {k:'wtTable',type:'sel',opts:TABLE_OPTS,aria:'Wavetable A'},
   {k:'wtPos',l:'Position',min:0,max:1,fmt:pct,live:true},
   {k:'uni',l:'Unison',min:1,max:7,step:1,fmt:v=>v+'×'},
   {k:'spread',l:'Spread',min:0,max:40,fmt:v=>Math.round(v)+'¢'},
   {k:'width',l:'Width',min:0,max:1,fmt:pct},
   {k:'subLevel',l:'Sub',min:0,max:1,fmt:pct},
   {k:'noise',l:'Noise',min:0,max:1,fmt:pct}]],
  ['Wavetable B', [
   {k:'bTable',type:'sel',opts:TABLE_OPTS,aria:'Wavetable B'},
   {k:'bLevel',l:'Level',min:0,max:1,fmt:pct},
   {k:'bPos',l:'Position',min:0,max:1,fmt:pct,live:true},
   {k:'bSemi',l:'Semi',min:-24,max:24,step:1,fmt:sgn},
   {k:'bDet',l:'Detune',min:-50,max:50,fmt:v=>Math.round(v)+'¢'}]],
  ['Morph', [
   {k:'pEnv',l:'Env amt',min:-1,max:1,fmt:v=>sgn(Math.round(v*100))+'%'},
   {k:'pA',l:'Attack',min:0.002,max:8,exp:3,fmt:ms},
   {k:'pD',l:'Decay',min:0.01,max:8,exp:3,fmt:ms},
   {k:'pS',l:'Sustain',min:0,max:1,fmt:pct},
   {k:'lfoPos',l:'LFO→Pos',min:0,max:0.5,fmt:pct}]],
  ['Filter', [
   {k:'fType',type:'sel',opts:[['lp24','Low-pass 24'],['lp12','Low-pass 12'],['bp','Band-pass'],['hp','High-pass']],aria:'Filter type'},
   {k:'cutoff',l:'Cutoff',min:40,max:18000,log:true,fmt:hz,live:true},
   {k:'res',l:'Reso',min:0.3,max:18,exp:1.6,fmt:v=>v.toFixed(1),live:true},
   {k:'fEnv',l:'Env amt',min:-3,max:6,fmt:v=>sgn(v.toFixed(1))+' oct'},
   {k:'keyTrack',l:'Key trk',min:0,max:1,fmt:pct},
   {k:'velFilt',l:'Vel→Filt',min:0,max:1,fmt:pct}]],
  ['Filter envelope', [
   {k:'fA',l:'Attack',min:0.001,max:5,exp:3,fmt:ms},
   {k:'fD',l:'Decay',min:0.01,max:6,exp:3,fmt:ms},
   {k:'fS',l:'Sustain',min:0,max:1,fmt:pct},
   {k:'fR',l:'Release',min:0.01,max:8,exp:3,fmt:ms}], 'meter'],
  ['Amp envelope', [
   {k:'aA',l:'Attack',min:0.001,max:5,exp:3,fmt:ms},
   {k:'aD',l:'Decay',min:0.01,max:8,exp:3,fmt:ms},
   {k:'aS',l:'Sustain',min:0,max:1,fmt:pct},
   {k:'aR',l:'Release',min:0.01,max:8,exp:3,fmt:ms},
   {k:'velSens',l:'Velocity',min:0,max:1,fmt:pct}]],
  ['LFO', [
   {k:'lfoRate',l:'Rate',min:0.05,max:12,exp:2,fmt:v=>v.toFixed(2)+' Hz',live:true},
   {k:'lfoVib',l:'Vibrato',min:0,max:60,exp:2,fmt:v=>Math.round(v)+'¢',live:true},
   {k:'modVib',l:'Wheel vib',min:0,max:100,fmt:v=>Math.round(v)+'¢',live:true},
   {k:'lfoFilt',l:'LFO→Filt',min:0,max:2400,exp:2,fmt:v=>Math.round(v)+'¢',live:true}]],
 ],
 exprDefs:[{k:'pressPos',l:'Press→Morph',min:0,max:1,fmt:pct},{k:'pressFilt',l:'Press→Filt',min:0,max:4800,exp:1.5,fmt:v=>(v/1200).toFixed(1)+' oct'}],
 setup(s){
  const x = {in: gn(1)}; x.cut = cs(0); x.cut.start(); x.lfoF = gn(0); s.n.lfo.connect(x.lfoF);
  x.filtMod = gn(1); x.cut.connect(x.filtMod); x.lfoF.connect(x.filtMod);
  x.lfoP = gn(0); s.n.lfo.connect(x.lfoP);
  x.in.connect(s.n.fxIn); x.nodes = [x.cut, x.lfoF, x.filtMod, x.lfoP];
  return x;
 },
 live(s, k){
  const P = s.P, x = s.inst, t = ctx.currentTime;
  if(k===undefined || k==='wtTable') ensureTable(P.wtTable);
  if(k===undefined || k==='bTable') ensureTable(P.bTable);
  x.cut.offset.setTargetAtTime(1200*Math.log2(P.cutoff/1000), t, 0.02);
  x.lfoF.gain.setTargetAtTime(P.lfoFilt, t, 0.02);
  x.lfoP.gain.setTargetAtTime(P.lfoPos, t, 0.02);
  for(const v of s.voices) if(!v.dead){
   for(const fl of v.h.filters) fl.Q.setTargetAtTime(fl===v.h.filters[1] ? Math.min(P.res*0.35,2) : P.res, t, 0.02);
   if(v.h.posA) v.h.posA.setTargetAtTime(P.wtPos, t, 0.02);
   if(v.h.posB) v.h.posB.setTargetAtTime(P.bPos, t, 0.02);
  }
 },
 voice(s, o){
  const P = o.P, t = o.t, f = o.f, x = s.inst, h = {srcs:[], tune:[], filters:[]};
  const mix = gn(0.9);
  const posEnv = cs(0); h.srcs.push(posEnv);
  posEnv.offset.setValueAtTime(0,t); posEnv.offset.linearRampToValueAtTime(P.pEnv,t+P.pA); posEnv.offset.setTargetAtTime(P.pEnv*P.pS,t+P.pA,P.pD/3);
  const pp = gn(P.pressPos), pt = gn(P.pressPos*0.5); o.press.connect(pp); o.timbre.connect(pt);
  h.posParams = [];
  const freqStart = fq => (n)=>{ if(o.glideFrom){ n.setValueAtTime(fq*o.ratio,t); n.exponentialRampToValueAtTime(fq,t+P.glide); } else n.setValueAtTime(fq,t); };
  const mkWT = (table, pos, fq, det, uni, spread, width, level) => {
   let node, freqP, posP;
   if(WT_OK){
    ensureTable(table);
    node = new AudioWorkletNode(ctx, 'wt-osc', {numberOfInputs:0, numberOfOutputs:1, outputChannelCount:[2], processorOptions:{id: WT_TABLES[table] ? table : 'basic', uni, spread, width}});
    freqP = node.parameters.get('frequency'); posP = node.parameters.get('position'); posP.value = pos;
    o.pitch.connect(node.parameters.get('detune')); node.parameters.get('detune').value = det;
    posEnv.connect(posP); x.lfoP.connect(posP); pp.connect(posP); pt.connect(posP); h.posParams.push(posP);
    node.stop = when => node.port.postMessage({stopAt: when + 0.05});
   }else{
    node = ctx.createOscillator(); node.setPeriodicWave(framePW(table, pos)); freqP = node.frequency; node.detune.value = det; o.pitch.connect(node.detune); node.start(t);
   }
   freqStart(fq)(freqP);
   const g = gn(level); node.connect(g); g.connect(mix); h.srcs.push(node); h.tune.push([freqP, fq/f]);
   return posP;
  };
  h.posA = mkWT(P.wtTable, P.wtPos, f, 0, Math.max(1,P.uni|0), P.spread, P.width, 1);
  if(P.bLevel > 0) h.posB = mkWT(P.bTable, P.bPos, f*Math.pow(2,P.bSemi/12), P.bDet, 1, 0, 0, P.bLevel);
  if(P.subLevel > 0){ const n = ctx.createOscillator(); freqStart(f/2)(n.frequency); o.pitch.connect(n.detune); const g = gn(P.subLevel*0.8); n.connect(g); g.connect(mix); n.start(t); h.srcs.push(n); h.tune.push([n.frequency,0.5]); }
  if(P.noise > 0){ const n = ctx.createBufferSource(); n.buffer = noiseBuf(); n.loop = true; const g = gn(P.noise*0.35); n.connect(g); g.connect(mix); n.start(t); h.srcs.push(n); }
  // filter
  const types = {lp24:['lowpass','lowpass'], lp12:['lowpass'], bp:['bandpass'], hp:['highpass']}[P.fType] || ['lowpass','lowpass'];
  let prev = mix; const vfilt = gn(1); x.filtMod.connect(vfilt);
  const pf = gn(P.pressFilt); o.press.connect(pf); pf.connect(vfilt);
  for(let i=0;i<types.length;i++){ const fl = ctx.createBiquadFilter(); fl.type = types[i]; fl.Q.value = i ? Math.min(P.res*0.35,2) : P.res; vfilt.connect(fl.detune); prev.connect(fl); prev = fl; h.filters.push(fl); }
  const amp = gn(0); prev.connect(amp); amp.connect(o.out);
  const base = 1000*Math.pow(2,P.keyTrack*(o.note-60)/12), envOct = P.fEnv*(1-P.velFilt+P.velFilt*o.vel/127);
  const peak = clamp(base*Math.pow(2,envOct),10,22000), sus = clamp(base*Math.pow(2,envOct*P.fS),10,22000);
  for(const fl of h.filters){ fl.frequency.setValueAtTime(base,t); fl.frequency.exponentialRampToValueAtTime(peak,t+P.fA); fl.frequency.setTargetAtTime(sus,t+P.fA,P.fD/3); }
  adsr(amp.gain, t, 0.22*o.velG, P.aA, P.aD, P.aS);
  posEnv.start(t);
  Object.assign(h, {
   release(tr){ for(const fl of h.filters) relEnv(fl.frequency, tr, P.fR, base); return relEnv(amp.gain, tr, s.P.aR); },
   cleanup(){ try{ x.filtMod.disconnect(vfilt); }catch(_){}; for(const p of h.posParams){ try{ x.lfoP.disconnect(p); }catch(_){} } },
   meter(){ return h.filters[0].frequency.value*s.P.cutoff/1000; }});
  // remember morph timing for the display
  h.posInfo = {t0:t, A:P.pA, D:P.pD, S:P.pS, amt:P.pEnv};
  return h;
 },
 screen(cx, w, h, s){
  const P = s.P, tb = buildTable(WT_TABLES[P.wtTable] ? P.wtTable : 'basic');
  cx.fillStyle = '#0a0a1a'; cx.fillRect(0,0,w,h);
  // live position: base + morph envelope of the newest playing voice
  let pos = P.wtPos; const v = s.voices.filter(v=>!v.dead && !v.rel).pop();
  if(v && ctx){ const i = v.h.posInfo, dt = ctx.currentTime - i.t0; const e = dt < i.A ? dt/i.A : i.S + (1-i.S)*Math.exp(-(dt-i.A)/(i.D/3)); pos = clamp(pos + i.amt*e, 0, 1); }
  const rows = 16, ox = w*0.08, oy = h*0.82, dx = w*0.022, dy = -h*0.032, ww = w*0.62, amp = h*0.16;
  for(let r=rows-1;r>=0;r--){
   const fr = Math.round(r/(rows-1)*(WT_F-1)), on = Math.abs(r/(rows-1) - pos) < 0.5/(rows-1);
   const off = fr*WT_M*WT_N; cx.beginPath();
   for(let i=0;i<=96;i++){ const xx = ox + r*dx + i/96*ww, yy = oy + r*dy - tb.data[off + Math.floor(i/96*(WT_N-1))]*amp; i ? cx.lineTo(xx,yy) : cx.moveTo(xx,yy); }
   cx.strokeStyle = on ? '#ff4fd8' : 'rgba(80,220,255,'+(0.18+0.35*(1-r/rows))+')'; cx.lineWidth = on ? 2.5 : 1; cx.stroke();
  }
  cx.fillStyle = '#9fe9ff'; cx.font = '600 '+Math.max(13,Math.min(16,h/9))+'px '+F_WT+'';
  cx.fillText(WT_TABLES[P.wtTable]?.name.toUpperCase() + '  ·  POS ' + Math.round(pos*100) + '%' + (WT_OK ? '' : '  ·  STATIC MODE'), 12, 20);
  return {scope:[w*0.74, h*0.2, w*0.24, h*0.6], color:'#ff4fd8'};
 }
});

/* ================= Tonewheel B3 — drawbar organ with rotary speaker ================= */
const DB_HARM = [1,3,2,4,6,8,10,12,16];                    // harmonics of the 16' fundamental
const DB_FEET = ["16'","5⅓'","8'","4'","2⅔'","2'","1⅗'","1⅓'","1'"];
const DB_COLOR = ['brown','brown','white','white','black','white','black','black','white'];
const ORG_WAVES = {};
function organWave(P){
 const key = DB_HARM.map((_,i)=>P['db'+(i+1)]|0).join('');
 if(ORG_WAVES[key]) return ORG_WAVES[key];
 const re = new Float32Array(17), im = new Float32Array(17);
 DB_HARM.forEach((hh,i)=>{ const d = P['db'+(i+1)]|0; if(d>0) im[hh] += 0.13*Math.pow(10, -(8-d)*3/20); });
 return ORG_WAVES[key] = ctx.createPeriodicWave(re, im, {disableNormalization:true});
}
const SCAN = {off:[0,1,0], V1:[0.00025,0,1], V2:[0.0005,0,1], V3:[0.0009,0,1], C1:[0.00025,0.6,0.6], C2:[0.0005,0.6,0.6], C3:[0.0009,0.6,0.6]};
const orgBase = {db1:8,db2:8,db3:8,db4:0,db5:0,db6:0,db7:0,db8:0,db9:0, perc:'off',percDecay:'fast',percVol:'normal',click:0.4,
 scan:'C3',orgDrive:0.2,orgTone:9000,rotary:'slow',orgRel:0.04,velSens:0,lfoVib:0,modVib:0,chorus:0,dMix:0,rMix:0.18,rSize:2.2,drive:0,pressAmp:0.15};
const OG = (cat, name, bars, p = {}) => { const o = {}; [...bars].forEach((c,i)=>o['db'+(i+1)] = +c); return [cat, name, Object.assign(o, p)]; };
const ORG_PRESETS = [
 OG('Jazz','Jimmy Smith','888000000',{perc:'3rd',percDecay:'fast',scan:'C3',rotary:'slow',orgDrive:0.25}),
 OG('Jazz','Jazz Ballad','838000000',{scan:'C3',rotary:'slow',orgDrive:0.1,click:0.25}),
 OG('Jazz','Soul Comping','888400000',{perc:'2nd',percDecay:'fast',scan:'C3',rotary:'slow',orgDrive:0.3}),
 OG('Jazz','Mellow Flutes','008600000',{scan:'V2',rotary:'slow',orgDrive:0.05,click:0.15}),
 OG('Jazz','Booker Groove','886000000',{perc:'3rd',percDecay:'fast',percVol:'soft',scan:'C3',rotary:'slow',orgDrive:0.35}),
 OG('Gospel','Full Gospel','888888888',{scan:'C3',rotary:'fast',orgDrive:0.35}),
 OG('Gospel','Gospel Shout','888800008',{perc:'2nd',scan:'C3',rotary:'fast',orgDrive:0.45}),
 OG('Gospel','Sunday Swell','688600000',{scan:'C3',rotary:'slow',orgDrive:0.2,rMix:0.3}),
 OG('Rock','Rock Organ','888800000',{scan:'C3',rotary:'fast',orgDrive:0.7,orgTone:7000}),
 OG('Rock','Screaming Drawbars','888888888',{scan:'C3',rotary:'fast',orgDrive:0.95,orgTone:6000}),
 OG('Rock','Prog Organ','888000888',{perc:'3rd',scan:'V3',rotary:'slow',orgDrive:0.6}),
 OG('Rock','Garage Combo','808080800',{scan:'off',rotary:'off',orgDrive:0.5,click:0.7,orgTone:5000}),
 OG('Classic','Whiter Shade','688600000',{scan:'C3',rotary:'slow',orgDrive:0.15,rMix:0.35,rSize:4}),
 OG('Classic','Church Pipes','888876540',{scan:'off',rotary:'off',orgDrive:0,click:0,orgRel:0.6,rMix:0.55,rSize:8}),
 OG('Classic','Theatre Organ','878787878',{scan:'V3',rotary:'slow',orgDrive:0.1,rMix:0.4,rSize:5}),
 OG('Classic','Reggae Bubble','008000000',{perc:'2nd',percDecay:'fast',scan:'off',rotary:'off',orgDrive:0.1,orgRel:0.03}),
 OG('Classic','Ballpark','888888888',{scan:'V3',rotary:'off',orgDrive:0,click:0.2,rMix:0.35,rSize:4}),
 OG('Bass & Pedals','Pedal Bass','880000000',{scan:'off',rotary:'off',orgDrive:0.2,orgTone:2500,click:0.2}),
 OG('Bass & Pedals','Deep Sixteen','800000000',{scan:'C1',rotary:'slow',orgDrive:0.15}),
 OG('Init','Init Organ','008000000',{perc:'off',scan:'off',rotary:'off',orgDrive:0,click:0.3}),
];
const drawbarDefs = DB_FEET.map((ft,i)=>({k:'db'+(i+1), l:ft, type:'drawbar', color:DB_COLOR[i], min:0, max:8, step:1, fmt:v=>String(v|0), live:true}));
defineInstrument({
 id:'organ', name:'Tonewheel B3', brand:'Tonewheel <span>B3</span>', tag:'drawbar organ with rotary speaker', theme:'organ',
 cats:['Jazz','Gospel','Rock','Classic','Bass & Pedals','Init'], presets: ORG_PRESETS, base: orgBase,
 cc74:['orgDrive', x => x], cc71:['orgTone', x => 1500*Math.pow(10, x)],
 sections:[
  ['Drawbars', drawbarDefs],
  ['Percussion & click', [
   {k:'perc',type:'sel',opts:[['off','Percussion off'],['2nd','Percussion 2nd'],['3rd','Percussion 3rd']],aria:'Percussion'},
   {k:'percDecay',type:'sel',opts:[['fast','Fast decay'],['slow','Slow decay']],aria:'Percussion decay'},
   {k:'percVol',type:'sel',opts:[['normal','Normal'],['soft','Soft']],aria:'Percussion volume'},
   {k:'click',l:'Key click',min:0,max:1,fmt:pct},
   {k:'orgRel',l:'Release',min:0.01,max:1.5,exp:2,fmt:ms}]],
  ['Vibrato & tone', [
   {k:'scan',type:'sel',opts:[['off','Scanner off'],['V1','Vibrato 1'],['V2','Vibrato 2'],['V3','Vibrato 3'],['C1','Chorus 1'],['C2','Chorus 2'],['C3','Chorus 3']],aria:'Vibrato and chorus',live:true},
   {k:'orgDrive',l:'Tube drive',min:0,max:1,fmt:pct,live:true},
   {k:'orgTone',l:'Tone',min:1500,max:15000,log:true,fmt:hz,live:true}]],
  ['Rotary speaker', [
   {k:'rotary',type:'sel',opts:[['off','Rotary off'],['slow','Slow (chorale)'],['fast','Fast (tremolo)']],aria:'Rotary speaker',live:true}], 'rotary'],
 ],
 exprDefs:[], noLFO:true,
 setup(s){
  const x = {in: gn(1)}, N = [];
  x.tone = ctx.createBiquadFilter(); x.tone.type = 'lowpass'; x.tone.Q.value = 0.4; x.in.connect(x.tone);
  // vibrato / chorus scanner
  x.sDry = gn(1); x.sWet = gn(0); x.sDel = ctx.createDelay(0.01); x.sDel.delayTime.value = 0.0015;
  const sl = phasedLFO(6.9, 0); x.sDepth = gn(0); sl.connect(x.sDepth); x.sDepth.connect(x.sDel.delayTime);
  x.tone.connect(x.sDry); x.tone.connect(x.sDel); x.sDel.connect(x.sWet);
  x.drv = ctx.createWaveShaper(); x.drv.oversample = '4x'; x.drvOut = gn(1);
  x.sDry.connect(x.drv); x.sWet.connect(x.drv); x.drv.connect(x.drvOut);
  // rotary: drum (low) + horn (high), each with doppler, amplitude and pan modulation
  x.bypass = gn(1); x.rot = gn(0); x.drvOut.connect(x.bypass); x.drvOut.connect(x.rot);
  const rotor = (type, base, dDepth, aDepth, pDepth) => {
   const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.value = 800; flt.Q.value = 0.6;
   const del = ctx.createDelay(0.02); del.delayTime.value = base; const am = gn(1), pan = ctx.createStereoPanner();
   const ls = phasedLFO(1, 0), lc = phasedLFO(1, Math.PI/2);
   const gd = gn(dDepth), ga = gn(aDepth), gp = gn(pDepth); ls.connect(gd); gd.connect(del.delayTime); lc.connect(ga); ga.connect(am.gain); lc.connect(gp); gp.connect(pan.pan);
   x.rot.connect(flt); flt.connect(del); del.connect(am); am.connect(pan); pan.connect(s.n.fxIn);
   N.push(flt, del, am, pan, ls, lc, gd, ga, gp); return [ls, lc];
  };
  x.drum = rotor('lowpass', 0.004, 0.00025, 0.15, 0.35);
  x.horn = rotor('highpass', 0.002, 0.0006, 0.35, 0.8);
  x.bypass.connect(s.n.fxIn);
  x.speed = {horn:0.8, drum:0.7, ang:[0,0], last:0};
  x.nodes = [x.tone, x.sDry, x.sWet, x.sDel, sl, x.sDepth, x.drv, x.drvOut, x.bypass, x.rot, ...N];
  return x;
 },
 rotorSpeed(s){ const P = s.P; return P.rotary==='off' ? null : ((P.rotary==='fast') !== (modWheel > 0.5) ? 'fast' : 'slow'); },
 live(s, k){
  const P = s.P, x = s.inst, t = ctx.currentTime;
  x.tone.frequency.setTargetAtTime(P.orgTone, t, 0.02);
  const sc = SCAN[P.scan] || SCAN.off; x.sDepth.gain.setTargetAtTime(sc[0], t, 0.02); x.sDry.gain.setTargetAtTime(sc[1], t, 0.02); x.sWet.gain.setTargetAtTime(sc[2], t, 0.02);
  const dc = driveCurve(P.orgDrive*0.9); x.drv.curve = dc.c; x.drvOut.gain.setTargetAtTime(dc.post, t, 0.02);
  this.setRotor(s);
  if(k && k.startsWith('db')) for(const v of s.voices) if(!v.dead && v.h.osc) v.h.osc.setPeriodicWave(organWave(P));
 },
 setRotor(s){
  const x = s.inst, t = ctx.currentTime, sp = this.rotorSpeed(s);
  x.bypass.gain.setTargetAtTime(sp ? 0 : 1, t, 0.03); x.rot.gain.setTargetAtTime(sp ? 1 : 0, t, 0.03);
  const fast = sp === 'fast', hz = fast ? [6.7, 5.8] : [0.8, 0.7], up = fast;
  for(const o of x.horn) o.frequency.setTargetAtTime(hz[0], t, up ? 0.35 : 0.55);
  for(const o of x.drum) o.frequency.setTargetAtTime(hz[1], t, up ? 1.4 : 2.2);
  x.target = sp ? hz : [0,0];
 },
 modWheel(s){ this.setRotor(s); },
 voice(s, o){
  const P = o.P, t = o.t, f = o.f, h = {srcs:[], tune:[]};
  const fresh = !s.voices.some(v=>!v.dead && !v.rel && v !== o.v);   // percussion is single-triggered
  const osc = ctx.createOscillator(); osc.setPeriodicWave(organWave(P));
  if(o.glideFrom){ osc.frequency.setValueAtTime(f/2*o.ratio,t); osc.frequency.exponentialRampToValueAtTime(f/2,t+P.glide); } else osc.frequency.value = f/2;
  o.pitch.connect(osc.detune);
  const amp = gn(0); osc.connect(amp); amp.connect(o.out);
  amp.gain.setValueAtTime(0,t); amp.gain.linearRampToValueAtTime(o.velG*0.36, t+0.005);
  osc.start(t); h.srcs.push(osc); h.tune.push([osc.frequency, 0.5]); h.osc = osc;
  if(P.perc !== 'off' && fresh){
   const p = ctx.createOscillator(), mult = P.perc==='2nd' ? 2 : 3; p.frequency.value = f*mult; o.pitch.connect(p.detune);
   const pg = gn(0), lvl = (P.percVol==='soft' ? 0.09 : 0.18)*o.velG;
   pg.gain.setValueAtTime(lvl, t); pg.gain.setTargetAtTime(0, t, P.percDecay==='fast' ? 0.12 : 0.38);
   p.connect(pg); pg.connect(amp); p.start(t); h.srcs.push(p); h.tune.push([p.frequency, mult]);
  }
  if(P.click > 0){
   const n = ctx.createBufferSource(); n.buffer = noiseBuf(); n.loopStart = Math.random();
   const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200 + Math.random()*2500; bp.Q.value = 1.2;
   const cg = gn(0); cg.gain.setValueAtTime(P.click*0.22, t); cg.gain.setTargetAtTime(0, t, 0.004);
   n.connect(bp); bp.connect(cg); cg.connect(o.out); n.start(t, Math.random()); n.stop(t+0.05);
  }
  h.release = tr => relEnv(amp.gain, tr, s.P.orgRel);
  return h;
 },
 screen(cx, w, h, s){
  const x = s.inst, P = s.P;
  cx.fillStyle = '#1b0f08'; cx.fillRect(0,0,w,h);
  // drawbar strip
  const bw = Math.min(16, w*0.022), gap = bw*0.7, x0 = 14;
  for(let i=0;i<9;i++){
   const d = P['db'+(i+1)]|0, xx = x0 + i*(bw+gap), len = (h-30)*(0.15 + 0.85*d/8);
   cx.fillStyle = '#6b5a48'; cx.fillRect(xx+bw*0.35, 10, bw*0.3, len);
   cx.fillStyle = DB_COLOR[i]==='brown' ? '#7a3b1c' : DB_COLOR[i]==='black' ? '#1a1a1a' : '#f2ecdf';
   cx.fillRect(xx, 10+len-bw*1.4, bw, bw*1.4);
  }
  // rotary indicators: angle integrates the (ramping) rotor speed
  if(x && ctx){
   const now = performance.now()/1000, dt = Math.min(0.1, now - (x.speed.last||now)); x.speed.last = now;
   const tg = x.target || [0,0];
   x.speed.horn += (tg[0]-x.speed.horn)*Math.min(1, dt/0.45); x.speed.drum += (tg[1]-x.speed.drum)*Math.min(1, dt/1.8);
   x.speed.ang[0] += x.speed.horn*dt*2*Math.PI; x.speed.ang[1] += x.speed.drum*dt*2*Math.PI;
   const cy = h/2, r = Math.min(h*0.32, w*0.08);
   [[w*0.46, 'HORN', x.speed.ang[0], x.speed.horn],[w*0.46 + r*2.6, 'DRUM', x.speed.ang[1], x.speed.drum]].forEach(([cxp,lab,a,sp])=>{
    cx.strokeStyle = '#c9a26a'; cx.lineWidth = 2; cx.beginPath(); cx.arc(cxp, cy, r, 0, Math.PI*2); cx.stroke();
    cx.fillStyle = '#e7c48d'; cx.beginPath(); cx.ellipse(cxp + Math.cos(a)*r*0.55, cy + Math.sin(a)*r*0.25, r*0.32, r*0.16, 0, 0, Math.PI*2); cx.fill();
    cx.fillStyle = '#c9a26a'; cx.font = '600 13px '+F_ORG+''; cx.textAlign = 'center'; cx.fillText(lab+' '+sp.toFixed(1)+' Hz', cxp, cy + r + 18); cx.textAlign = 'left';
   });
   cx.fillStyle = '#e7c48d'; cx.font = 'italic 600 15px '+F_ORG+'';
   const sp = this.rotorSpeed(s); cx.fillText(sp ? 'Rotary · '+(sp==='fast'?'Tremolo':'Chorale') : 'Rotary off', w*0.46 - r, 22);
  }
  return {scope:[w*0.76, h*0.2, w*0.22, h*0.6], color:'#e7c48d'};
 }
});

/* ================= Ensemble 70 — string machine with ensemble chorus and phaser ================= */
const VOWEL_F = {ah:[[700,1],[1220,0.5],[2600,0.28]], oo:[[300,1],[870,0.45],[2240,0.2]], ee:[[270,1],[2290,0.4],[3010,0.3]], oh:[[450,1],[800,0.55],[2830,0.2]]};
const strBase = {lvl16:0.3,lvl8:0.8,lvlViola:0.3,lvl4:0.5,choir:0,vowel:'ah',drift:6,bright:3200,keyTrack:0.4,bow:0.6,
 aA:0.35,aS:1,aR:1.2,velSens:0.2,ensDepth:0.8,ensMix:0.85,phRate:0.25,phDepth:0,phMix:0,lfoVib:0,modVib:25,lfoRate:5,
 chorus:0,dMix:0.06,rMix:0.4,rSize:4.5,drive:0.05,pressBright:0.5};
const SP = (cat, name, p) => [cat, name, p];
const STR_PRESETS = [
 SP('Strings','Solina Classic',{}),
 SP('Strings','Disco Strings',{lvl16:0.1,lvl8:0.9,lvl4:0.7,bright:5000,aA:0.12,aR:0.6,ensDepth:0.9,dMix:0.12,rMix:0.35}),
 SP('Strings','Oxygene Sweep',{lvl16:0.5,lvl8:0.8,lvl4:0.4,bright:2600,aA:0.6,aR:2.2,phDepth:1,phMix:0.8,phRate:0.12,dMix:0.15,dFb:0.5,rSize:8,rMix:0.55}),
 SP('Strings','Cello Ensemble',{lvl16:0.6,lvl8:1,lvlViola:0.1,lvl4:0,bright:1400,aA:0.45,aR:1.4,ensDepth:0.6,lfoVib:4}),
 SP('Strings','Violins High',{lvl16:0,lvl8:0.4,lvlViola:0,lvl4:1,bright:6000,aA:0.4,ensDepth:0.9,lfoVib:6,rMix:0.45}),
 SP('Strings','Viola Section',{lvl16:0,lvl8:0.2,lvlViola:1,lvl4:0.3,bright:2800,aA:0.35}),
 SP('Strings','Ballad Strings',{lvl16:0.3,lvl8:0.8,lvl4:0.5,bright:2200,aA:0.9,aR:2.5,ensDepth:0.7,rSize:7,rMix:0.55}),
 SP('Strings','Lo-fi Tape Strings',{lvl16:0.2,lvl8:0.9,lvl4:0.4,bright:1600,drift:14,lfoRate:0.4,lfoVib:10,aA:0.4,drive:0.3,ensDepth:1,rMix:0.35}),
 SP('Strings','Bowed Bass',{lvl16:1,lvl8:0.6,lvlViola:0,lvl4:0,bright:900,aA:0.25,aR:0.8,ensDepth:0.4,ensMix:0.6}),
 SP('Choirs','Choir Ahh',{lvl16:0,lvl8:0.1,lvlViola:0,lvl4:0,choir:1,vowel:'ah',bright:5000,aA:0.6,aR:2,ensDepth:0.9,rSize:7,rMix:0.55}),
 SP('Choirs','Choir Ooh',{lvl16:0,lvl8:0,lvlViola:0,lvl4:0,choir:1,vowel:'oo',bright:4000,aA:0.7,aR:2.2,ensDepth:1,rSize:8,rMix:0.6}),
 SP('Choirs','Strings & Choir',{lvl16:0.2,lvl8:0.6,lvl4:0.4,choir:0.8,vowel:'ah',bright:3500,aA:0.6,aR:2,rSize:7,rMix:0.55}),
 SP('Choirs','Vox Humana',{lvl16:0,lvl8:0.3,lvlViola:0.3,lvl4:0,choir:0.9,vowel:'oh',bright:3000,lfoVib:7,lfoRate:5.5,aA:0.3,ensDepth:0.7}),
 SP('Choirs','Ghost Choir',{lvl16:0,lvl8:0,lvl4:0.2,choir:1,vowel:'ee',bright:6000,aA:1.5,aR:4,phDepth:0.6,phMix:0.5,phRate:0.08,dMix:0.25,dFb:0.6,rSize:12,rMix:0.75}),
 SP('Pads','Jarre Pad',{lvl16:0.6,lvl8:0.7,lvlViola:0.4,lvl4:0.6,bright:3000,aA:1,aR:3,phDepth:1,phMix:0.9,phRate:0.18,dMix:0.25,dFb:0.55,rSize:10,rMix:0.6}),
 SP('Pads','Dark Ensemble',{lvl16:0.8,lvl8:0.7,lvl4:0,bright:700,aA:1.2,aR:3,ensDepth:1,rSize:9,rMix:0.6}),
 SP('Pads','Polymoog Vox',{lvl16:0.2,lvl8:0.6,lvlViola:0.6,lvl4:0.3,choir:0.4,vowel:'oh',bright:2600,aA:0.5,phDepth:0.5,phMix:0.5,phRate:0.3}),
 SP('Pads','Eno Ambience',{lvl16:0.3,lvl8:0.5,lvl4:0.6,choir:0.4,vowel:'oo',bright:2000,aA:2.5,aR:6,dTime:0.6,dFb:0.65,dMix:0.3,rSize:12,rMix:0.75}),
 SP('Pads','Glass Ensemble',{lvl16:0,lvl8:0.3,lvl4:1,choir:0.3,vowel:'ee',bright:8000,aA:0.8,aR:3,phDepth:0.4,phMix:0.4,rSize:9,rMix:0.6}),
 SP('Pads','Brass Ensemble',{lvl16:0.4,lvl8:1,lvlViola:0.6,lvl4:0.2,bright:1200,bow:1,aA:0.08,aR:0.5,ensDepth:0.5,ensMix:0.6,drive:0.25}),
 SP('Init','Init Strings',{}),
];
defineInstrument({
 id:'strings', name:'Ensemble 70', brand:'Ensemble <span>70</span>', tag:'string & choir machine with ensemble and phaser', theme:'strings',
 cats:['Strings','Choirs','Pads','Init'], presets: STR_PRESETS, base: strBase,
 cc74:['bright', x => 300*Math.pow(40, x)], cc71:['phDepth', x => x],
 sections:[
  ['Registers', [
   {k:'lvl16',l:"Bass 16'",type:'fader',color:'#c2410c',min:0,max:1,fmt:pct},
   {k:'lvl8',l:"Cello 8'",type:'fader',color:'#d97706',min:0,max:1,fmt:pct},
   {k:'lvlViola',l:"Viola 8'",type:'fader',color:'#ca8a04',min:0,max:1,fmt:pct},
   {k:'lvl4',l:"Violin 4'",type:'fader',color:'#a16207',min:0,max:1,fmt:pct},
   {k:'choir',l:'Choir',type:'fader',color:'#7c2d12',min:0,max:1,fmt:pct}]],
  ['Voice', [
   {k:'vowel',type:'sel',opts:[['ah','Choir “ah”'],['oh','Choir “oh”'],['oo','Choir “oo”'],['ee','Choir “ee”']],aria:'Choir vowel'},
   {k:'bright',l:'Brightness',min:300,max:12000,log:true,fmt:hz,live:true},
   {k:'bow',l:'Bow swell',min:0,max:1.5,fmt:v=>v.toFixed(1)+' oct'},
   {k:'keyTrack',l:'Key trk',min:0,max:1,fmt:pct},
   {k:'drift',l:'Drift',min:0,max:25,fmt:v=>Math.round(v)+'¢'}]],
  ['Envelope', [
   {k:'aA',l:'Crescendo',min:0.005,max:5,exp:2.5,fmt:ms,live:true},
   {k:'aS',l:'Sustain',min:0,max:1,fmt:pct},
   {k:'aR',l:'Release',min:0.02,max:8,exp:2.5,fmt:ms},
   {k:'velSens',l:'Velocity',min:0,max:1,fmt:pct}]],
  ['Ensemble', [
   {k:'ensDepth',l:'Depth',type:'fader',color:'#b45309',min:0,max:1,fmt:pct,live:true},
   {k:'ensMix',l:'Mix',type:'fader',color:'#b45309',min:0,max:1,fmt:pct,live:true}]],
  ['Phaser', [
   {k:'phRate',l:'Rate',min:0.03,max:4,exp:2,fmt:v=>v.toFixed(2)+' Hz',live:true},
   {k:'phDepth',l:'Depth',min:0,max:1,fmt:pct,live:true},
   {k:'phMix',l:'Mix',min:0,max:1,fmt:pct,live:true}]],
  ['Vibrato', [
   {k:'lfoRate',l:'Rate',min:0.05,max:12,exp:2,fmt:v=>v.toFixed(2)+' Hz',live:true},
   {k:'lfoVib',l:'Vibrato',min:0,max:40,exp:2,fmt:v=>Math.round(v)+'¢',live:true},
   {k:'modVib',l:'Wheel vib',min:0,max:100,fmt:v=>Math.round(v)+'¢',live:true}]],
 ],
 exprDefs:[{k:'pressBright',l:'Press→Bright',min:0,max:1,fmt:pct}],
 setup(s){
  const x = {in: gn(1)}, N = [];
  x.bright = cs(0); x.bright.start(); N.push(x.bright);
  // 3-line ensemble: each delay modulated by a slow and a fast LFO, 120° apart
  x.eDry = gn(1); x.eWet = gn(0); x.in.connect(x.eDry);
  const mer = ctx.createChannelMerger(2); x.slowG = []; x.fastG = [];
  for(let i=0;i<3;i++){
   const d = ctx.createDelay(0.03); d.delayTime.value = 0.008;
   const sl = phasedLFO(0.62, i*2*Math.PI/3), fa = phasedLFO(6.1, i*2*Math.PI/3), gs = gn(0), gf = gn(0);
   sl.connect(gs); fa.connect(gf); gs.connect(d.delayTime); gf.connect(d.delayTime); x.slowG.push(gs); x.fastG.push(gf);
   x.in.connect(d);
   if(i===1){ const h1 = gn(0.5), h2 = gn(0.5); d.connect(h1); d.connect(h2); h1.connect(mer,0,0); h2.connect(mer,0,1); N.push(h1,h2); }
   else d.connect(mer, 0, i===0 ? 0 : 1);
   N.push(d, sl, fa, gs, gf);
  }
  mer.connect(x.eWet); x.ens = gn(1); x.eDry.connect(x.ens); x.eWet.connect(x.ens);
  // 6-stage phaser
  x.pDry = gn(1); x.pWet = gn(0); x.ens.connect(x.pDry);
  const pl = ctx.createOscillator(); pl.start(); x.phLFO = pl; x.phAmt = gn(0); pl.connect(x.phAmt);
  let prev = x.ens;
  for(let i=0;i<6;i++){ const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = 500; ap.Q.value = 0.6; x.phAmt.connect(ap.detune); prev.connect(ap); prev = ap; N.push(ap); }
  prev.connect(x.pWet);
  x.pDry.connect(s.n.fxIn); x.pWet.connect(s.n.fxIn);
  x.nodes = [x.eDry, x.eWet, mer, x.ens, x.pDry, x.pWet, pl, x.phAmt, ...N];
  return x;
 },
 live(s){
  const P = s.P, x = s.inst, t = ctx.currentTime;
  x.bright.offset.setTargetAtTime(1200*Math.log2(P.bright/1000), t, 0.02);
  for(const g of x.slowG) g.gain.setTargetAtTime(0.0019*P.ensDepth, t, 0.02);
  for(const g of x.fastG) g.gain.setTargetAtTime(0.00028*P.ensDepth, t, 0.02);
  x.eWet.gain.setTargetAtTime(P.ensMix*1.1, t, 0.02); x.eDry.gain.setTargetAtTime(1 - P.ensMix*0.75, t, 0.02);
  x.phLFO.frequency.setTargetAtTime(P.phRate, t, 0.02); x.phAmt.gain.setTargetAtTime(P.phDepth*2400, t, 0.02);
  x.pWet.gain.setTargetAtTime(P.phMix*0.8, t, 0.02); x.pDry.gain.setTargetAtTime(1 - P.phMix*0.2, t, 0.02);
 },
 voice(s, o){
  const P = o.P, t = o.t, f = o.f, x = s.inst, h = {srcs:[], tune:[]};
  const vmix = gn(1), cmix = gn(1);
  const reg = (type, mult, lvl, dest) => { if(lvl <= 0) return; const n = ctx.createOscillator(); setWave(n, type);
   const fq = f*mult; if(o.glideFrom){ n.frequency.setValueAtTime(fq*o.ratio,t); n.frequency.exponentialRampToValueAtTime(fq,t+P.glide); } else n.frequency.value = fq;
   n.detune.value = (Math.random()*2-1)*P.drift; o.pitch.connect(n.detune);
   const g = gn(lvl*0.42); n.connect(g); g.connect(dest); n.start(t); h.srcs.push(n); h.tune.push([n.frequency, mult]); };
  reg('sawtooth', 0.5, P.lvl16, vmix); reg('sawtooth', 1, P.lvl8, vmix); reg('pulse', 1, P.lvlViola, vmix); reg('sawtooth', 2, P.lvl4, vmix);
  if(P.choir > 0){
   reg('sawtooth', 1, P.choir*1.6, cmix);
   for(const [F,g] of VOWEL_F[P.vowel] || VOWEL_F.ah){ const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = F; bp.Q.value = 9; const bg = gn(g*3.2); cmix.connect(bp); bp.connect(bg); bg.connect(vmix); }
  }
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
  const vf = gn(1); x.bright.connect(vf); vf.connect(lp.detune); const pb = gn(P.pressBright*2400); o.press.connect(pb); pb.connect(vf);
  const base = 1000*Math.pow(2, P.keyTrack*(o.note-60)/12);
  lp.frequency.setValueAtTime(base*Math.pow(2,-P.bow), t); lp.frequency.setTargetAtTime(base, t, Math.max(0.01,P.aA)*0.7);
  const amp = gn(0); vmix.connect(lp); lp.connect(amp); amp.connect(o.out);
  adsr(amp.gain, t, 0.16*o.velG, P.aA, Math.max(0.2,P.aA), P.aS);
  h.release = tr => relEnv(amp.gain, tr, s.P.aR);
  h.cleanup = () => { try{ x.bright.disconnect(vf); }catch(_){} };
  return h;
 }
});


/* ================= interface ================= */
const TAB_COLOR = {ember:'#ec4a2c', fm:'#35c4b5', wt:'#ff4fd8', organ:'#e9a640', strings:'#d9541e'};
const store = { get(k,d){ try{ const v = localStorage.getItem(k); return v==null ? d : JSON.parse(v); }catch(_){ return d; } }, set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }catch(_){ return false; } } };
const edS = () => slots[editSlot];

/* ---------- core sections every instrument gets ---------- */
const PERF_SECTION = ['Performance', [
 {k:'playMode',type:'sel',opts:[['poly','Poly'],['mono','Mono'],['legato','Legato']],aria:'Play mode'},
 {k:'glideMode',type:'sel',opts:[['always','Glide always'],['overlap','Glide when overlapping']],aria:'Glide mode'},
 {k:'glide',l:'Portamento',min:0,max:1,exp:2.5,fmt:v=>v<0.001?'Off':ms(v)},
 {k:'transpose',l:'Transpose',min:-12,max:12,step:1,fmt:v=>sgn(v)+' st'},
 {k:'octave',l:'Octave',min:-3,max:3,step:1,fmt:sgn}]];
const ARP_SECTION = ['Arpeggiator', [
 {k:'arpMode',type:'sel',opts:[['off','Arp off'],['up','Up'],['down','Down'],['updown','Up-down'],['random','Random'],['played','As played'],['chord','Chord repeat']],aria:'Arpeggiator pattern'},
 {k:'arpRate',type:'sel',opts:Object.keys(RATES).map(r=>[r, r.replace('T',' triplet')]),aria:'Arpeggiator note length'},
 {k:'arpHold',type:'sel',opts:[['off','Hold off'],['on','Hold on']],aria:'Arpeggiator hold'},
 {k:'tempo',l:'Tempo',min:40,max:220,step:1,fmt:v=>Math.round(v)+' BPM'},
 {k:'arpOct',l:'Octaves',min:1,max:4,step:1,fmt:v=>v+' oct'},
 {k:'arpGate',l:'Gate',min:0.05,max:1,fmt:pct}], 'arp'];
const exprSection = id => ['Expression · MPE', [
 {k:'mpeMode',type:'sel',opts:[['auto','MPE on (auto)'],['off','MPE off']],aria:'MPE mode'},
 {k:'bendRange',l:'Note bend',min:1,max:96,step:1,fmt:v=>'±'+v+' st'},
 {k:'gBend',l:'Wheel bend',min:1,max:24,step:1,fmt:v=>'±'+v+' st'},
 {k:'pressAmp',l:'Press→Vol',min:0,max:1,fmt:pct},
 {k:'pressVib',l:'Press→Vib',min:0,max:80,exp:1.5,fmt:v=>Math.round(v)+'¢'},
 ...(INSTR[id].exprDefs||[])]];

/* ---------- controls ---------- */
const ctl = {}, defs = {};
function toNorm(d,v){ if(d.log) return Math.log(v/d.min)/Math.log(d.max/d.min); const n = (v-d.min)/(d.max-d.min); return Math.pow(clamp(n,0,1), 1/(d.exp||1)); }
function fromNorm(d,n){ n = clamp(n,0,1); let v = d.log ? d.min*Math.pow(d.max/d.min,n) : d.min+(d.max-d.min)*Math.pow(n,d.exp||1); if(d.step) v = Math.round(v/d.step)*d.step; return clamp(v,d.min,d.max); }
function arc(a0,a1,r){ const p = a=>[22+r*Math.cos(a),22+r*Math.sin(a)]; const [x0,y0]=p(a0),[x1,y1]=p(a1); return `M${x0} ${y0}A${r} ${r} 0 ${a1-a0>Math.PI?1:0} 1 ${x1} ${y1}`; }
const A0 = Math.PI*0.75, A1 = Math.PI*2.25;
function drawCtl(k){
 const d = defs[k], el = ctl[k]; if(!d || !el) return; const v = edS().P[k], n = toNorm(d, v);
 if(d.type==='fader' || d.type==='drawbar'){ el.style.setProperty('--v', n.toFixed(3)); if(d.type==='drawbar') el.querySelector('.tip').textContent = v|0; }
 else { const a = A0+(A1-A0)*n; el.querySelector('.arcv').setAttribute('d', n>0.002 ? arc(A0,a,19) : ''); el.querySelector('.ptr').setAttribute('transform', `rotate(${a*180/Math.PI} 22 22)`); }
 el.querySelector('.val').textContent = d.fmt(v); el.setAttribute('aria-valuetext', d.fmt(v));
}
function ctlHTML(d, title){
 if(d.type==='sel') return `<select data-k="${d.k}" aria-label="${esc(d.aria||d.k)}">${d.opts.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
 defs[d.k] = d;
 if(d.type==='drawbar'){ const cc = {brown:'#7a3b1c',white:'#f2ecdf',black:'#1a1a1a'}[d.color], ci = d.color==='white' ? '#2a1a0c' : '#f2ecdf';
  return `<div class="fader drawbar" tabindex="0" role="slider" aria-label="Drawbar ${esc(d.l)}" data-k="${d.k}" style="--cc:${cc};--ci:${ci}"><span class="lab">${esc(d.l)}</span><div class="trk"><div class="rod"></div><div class="tip"></div></div><span class="val"></span></div>`; }
 if(d.type==='fader') return `<div class="fader" tabindex="0" role="slider" aria-label="${esc(title+' '+d.l)}" data-k="${d.k}" style="--cc:${d.color||'#ddd'}"><div class="trk"><div class="cap"></div></div><span class="lab">${esc(d.l)}</span><span class="val"></span></div>`;
 return `<div class="knob" tabindex="0" role="slider" aria-label="${esc(title+' '+d.l)}" data-k="${d.k}"><svg viewBox="0 0 44 44"><path class="arcbg" d="${arc(A0,A1,19)}" stroke="#0005" stroke-width="3" fill="none" stroke-linecap="round"/><path class="arcv" stroke="var(--accent)" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="22" cy="23.5" r="14" fill="#0006"/><circle cx="22" cy="22" r="14" fill="url(#emb-kg)"/><g class="ptr"><line x1="27" y1="22" x2="35" y2="22" stroke="var(--kPtr)" stroke-width="2.6" stroke-linecap="round"/></g></svg><span class="lab">${esc(d.l)}</span><span class="val"></span></div>`;
}
function wireCtl(el){
 const k = el.dataset.k, d = defs[k]; ctl[k] = el; drawCtl(k);
 const dir = d.type==='drawbar' ? -1 : 1; let sy = 0, sn = 0;
 el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); sy = e.clientY; sn = toNorm(d, edS().P[k]); el.classList.add('drag'); });
 el.addEventListener('pointermove', e => { if(!el.classList.contains('drag')) return; const sc = (e.shiftKey?900:180)*(d.type==='drawbar'||d.type==='fader' ? 0.7 : 1); setParam(k, fromNorm(d, sn + dir*(sy-e.clientY)/sc)); });
 const end = () => el.classList.remove('drag'); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
 el.addEventListener('dblclick', () => setParam(k, DEV.includes(k) ? DEV_DEF[k] : (edS().cur?.p[k] ?? baseOf(edS().instr)[k])));
 const stepN = d.step ? d.step/(d.max-d.min) : 0.02;
 el.addEventListener('wheel', e => { e.preventDefault(); setParam(k, fromNorm(d, toNorm(d, edS().P[k]) - Math.sign(e.deltaY)*stepN*(d.type==='drawbar'?-1:1))); }, {passive:false});
 el.addEventListener('keydown', e => { const s = (e.key==='ArrowUp'||e.key==='ArrowRight') ? 1 : (e.key==='ArrowDown'||e.key==='ArrowLeft') ? -1 : 0; if(!s) return; e.preventDefault(); e.stopPropagation(); setParam(k, fromNorm(d, toNorm(d, edS().P[k]) + s*stepN)); });
}
function setDev(k, v){ DEVP[k] = v; for(const x of slots) if(x.P) x.P[k] = v; store.set('ember-studio-dev', DEVP); }
function setParam(k, v){
 const s = edS();
 if(DEV.includes(k)){
  setDev(k, v); updateMidiLabel();
  if(k==='tempo' && Studio && Studio.transport){   // the arp follows the studio tempo; turning the knob sets it
   if(typeof Studio.transport.setBpm === 'function') Studio.transport.setBpm(v); else Studio.transport.bpm = v;
  }
 }
 else { s.P[k] = v; markDirty(); }
 if(ctl[k]) drawCtl(k);
 if(k==='playMode'){ s.mono.stack = []; if(ctx) for(const x of s.voices) release(x, ctx.currentTime); }
 if(k==='arpMode' && !arpActive(s)) arpClear(s);
 if(k==='arpHold' && s.P.arpHold==='off'){ s.arp.held = s.arp.held.filter(x=>x.down); if(!s.arp.held.length) arpStop(s); }
 if(ctx && s.inst) slotLive(s, k);
 if(k==='fEnv' || k==='cutoff') filtHint();
 if(INSTR[s.instr].theme==='fm' || k==='wtPos') drawScreenSoon();
}

/* ---------- panel ---------- */
function renderPanel(){
 if(!root) return;
 const s = edS(), I = INSTR[s.instr];
 $('#synth').dataset.theme = I.theme; $('#lib').dataset.theme = I.theme; $('#saveDlg').dataset.theme = I.theme;
 $('#brand').innerHTML = I.brand; $('#tag').textContent = I.tag;
 for(const k in ctl) delete ctl[k]; for(const k in defs) delete defs[k];
 const secs = [...I.sections, PERF_SECTION, ARP_SECTION, exprSection(s.instr), FX_SECTION];
 $('#sections').innerHTML = secs.map(([title, items, extra]) => `<div class="sec${title==='Drawbars'?' wide':''}" data-s="${esc(title)}"><h2>${esc(title)}${extra==='arp'?' <span class="led" id="emb-arpLed" title="Arp step"></span>':''}</h2>${extra==='meter'?'<div class="fmeter"><span>Filter now</span><span class="fbar"><i id="emb-fbarI"></i></span><span class="fval" id="emb-fval">–</span></div><p class="fhint" id="emb-fhint"></p>':''}<div class="row">${items.map(d=>ctlHTML(d,title)).join('')}</div></div>`).join('') +
  `<svg width="0" height="0" style="position:absolute"><defs><radialGradient id="emb-kg" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="var(--kA)"/><stop offset=".6" stop-color="var(--kB)"/><stop offset="1" stop-color="var(--kC)"/></radialGradient></defs></svg>`;
 $$('#sections [data-k]:not(select)').forEach(wireCtl);
 $$('#sections select[data-k]').forEach(sel => { sel.value = s.P[sel.dataset.k]; sel.addEventListener('change', () => { setParam(sel.dataset.k, sel.value); sel.blur(); }); });
 $('#saveCat').innerHTML = I.cats.map(c=>`<option>${esc(c)}</option>`).join('');
 patchLabel(); filtHint(); renderTop(); updateMidiLabel(); drawScreenSoon();
}
function refreshCtls(){ if(!root) return; const s = edS(); for(const k in ctl) drawCtl(k); $$('#sections select[data-k]').forEach(sel => sel.value = s.P[sel.dataset.k]); filtHint(); }
function filtHint(){
 const sec = $('.sec[data-s="Filter envelope"]'), h = $('#fhint'); if(!sec || !h) return; const P = edS().P;
 const off = Math.abs(P.fEnv) < 0.05; sec.classList.toggle('muted', off);
 h.textContent = off ? 'Env amt (in Filter) is 0 on this patch, so these knobs have nothing to move. Turn Env amt up to hear the sweep.'
  : (P.cutoff > 5000 && P.cutoff*Math.pow(2,Math.max(0,P.fEnv)) > 16000) ? 'Cutoff is already bright, so most of the sweep is above what you can hear. Lower Cutoff to hear it.' : '';
}

/* ---------- studio bar: tabs, layer / split ---------- */
function renderTop(){
 if(!root) return;
 const s = edS();
 $('#tabs').innerHTML = INSTR_ORDER.map(id=>`<button class="tab" role="tab" aria-selected="${s.instr===id}" data-i="${id}"><i style="background:${TAB_COLOR[id]}"></i>${esc(INSTR[id].name)}</button>`).join('');
 $('#mode').value = mode;
 const multi = mode !== 'single';
 $('#slotBtns').hidden = !multi; $('#bCtl').hidden = !multi; $('#splitBtn').hidden = mode !== 'split';
 $('#editA').setAttribute('aria-pressed', editSlot===0); $('#editB').setAttribute('aria-pressed', editSlot===1);
 $('#bVol').value = bVol; $('#bOct').value = bOct;
 $('#splitBtn').textContent = learnSplit ? 'Press a key…' : 'Split at ' + noteName(splitNote);
 const nm = x => `<b>${esc(INSTR[x.instr].name)}</b> · ${esc(x.cur?.name||'')}`;
 $('#slotInfo').innerHTML = multi ? (mode==='layer' ? `Layer: A ${nm(slots[0])} + B ${nm(slots[1])}` : `Split: B ${nm(slots[1])} below ${noteName(splitNote)}, A ${nm(slots[0])} above`) + ` — editing <b>${editSlot ? 'B' : 'A'}</b>` : '';
}
const noteName = n => ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][n%12] + (Math.floor(n/12)-1);
function setInstrument(s, id){
 if(s.instr === id) return;
 arpClear(s); s.instr = id;
 const L = allPatches(id), last = store.get('ember-studio-last', {})[id];
 const e = (last && L.find(x=>x.name===last.name && x.user===last.user)) || L.find(x=>x.cat!=='Init') || L[0];
 loadPatch(s, e, true);
}

/* ---------- patches & library ---------- */
let USER = store.get('ember-studio-user', null);
if(!USER){ USER = (store.get('ember-user', [])||[]).filter(u=>u && u.name && u.p).map(u=>({instr:'ember', name:u.name, cat:u.cat||'Utility', p:u.p})); store.set('ember-studio-user', USER); }
USER = USER.filter(u=>u && INSTR[u.instr] && typeof u.name==='string' && u.p && typeof u.p==='object');
const saveUser = () => store.set('ember-studio-user', USER);
const allPatches = id => INSTR[id].presets.map(([cat,name,p])=>({cat,name,p,user:false})).concat(USER.filter(u=>u.instr===id).map(u=>({cat:INSTR[id].cats.includes(u.cat)?u.cat:INSTR[id].cats[INSTR[id].cats.length-1],name:u.name,p:u.p,user:true})));
const same = (a,b) => a && b && a.name===b.name && a.user===b.user;
function loadPatch(s, e, rebuild){
 if(ctx && s.P && s.P.playMode !== (e.p.playMode||'poly')){ s.mono.stack = []; for(const v of s.voices) release(v, ctx.currentTime); }
 s.P = {...baseOf(s.instr), ...e.p, ...DEVP}; s.cur = e; s.dirty = false;
 if(!arpActive(s)) arpClear(s);
 if(ctx){ if(rebuild || !s.inst) buildSlot(s); else slotLive(s); }
 const last = store.get('ember-studio-last', {}); last[s.instr] = {name:e.name, user:e.user}; store.set('ember-studio-last', last);
 if(s === edS()){ if(rebuild) renderPanel(); else { refreshCtls(); patchLabel(); renderTop(); } renderLib(); }
 else renderTop();
 saveState();
}
function patchLabel(){ if(!root) return; const s = edS(); if(!s.cur) return; $('#pname').textContent = s.cur.name + (s.dirty?' *':''); $('#pcat').textContent = (s.cur.user?'Yours · ':'') + s.cur.cat; }
function markDirty(){ const s = edS(); if(s.cur && !s.dirty){ s.dirty = true; patchLabel(); } }
function stepPatch(d){ const s = edS(), L = allPatches(s.instr), i = L.findIndex(x=>same(x,s.cur)); loadPatch(s, L[(i+d+L.length)%L.length]); }
let libCat = 'All';
function renderLib(){
 if(!root || $('#lib').hidden) return;
 const s = edS(), I = INSTR[s.instr], L = allPatches(s.instr), q = $('#libQ').value.trim().toLowerCase();
 $('#libT').textContent = I.name + ' patches';
 if(libCat!=='All' && libCat!=='Yours' && !I.cats.includes(libCat)) libCat = 'All';
 const n = c => c==='All' ? L.length : c==='Yours' ? L.filter(x=>x.user).length : L.filter(x=>x.cat===c).length;
 $('#cats').innerHTML = ['All',...I.cats,'Yours'].map(c=>`<button data-c="${esc(c)}" class="${c===libCat?'on':''}">${esc(c)}<small>${n(c)}</small></button>`).join('');
 const list = L.filter(x => (libCat==='All' || (libCat==='Yours' ? x.user : x.cat===libCat)) && (!q || (x.name+' '+x.cat).toLowerCase().includes(q)));
 $('#plist').innerHTML = list.length ? list.map(x=>`<button class="pc ${same(x,s.cur)?'on':''}" data-n="${esc(x.name)}" data-u="${x.user?1:0}"><span>${esc(x.name)}</span><small>${esc(x.cat)}${x.user?' · yours':''}</small>${x.user?`<span class="del" role="button" aria-label="Delete ${esc(x.name)}" data-del="1">×</span>`:''}</button>`).join('')
  : `<p class="empty">${libCat==='Yours' && !q ? 'Nothing saved for this instrument yet. Shape a sound, then press Save.' : 'No patches match that search.'}</p>`;
}
function openLib(){ $('#lib').hidden = false; renderLib(); $('#plist .on')?.scrollIntoView({block:'nearest'}); }
function closeDlgs(){ if(!root) return; $('#lib').hidden = true; $('#saveDlg').hidden = true; }
function saveHint(){ const n = $('#saveName').value.trim(); $('#saveNote').textContent = USER.some(u=>u.instr===edS().instr && u.name===n) ? 'This will replace your saved patch with the same name.' : ''; }
function saveState(){
 store.set('ember-studio-state', {mode, editSlot, splitNote, bVol, bOct, slots: slots.map(s=>({instr:s.instr, patch: s.cur ? {name:s.cur.name, user:s.cur.user} : null}))});
}

/* ---------- lights, screen, meter ---------- */
let ledT = 0;
function blink(){ const led = $('#led'); if(!led) return; led.classList.add('on'); clearTimeout(ledT); ledT = setTimeout(()=>led.classList.remove('on'),60); }
function arpBlink(delay){ const l = $('#arpLed'); if(l) setTimeout(()=>{ l.classList.add('on'); setTimeout(()=>l.classList.remove('on'),60); }, Math.max(0, delay*1000)); }
let cv = null, cx = null, buf = null, scrDirty = true, raf = 0;
function drawScreenSoon(){ scrDirty = true; }
function draw(){
 raf = requestAnimationFrame(draw);
 if(!cv || !root || !root.isConnected) return;
 const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio||1;
 if(!w || !h) return;   // panel hidden (another tab is showing)
 if(cv.width !== Math.round(w*dpr) || cv.height !== Math.round(h*dpr)){ cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr); }
 cx.setTransform(dpr,0,0,dpr,0,0); cx.clearRect(0,0,w,h);
 const s = edS(), I = INSTR[s.instr];
 let reg = [0,0,w,h], col = '#ff7a52';
 if(I.screen){ const r = I.screen(cx, w, h, s); if(r){ reg = r.scope; col = r.color; } }
 else { cx.strokeStyle = '#ffffff10'; cx.lineWidth = 1; for(let i=1;i<8;i++){ cx.beginPath(); cx.moveTo(w*i/8,0); cx.lineTo(w*i/8,h); cx.stroke(); } for(let i=1;i<4;i++){ cx.beginPath(); cx.moveTo(0,h*i/4); cx.lineTo(w,h*i/4); cx.stroke(); } }
 // filter meter
 const fb = $('#fbarI'), fv = $('#fval');
 if(fb){ let hzv = s.P.cutoff, live = false; for(let i=s.voices.length-1;i>=0;i--){ const v = s.voices[i]; if(!v.dead && !v.killed && v.h.meter){ hzv = v.h.meter(); live = true; break; } }
  hzv = clamp(hzv,20,20000); fb.style.width = (Math.log(hzv/20)/Math.log(1000)*100).toFixed(1)+'%'; fv.textContent = live ? hz(hzv) : 'Play a note'; }
 if(!ctx || !M.an) return;
 if(!buf) buf = new Float32Array(M.an.fftSize);
 M.an.getFloatTimeDomainData(buf);
 let st = 0; for(let i=1;i<buf.length/2;i++) if(buf[i-1]<0 && buf[i]>=0){ st = i; break; }
 const [rx,ry,rw,rh] = reg, N = 1024; cx.beginPath();
 for(let i=0;i<N;i++){ const xx = rx + i/(N-1)*rw, yy = ry + rh/2 - buf[st+i]*rh*0.45; i ? cx.lineTo(xx,yy) : cx.moveTo(xx,yy); }
 cx.strokeStyle = col; cx.lineWidth = 2; cx.shadowColor = col; cx.shadowBlur = 10; cx.stroke(); cx.shadowBlur = 0;
}

/* ---------- panel markup (ids are prefixed emb- and only looked up inside the mount element) ---------- */
const PANEL_HTML = `
<div class="lib" id="emb-lib" hidden><div class="libbox" role="dialog" aria-modal="true" aria-labelledby="emb-libT">
  <div class="libhead"><h2 id="emb-libT">Patch library</h2><input type="search" id="emb-libQ" placeholder="Search patches" aria-label="Search patches"><button id="emb-libDone">Done</button></div>
  <div class="libmain"><nav class="cats" id="emb-cats"></nav><div class="plist" id="emb-plist"></div></div>
  <div class="libfoot"><button id="emb-expBtn">Export my patches</button><label class="btn" for="emb-impFile">Import</label><input type="file" id="emb-impFile" accept=".json,application/json" hidden><span id="emb-libMsg">Click a patch to load it — keep playing while you browse.</span></div>
</div></div>
<div class="lib" id="emb-saveDlg" hidden><form class="libbox savebox" id="emb-saveForm" role="dialog" aria-modal="true" aria-labelledby="emb-saveT">
  <div class="libhead"><h2 id="emb-saveT">Save patch</h2></div>
  <div class="savebody"><label class="f">Name<input type="text" id="emb-saveName" maxlength="40" placeholder="My patch" autocomplete="off"></label>
  <label class="f">Category<select id="emb-saveCat"></select></label><p id="emb-saveNote"></p></div>
  <div class="libfoot"><button type="button" id="emb-saveCancel">Cancel</button><button type="submit" class="primary">Save patch</button></div>
</form></div>
<div class="wrap">
<div class="bar">
  <div class="tabs" id="emb-tabs" role="tablist" aria-label="Instrument"></div>
  <div class="layer">
    <select id="emb-mode" aria-label="Keyboard mode"><option value="single">Single</option><option value="layer">Layer A + B</option><option value="split">Split A / B</option></select>
    <span class="bset" id="emb-slotBtns"><button id="emb-editA" aria-pressed="true">Edit A</button><button id="emb-editB" aria-pressed="false">Edit B</button></span>
    <span class="bset" id="emb-bCtl"><label for="emb-bVol">B level</label><input type="range" id="emb-bVol" min="0" max="1.5" step="0.01"><select id="emb-bOct" aria-label="Slot B octave"><option value="-2">B −2 oct</option><option value="-1">B −1 oct</option><option value="0">B ±0 oct</option><option value="1">B +1 oct</option><option value="2">B +2 oct</option></select></span>
    <button id="emb-splitBtn">Split at C4</button>
  </div>
  <div class="slotinfo" id="emb-slotInfo"></div>
</div>
<div class="synth" id="emb-synth" data-theme="ember">
<div class="cheek"></div>
<div class="body">
  <div class="top">
    <div class="brand">
      <h1 id="emb-brand"></h1>
      <p id="emb-tag"></p>
      <div class="midi"><span class="led" id="emb-led"></span><span id="emb-midiStatus">Ready</span></div>
    </div>
    <div class="scope"><canvas id="emb-scope"></canvas></div>
    <div class="ctrl">
      <div class="patch"><button id="emb-prev" aria-label="Previous patch">‹</button><button id="emb-patchBtn" class="pname" aria-label="Open patch library"><small id="emb-pcat"></small><span id="emb-pname"></span></button><button id="emb-next" aria-label="Next patch">›</button></div>
      <div class="pbtns"><button id="emb-libBtn">Library</button><button id="emb-saveBtn">Save</button><button id="emb-panic">Panic</button></div>
    </div>
  </div>
  <div class="sections" id="emb-sections"></div>
</div>
<div class="cheek"></div>
</div>
<p class="note"><b>Five instruments:</b> pick one with the tabs. <b>Layer</b> plays slot A and B together; <b>Split</b> puts B below the split point (press “Split at…”, then a key to move it). <b>Edit A / Edit B</b> chooses which slot the panel shows. Knobs and faders: drag up/down (Shift = fine), scroll, or arrow keys; double-click resets. Mod wheel adds vibrato (on the organ it switches the rotary speaker fast/slow), sustain pedal works, CC74/CC71 control each instrument's main tone knobs. <b>ROLI Piano M / MPE:</b> in ROLI Dashboard turn on pitch bend and pressure and use the Lower zone. The arpeggiator follows the studio tempo.</p>
</div>`;

function wireUI(){
 $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-i]'); if(b) setInstrument(edS(), b.dataset.i); });
 $('#tabs').addEventListener('keydown', e => { if(e.key!=='ArrowRight' && e.key!=='ArrowLeft') return; const i = INSTR_ORDER.indexOf(edS().instr), n = INSTR_ORDER[(i + (e.key==='ArrowRight'?1:-1) + INSTR_ORDER.length) % INSTR_ORDER.length]; setInstrument(edS(), n); setTimeout(()=>$(`.tab[data-i="${n}"]`)?.focus()); e.preventDefault(); e.stopPropagation(); });
 $('#mode').onchange = e => { mode = e.target.value; if(mode==='single') editSlot = 0; panic(); renderPanel(); saveState(); e.target.blur(); };
 $('#editA').onclick = () => { editSlot = 0; renderPanel(); saveState(); };
 $('#editB').onclick = () => { editSlot = 1; renderPanel(); saveState(); };
 $('#bVol').oninput = e => { bVol = +e.target.value; if(ctx) slotLive(slots[1]); saveState(); };
 $('#bOct').onchange = e => { bOct = +e.target.value; saveState(); e.target.blur(); };
 $('#splitBtn').onclick = () => { learnSplit = !learnSplit; renderTop(); };
 $('#patchBtn').onclick = openLib; $('#libBtn').onclick = openLib;
 $('#prev').onclick = () => stepPatch(-1); $('#next').onclick = () => stepPatch(1);
 $('#libDone').onclick = closeDlgs; $('#panic').onclick = panic;
 for(const id of ['#lib','#saveDlg']) $(id).addEventListener('pointerdown', e => { if(e.target===$(id)) closeDlgs(); });
 root.addEventListener('keydown', e => { if(e.key==='Escape' && (!$('#lib').hidden || !$('#saveDlg').hidden)){ closeDlgs(); e.stopPropagation(); } });
 $('#libQ').addEventListener('input', renderLib);
 $('#cats').onclick = e => { const b = e.target.closest('[data-c]'); if(b){ libCat = b.dataset.c; renderLib(); } };
 $('#plist').onclick = e => {
  const b = e.target.closest('.pc'); if(!b) return; const s = edS(), name = b.dataset.n, user = b.dataset.u==='1';
  if(e.target.dataset.del){
   if(!e.target.classList.contains('armed')){ e.target.classList.add('armed'); e.target.textContent = 'Delete?'; return; }
   USER = USER.filter(u=>!(u.instr===s.instr && u.name===name)); saveUser();
   if(s.cur.user && s.cur.name===name){ s.cur = {...s.cur, user:false}; s.dirty = true; patchLabel(); }
   $('#libMsg').textContent = `Deleted “${name}”.`; renderLib(); return;
  }
  const x = allPatches(s.instr).find(x=>x.name===name && x.user===user); if(x) loadPatch(s, x);
 };
 $('#expBtn').onclick = async () => {
  if(!USER.length){ $('#libMsg').textContent = 'You have no saved patches to export yet.'; return; }
  const json = JSON.stringify({emberStudio:1, patches:USER}, null, 1), msg = [];
  try{ await navigator.clipboard.writeText(json); msg.push('copied to clipboard'); }catch(_){}
  try{ const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json],{type:'application/json'})); a.download = 'ember-studio-patches.json'; root.appendChild(a); a.click(); a.remove(); msg.push('downloaded (if your browser allows it)'); }catch(_){}
  $('#libMsg').textContent = `${USER.length} patch${USER.length>1?'es':''} ${msg.join(' and ') || 'could not be exported here'}.`;
 };
 $('#impFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if(!f) return;
  try{
   const d = JSON.parse(await f.text()), arr = Array.isArray(d) ? d : d.patches;
   const ok = (arr||[]).filter(u=>u && typeof u.name==='string' && u.name.trim() && u.p && typeof u.p==='object').map(u=>({instr: INSTR[u.instr] ? u.instr : 'ember', name:u.name.trim().slice(0,40), cat:String(u.cat||''), p:u.p}));
   if(!ok.length) throw 0;
   for(const u of ok){ USER = USER.filter(x=>!(x.instr===u.instr && x.name===u.name)); USER.push(u); }
   $('#libMsg').textContent = saveUser() ? `Imported ${ok.length} patch${ok.length>1?'es':''}.` : 'Imported for this session, but this browser won’t keep them.';
   libCat = 'Yours'; renderLib();
  }catch(_){ $('#libMsg').textContent = 'That file isn’t an Ember patch export.'; }
 };
 $('#saveName').addEventListener('input', saveHint);
 $('#saveBtn').onclick = () => { const s = edS(); $('#saveDlg').hidden = false; $('#lib').hidden = true; $('#saveName').value = s.cur.user ? s.cur.name : (s.cur.cat==='Init' ? '' : s.cur.name + ' 2'); $('#saveCat').value = INSTR[s.instr].cats.includes(s.cur.cat) ? s.cur.cat : INSTR[s.instr].cats[0]; saveHint(); $('#saveName').focus(); $('#saveName').select(); };
 $('#saveCancel').onclick = closeDlgs;
 $('#saveForm').addEventListener('submit', e => {
  e.preventDefault(); const s = edS(), name = $('#saveName').value.trim().slice(0,40);
  if(!name){ $('#saveNote').textContent = 'Give your patch a name first.'; return; }
  const p = Object.fromEntries(Object.entries(s.P).filter(([k])=>!DEV.includes(k)));
  const entry = {instr:s.instr, name, cat:$('#saveCat').value, p};
  USER = USER.filter(u=>!(u.instr===s.instr && u.name===name)); USER.push(entry);
  if(!saveUser()){ $('#saveNote').textContent = 'This browser won’t store patches here — they are still kept in your studio project.'; }
  s.cur = {cat:entry.cat, name, p, user:true}; s.dirty = false; patchLabel(); renderTop(); closeDlgs(); saveState();
  const last = store.get('ember-studio-last', {}); last[s.instr] = {name, user:true}; store.set('ember-studio-last', last);
 });
}

/* ---------- boot (no audio, no DOM: just restore the last state) ---------- */
{
 const dv = store.get('ember-studio-dev', null) || store.get('ember-dev', null);
 if(dv) for(const k of DEV) if(k in dv) DEVP[k] = dv[k];
 const st = store.get('ember-studio-state', null);
 if(st){ mode = ['single','layer','split'].includes(st.mode) ? st.mode : 'single'; editSlot = mode==='single' ? 0 : (st.editSlot|0); splitNote = st.splitNote||60; bVol = st.bVol ?? 0.8; bOct = st.bOct|0; }
 slots.forEach((s,i)=>{
  const ss = st?.slots?.[i]; if(ss && INSTR[ss.instr]) s.instr = ss.instr;
  const L = allPatches(s.instr), want = ss?.patch;
  const e = (want && L.find(x=>x.name===want.name && x.user===want.user)) || (i===0 && s.instr==='ember' ? L.find(x=>x.name==='Wall of Sound') : null) || L.find(x=>x.cat!=='Init') || L[0];
  s.P = {...baseOf(s.instr), ...e.p, ...DEVP}; s.cur = e;
 });
}

/* ---------- project state ---------- */
const patchParams = P => Object.fromEntries(Object.entries(P).filter(([k])=>!DEV.includes(k)));
function getState(){
 return {v:1, mode, editSlot, splitNote, bVol, bOct,
  dev: Object.fromEntries(DEV.filter(k=>k!=='tempo').map(k=>[k, DEVP[k]])),
  slots: slots.map(s=>({instr:s.instr, patch: s.cur ? {name:s.cur.name, cat:s.cur.cat, user:!!s.cur.user} : null, P: patchParams(s.P), dirty: !!s.dirty})),
  user: USER.map(u=>({instr:u.instr, name:u.name, cat:u.cat, p:u.p}))};
}
function setState(st){
 if(!st || typeof st !== 'object') return;
 panic();
 if(Array.isArray(st.user)){
  for(const u of st.user){ if(!u || !INSTR[u.instr] || typeof u.name!=='string' || !u.p || typeof u.p!=='object') continue; USER = USER.filter(x=>!(x.instr===u.instr && x.name===u.name)); USER.push({instr:u.instr, name:u.name, cat:String(u.cat||''), p:u.p}); }
  saveUser();
 }
 if(st.dev) for(const k of DEV) if(k!=='tempo' && k in st.dev) DEVP[k] = st.dev[k];
 store.set('ember-studio-dev', DEVP);
 mode = ['single','layer','split'].includes(st.mode) ? st.mode : 'single';
 editSlot = mode==='single' ? 0 : (st.editSlot|0) ? 1 : 0;
 if(Number.isFinite(st.splitNote)) splitNote = st.splitNote;
 if(Number.isFinite(st.bVol)) bVol = st.bVol;
 if(Number.isFinite(st.bOct)) bOct = st.bOct|0;
 slots.forEach((s,i)=>{
  const ss = st.slots?.[i]; if(!ss || !INSTR[ss.instr]) return;
  arpClear(s); s.instr = ss.instr;
  const L = allPatches(s.instr), want = ss.patch;
  let e = want && L.find(x=>x.name===want.name && x.user===!!want.user);
  if(!e) e = want ? {cat: want.cat || INSTR[s.instr].cats[0], name: want.name, p: ss.P || {}, user: !!want.user} : (L.find(x=>x.cat!=='Init') || L[0]);
  s.P = {...baseOf(s.instr), ...e.p, ...(ss.P||{}), ...DEVP}; s.cur = e; s.dirty = !!ss.dirty;
  if(ctx) buildSlot(s);
 });
 saveState(); renderPanel();
}

/* ---------- plugin ---------- */
const def = {
 id:'ember', name:'Ember Studio', kind:'instrument', color:'#ec4a2c',
 icon:'<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 2.5c1.8 2.6 4.5 4.6 4.5 8.2a4.5 4.5 0 0 1-9 0c0-1.9.9-3.2 1.9-4.3.2 1.4.9 2.3 1.8 2.7-.4-2.4.1-4.5.8-6.6z"/></svg>',
 async init(c, out, S){
  if(ctx) return;   // already initialised
  ctx = c; OUT = out; Studio = S || window.Studio || null;
  const tr = Studio && Studio.transport;
  if(tr){
   if(Number.isFinite(tr.bpm)) setDev('tempo', tr.bpm);
   if(typeof tr.on === 'function') tr.on('bpm', b => { if(!Number.isFinite(b)) return; setDev('tempo', b); drawCtl('tempo'); });
  }
  await initAudio();
 },
 mount(el){
  if(root) return;
  root = el; el.classList.add('plug-ember');
  el.innerHTML = PANEL_HTML;
  cv = $('#scope'); cx = cv.getContext('2d');
  wireUI(); renderPanel(); updateMidiLabel();
  if(!raf) draw();
 },
 noteOn(note, vel, time, info){
  const ch = chOf(info); noteFlag(ch, info);
  noteOn(note|0, Math.max(1, Math.min(127, Math.round((vel == null ? 0.8 : vel)*127))), ch, time);
 },
 noteOff(note, time, info){ noteOff(note|0, chOf(info), time); },
 bend(semis, info){
  if(!ctx) return; const ch = chOf(info); noteFlag(ch, info);
  let n;
  if(info && Number.isFinite(info.raw)) n = (info.raw-8192)/8192;                 // raw 14-bit value if the shell passes it
  else if(info && Number.isFinite(info.norm)) n = info.norm;                        // or -1..1
  else n = (semis||0) / (isMember(ch) ? DEVP.bendRange : DEVP.gBend);               // semitones: undo Ember's own range scaling
  bendNorm(ch, n, ctx.currentTime);
 },
 pressure(value, info){
  if(!ctx) return; const ch = chOf(info); noteFlag(ch, info);
  const x = clamp(+value || 0, 0, 1);
  if(info && Number.isFinite(info.note)) setPressure(allVoices().filter(v=>v.key===info.note && !v.dead), x);  // poly aftertouch
  else chanPressure(ch, x);
 },
 cc(num, v01, info){ const ch = chOf(info); noteFlag(ch, info); onCC(ch, num|0, Math.round(clamp(+v01 || 0, 0, 1)*127)); },
 allNotesOff(){ panic(); },
 getState, setState,
 // test / debug hooks
 _debug: { slots, INSTR, INSTR_ORDER, LEVELS, allPatches, loadPatch: (i, name) => { const s = slots[i], e = allPatches(s.instr).find(x=>x.name===name); if(e) loadPatch(s, e); return !!e; },
  setInstrument: (i, id) => setInstrument(slots[i], id), onMidi: data => onMidi({data}), M, get ctx(){ return ctx; }, voices: allVoices, get mode(){ return mode; } }
};
function chOf(info){ const c = info && Number.isFinite(info.ch) ? info.ch|0 : 0; return c < 0 ? 0 : c > 16 ? 16 : c; }
function noteFlag(ch, info){ if(info && typeof info.mpe === 'boolean') mpeFlag[ch] = info.mpe; }

if(window.Studio && typeof window.Studio.registerPlugin === 'function') window.Studio.registerPlugin(def);
else console.warn('[ember] window.Studio not found; plugin not registered');
})();
