import { createServer } from 'node:http';
import { execFile } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const worklet = `class KS extends AudioWorkletProcessor{
  constructor(){super();this.buf=new Float32Array(512);this.w=0;this.delay=44100/523.25;this.init=true;this.x1=0;}
  process(_,o){const out=o[0][0];for(let i=0;i<out.length;i++){let e=0;if(this.init&&this.w<64)e=Math.random()*2-1;
  const rp=(this.w-this.delay+512)%512;const i0=Math.floor(rp),fr=rp-i0;
  const s=this.buf[i0]*(1-fr)+this.buf[(i0+1)%512]*fr;let v=s+e;v=0.998*(0.5*v+0.5*this.x1);this.x1=v;
  this.buf[this.w]=v;this.w=(this.w+1)%512;out[i]=s;}if(this.w>200)this.init=false;return true;}}
registerProcessor('ks',KS);`;

const page = `<!doctype html><meta charset=utf8><body><div id=result>PENDING</div><script type=module>
async function run(){const R={};try{
  const off=new OfflineAudioContext(1,44100,22050);
  await off.audioWorklet.addModule('/ks.js');
  const node=new AudioWorkletNode(off,'ks'); node.connect(off.destination);
  const buf=await off.startRendering(); const d=buf.getChannelData(0);
  let bl=0,bc=-1;for(let lag=40;lag<200;lag++){let c=0;for(let n=3000;n<12000;n++)c+=d[n]*d[n-lag];if(c>bc){bc=c;bl=lag;}}
  R.hz=44100/bl; R.c5ok=Math.abs(R.hz-523.25)<20; R.loaded=true;
}catch(e){R.err=e.message;R.loaded=false;}
document.getElementById('result').textContent='RESULT:'+JSON.stringify(R);}
run();
</script></body>`;

const server = createServer((req, res) => {
  if (req.url === '/ks.js') { res.setHeader('Content-Type','application/javascript'); res.end(worklet); }
  else { res.setHeader('Content-Type','text/html'); res.end(page); }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

execFile(CHROME, [
  '--headless=new','--disable-gpu','--no-sandbox',
  '--user-data-dir=/tmp/eks_chrome_profile3',
  '--virtual-time-budget=6000','--dump-dom',
  `http://localhost:${port}/`
], { timeout: 45000, maxBuffer: 1<<24 }, (err, stdout) => {
  const m = (stdout||'').match(/RESULT:(\{.*?\})<\/div>/s);
  if (m) {
    const R = JSON.parse(m[1]);
    console.log('AudioWorklet over http: loaded?', R.loaded, 'measuredHz:', R.hz?.toFixed(1), '(wanted 523.25) C5 ok?', R.c5ok, R.err ? 'ERR:'+R.err : '');
  } else {
    console.log('NO MARKER. tail:', (stdout||'').slice(-400));
  }
  server.close();
});
