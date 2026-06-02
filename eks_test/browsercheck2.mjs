import { execFile } from 'node:child_process';
import { writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RESULT = '/tmp/eks_result.json';
if (existsSync(RESULT)) rmSync(RESULT);

// The page computes results then writes them where --dump-dom can read them:
// we stuff JSON into document.title and also a #result element. We poll the DOM
// repeatedly by re-dumping until the marker appears.
const html = `<!doctype html><meta charset=utf8><body><div id=result>PENDING</div><script type=module>
const R={};
async function pitchOf(d,lo,hi,a,b){let bl=0,bc=-1;for(let lag=lo;lag<hi;lag++){let c=0;for(let n=a;n<b;n++)c+=d[n]*d[n-lag];if(c>bc){bc=c;bl=lag;}}return 44100/bl;}
async function run(){
  try{
    // NATIVE DelayNode feedback loop -> C4
    const off=new OfflineAudioContext(1,44100,44100);
    const delay=off.createDelay(1); delay.delayTime.value=1/261.63;
    const fb=off.createGain(); fb.gain.value=0.99;
    const nb=off.createBuffer(1,128,44100); const nd=nb.getChannelData(0);
    for(let i=0;i<128;i++) nd[i]=Math.random()*2-1;
    const src=off.createBufferSource(); src.buffer=nb;
    src.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(off.destination); src.start();
    const buf=await off.startRendering();
    R.nativeHz=await pitchOf(buf.getChannelData(0),40,400,5000,20000);
    R.nativeC4ok=Math.abs(R.nativeHz-261.63)<15;
  }catch(e){R.nativeErr=e.message;}
  try{
    const off2=new OfflineAudioContext(1,44100,22050);
    const code=\`class KS extends AudioWorkletProcessor{constructor(){super();this.buf=new Float32Array(512);this.w=0;this.delay=44100/523.25;this.init=true;this.x1=0;}process(_,o){const out=o[0][0];for(let i=0;i<out.length;i++){let e=0;if(this.init&&this.w<64)e=Math.random()*2-1;const rp=(this.w-this.delay+512)%512;const i0=Math.floor(rp),fr=rp-i0;const s=this.buf[i0]*(1-fr)+this.buf[(i0+1)%512]*fr;let v=s+e;v=0.998*(0.5*v+0.5*this.x1);this.x1=v;this.buf[this.w]=v;this.w=(this.w+1)%512;out[i]=s;}if(this.w>200)this.init=false;return true;}}registerProcessor('ks',KS);\`;
    const url=URL.createObjectURL(new Blob([code],{type:'application/javascript'}));
    await off2.audioWorklet.addModule(url);
    const node=new AudioWorkletNode(off2,'ks'); node.connect(off2.destination);
    const buf2=await off2.startRendering();
    R.workletHz=await pitchOf(buf2.getChannelData(0),40,200,3000,12000);
    R.workletC5ok=Math.abs(R.workletHz-523.25)<20;
    R.workletSupported=true;
  }catch(e){R.workletErr=e.message;R.workletSupported=false;}
  document.getElementById('result').textContent='RESULT:'+JSON.stringify(R);
  document.title='DONE';
}
run();
</script></body>`;

writeFileSync('/tmp/eks_browser.html', html);
const profile = '/tmp/eks_chrome_profile2';

function dump() {
  return new Promise((res) => {
    execFile(CHROME, [
      '--headless=new','--disable-gpu','--no-sandbox',
      '--user-data-dir=' + profile,
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=6000',
      '--dump-dom','file:///tmp/eks_browser.html'
    ], { timeout: 45000, maxBuffer: 1<<24 }, (err, stdout) => {
      res(stdout || '');
    });
  });
}

const out = await dump();
const m = out.match(/RESULT:(\{.*?\})<\/div>/s);
if (m) {
  const R = JSON.parse(m[1]);
  console.log('Native DelayNode loop measuredHz:', R.nativeHz?.toFixed(1), '(wanted 261.63) C4 ok?', R.nativeC4ok, R.nativeErr ? 'ERR:'+R.nativeErr : '');
  console.log('AudioWorklet supported?', R.workletSupported, 'measuredHz:', R.workletHz?.toFixed(1), '(wanted 523.25) C5 ok?', R.workletC5ok, R.workletErr ? 'ERR:'+R.workletErr : '');
} else {
  console.log('NO RESULT MARKER. raw tail:', out.slice(-600));
}
