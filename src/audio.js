// audio.js — 程序化游戏音频（Web Audio 合成，零素材文件）
// 设计哲学与 SFXForge 一致：参数化合成（振荡器/噪声/ADSR/滤波）生成空战音景。
// 结构：master → (bgmGain | sfxGain)；引擎为常驻节点，随油门/马赫实时调制。
import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.volumes = { bgm: 0.45, sfx: 0.7 };
    this._bgmSource = null;
    this._bgmTimer = null;
    this._engine = null;
    this._lastGun = 0;
    this._lastRwr = 0;
    this._lastLock = 0;
    this._lastExplosion = 0;
    this._muted = false;
  }

  // 浏览器 autoplay 策略：必须在用户手势里 init/resume
  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.bgmGain = this.ctx.createGain();
    this.sfxGain = this.ctx.createGain();
    this.bgmGain.connect(this.master);
    this.sfxGain.connect(this.master);
    this._applyVolumes();
    this.ready = true;
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  setVolumes(v) {
    this.volumes = { ...this.volumes, ...v };
    this._applyVolumes();
  }

  setPausedMuted(m) {   // 暂停/主菜单时压低
    this._muted = m;
    if (this.ready) this.master.gain.setTargetAtTime(m ? 0.18 : 1.0, this.ctx.currentTime, 0.15);
  }

  _applyVolumes() {
    if (!this.ready) return;
    this.bgmGain.gain.value = this.volumes.bgm;
    this.sfxGain.gain.value = this.volumes.sfx;
  }

  _noiseBuffer(seconds = 1, type = 'white') {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    return buf;
  }

  // ---------------- BGM：程序化暗色电子 pad（16 小节循环，战斗氛围）----------------
  startBGM() {
    if (!this.ready || this._bgmSource) return;
    const t0 = performance.now();
    const sr = this.ctx.sampleRate;
    const barSec = 2.4;                        // 一小节
    const bars = 16;
    const len = Math.floor(sr * barSec * bars);
    const buf = this.ctx.createBuffer(2, len, sr);
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    // 和声进行（Am – F – C – G 变体，暗色小调）
    const chords = [
      [110.0, 130.8, 164.8], [87.3, 110.0, 130.8],
      [98.0, 123.5, 146.8], [110.0, 138.6, 164.8],
    ];
    for (let bar = 0; bar < bars; bar++) {
      const chord = chords[bar % 4];
      const t0 = bar * barSec;
      // 每小节：pad（3 个 detuned saw 的加法合成，soft attack）+ sub bass + hat 脉冲
      for (const f of chord) {
        for (const det of [-0.7, 0, 0.7]) {
          const freq = (f + det) * (bar >= 8 ? 1.5 : 1);   // B 段升调提张力
          const amp = 0.028;
          for (let i = 0; i < sr * barSec; i++) {
            const t = i / sr;
            const env = Math.min(t / 0.4, 1) * Math.min((barSec - t) / 0.5, 1);
            const s = Math.sin(2 * Math.PI * freq * t + 0.3 * Math.sin(2 * Math.PI * 0.13 * (t0 + t)));
            L[Math.floor(t0 * sr) + i] += s * amp * env;
            R[Math.floor(t0 * sr) + i] += s * amp * env * 0.92;
          }
        }
      }
      // sub bass：每小节两拍
      const bassF = chord[0] / 2;
      for (let beat = 0; beat < 4; beat++) {
        const b0 = Math.floor((t0 + beat * barSec / 4) * sr);
        const bl = Math.floor(sr * 0.22);
        for (let i = 0; i < bl; i++) {
          const t = i / sr;
          const env = Math.exp(-t * 9);
          const s = Math.sin(2 * Math.PI * bassF * t) * env * 0.10;
          L[b0 + i] += s; R[b0 + i] += s;
        }
      }
      // hi-hat 噪声脉冲（每半拍，B 段加密）
      const hats = bar >= 8 ? 8 : 4;
      for (let h = 0; h < hats; h++) {
        const h0 = Math.floor((t0 + h * barSec / hats) * sr);
        const hl = Math.floor(sr * 0.03);
        for (let i = 0; i < hl; i++) {
          const env = Math.exp(-i / sr * 150);
          const s = (Math.random() * 2 - 1) * env * 0.035;
          L[h0 + i] += s; R[h0 + i] += s * -0.8;
        }
      }
    }
    // 归一防削波
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const g = peak > 0 ? 0.85 / peak : 1;
    for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }

    this._bgmSource = this.ctx.createBufferSource();
    this._bgmSource.buffer = buf;
    this._bgmSource.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600;
    this._bgmSource.connect(lp).connect(this.bgmGain);
    this._bgmSource.start();
    this._bgmTiming = Math.round(performance.now() - t0);
    console.log(`[audio] BGM synthesized in ${this._bgmTiming}ms`);
  }

  stopBGM() {
    if (this._bgmSource) {
      try { this._bgmSource.stop(); } catch { /* already stopped */ }
      this._bgmSource.disconnect();
      this._bgmSource = null;
    }
  }

  // ---------------- 引擎：粉/棕噪 + 低频锯齿，随油门与马赫调制 ----------------
  startEngine() {
    if (!this.ready || this._engine) return;
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer(2, 'brown');
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass'; nf.frequency.value = 320; nf.Q.value = 0.6;
    const ng = ctx.createGain(); ng.gain.value = 0.0;
    const roar = ctx.createOscillator();
    roar.type = 'sawtooth'; roar.frequency.value = 55;
    const rf = ctx.createBiquadFilter();
    rf.type = 'lowpass'; rf.frequency.value = 180;
    const rg = ctx.createGain(); rg.gain.value = 0.0;
    noise.connect(nf).connect(ng).connect(this.sfxGain);
    roar.connect(rf).connect(rg).connect(this.sfxGain);
    noise.start(); roar.start();
    this._engine = { noise, nf, ng, roar, rf, rg };
  }

  stopEngine() {
    if (!this._engine) return;
    try { this._engine.noise.stop(); this._engine.roar.stop(); } catch { /* ok */ }
    this._engine = null;
  }

  updateEngine(throttle, mach, afterburner) {
    if (!this._engine) return;
    const t = this.ctx.currentTime;
    const th = clamp(throttle, 0, 1);
    this._engine.nf.frequency.setTargetAtTime(220 + th * 680 + (afterburner ? 300 : 0), t, 0.2);
    this._engine.ng.gain.setTargetAtTime(0.05 + th * 0.16 + (afterburner ? 0.10 : 0), t, 0.25);
    this._engine.roar.frequency.setTargetAtTime(46 + th * 40 + mach * 14, t, 0.3);
    this._engine.rg.gain.setTargetAtTime(0.02 + th * 0.05 + (afterburner ? 0.05 : 0), t, 0.3);
  }

  // ---------------- 一次性 SFX ----------------
  _env(gain, a, peak, decay) {
    const t = this.ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0011), t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + decay);
  }

  gun() {   // 机炮：节流 90ms
    if (!this.ready) return;
    const now = performance.now();
    if (now - this._lastGun < 90) return;
    this._lastGun = now;
    const ctx = this.ctx;
    // 低频冲击
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(140, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(55, ctx.currentTime + 0.07);
    const g = ctx.createGain();
    this._env(g, 0.004, 0.5, 0.10);
    o.connect(g).connect(this.sfxGain);
    o.start(); o.stop(ctx.currentTime + 0.13);
    // 高频机械噪声
    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer(0.1);
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 1800; nf.Q.value = 0.8;
    const ng = ctx.createGain();
    this._env(ng, 0.002, 0.22, 0.07);
    n.connect(nf).connect(ng).connect(this.sfxGain);
    n.start();
  }

  missileLaunch() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer(0.9);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.1;
    f.frequency.setValueAtTime(300, ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(1500, ctx.currentTime + 0.7);
    const g = ctx.createGain();
    this._env(g, 0.02, 0.5, 0.75);
    n.connect(f).connect(g).connect(this.sfxGain);
    n.start();
  }

  explosion(distance = 0) {   // 距离衰减（米）
    if (!this.ready) return;
    const now = performance.now();
    if (now - this._lastExplosion < 120) return;
    this._lastExplosion = now;
    const ctx = this.ctx;
    const att = clamp(1 - distance / 9000, 0.12, 1);
    const n = ctx.createBufferSource();
    n.buffer = this._noiseBuffer(1.3, 'brown');
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, ctx.currentTime);
    f.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 1.0);
    const g = ctx.createGain();
    this._env(g, 0.01, 0.9 * att, 1.05);
    n.connect(f).connect(g).connect(this.sfxGain);
    n.start();
    // 次声轰
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(32, ctx.currentTime + 0.8);
    const og = ctx.createGain();
    this._env(og, 0.008, 0.55 * att, 0.85);
    o.connect(og).connect(this.sfxGain);
    o.start(); o.stop(ctx.currentTime + 0.95);
  }

  hit() {   // 命中反馈
    if (!this.ready) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(420, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(160, ctx.currentTime + 0.09);
    const g = ctx.createGain();
    this._env(g, 0.002, 0.18, 0.1);
    o.connect(g).connect(this.sfxGain);
    o.start(); o.stop(ctx.currentTime + 0.12);
  }

  rwrBeep(urgent) {   // 导弹告警：急促三连 / 常规双响
    if (!this.ready) return;
    const now = performance.now();
    const gap = urgent ? 320 : 650;
    if (now - this._lastRwr < gap) return;
    this._lastRwr = now;
    const ctx = this.ctx;
    const times = urgent ? 3 : 2;
    for (let i = 0; i < times; i++) {
      const t0 = ctx.currentTime + i * 0.09;
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = urgent ? 1150 : 850;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.13, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.08);
    }
  }

  lockTone() {
    if (!this.ready) return;
    const now = performance.now();
    if (now - this._lastLock < 400) return;
    this._lastLock = now;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = 1250;
    const g = ctx.createGain();
    this._env(g, 0.005, 0.12, 0.12);
    o.connect(g).connect(this.sfxGain);
    o.start(); o.stop(ctx.currentTime + 0.15);
  }

  supply() {
    if (!this.ready) return;
    const ctx = this.ctx;
    [520, 780].forEach((f, i) => {
      const t0 = ctx.currentTime + i * 0.12;
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      o.connect(g).connect(this.sfxGain);
      o.start(t0); o.stop(t0 + 0.3);
    });
  }

  waveStart() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, ctx.currentTime);
    o.frequency.linearRampToValueAtTime(340, ctx.currentTime + 0.35);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900;
    const g = this.ctx.createGain();
    this._env(g, 0.05, 0.10, 0.5);
    o.connect(f).connect(g).connect(this.sfxGain);
    o.start(); o.stop(ctx.currentTime + 0.6);
  }

  death() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(240, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(38, ctx.currentTime + 1.4);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 700;
    const g = this.ctx.createGain();
    this._env(g, 0.01, 0.4, 1.5);
    o.connect(f).connect(g).connect(this.sfxGain);
    o.start(); o.stop(ctx.currentTime + 1.6);
  }

  uiClick() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = 900;
    const g = this.ctx.createGain();
    this._env(g, 0.002, 0.06, 0.05);
    o.connect(g).connect(this.sfxGain);
    o.start(); o.stop(ctx.currentTime + 0.07);
  }
}
