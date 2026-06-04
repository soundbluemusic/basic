// ============================================================================
// 피아노 전용 모달 물리 모델 합성 엔진 (AudioWorklet · 샘플 단위 DSP)
// ----------------------------------------------------------------------------
// 표준 그랜드 피아노의 "실측 음향 파라미터"를 정답지로 삼아 맞춘 모달 합성.
// 소리 = 물리에서 도출한 감쇠 사인파(현의 진동 모드)의 합. 샘플 녹음 없음.
//
// 측정 근거(논문):
//  · 비조화 B(음): Rigaud–David–Daudet 2013(JASA 133-5) / Railsback,
//      A3≈2e-4, A4≈7e-4 → B = 2e-4·(f₀/220)^1.81  (중역→고역 증가)
//      비조화 모드: fₙ = n·f₀·√(1+B·n²)
//  · 배음 진폭 롤오프: Fletcher–Blackham–Stratton 1962(JASA 34-6),
//      "최적 음질 = 부분음이 주파수 100 Hz당 2 dB 감소"(부분음 번호 아님, 주파수 기준)
//  · 감쇠: FBS 1962, 저음 ~20초·초고역 <1초, 고배음이 먼저 죽음 → σ(f)=0.13+0.00212·f
//  · 2단 감쇠(prompt/aftersound, Weinreich 1977): 주파수 의존 감쇠로 창발
//      (고배음이 빨리 죽어 밝은 어택 → 기본음만 길게 남는 여음)
//  · 타현 위치 빗: Hall 1986(JASA 79-1), 타현점 L/8의 마디 모드 억제 → sin(n·π/8)
//  · 망치: 접촉<10ms(FBS), 세게 칠수록 밝음 → 임펄스 가진 + 속도 의존 롤오프 틸트
//  · 유니즌 3현 미세 디튠 → 맥놀이(수치는 측정 미확정, ±0.4cent 추정)
//
// 각 모드 = 2차 공진기(감쇠 사인파). 망치 타격은 초기 진폭 주입(임펄스 응답)으로
// 표현하고, 초기 진폭 = (타현 빗)×(측정 배음 롤오프 포락선)×(속도 음량).
// ============================================================================

const SR = sampleRate;

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// 비조화 계수 B(f₀): U자 곡선. 중역 최소, 저음·고음으로 상승.
//  · treble bridge 점근선(A3≈2e-4, A4≈7e-4) 멱법칙
//  · bass: 권선현 강성으로 저음에서 비조화 상승(FBS 실측 경향)
function inharmonicity(f0) {
  const treble = 2.0e-4 * Math.pow(f0 / 220, 1.81);
  const bass = 6.0e-5 * Math.pow(180 / Math.max(f0, 28), 1.6);
  return Math.max(treble, bass);
}

class Voice {
  constructor(midi, vel) {
    const f0 = midiToFreq(midi);
    const v = Math.min(1, Math.max(0.05, vel));
    this.dead = false;

    const B = inharmonicity(f0);
    const nyq = 0.45 * SR;
    // 타현 위치(현 길이의 1/8) → 8배수 배음 억제. 매 타건 미세 랜덤(안티-머신건).
    const x0 = 1 / 8 + 0.005 * (Math.random() * 2 - 1);
    // 배음 롤오프(dB/100Hz): 사용자 실제 피아노의 공정 스펙트럼(중역 기준)에 맞춤.
    // 고역 brilliance가 생각보다 풍부해 과한 어둠을 거두고 중간값으로.
    const rolloff = Math.min(2.5, Math.max(0.4, 1.0 + (0.6 - v) * 0.9));
    // 레지스터별 현 수: 저음 권선현 1~2개, 중·고음 3개 (실제 피아노 구조)
    const numStrings = f0 < 120 ? 1 : f0 < 250 ? 2 : 3;
    const baseDet =
      numStrings === 3
        ? [-0.00025, 0.00003, 0.00025]
        : numStrings === 2
          ? [-0.0003, 0.0003]
          : [0];
    // 2단 감쇠(prompt/aftersound): 현마다 감쇠율을 살짝 달리해 빠른+느린 꼬리 창발
    const decayMul =
      numStrings === 3 ? [1.18, 1.0, 0.86] : numStrings === 2 ? [1.12, 0.9] : [1.0];
    // 안티-머신건: 매 타건 미세 랜덤(디튠·음량) → 반복해도 똑같지 않게
    const jit = () => Math.random() * 2 - 1;
    const detunes = baseDet.map((d) => d + 0.0002 * jit());
    const ampJit = 1 + 0.08 * jit();

    const a1 = [],
      a2 = [],
      init = [];
    const firstPartials = []; // 저음 phantom 계산용(첫 현의 낮은 배음들)
    for (let si = 0; si < detunes.length; si++) {
      const fs = f0 * (1 + detunes[si]);
      const dmul = decayMul[si];
      for (let n = 1; n <= 48; n++) {
        const fn = n * fs * Math.sqrt(1 + B * n * n); // 비조화 모드 주파수
        if (fn >= nyq) break;
        const env = Math.pow(10, (-rolloff * (fn - f0)) / 2000); // -rolloff dB/100Hz
        if (env < 5e-4 && n > 6) break; // 측정 포락선상 들리지 않는 고배음 컷
        const w = (2 * Math.PI * fn) / SR;
        const sigma = (0.13 + 0.00212 * fn) * dmul; // 주파수 의존 + 현별 2단감쇠
        const r = Math.exp(-sigma / SR);
        const comb = Math.sin(n * Math.PI * x0); // 타현 위치 빗
        const amp = comb * env * v * ampJit; // 빗×포락선×음량(현별)
        a1.push(2 * r * Math.cos(w));
        a2.push(-r * r);
        init.push(amp);
        if (si === 0 && n <= 6) firstPartials.push({ f: fn, a: amp });
      }
    }

    // ── 저음 종진동/phantom partial: 횡진동 배음의 합주파수(fᵢ+fⱼ), 가진 제곱(∝vel²) ──
    // 저음의 '금속성 울림'·어택의 정체 (Bank SMAC03). 중·고음(f0≥250)엔 안 붙임.
    if (f0 < 250) {
      const pg = 0.45;
      for (let i = 0; i < firstPartials.length; i++) {
        for (let j = i; j < Math.min(firstPartials.length, i + 3); j++) {
          const fp = firstPartials[i].f + firstPartials[j].f;
          if (fp >= nyq) continue;
          const amp = pg * Math.abs(firstPartials[i].a) * Math.abs(firstPartials[j].a);
          if (amp < 1e-4) continue;
          const w = (2 * Math.PI * fp) / SR;
          const sigma = (0.13 + 0.00212 * fp) * 0.8; // forced → 약간 더 길게
          const r = Math.exp(-sigma / SR);
          a1.push(2 * r * Math.cos(w));
          a2.push(-r * r);
          init.push(amp);
        }
      }
    }
    const M = a1.length;
    this.M = M;
    this.a1 = Float64Array.from(a1);
    this.a2 = Float64Array.from(a2);
    this.y1 = Float64Array.from(init); // 초기 상태 주입 = 임펄스 가진
    this.y2 = new Float64Array(M);

    // 레지스터 음량 보정(전 음역 88키 균형):
    //  · 중·고음(f0≥~177Hz): (f0/261.63)^1.45 — 모드 적은 고음 보상(도4~도5 튜닝 보존)
    //  · 저음(f0<~177Hz): 완만한 바닥 곡선 — 모드 많고 phantom 있는 저음이 깔리지 않게
    const r0 = f0 / 261.63;
    this.norm = Math.max(Math.pow(r0, 1.45), 0.62 * Math.pow(r0, 0.22));

    this.env = 0;
    this.peak = 1e-9;
    this.rel = Math.exp(-1 / (0.03 * SR));
  }

  render() {
    const a1 = this.a1,
      a2 = this.a2,
      y1 = this.y1,
      y2 = this.y2,
      M = this.M;
    let out = 0;
    for (let i = 0; i < M; i++) {
      const y = a1[i] * y1[i] + a2[i] * y2[i]; // 자유 감쇠(임펄스 응답)
      y2[i] = y1[i];
      y1[i] = y;
      out += y;
    }
    const a = out < 0 ? -out : out;
    if (a > this.peak) this.peak = a;
    this.env = a > this.env ? a : this.env * this.rel;
    if (this.env < this.peak * 1.5e-4) this.dead = true;
    return out;
  }
}

// ── 사운드보드 바디(가벼운 보정) ──
// 정밀 사운드보드 포먼트(Conklin/Giordano)는 아직 실측 수치 미확정이라
// 과장 없이 최소만: 저역 따뜻함 1개 + 거친 고역 약화.
function makeBiquadPeak(f0, Q, dB) {
  const A = Math.pow(10, dB / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cosw) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha / A) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}
function makeHighPass(f0, Q) {
  const w0 = (2 * Math.PI * f0) / SR;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cosw) / 2) / a0,
    b1: (-(1 + cosw)) / a0,
    b2: ((1 + cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}
function makeHighShelf(f0, dB) {
  const A = Math.pow(10, dB / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / 1 - 1) + 2);
  const tsa = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cosw + tsa;
  return {
    b0: (A * (A + 1 + (A - 1) * cosw + tsa)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cosw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cosw - tsa)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cosw)) / a0,
    a2: (A + 1 - (A - 1) * cosw - tsa) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
  };
}
function biquad(s, x) {
  const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

class PianoProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.voices = [];
    this.MAX = 16;
    const init = options && options.processorOptions;
    this.testLinear = !!(init && init.testLinear);
    this.voiceGain = init && init.voiceGain != null ? init.voiceGain : 0.0044;
    // 사운드보드 복사(radiation) 근사: 저음(기본음) 약화 + 중역(노래하는 0.5~3kHz) 강조
    // → 진짜 그랜드처럼 2~7배음이 살아 밝고 풍부해짐. 거친 초고역은 약화.
    // 사용자 피아노의 공정 스펙트럼에 맞춘 사운드보드: 저중역 따뜻함 + 고역 brilliance 복원.
    this.sb = [
      makeHighPass(100, 0.7), // 초저역만 정리
      makeBiquadPeak(380, 0.7, 3), // 저중역 바디/따뜻함
      makeBiquadPeak(850, 0.8, 4), // 760~960Hz 딥 보강
      makeHighShelf(3500, 5), // 고역 공기감/brilliance 복원(실측 대비 부족분)
    ];
    if (init && init.midi != null) {
      this.voices.push(new Voice(init.midi, init.vel == null ? 0.8 : init.vel));
    }
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'noteOn') {
        if (this.voices.length >= this.MAX) this.voices.shift();
        this.voices.push(new Voice(d.midi, d.vel == null ? 0.8 : d.vel));
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const N = out[0].length;
    const voices = this.voices;
    const sb = this.sb;
    const vg = this.voiceGain;
    const lin = this.testLinear;

    for (let s = 0; s < N; s++) {
      let mix = 0;
      for (let v = 0; v < voices.length; v++) {
        mix += voices[v].render() * vg * voices[v].norm;
      }
      for (let b = 0; b < sb.length; b++) mix = biquad(sb[b], mix);
      const y = lin ? mix : Math.tanh(mix);
      for (let c = 0; c < out.length; c++) out[c][s] = y;
    }

    if (voices.some((v) => v.dead)) this.voices = voices.filter((v) => !v.dead);
    return true;
  }
}

registerProcessor('piano-processor', PianoProcessor);
