// Hand-drawn SVG art: resource icons, tile textures and the little scenes on
// each tile. Everything is defined once in a hidden <svg> and reused with <use>,
// so it looks the same on every device (emoji differ between phones) and the
// board can be redrawn freely.
const INK = '#1b1b1b';
const S = `stroke="${INK}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"`;

const DEFS = `<defs>
  <!-- resource icons, 32x32 -->
  <symbol id="ic-wood" viewBox="0 0 32 32">
    <rect x="13.5" y="21" width="5" height="8" rx="1" fill="#8b5a2b" ${S}/>
    <path d="M16 2.5 L24 13 H20 L27 22.5 H5 L12 13 H8 Z" fill="#2f9e44" ${S}/>
    <path d="M16 4.5 L9.5 13 H13 L7.5 21 H15.5 Z" fill="#5cc66a"/>
  </symbol>
  <symbol id="ic-brick" viewBox="0 0 32 32">
    <rect x="3" y="18" width="13" height="9" rx="1.5" fill="#d9542f" ${S}/>
    <rect x="16" y="18" width="13" height="9" rx="1.5" fill="#bf4524" ${S}/>
    <rect x="9.5" y="8" width="13" height="10" rx="1.5" fill="#e4653c" ${S}/>
    <path d="M5 20.5 H14 M18 20.5 H27 M11.5 10.5 H20.5" stroke="#ffb08f" stroke-width="1.6" stroke-linecap="round"/>
  </symbol>
  <symbol id="ic-sheep" viewBox="0 0 32 32">
    <path d="M10 22 V28 M14 23 V28 M19 23 V28 M23 22 V28" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/>
    <g stroke="${INK}" stroke-width="4.5"><circle cx="11" cy="15" r="5"/><circle cx="17" cy="12" r="5.5"/><circle cx="22" cy="16" r="5"/><circle cx="16" cy="19" r="5.5"/><circle cx="9.5" cy="19.5" r="4.5"/></g>
    <g fill="#fbfbf7"><circle cx="11" cy="15" r="5"/><circle cx="17" cy="12" r="5.5"/><circle cx="22" cy="16" r="5"/><circle cx="16" cy="19" r="5.5"/><circle cx="9.5" cy="19.5" r="4.5"/></g>
    <ellipse cx="25.5" cy="15" rx="3.6" ry="4.6" fill="#3b3b3b" ${S}/>
    <circle cx="26.6" cy="14" r="0.9" fill="#fff"/>
    <circle cx="14" cy="11" r="2" fill="#fff" opacity=".9"/>
  </symbol>
  <symbol id="ic-wheat" viewBox="0 0 32 32">
    <path d="M16 29 V12 M16 29 L10 10 M16 29 L22 10" stroke="${INK}" stroke-width="4.2" stroke-linecap="round"/><path d="M16 29 V12 M16 29 L10 10 M16 29 L22 10" stroke="#c98f22" stroke-width="2" stroke-linecap="round"/>
    <g fill="#f6c445" ${S}>
      <path d="M16 2 C20 5.5 20 11.5 16 15 C12 11.5 12 5.5 16 2 Z"/>
      <path d="M8.5 4 C13 6.5 13.5 12.5 10.5 16 C6.8 13 6.3 7.8 8.5 4 Z"/>
      <path d="M23.5 4 C25.7 7.8 25.2 13 21.5 16 C18.5 12.5 19 6.5 23.5 4 Z"/>
    </g>
    <path d="M14.6 6 C14 8 14 10 14.8 12" stroke="#fff3c4" stroke-width="1.4" fill="none" stroke-linecap="round"/>
    <rect x="12.5" y="19.5" width="7" height="3.5" rx="1" fill="#c0392b" ${S}/>
  </symbol>
  <symbol id="ic-ore" viewBox="0 0 32 32">
    <path d="M4 24 L8.5 12 L16 6.5 L24.5 9.5 L28.5 21.5 L22 27.5 H9.5 Z" fill="#8f99a4" ${S}/>
    <path d="M8.5 12 L16 6.5 L24.5 9.5 L17 14.5 Z" fill="#c9d0d7"/>
    <path d="M24.5 9.5 L28.5 21.5 L22 27.5 L17 14.5 Z" fill="#717b86"/>
    <path d="M4 24 L8.5 12 L16 6.5 L24.5 9.5 L28.5 21.5 L22 27.5 H9.5 Z M17 14.5 L8.5 12 M17 14.5 L24.5 9.5 M17 14.5 L22 27.5" fill="none" ${S}/>
    <path d="M12 18 l1.5 -1.5 M20 19 l1.2 1.2" stroke="#e8f4ff" stroke-width="1.6" stroke-linecap="round"/>
  </symbol>

  <!-- scene pieces -->
  <symbol id="sc-mountain" viewBox="0 0 44 32">
    <path d="M2 30 L17 5 L24 15 L29 9 L42 30 Z" fill="#8a949f" ${S}/>
    <path d="M17 5 L2 30 H13 L18 16 Z" fill="#a9b2bc"/>
    <path d="M17 5 L12.2 13 L14.8 11.7 L17 14 L19.4 11.6 L21 13.2 Z" fill="#fff" ${S}/>
    <path d="M29 9 L26.2 13.5 L28.4 12.6 L30.5 14 L31.6 12.4 Z" fill="#fff" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
  </symbol>
  <symbol id="sc-hill" viewBox="0 0 44 26">
    <path d="M2 24 Q12 4 22 6 Q34 8 42 24 Z" fill="#c9562e" ${S}/>
    <path d="M6 22 Q13 9 21 9 Q14 13 12 22 Z" fill="#e57a50"/>
    <path d="M20 16 h5 M28 19 h5 M15 20 h4" stroke="#a8431f" stroke-width="1.6" stroke-linecap="round"/>
  </symbol>
  <symbol id="sc-tuft" viewBox="0 0 16 10">
    <path d="M2 9 Q4 3 5 1 Q6 5 8 9 Q9 3 11 2 Q11 6 14 9 Z" fill="#5fae3a" stroke="${INK}" stroke-width="1.4" stroke-linejoin="round"/>
  </symbol>

  <!-- tile textures (kept subtle; the scenes carry the detail) -->
  <pattern id="tx-wood" width="18" height="18" patternUnits="userSpaceOnUse"><rect width="18" height="18" fill="#3f9d4b"/>
    <circle cx="4" cy="5" r="1.6" fill="#37904a"/><circle cx="13" cy="13" r="1.8" fill="#37904a"/></pattern>
  <pattern id="tx-brick" width="22" height="12" patternUnits="userSpaceOnUse"><rect width="22" height="12" fill="#e07443"/>
    <path d="M0 0.5H22M0 6.5H22M5 0V6M16 6V12" stroke="#cf6436" stroke-width="1.2"/></pattern>
  <pattern id="tx-sheep" width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill="#a4d65e"/>
    <path d="M3 7q1.5-3 3 0M13 16q1.5-3 3 0" stroke="#8fc44d" stroke-width="1.4" fill="none"/></pattern>
  <pattern id="tx-wheat" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)"><rect width="14" height="14" fill="#efbd47"/>
    <path d="M0 3.5H14" stroke="#e0a634" stroke-width="3"/><path d="M0 10H14" stroke="#f6d27a" stroke-width="1.6"/></pattern>
  <pattern id="tx-ore" width="26" height="22" patternUnits="userSpaceOnUse"><rect width="26" height="22" fill="#a5adb7"/>
    <path d="M3 6 l5 3 l-2 5 M17 3 l3 5 l5 1" stroke="#929ba6" stroke-width="1.3" fill="none" stroke-linecap="round"/></pattern>
  <linearGradient id="tileLight" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".14"/>
  </linearGradient>
</defs>`;

export function installArt() {
  document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${DEFS}</svg>`);
}

const NAMES = { wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore' };
const EMOJI = { '🌲': 'wood', '🧱': 'brick', '🐑': 'sheep', '🌾': 'wheat', '🪨': 'ore' };

// An inline resource icon for HTML.
export const ri = r => `<svg class="ri" role="img" aria-label="${NAMES[r]}"><use href="#ic-${r}"/></svg>`;
// Swap the engine's emoji (used in log messages) for the drawn icons.
export const iconize = text => text.replace(/🌲|🧱|🐑|🌾|🪨/gu, m => ri(EMOJI[m]));

// Spots inside a tile (offsets from its centre, R = 60) that stay clear of the number token.
const SLOTS = [[0, -41], [-21, -31], [21, -31], [-37, -9], [37, -9], [-36, 17], [36, 17], [-19, 37], [19, 37], [0, 45]];

const PIECES = {
  wood: { use: 'ic-wood', size: [23, 28], count: 8 },
  ore: { use: 'sc-mountain', size: [40, 47], count: 4, aspect: 32 / 44 },
  sheep: { use: 'ic-sheep', size: [24, 27], count: 3, extra: ['sc-tuft', 14, 4] },
  wheat: { use: 'ic-wheat', size: [25, 29], count: 6 },
  brick: { use: 'sc-hill', size: [38, 44], count: 3, aspect: 26 / 44, extra: ['ic-brick', 21, 2] },
};

// A small deterministic random number generator, so each tile keeps its look between redraws.
function rng(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 1000) / 1000; };
}

// The little picture drawn on a tile.
export function tileScene(res, cx, cy, seed) {
  const p = PIECES[res], rand = rng(seed + 1);
  const slots = SLOTS.map(s => [s, rand()]).sort((a, b) => a[1] - b[1]).map(a => a[0]);
  const items = [];
  const place = (id, w, aspect, [dx, dy]) => {
    const h = w * (aspect || 1);
    // Keep the piece inside the hexagon (pointy top, inner width ±52 at R = 60).
    const mx = 47 - w / 2;
    dx = Math.max(-mx, Math.min(mx, dx));
    const my = 54 - Math.abs(dx) * 0.58 - h / 2;
    dy = Math.max(-my, Math.min(my, dy));
    const jx = (rand() - 0.5) * 4, jy = (rand() - 0.5) * 3;
    items.push({ y: dy, svg: `<use href="#${id}" x="${(cx + dx + jx - w / 2).toFixed(1)}" y="${(cy + dy + jy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>` });
  };
  let i = 0;
  for (; i < p.count && i < slots.length; i++) place(p.use, p.size[0] + rand() * (p.size[1] - p.size[0]), p.aspect, slots[i]);
  if (p.extra) {
    const [id, w, n] = p.extra;
    for (let k = 0; k < n && i < slots.length; k++, i++) place(id, w, id === 'sc-tuft' ? 10 / 16 : 1, slots[i]);
  }
  items.sort((a, b) => a.y - b.y); // things lower down overlap the ones behind them
  return `<g class="scene" pointer-events="none">${items.map(t => t.svg).join('')}</g>`;
}

