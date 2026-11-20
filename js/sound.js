// Game sounds, synthesised with the Web Audio API (no sound files to load).
// Browsers only allow audio after the player has interacted with the page,
// so the audio context is created on the first tap or key press.
const KEY = 'tinysettler.muted';
let ctx = null, master = null;
let muted = false;
try { muted = localStorage.getItem(KEY) === '1'; } catch { /* storage unavailable */ }

function audio() {
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
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => audio(), { once: true, capture: true }));

// One note: a pitch (optionally sliding to f2) with a quick attack and a soft fade.
function tone({ f, f2 = f, type = 'sine', dur = 0.12, vol = 0.25, at = 0 }) {
  const a = audio();
  if (!a || muted) return;
  const t = a.currentTime + at;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// A short burst of filtered noise (dice hitting the table, wood knocks).
function noise({ dur = 0.05, vol = 0.3, freq = 2000, q = 1.5, at = 0 }) {
  const a = audio();
  if (!a || muted) return;
  const t = a.currentTime + at;
  const len = Math.ceil(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource(), filter = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf;
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  g.gain.value = vol;
  src.connect(filter).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  // a soft, satisfying "pop" for every button
  click() { tone({ f: 880, f2: 520, type: 'triangle', dur: 0.07, vol: 0.18 }); noise({ dur: 0.02, vol: 0.08, freq: 3500 }); },
  // dice tumbling, then landing
  dice() {
    for (let i = 0; i < 7; i++) noise({ dur: 0.04, vol: 0.22, freq: 1800 + Math.random() * 1600, q: 3, at: i * 0.075 + Math.random() * 0.02 });
    noise({ dur: 0.07, vol: 0.32, freq: 1200, q: 2, at: 0.6 });
  },
  // a wooden knock and a little chime when a settlement or city goes down
  build() { noise({ dur: 0.06, vol: 0.35, freq: 600, q: 4 }); tone({ f: 196, f2: 150, type: 'sine', dur: 0.18, vol: 0.3 }); tone({ f: 784, type: 'triangle', dur: 0.15, vol: 0.12, at: 0.06 }); },
  road() { noise({ dur: 0.05, vol: 0.28, freq: 900, q: 4 }); tone({ f: 330, f2: 260, type: 'triangle', dur: 0.1, vol: 0.16 }); },
  // resources arriving
  gain() { tone({ f: 988, type: 'sine', dur: 0.12, vol: 0.14 }); tone({ f: 1319, type: 'sine', dur: 0.16, vol: 0.12, at: 0.07 }); },
  // your turn
  turn() { tone({ f: 523, type: 'triangle', dur: 0.12, vol: 0.16 }); tone({ f: 784, type: 'triangle', dur: 0.2, vol: 0.16, at: 0.1 }); },
  robber() { tone({ f: 165, f2: 98, type: 'sawtooth', dur: 0.35, vol: 0.12 }); noise({ dur: 0.15, vol: 0.18, freq: 400, q: 1 }); },
  card() { noise({ dur: 0.06, vol: 0.2, freq: 5000, q: 0.8 }); tone({ f: 660, f2: 990, type: 'triangle', dur: 0.12, vol: 0.12, at: 0.03 }); },
  emote() { tone({ f: 700, f2: 1300, type: 'sine', dur: 0.12, vol: 0.18 }); },
  error() { tone({ f: 220, f2: 180, type: 'square', dur: 0.12, vol: 0.07 }); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone({ f, type: 'triangle', dur: i === 3 ? 0.5 : 0.16, vol: 0.2, at: i * 0.13 })); },
  lose() { [392, 330, 262].forEach((f, i) => tone({ f, type: 'triangle', dur: i === 2 ? 0.45 : 0.2, vol: 0.18, at: i * 0.18 })); },
};

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem(KEY, m ? '1' : '0'); } catch { /* storage unavailable */ }
}
