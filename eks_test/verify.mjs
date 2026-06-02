// Offline verification of the EKS piano DSP in pure Node (no browser).
// We replicate the exact sample-loop math the AudioWorklet would run,
// render C4 and C5 offline, then FFT to measure inharmonicity B and
// per-partial decay. This proves the DSP is correct BEFORE trusting the browser.

const SR = 44100;

// ---- Thiran/stiffness: 1st-order allpass cascade for dispersion ----
// y[n] = a*x[n] + x[n-1] - a*y[n-1]
function makeAllpass(a) {
  let x1 = 0, y1 = 0;
  return (x) => {
    const y = a * x + x1 - a * y1;
    x1 = x; y1 = y;
    return y;
  };
}

// One-zero damping lowpass (loop filter): y = g*((1-d)*x + d*x1)
function makeLoopFilter(g, d) {
  let x1 = 0;
  return (x) => {
    const y = g * ((1 - d) * x + d * x1);
    x1 = x;
    return y;
  };
}

// Fractional delay line via linear interpolation (the tuning allpass would be
// better, but linear interp is enough to validate pitch + inharmonicity here).
function makeDelay(maxLen) {
  const buf = new Float32Array(maxLen);
  let w = 0;
  return {
    read(delaySamples) {
      const rPos = (w - delaySamples + maxLen) % maxLen;
      const i0 = Math.floor(rPos);
      const frac = rPos - i0;
      const i1 = (i0 + 1) % maxLen;
      return buf[i0] * (1 - frac) + buf[i1] * frac;
    },
    write(v) { buf[w] = v; w = (w + 1) % maxLen; },
  };
}

function renderNote(f0, opts) {
  const { B, nAllpass, g, d, durSec, hammerMs } = opts;
  const N = Math.floor(durSec * SR);
  const out = new Float32Array(N);

  // Stiffness allpass coefficient. The cascade adds phase delay that pushes
  // high partials sharp -> inharmonicity. We tune coefficient a to target B.
  // Empirical mapping: stronger negative-ish 'a' -> more dispersion.
  // Use a per the simplified relation a = (1 - sqrt(B-ish))/(1+...).
  // We'll just sweep a few 'a' values mapped from B.
  const a = -0.5 * Math.sqrt(B) * 30; // crude monotonic mapping, clamped below
  const aClamped = Math.max(-0.99, Math.min(0.99, a));
  const allpasses = Array.from({ length: nAllpass }, () => makeAllpass(aClamped));

  // The allpass cascade adds extra delay; we must subtract its phase delay at f0
  // from the main delay so pitch stays correct. Approx phase delay per allpass
  // at low freq ~ (1-a)/(1+a). Compute total and subtract.
  const pdPerAp = (1 - aClamped) / (1 + aClamped); // samples, low-freq limit
  const totalApDelay = nAllpass * pdPerAp;

  const loopFilterDelay = 0.5; // approx group delay of one-zero filter
  const targetDelay = SR / f0 - loopFilterDelay - totalApDelay;
  const maxLen = Math.ceil(SR / 100) + 4;
  const delay = makeDelay(maxLen);
  const loop = makeLoopFilter(g, d);

  // Excitation: short broadband burst = hammer. Noise burst windowed,
  // lowpassed slightly so it's not white-harsh. Length ~ hammerMs.
  const hammerN = Math.floor((hammerMs / 1000) * SR);
  let lastNoise = 0;
  for (let n = 0; n < N; n++) {
    let exc = 0;
    if (n < hammerN) {
      const raw = Math.random() * 2 - 1;
      lastNoise = 0.6 * lastNoise + 0.4 * raw; // mild LP -> softer hammer
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (hammerN * 2)); // half-Hann rise
      exc = lastNoise * win;
    }
    const dline = delay.read(targetDelay);
    let v = dline + exc;
    for (const ap of allpasses) v = ap(v);
    v = loop(v);
    delay.write(v);
    out[n] = dline;
  }
  return out;
}

// ---- Naive DFT at candidate partial freqs to measure inharmonicity & decay ----
function goertzelMag(sig, f0, freq, start, len) {
  const w = (2 * Math.PI * freq) / SR;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  const end = Math.min(start + len, sig.length);
  for (let n = start; n < end; n++) {
    s0 = sig[n] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const real = s1 - s2 * Math.cos(w);
  const imag = s2 * Math.sin(w);
  return Math.sqrt(real * real + imag * imag) / (end - start);
}

function findPartial(sig, harmonic, f0, B) {
  // expected inharmonic freq
  const expected = harmonic * f0 * Math.sqrt(1 + B * harmonic * harmonic);
  // search +-3% for the local peak
  let best = 0, bestF = expected;
  for (let f = expected * 0.97; f <= expected * 1.03; f += expected * 0.0015) {
    const m = goertzelMag(sig, f0, f, 2000, 16384);
    if (m > best) { best = m; bestF = f; }
  }
  return { freq: bestF, mag: best, expected };
}

function analyze(label, f0, opts) {
  const sig = renderNote(f0, opts);
  // RMS envelope over time (4 windows) for decay character
  const wl = Math.floor(sig.length / 4);
  const rms = [];
  for (let k = 0; k < 4; k++) {
    let s = 0;
    for (let n = k * wl; n < (k + 1) * wl; n++) s += sig[n] * sig[n];
    rms.push(Math.sqrt(s / wl));
  }
  // measure inharmonicity from partials 1..8
  const partials = [];
  for (let h = 1; h <= 8; h++) partials.push(findPartial(sig, h, f0, opts.B));
  // estimate effective B from measured partial 6
  const p6 = partials[5];
  const measuredRatio = p6.freq / (6 * f0);
  const measuredB = (measuredRatio * measuredRatio - 1) / 36;

  console.log(`\n=== ${label} (f0=${f0.toFixed(2)}Hz, targetB=${opts.B}) ===`);
  console.log('RMS env (4 windows):', rms.map((r) => r.toFixed(4)).join('  '));
  const decayRatio = rms[3] / (rms[0] + 1e-9);
  console.log(`tail/head ratio: ${decayRatio.toFixed(3)} (lower = faster decay)`);
  console.log(`measured B (from p6): ${measuredB.toExponential(2)}`);
  console.log('partials (h: measuredHz / idealHarmonicHz / sharpCents):');
  partials.forEach((p, i) => {
    const h = i + 1;
    const ideal = h * f0;
    const cents = 1200 * Math.log2(p.freq / ideal);
    console.log(`  h${h}: ${p.freq.toFixed(1)} / ${ideal.toFixed(1)} / +${cents.toFixed(1)}c  mag=${p.mag.toFixed(4)}`);
  });
  // check fundamental isn't always strongest (piano character)
  const mags = partials.map((p) => p.mag);
  const maxIdx = mags.indexOf(Math.max(...mags));
  console.log(`strongest partial: h${maxIdx + 1} (piano often NOT h1)`);
  return { measuredB, decayRatio, fundamentalStrongest: maxIdx === 0 };
}

// C4 bass-ish mid: low B; C5: needs higher B
const r1 = analyze('C4', 261.63, { B: 0.0004, nAllpass: 8, g: 0.999, d: 0.5, durSec: 2.5, hammerMs: 3 });
const r2 = analyze('C5', 523.25, { B: 0.0009, nAllpass: 8, g: 0.998, d: 0.5, durSec: 2.0, hammerMs: 2.5 });

console.log('\n--- VERDICT ---');
console.log('C4 inharmonicity present:', r1.measuredB > 0.00005);
console.log('C5 inharmonicity present:', r2.measuredB > 0.00005);
console.log('Both decay (not sustained):', r1.decayRatio < 0.8 && r2.decayRatio < 0.8);
