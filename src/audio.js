import { MUSIC, musicTargetGain } from './quality.js';
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.ambientNodes = [];
    this.ambientTimers = [];
    this.musicTimer = null;
    this.musicGain = null;
    this.volume = 0.75;
    this.muted = false;
    try {
      const v = parseFloat(localStorage.getItem('swyy_volume'));
      if (Number.isFinite(v)) this.volume = Math.min(1, Math.max(0, v));
      this.muted = localStorage.getItem('swyy_muted') === '1';
    } catch { /* 存储不可用时用默认值 */ }
  }

  applyVolume() {
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    try {
      localStorage.setItem('swyy_volume', String(this.volume));
      localStorage.setItem('swyy_muted', this.muted ? '1' : '0');
    } catch { /* ignore */ }
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.volume > 0) this.muted = false;
    this.applyVolume();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolume();
    return this.muted;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 8;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp);
    const len = this.ctx.sampleRate * 2;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbient();
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  _noise({ dur = 0.1, type = 'lowpass', freq = 1000, freqEnd = null, q = 1, gain = 0.3, delay = 0 }) {
    if (!this.ctx) return;
    const t0 = this.t + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t0); f.Q.value = q;
    if (freqEnd !== null) f.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  _tone({ type = 'sine', f0 = 440, f1 = null, dur = 0.15, gain = 0.2, delay = 0, filter = null }) {
    if (!this.ctx) return;
    const t0 = this.t + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = o;
    if (filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = filter.type; f.frequency.value = filter.freq; f.Q.value = filter.q || 1;
      o.connect(f); node = f;
    }
    node.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  shoot() {
    const v = 0.9 + Math.random() * 0.2;
    this._noise({ dur: 0.13, type: 'lowpass', freq: 7000 * v, freqEnd: 500, gain: 0.5 });
    this._noise({ dur: 0.05, type: 'highpass', freq: 2600, gain: 0.22 });
    this._tone({ type: 'triangle', f0: 170 * v, f1: 55, dur: 0.1, gain: 0.34 });
  }

  enemyShoot() {
    this._noise({ dur: 0.1, type: 'lowpass', freq: 3200, freqEnd: 400, gain: 0.2 });
    this._tone({ type: 'triangle', f0: 130, f1: 50, dur: 0.08, gain: 0.16 });
  }

  swing() {
    this._noise({ dur: 0.14, type: 'bandpass', freq: 900, freqEnd: 250, q: 1.2, gain: 0.22 });
  }

  hit() {
    this._noise({ dur: 0.06, type: 'bandpass', freq: 1100, q: 1.4, gain: 0.26 });
    this._tone({ type: 'square', f0: 240, f1: 90, dur: 0.05, gain: 0.12 });
  }

  kill() {
    this._noise({ dur: 0.3, type: 'lowpass', freq: 1600, freqEnd: 240, gain: 0.3 });
    this._tone({ type: 'sine', f0: 520, f1: 180, dur: 0.22, gain: 0.14 });
    this.quack(0.8, 0.12, 0.05);
  }

  hurt() {
    this._tone({ type: 'sawtooth', f0: 300, f1: 110, dur: 0.24, gain: 0.24, filter: { type: 'lowpass', freq: 1200 } });
    this._noise({ dur: 0.14, type: 'lowpass', freq: 900, freqEnd: 200, gain: 0.24 });
    this.quack(1.25, 0.2, 0.02);
  }

  quack(pitch = 1, gain = 0.22, delay = 0) {
    if (!this.ctx) return;
    const t0 = this.t + delay;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(340 * pitch, t0);
    o.frequency.linearRampToValueAtTime(250 * pitch, t0 + 0.07);
    o.frequency.linearRampToValueAtTime(310 * pitch, t0 + 0.14);
    const f1 = this.ctx.createBiquadFilter();
    f1.type = 'bandpass'; f1.frequency.value = 900 * pitch; f1.Q.value = 2.2;
    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'bandpass'; f2.frequency.value = 1900 * pitch; f2.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
    g.gain.setValueAtTime(gain, t0 + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o.connect(f1); o.connect(f2);
    f1.connect(g); f2.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + 0.22);
  }

  reload(total = 1.6) {
    // 音效节点按实际换弹时长等比排程，手套缩短换弹后不再出现「换完还响」
    const k = Math.max(0.2, total) / 1.6;
    this._noise({ dur: 0.04, type: 'highpass', freq: 2400, gain: 0.2 });
    this._noise({ dur: 0.05, type: 'highpass', freq: 1800, gain: 0.22, delay: 0.55 * k });
    this._tone({ type: 'square', f0: 700, f1: 500, dur: 0.04, gain: 0.08, delay: 0.55 * k });
    this._noise({ dur: 0.06, type: 'highpass', freq: 2600, gain: 0.26, delay: 1.15 * k });
    this._tone({ type: 'triangle', f0: 320, f1: 240, dur: 0.06, gain: 0.14, delay: 1.15 * k });
  }

  emptyClick() {
    this._noise({ dur: 0.03, type: 'highpass', freq: 3000, gain: 0.14 });
  }

  dash() {
    this._noise({ dur: 0.2, type: 'bandpass', freq: 500, freqEnd: 2600, q: 1.2, gain: 0.2 });
  }

  pickup() {
    this._tone({ type: 'sine', f0: 660, dur: 0.08, gain: 0.18 });
    this._tone({ type: 'sine', f0: 990, dur: 0.12, gain: 0.18, delay: 0.07 });
    this._tone({ type: 'sine', f0: 1320, dur: 0.14, gain: 0.1, delay: 0.14 });
  }

  waveHorn() {
    this._tone({ type: 'sawtooth', f0: 110, dur: 0.9, gain: 0.16, filter: { type: 'lowpass', freq: 700 } });
    this._tone({ type: 'sawtooth', f0: 165, dur: 0.9, gain: 0.12, filter: { type: 'lowpass', freq: 800 } });
    this._tone({ type: 'sine', f0: 60, f1: 40, dur: 0.5, gain: 0.3 });
    this._noise({ dur: 0.6, type: 'lowpass', freq: 500, freqEnd: 120, gain: 0.12 });
  }

  waveClear() {
    [523, 659, 784, 1046].forEach((f, i) =>
      this._tone({ type: 'triangle', f0: f, dur: 0.22, gain: 0.14, delay: i * 0.09 }));
  }

  gameOver() {
    [440, 349, 262, 196].forEach((f, i) =>
      this._tone({ type: 'triangle', f0: f, dur: 0.34, gain: 0.18, delay: i * 0.22 }));
    this._noise({ dur: 1.2, type: 'lowpass', freq: 800, freqEnd: 90, gain: 0.14, delay: 0.2 });
  }

  uiClick() {
    this._tone({ type: 'sine', f0: 880, f1: 660, dur: 0.06, gain: 0.12 });
  }

  skillCast() {
    this._noise({ dur: 0.28, type: 'bandpass', freq: 700, freqEnd: 3200, q: 1.1, gain: 0.2 });
    this._tone({ type: 'triangle', f0: 392, f1: 784, dur: 0.24, gain: 0.16 });
    this._tone({ type: 'sine', f0: 1175, dur: 0.18, gain: 0.1, delay: 0.06 });
    this.quack(1.4, 0.14, 0.02);
  }

  boom() {
    this._tone({ type: 'sine', f0: 90, f1: 30, dur: 0.5, gain: 0.34 });
    this._noise({ dur: 0.45, type: 'lowpass', freq: 900, freqEnd: 120, gain: 0.22 });
  }

  levelUp() {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      this._tone({ type: 'triangle', f0: f, dur: 0.2, gain: 0.16, delay: i * 0.07 }));
    this._tone({ type: 'sine', f0: 1568, dur: 0.3, gain: 0.1, delay: 0.35 });
  }

  startAmbient() {
    if (!this.ctx) return;
    const wind = this.ctx.createBufferSource();
    wind.buffer = this.noiseBuf; wind.loop = true;
    const wf = this.ctx.createBiquadFilter();
    wf.type = 'lowpass'; wf.frequency.value = 320; wf.Q.value = 0.6;
    const wg = this.ctx.createGain(); wg.gain.value = 0.05;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.13;
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 140;
    lfo.connect(lfoG); lfoG.connect(wf.frequency);
    const lfo2 = this.ctx.createOscillator(); lfo2.frequency.value = 0.07;
    const lfo2G = this.ctx.createGain(); lfo2G.gain.value = 0.022;
    lfo2.connect(lfo2G); lfo2G.connect(wg.gain);
    wind.connect(wf); wf.connect(wg); wg.connect(this.master);
    wind.start(); lfo.start(); lfo2.start();
    this.ambientNodes.push(wind, lfo, lfo2);

    const cricket = () => {
      if (!this.ctx) return;
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        this._tone({ type: 'square', f0: 4300 + Math.random() * 300, dur: 0.035, gain: 0.012, delay: i * 0.07 });
      }
    };
    const bird = () => {
      const f = 1900 + Math.random() * 700;
      this._tone({ type: 'sine', f0: f, f1: f * 1.35, dur: 0.12, gain: 0.02 });
      this._tone({ type: 'sine', f0: f * 1.2, f1: f * 0.85, dur: 0.14, gain: 0.018, delay: 0.15 });
    };
    this.ambientTimers.push(setInterval(cricket, 2600));
    this.ambientTimers.push(setInterval(() => { if (Math.random() < 0.5) bird(); }, 8000));
  }

  stopAmbient() {
    this.ambientTimers.forEach(clearInterval);
    this.ambientTimers = [];
    this.ambientNodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
    this.ambientNodes = [];
  }

  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = MUSIC.playGain;
    this.musicGain.connect(this.master);
    this._musicDucked = false;
    const chords = [
      [130.81, 164.81, 196.00, 261.63],
      [110.00, 130.81, 164.81, 220.00],
      [87.31, 110.00, 130.81, 174.61],
      [98.00, 123.47, 146.83, 196.00],
    ];
    let bar = 0;
    const playBar = () => {
      if (!this.ctx || !this.musicGain) return;
      const ch = chords[bar % chords.length];
      const t0 = this.t + 0.05;
      for (const f of ch) {
        for (const det of [-3, 3]) {
          const o = this.ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = f;
          o.detune.value = det;
          const g = this.ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.linearRampToValueAtTime(0.028, t0 + 1.2);
          g.gain.setValueAtTime(0.028, t0 + 2.6);
          g.gain.linearRampToValueAtTime(0.0001, t0 + 4.0);
          const lp = this.ctx.createBiquadFilter();
          lp.type = 'lowpass'; lp.frequency.value = 900;
          o.connect(lp); lp.connect(g); g.connect(this.musicGain);
          o.start(t0); o.stop(t0 + 4.1);
        }
      }
      const seq = [0, 2, 1, 3, 2, 1, 3, 2];
      seq.forEach((idx, i) => {
        const tt = t0 + i * 0.5;
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = ch[idx] * 2;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.exponentialRampToValueAtTime(0.05, tt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.45);
        o.connect(g); g.connect(this.musicGain);
        o.start(tt); o.stop(tt + 0.5);
      });
      bar++;
    };
    playBar();
    this.musicTimer = setInterval(playBar, 4000);
  }

  stopMusic() {
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
    if (this.musicGain) {
      const g = this.musicGain;
      g.gain.setTargetAtTime(MUSIC.duckGain, this.t, 0.4);
      setTimeout(() => { try { g.disconnect(); } catch { /* ignore */ } }, 1500);
      this.musicGain = null;
      this._musicDucked = false;
    }
  }

  // 暂停/菜单时把 BGM 降到几乎无声，恢复时回到原 playGain；不改 master 音量或静音状态。
  duckMusic(on) {
    if (!this.ctx || !this.musicGain) return;
    this._musicDucked = !!on;
    const target = on ? MUSIC.duckGain : MUSIC.playGain;
    this.musicGain.gain.cancelScheduledValues(this.t);
    this.musicGain.gain.setTargetAtTime(target, this.t, MUSIC.duckTimeConstant);
  }

  syncMusicToState(state) {
    const g = musicTargetGain(state);
    if (g <= 0) return; // 标题/结算由 stopMusic 负责
    this.duckMusic(g < MUSIC.playGain);
  }
}
