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

// 측정 비조화 계수 B(f₀): treble bridge 점근선(A3≈2e-4, A4≈7e-4)에 맞춘 멱법칙.
function inharmonicity(f0) {
  return 2.0e-4 * Math.pow(f0 / 220, 1.81);
}

class Voice {
  constructor(midi, vel) {
    const f0 = midiToFreq(midi);
    const v = Math.min(1, Math.max(0.05, vel));
    this.dead = false;

    const B = inharmonicity(f0);
    const nyq = 0.45 * SR;
    const x0 = 1 / 8; // 타현 위치(현 길이의 1/8) → 8배수 배음 억제
    // 배음 롤오프(dB/100Hz): 사용자의 실제 피아노(따뜻·어두움, 고역 가파르게 감쇠)에 맞춤.
    // 고역 배음을 빠르게 줄여 묵직한 음색. 속도가 셀수록 약간 완만(셈여림 밝기).
    const rolloff = Math.min(3.0, Math.max(0.8, 1.7 + (0.6 - v) * 1.0));
    // 유니즌 3현 미세 디튠(≈±0.4cent) → 맥놀이 (정량 측정 미확정, 추정값)
    const detunes = [-0.00025, 0.00003, 0.00025];

    const a1 = [],
      a2 = [],
      init = [];
    for (const det of detunes) {
      const fs = f0 * (1 + det);
      for (let n = 1; n <= 48; n++) {
        const fn = n * fs * Math.sqrt(1 + B * n * n); // 비조화 모드 주파수
        if (fn >= nyq) break;
        const env = Math.pow(10, (-rolloff * (fn - f0)) / 2000); // -rolloff dB/100Hz
        if (env < 5e-4 && n > 6) break; // 측정 포락선상 들리지 않는 고배음 컷
        const w = (2 * Math.PI * fn) / SR;
        const sigma = 0.13 + 0.00212 * fn; // 측정 기반 감쇠율(고배음일수록 큼)
        const r = Math.exp(-sigma / SR);
        const comb = Math.sin(n * Math.PI * x0); // 타현 위치 빗
        a1.push(2 * r * Math.cos(w));
        a2.push(-r * r);
        init.push(comb * env * v); // 망치 임펄스 = 초기 모드 진폭(빗×포락선×음량)
      }
    }
    const M = a1.length;
    this.M = M;
    this.a1 = Float64Array.from(a1);
    this.a2 = Float64Array.from(a2);
    this.y1 = Float64Array.from(init); // 초기 상태 주입 = 임펄스 가진
    this.y2 = new Float64Array(M);

    // 레지스터 음량 보정(고음은 모드가 적어 작음) — 캘리브레이션으로 도4~도5 균형
    this.norm = Math.pow(f0 / 261.63, 1.45);

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
    this.voiceGain = init && init.voiceGain != null ? init.voiceGain : 0.0066;
    // 사운드보드 복사(radiation) 근사: 저음(기본음) 약화 + 중역(노래하는 0.5~3kHz) 강조
    // → 진짜 그랜드처럼 2~7배음이 살아 밝고 풍부해짐. 거친 초고역은 약화.
    // 사용자 피아노(따뜻·어두움)에 맞춘 사운드보드: 저중역 따뜻함 + 고역 강한 약화.
    this.sb = [
      makeHighPass(100, 0.7), // 초저역만 정리(저음 풍부함 유지)
      makeBiquadPeak(380, 0.7, 3), // 저중역 바디/따뜻함
      makeHighShelf(2600, -9), // 어두운 음색: 고역 강하게 약화
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
