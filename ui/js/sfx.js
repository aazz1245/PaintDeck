// 音效（2.0.6 重新設計）：全部用 Web Audio 現場合成，不帶音檔。
// 方向：機械鍵盤和 80 年代卡帶機的手感——白噪音濾波做出「喀」和「咚」，每次音高、音量隨機差一點點，聽起來才不像同一個錄音一直重播。
//   key      一般按鍵按下：軸體的「喀」＋觸底的「咚」＋外殼共鳴
//   keyUp    放開：回彈的輕「喀」
//   big      大生成鍵：較重的觸底聲，加上卡帶機播放鍵的卡榫「喀噠」
//   toggle   撥桿開關（勾選框）：兩段短促的金屬「答答」
//   slide    三段滑動開關（主題）：滑過去的沙沙聲，最後卡進去
//   detent   旋鈕轉一格：細小的段落感
//   done     畫完：兩個音的柔和鐘聲（往上）
//   error    失敗：兩下低沉的悶響（往下）
// 每個音效函式都吃 (ctx, out, t)，所以也能丟進 OfflineAudioContext 量音量。

let actx = null, master = null, noiseBuf = null;

function live() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain();
    master.gain.value = 0.9;
    master.connect(actx.destination);
  }
  if (actx.state === "suspended") actx.resume();
  return actx;
}

const jit = (x, r = 0.08) => x * (1 + (Math.random() - 0.5) * 2 * r);

function noise(ctx) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  return s;
}

// 一段濾過的噪音：attack 0.5ms，指數衰減
function burst(ctx, out, t, { type = "bandpass", freq, q = 1, gain, dur }) {
  const s = noise(ctx), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.0005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random() * 0.4);
  s.stop(t + dur + 0.01);
}

// 一個正弦音：音高可以從 f0 滑到 f1
function tone(ctx, out, t, { f0, f1 = f0, gain, dur, attack = 0.001, type = "sine" }) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const SFX = {
  key(ctx, out, t) {
    const v = jit(1, 0.06), a = jit(1, 0.15);
    burst(ctx, out, t, { freq: 3400 * v, q: 1.4, gain: 0.5 * a, dur: 0.012 });               // 軸體喀
    burst(ctx, out, t + 0.004, { type: "lowpass", freq: 1200 * v, q: 0.7, gain: 0.55 * a, dur: 0.04 }); // 觸底咚
    tone(ctx, out, t + 0.004, { f0: 230 * v, f1: 150 * v, gain: 0.16 * a, dur: 0.05 });     // 外殼共鳴
  },
  keyUp(ctx, out, t) {
    const v = jit(1, 0.06), a = jit(1, 0.15);
    burst(ctx, out, t, { freq: 2600 * v, q: 1.2, gain: 0.22 * a, dur: 0.009 });
    burst(ctx, out, t + 0.002, { type: "lowpass", freq: 800 * v, gain: 0.18 * a, dur: 0.022 });
  },
  big(ctx, out, t) {
    const v = jit(1, 0.04);
    burst(ctx, out, t, { freq: 2200 * v, q: 1.2, gain: 0.45, dur: 0.016 });
    burst(ctx, out, t + 0.006, { type: "lowpass", freq: 700 * v, q: 0.9, gain: 0.8, dur: 0.08 });
    tone(ctx, out, t + 0.006, { f0: 150 * v, f1: 85 * v, gain: 0.32, dur: 0.11 });
    burst(ctx, out, t + 0.05, { freq: 4200 * v, q: 3, gain: 0.3, dur: 0.01 });             // 卡榫喀
    burst(ctx, out, t + 0.066, { freq: 3000 * v, q: 3, gain: 0.22, dur: 0.012 });          // 噠
  },
  toggle(ctx, out, t) {
    const v = jit(1, 0.05);
    burst(ctx, out, t, { type: "highpass", freq: 3800 * v, q: 0.8, gain: 0.35, dur: 0.008 });
    burst(ctx, out, t + 0.014, { freq: 2400 * v, q: 2, gain: 0.4, dur: 0.018 });
    tone(ctx, out, t + 0.014, { f0: 520 * v, f1: 380 * v, gain: 0.05, dur: 0.04 });
  },
  slide(ctx, out, t) {
    const v = jit(1, 0.05), s = noise(ctx), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = "bandpass"; f.Q.value = 1.5;
    f.frequency.setValueAtTime(900 * v, t); f.frequency.exponentialRampToValueAtTime(2600 * v, t + 0.08);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.connect(f).connect(g).connect(out); s.start(t, Math.random() * 0.3); s.stop(t + 0.1);
    burst(ctx, out, t + 0.09, { freq: 3000 * v, q: 2, gain: 0.4, dur: 0.012 });
    burst(ctx, out, t + 0.092, { type: "lowpass", freq: 900 * v, gain: 0.3, dur: 0.03 });
  },
  detent(ctx, out, t) {
    const v = jit(1, 0.05);
    burst(ctx, out, t, { freq: 4600 * v, q: 3, gain: 0.3, dur: 0.006 });
    tone(ctx, out, t, { f0: 1100 * v, gain: 0.03, dur: 0.012 });
  },
  done(ctx, out, t) {
    // 鐘：基音＋2.76 倍、5.4 倍的泛音，像小鐵琴；C6 → G6
    for (const [dt, f] of [[0, 1046.5], [0.13, 1568]]) {
      tone(ctx, out, t + dt, { f0: f, gain: 0.13, dur: 1.1, attack: 0.004 });
      tone(ctx, out, t + dt, { f0: f * 2.76, gain: 0.035, dur: 0.45, attack: 0.003 });
      tone(ctx, out, t + dt, { f0: f * 5.4, gain: 0.012, dur: 0.18, attack: 0.002 });
    }
  },
  error(ctx, out, t) {
    for (const [dt, f] of [[0, 330], [0.17, 220]]) {
      tone(ctx, out, t + dt, { f0: f, f1: f * 0.85, gain: 0.2, dur: 0.28, attack: 0.004, type: "triangle" });
      burst(ctx, out, t + dt, { type: "lowpass", freq: 500, gain: 0.25, dur: 0.06 });
    }
  },
};

// 各音效的音量：用 OfflineAudioContext 量過，按鍵聲最大 50ms RMS 約 0.016（舊版方波嗶聲約 0.007，但方波在耳朵最敏感的頻段，聽感差不多）
export const VOL = { key: 0.45, keyUp: 0.6, big: 0.4, toggle: 0.45, slide: 0.8, detent: 0.7, done: 0.6, error: 0.65 };

export function play(name) {
  try {
    const ctx = live(), g = ctx.createGain();
    g.gain.value = VOL[name] ?? 1;
    g.connect(master);
    SFX[name](ctx, g, ctx.currentTime + 0.002);
    setTimeout(() => g.disconnect(), 2000);
  } catch { /* 沒有音效裝置 */ }
}
