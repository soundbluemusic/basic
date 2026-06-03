// ============================================================================
// 피아노 전용 모달 물리 모델 합성 엔진 (AudioWorklet · 샘플 단위 DSP)
// ----------------------------------------------------------------------------
// Pianoteq 계열 modal synthesis: 소리 = "물리에서 도출한 감쇠 사인파(현의 진동
// 모드)의 합". 샘플 녹음 없음 — 현의 물리를 실시간으로 푼다.
//
//  · 비조화 강성 현:     fₙ = n·f₀·√(1+B·n²)        (현이 뻣뻣해 배음이 위로 늘어남)
//  · 주파수 의존 감쇠:    고배음이 먼저 죽음           (시간이 갈수록 어두워짐)
//  · 타현 위치 빗(comb):  망치가 현의 1/8 지점 타격     (8배수 배음이 약함)
//  · 유니즌 3현 미세 디튠: 맥놀이 + 2단 감쇠            (자연 발생)
//  · 속도 의존 망치 접촉력: 세게 칠수록 접촉이 짧아 밝아짐 (실제 물리)
//  · 사운드보드 공진(포먼트) + 소프트 리미터
//
// 각 모드는 2차 공진기(감쇠 사인파 발진)로 구현하고, 망치 접촉력 펄스로 가진한다.
// 이것이 "모달 공진기 뱅크를 망치로 때린다"는 진짜 물리 엔진 구조다.
// ============================================================================

const SR = sampleRate; // AudioWorkletGlobalScope 전역

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// ── 한 음(현 다발) = 모달 공진기 뱅크 ──
class Voice {
  constructor(midi, vel) {
    const f0 = midiToFreq(midi);
    const v = Math.min(1, Math.max(0.05, vel));
    this.dead = false;

    // 비조화 계수 B: 레지스터가 높을수록 큼(강성 영향↑).
    const B = 0.0004 * Math.pow(f0 / 261.63, 1.0);
    const nyq = 0.45 * SR;
    const x0 = 1 / 8; // 타현 위치(현 길이의 1/8) → 8배수 배음 약화
    // 유니즌 3현: 미세 디튠(≈±1cent)으로 맥놀이 + 2단 감쇠가 자연 발생
    const detunes = [-0.0006, 0.00004, 0.0006];

    const a1 = [],
      a2 = [],
      b0 = [],
      sh = [];
    for (const det of detunes) {
      const fs = f0 * (1 + det);
      for (let n = 1; n <= 48; n++) {
        const fn = n * fs * Math.sqrt(1 + B * n * n); // 비조화 모드 주파수
        if (fn >= nyq) break;
        const w = (2 * Math.PI * fn) / SR;
        const sigma = 0.6 + 0.003 * fn; // 주파수 의존 감쇠율(1/s): 고음일수록 큼
        const r = Math.exp(-sigma / SR);
        a1.push(2 * r * Math.cos(w));
        a2.push(-r * r);
        b0.push(Math.sin(w)); // 공진기 진폭 정규화
        sh.push(Math.sin(n * Math.PI * x0)); // 타현/픽업 모드 형상(빗 구조)
      }
    }
    const M = a1.length;
    this.M = M;
    this.a1 = new Float64Array(a1);
    this.a2 = new Float64Array(a2);
    this.b0 = new Float64Array(b0);
    this.sh = new Float64Array(sh);
    this.y1 = new Float64Array(M);
    this.y2 = new Float64Array(M);

    // 속도 의존 망치 접촉력 펄스(raised-cosine): 세게 칠수록 짧고 강함
    //  - 짧은 펄스 = 넓은 스펙트럼 = 고배음 더 많이 가진 → 밝아짐 (실제 망치 거동 근사)
    this.W = Math.max(8, Math.round((0.006 - 0.0042 * v) * SR)); // 6ms(약)~1.8ms(강)
    this.k = 0;
    this.force = 2.3 * v;

    // 소멸 감지용 엔벨로프 추종기
    this.env = 0;
    this.peak = 1e-9;
    this.rel = Math.exp(-1 / (0.03 * SR)); // 30ms 릴리스
    // 레지스터 보정: 고음은 모드가 적어 원시 진폭이 작으므로 부스트해 음량 균형.
    this.norm = Math.pow(f0 / 261.63, 1.25);
  }

  render() {
    // 망치 접촉력 (펄스 구간 동안만)
    let F = 0;
    if (this.k < this.W) {
      F = this.force * 0.5 * (1 - Math.cos((2 * Math.PI * this.k) / this.W));
      this.k++;
    }
    const a1 = this.a1,
      a2 = this.a2,
      b0 = this.b0,
      sh = this.sh,
      y1 = this.y1,
      y2 = this.y2,
      M = this.M;
    let out = 0;
    for (let i = 0; i < M; i++) {
      const x = b0[i] * sh[i] * F; // 모드별 가진(빗 형상 반영)
      const y = a1[i] * y1[i] + a2[i] * y2[i] + x; // 2차 공진기(감쇠 사인파)
      y2[i] = y1[i];
      y1[i] = y;
      out += sh[i] * y; // 픽업: 모드 형상 가중 합
    }
    // 소멸 추적
    const a = out < 0 ? -out : out;
    if (a > this.peak) this.peak = a;
    this.env = a > this.env ? a : this.env * this.rel;
    if (this.k >= this.W && this.env < this.peak * 1.5e-4) this.dead = true;
    return out;
  }
}

// ── 사운드보드 공진(바디) : 고정 peaking 바이쿼드 캐스케이드 ──
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
function makeHighShelf(f0, dB) {
  const A = Math.pow(10, dB / 40);
  const w0 = (2 * Math.PI * f0) / SR;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const S = 1;
  const alpha = (sinw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
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
    // 초기 음(주로 OfflineAudioContext 검증용): postMessage 타이밍에 의존하지 않음
    const init = options && options.processorOptions;
    this.testLinear = !!(init && init.testLinear); // 검증용: tanh 없이 선형 출력
    this.voiceGain = init && init.voiceGain != null ? init.voiceGain : 0.0008;
    if (init && init.midi != null) {
      this.voices.push(new Voice(init.midi, init.vel == null ? 0.8 : init.vel));
    }
    // 사운드보드 바디 공진 + 고역 약화(거친 고배음 완화)
    this.sb = [
      makeBiquadPeak(125, 1.0, 4),
      makeBiquadPeak(260, 1.2, 3),
      makeBiquadPeak(440, 1.4, 2),
      makeHighShelf(6500, -5),
    ];
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
    const ch0 = out[0];
    const N = ch0.length;
    const voices = this.voices;
    const sb = this.sb;

    const vg = this.voiceGain;
    const lin = this.testLinear;
    for (let s = 0; s < N; s++) {
      let mix = 0;
      for (let v = 0; v < voices.length; v++) {
        mix += voices[v].render() * vg * voices[v].norm;
      }
      // 사운드보드 공진
      for (let b = 0; b < sb.length; b++) mix = biquad(sb[b], mix);
      // 소프트 리미터: 단음은 선형 구간(셈여림 유지), 화음 피크만 부드럽게 압축
      const y = lin ? mix : Math.tanh(mix);
      for (let c = 0; c < out.length; c++) out[c][s] = y;
    }

    // 죽은 보이스 정리
    if (voices.some((v) => v.dead)) this.voices = voices.filter((v) => !v.dead);
    return true;
  }
}

registerProcessor('piano-processor', PianoProcessor);
