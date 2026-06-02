// Headless Chrome check: can a NATIVE DelayNode feedback loop reach C4/C5,
// and does AudioWorklet render correctly offline? Uses OfflineAudioContext.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const html = `<!doctype html><meta charset=utf8><body><script type=module>
const log = (m)=>{ const p=document.createElement('pre'); p.textContent=m; p.id='out'+Math.random(); document.body.appendChild(p); window.__logs=(window.__logs||[]); window.__logs.push(m); };

async function run(){
  // 1) Native DelayNode minimum-delay test: what's the smallest reliable delay?
  // DelayNode delayTime is k-rate-ish per block; the real limiter for KS loops
  // is that DelayNode introduces a minimum 1-render-quantum (128 sample) latency
  // in a feedback loop on many engines. Test by building a feedback comb and
  // measuring resulting pitch.
  const off = new OfflineAudioContext(1, 44100, 44100);
  // feedback loop: source -> delay -> gain -> back to delay
  const delay = off.createDelay(1);
  delay.delayTime.value = 1/261.63; // want C4
  const fb = off.createGain(); fb.gain.value = 0.99;
  const noise = off.createBufferSource();
  const nb = off.createBuffer(1,128,44100);
  const nd = nb.getChannelData(0);
  for(let i=0;i<128;i++) nd[i]=Math.random()*2-1;
  noise.buffer = nb;
  noise.connect(delay); delay.connect(fb); fb.connect(delay);
  delay.connect(off.destination);
  noise.start();
  const buf = await off.startRendering();
  const d = buf.getChannelData(0);
  // crude pitch via autocorrelation peak between lags 40..400
  let bestLag=0,bestC=-1;
  for(let lag=40;lag<400;lag++){
    let c=0; for(let n=5000;n<20000;n++) c+=d[n]*d[n-lag];
    if(c>bestC){bestC=c;bestLag=lag;}
  }
  const measuredHz = 44100/bestLag;
  log('NATIVE DelayNode loop: wanted 261.63Hz, measured '+measuredHz.toFixed(1)+'Hz (lag='+bestLag+')');
  log('native loop usable for C4? '+(Math.abs(measuredHz-261.63)<15));

  // 2) AudioWorklet test
  try {
    const off2 = new OfflineAudioContext(1,44100,22050);
    const code = \`
      class KS extends AudioWorkletProcessor {
        constructor(){ super(); this.buf=new Float32Array(512); this.w=0; this.delay=44100/523.25; this.init=true; this.x1=0; }
        process(_,outs){
          const out=outs[0][0];
          for(let i=0;i<out.length;i++){
            let exc=0;
            if(this.init && this.w<64){ exc=Math.random()*2-1; }
            const rp=(this.w-this.delay+512)%512;
            const i0=Math.floor(rp), fr=rp-i0;
            const s=this.buf[i0]*(1-fr)+this.buf[(i0+1)%512]*fr;
            let v=(s+exc);
            v=0.998*(0.5*v+0.5*this.x1); this.x1=v;
            this.buf[this.w]=v; this.w=(this.w+1)%512;
            out[i]=s;
          }
          if(this.w>200) this.init=false;
          return true;
        }
      }
      registerProcessor('ks',KS);
    \`;
    const blob = new Blob([code],{type:'application/javascript'});
    const url = URL.createObjectURL(blob);
    await off2.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(off2,'ks');
    node.connect(off2.destination);
    const buf2 = await off2.startRendering();
    const d2 = buf2.getChannelData(0);
    let bestLag2=0,bestC2=-1;
    for(let lag=40;lag<200;lag++){
      let c=0; for(let n=3000;n<12000;n++) c+=d2[n]*d2[n-lag];
      if(c>bestC2){bestC2=c;bestLag2=lag;}
    }
    log('AudioWorklet KS loop: wanted 523.25Hz, measured '+(44100/bestLag2).toFixed(1)+'Hz');
    log('worklet usable for C5? '+(Math.abs(44100/bestLag2-523.25)<20));
  } catch(e){ log('AudioWorklet ERROR: '+e.message); }

  window.__done = true;
}
run();
</script></body>`;

writeFileSync('/tmp/eks_browser.html', html);

const profile = '/tmp/eks_chrome_profile';
try {
  const out = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + profile,
    '--virtual-time-budget=8000',
    '--dump-dom',
    'file:///tmp/eks_browser.html'
  ], { timeout: 60000, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  // extract <pre> contents
  const matches = [...out.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map(m=>m[1]);
  console.log(matches.length ? matches.join('\n') : '(no pre output captured)\n'+out.slice(0,500));
} catch(e){
  console.log('CHROME RUN FAILED:', e.message);
  if(e.stdout) console.log('stdout:', e.stdout.toString().slice(0,800));
}
