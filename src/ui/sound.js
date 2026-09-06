/**
 * 音效：全部用 Web Audio 现场合成，不依赖任何音频文件
 * （不占流量、离线可用、没有版权问题）
 *
 * 浏览器规矩：AudioContext 必须在用户第一次点击后才能出声，
 * 所以 unlock() 挂在所有按钮点击上，第一次点就自动解锁。
 */

let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = localStorage.getItem('wushik_sound') !== 'off';

/** 取（并按需创建）音频上下文；浏览器挂起时自动 resume */
function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** 用户手势时调用：解锁音频 */
export function unlock() {
  if (!enabled) return;
  ac();
}

export function isEnabled() { return enabled; }

export function setEnabled(on) {
  enabled = !!on;
  localStorage.setItem('wushik_sound', enabled ? 'on' : 'off');
  if (enabled) ac();
}

export function toggle() {
  setEnabled(!enabled);
  return enabled;
}

/** 白噪声缓冲（复用一份） */
function noise(c) {
  if (!noiseBuf) {
    const len = Math.floor(c.sampleRate * 0.6);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

/** 单个音符：可扫频、可包络 */
function tone(c, { freq, to, dur = 0.12, type = 'sine', gain = 0.3, delay = 0, attack = 0.005 }) {
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 一段噪声：模拟"啪"的撞击感 */
function hit(c, { dur = 0.09, freq = 1600, q = 1.2, gain = 0.35, type = 'bandpass', delay = 0, sweepTo = 0 }) {
  const t0 = c.currentTime + delay;
  const src = noise(c);
  const flt = c.createBiquadFilter();
  flt.type = type;
  flt.frequency.setValueAtTime(freq, t0);
  if (sweepTo) flt.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), t0 + dur);
  flt.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(flt).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/* ------------------------- 各种音效 ------------------------- */

const SFX = {
  /** 出牌：牌拍在桌上的"啪" */
  play() {
    const c = ac(); if (!c) return;
    hit(c, { dur: 0.085, freq: 2200, q: 0.9, gain: 0.5, sweepTo: 700 });
    tone(c, { freq: 150, to: 90, dur: 0.07, type: 'triangle', gain: 0.22 });
  },

  /** 过牌：轻轻一"嗒" */
  pass() {
    const c = ac(); if (!c) return;
    hit(c, { dur: 0.045, freq: 900, q: 2, gain: 0.16 });
    tone(c, { freq: 260, to: 200, dur: 0.06, type: 'sine', gain: 0.1 });
  },

  /** 炸弹：低频轰 + 噪声爆 */
  bomb() {
    const c = ac(); if (!c) return;
    hit(c, { dur: 0.34, freq: 1800, q: 0.6, gain: 0.5, type: 'lowpass', sweepTo: 160 });
    tone(c, { freq: 110, to: 38, dur: 0.36, type: 'sine', gain: 0.5 });
    tone(c, { freq: 70, to: 30, dur: 0.4, type: 'square', gain: 0.14 });
  },

  /** 五十K：清脆"叮铃" */
  bell() {
    const c = ac(); if (!c) return;
    tone(c, { freq: 988, dur: 0.5, type: 'sine', gain: 0.24 });
    tone(c, { freq: 1319, dur: 0.45, type: 'sine', gain: 0.16, delay: 0.06 });
    tone(c, { freq: 1976, dur: 0.35, type: 'sine', gain: 0.08, delay: 0.12 });
  },

  /** 王炸：更猛的轰 + 金属余韵 */
  joker() {
    const c = ac(); if (!c) return;
    SFX.bomb();
    tone(c, { freq: 660, to: 990, dur: 0.5, type: 'sawtooth', gain: 0.12, delay: 0.05 });
    tone(c, { freq: 1320, dur: 0.6, type: 'sine', gain: 0.1, delay: 0.14 });
  },

  /** 选牌：极轻的 tick */
  tick() {
    const c = ac(); if (!c) return;
    hit(c, { dur: 0.03, freq: 2600, q: 3, gain: 0.1 });
  },

  /** 轮到我：两声提示 */
  turn() {
    const c = ac(); if (!c) return;
    tone(c, { freq: 784, dur: 0.11, type: 'sine', gain: 0.2 });
    tone(c, { freq: 1046, dur: 0.14, type: 'sine', gain: 0.18, delay: 0.1 });
  },

  /** 发牌：一串快速的"唰" */
  deal() {
    const c = ac(); if (!c) return;
    for (let i = 0; i < 8; i++) {
      hit(c, { dur: 0.05, freq: 3000 + Math.random() * 1200, q: 1.6, gain: 0.1 + i * 0.012, delay: i * 0.045 });
    }
  },

  /** 赢：上行琶音 */
  win() {
    const c = ac(); if (!c) return;
    [523, 659, 784, 1047].forEach((f, i) => {
      tone(c, { freq: f, dur: 0.28, type: 'triangle', gain: 0.24, delay: i * 0.11 });
    });
  },

  /** 输：下行 */
  lose() {
    const c = ac(); if (!c) return;
    [523, 415, 330, 247].forEach((f, i) => {
      tone(c, { freq: f, dur: 0.3, type: 'triangle', gain: 0.2, delay: i * 0.12 });
    });
  },

  /** 收分（一圈打完分归己）：叮咚 */
  coin() {
    const c = ac(); if (!c) return;
    tone(c, { freq: 1046, dur: 0.12, type: 'sine', gain: 0.16 });
    tone(c, { freq: 1568, dur: 0.2, type: 'sine', gain: 0.12, delay: 0.07 });
  },

  /** 掷骰子 */
  dice() {
    const c = ac(); if (!c) return;
    for (let i = 0; i < 6; i++) {
      hit(c, { dur: 0.04, freq: 1200 + Math.random() * 900, q: 3, gain: 0.14, delay: i * 0.07 });
    }
  },
};

/** 播一个音效：play(name) */
export function play(name) {
  if (!enabled) return;
  const fn = SFX[name];
  if (!fn) return;
  try { fn(); } catch (e) { /* 音频不可用时静默降级，不影响游戏 */ }
}

export { SFX };
