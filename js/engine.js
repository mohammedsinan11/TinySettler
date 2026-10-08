// TinySettler rules engine. Pure game state + actions, no DOM.
// The state is plain JSON so it can be sent over the network as-is.

export const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '🪨' };
export const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
export const WIN_VP = 8;
export const PIECES = { road: 15, settlement: 5, city: 4 };
export const DEV_NAMES = { knight: 'Knight', roads: 'Road Building', plenty: 'Year of Plenty', vp: 'Victory Point' };

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const rnd = n => Math.floor(Math.random() * n);

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const pips = n => (n ? 6 - Math.abs(7 - n) : 0);

// ---------- board generation ----------

function hexCoords(size) {
  const centers = size === 'medium' ? [[0, 0], [1, 0]] : [[0, 0]];
  const list = centers.slice();
  const seen = new Set(list.map(c => c.join()));
  for (const [q, r] of centers) {
    for (const [dq, dr] of DIRS) {
      const k = `${q + dq},${r + dr}`;
      if (!seen.has(k)) { seen.add(k); list.push([q + dq, r + dr]); }
    }
  }
  return list;
}

function buildBoard(coords) {
  const r3 = x => Math.round(x * 1000) / 1000;
  const hexes = coords.map(([q, r]) => ({ q, r, x: r3(Math.sqrt(3) * (q + r / 2)), y: r3(1.5 * r), res: null, num: 0, v: [] }));
  const verts = [], edges = [], vKey = new Map(), eKey = new Map();
  hexes.forEach((h, hi) => {
    for (let k = 0; k < 6; k++) {
      const ang = Math.PI / 180 * (60 * k - 30);
      const x = r3(h.x + Math.cos(ang)), y = r3(h.y + Math.sin(ang));
      const key = Math.round(x * 100) + ',' + Math.round(y * 100);
      let vi = vKey.get(key);
      if (vi === undefined) {
        vi = verts.length;
        vKey.set(key, vi);
        verts.push({ x, y, hexes: [], adj: [], edges: [], port: null });
      }
      verts[vi].hexes.push(hi);
      h.v.push(vi);
    }
    for (let k = 0; k < 6; k++) {
      const a = h.v[k], b = h.v[(k + 1) % 6];
      const key = Math.min(a, b) + '-' + Math.max(a, b);
      let ei = eKey.get(key);
      if (ei === undefined) {
        ei = edges.length;
        eKey.set(key, ei);
        edges.push({ a, b, hexes: [], port: null });
        verts[a].edges.push(ei); verts[b].edges.push(ei);
        verts[a].adj.push(b); verts[b].adj.push(a);
      }
      edges[ei].hexes.push(hi);
    }
  });
  return { hexes, verts, edges };
}

function placePorts(b, size) {
  const cx = b.hexes.reduce((t, h) => t + h.x, 0) / b.hexes.length;
  const cy = b.hexes.reduce((t, h) => t + h.y, 0) / b.hexes.length;
  const ang = i => {
    const e = b.edges[i], va = b.verts[e.a], vb = b.verts[e.b];
    return Math.atan2((va.y + vb.y) / 2 - cy, (va.x + vb.x) / 2 - cx);
  };
  const coast = b.edges.map((_, i) => i).filter(i => b.edges[i].hexes.length === 1).sort((x, y) => ang(x) - ang(y));
  const specific = shuffle(RES.slice());
  const types = shuffle(size === 'medium' ? ['any', 'any', specific[0], specific[1]] : ['any', 'any', specific[0]]);
  const off = rnd(coast.length);
  types.forEach((t, i) => {
    const e = b.edges[coast[(off + Math.round(i * coast.length / types.length)) % coast.length]];
    e.port = t;
    b.verts[e.a].port = t;
    b.verts[e.b].port = t;
  });
}

function assignTiles(b, size) {
  const res = size === 'medium'
    ? [...RES, ...RES]
    : [...RES, ...shuffle(['wood', 'brick', 'sheep', 'wheat']).slice(0, 2)];
  shuffle(res);
  b.hexes.forEach((h, i) => { h.res = res[i]; });
  const nums = size === 'medium' ? [3, 4, 5, 5, 6, 8, 9, 9, 10, 11] : [3, 4, 5, 6, 8, 9, 10];
  const neighbours = b.edges.filter(e => e.hexes.length === 2).map(e => e.hexes);
  const hot = n => n === 6 || n === 8;
  for (let t = 0; t < 1000; t++) {
    shuffle(nums);
    if (!neighbours.some(([x, y]) => hot(nums[x]) && hot(nums[y]))) break;
  }
  b.hexes.forEach((h, i) => { h.num = nums[i]; });
}

function newPlayer() {
  return {
    res: Object.fromEntries(RES.map(r => [r, 0])),
    devs: [], fresh: [], knights: 0, vpCards: 0, roadLen: 0,
    left: { ...PIECES },
  };
}

export function newGame({ size = 'small', first = rnd(2) } = {}) {
  const b = buildBoard(hexCoords(size));
  placePorts(b, size);
  assignTiles(b, size);
  const deck = shuffle([
    ...Array(10).fill('knight'), ...Array(3).fill('vp'),
    ...Array(2).fill('roads'), ...Array(2).fill('plenty'),
  ]);
  return {
    size, hexes: b.hexes, verts: b.verts, edges: b.edges,
    robber: -1,
    vOwn: b.verts.map(() => -1), vCity: b.verts.map(() => false), eOwn: b.edges.map(() => -1),
    players: [newPlayer(), newPlayer()],
    devDeck: deck,
    first, cur: first, phase: 'setup',
    setupOrder: [first, 1 - first, 1 - first, first], setupStep: 0, setupNeed: 'settlement', lastSettle: -1,
    dice: null, rollId: 0, turn: 0, devPlayed: false, freeRoads: 0,
    lr: -1, la: -1, winner: -1, log: [],
  };
}

// ---------- queries ----------

export const total = P => RES.reduce((t, r) => t + P.res[r], 0);
export const afford = (P, cost) => RES.every(r => P.res[r] >= (cost[r] || 0));
const pay = (P, cost) => RES.forEach(r => { P.res[r] -= cost[r] || 0; });

export function spotFree(s, v) {
  return s.vOwn[v] === -1 && s.verts[v].adj.every(x => s.vOwn[x] === -1);
}

export function canSettle(s, p, v, setup) {
  if (!spotFree(s, v)) return false;
  return setup || s.verts[v].edges.some(e => s.eOwn[e] === p);
}

export function canRoad(s, p, e, setup) {
  if (s.eOwn[e] !== -1) return false;
  const { a, b } = s.edges[e];
  if (setup) return a === s.lastSettle || b === s.lastSettle;
  return [a, b].some(x => {
    if (s.vOwn[x] === p) return true;
    if (s.vOwn[x] !== -1) return false; // opponent's building blocks the connection
    return s.verts[x].edges.some(o => o !== e && s.eOwn[o] === p);
  });
}

export const legalSettles = (s, p, setup) => s.verts.map((_, v) => v).filter(v => canSettle(s, p, v, setup));
export const legalRoads = (s, p, setup) => s.edges.map((_, e) => e).filter(e => canRoad(s, p, e, setup));
export const upgradable = (s, p) => s.vOwn.map((_, v) => v).filter(v => s.vOwn[v] === p && !s.vCity[v]);

export function ratio(s, p, r) {
  let best = 4;
  s.verts.forEach((v, i) => {
    if (s.vOwn[i] !== p || !v.port) return;
    if (v.port === r) best = 2;
    else if (v.port === 'any') best = Math.min(best, 3);
  });
  return best;
}

export function vp(s, p, includeHidden = true) {
  let n = 0;
  s.vOwn.forEach((o, v) => { if (o === p) n += s.vCity[v] ? 2 : 1; });
  if (s.lr === p) n += 2;
  if (s.la === p) n += 2;
  if (includeHidden) n += s.players[p].vpCards;
  return n;
}

export function roadLength(s, p) {
  let best = 0;
  const used = new Set();
  const dfs = (v, len) => {
    if (len > best) best = len;
    if (len > 0 && s.vOwn[v] !== -1 && s.vOwn[v] !== p) return;
    for (const e of s.verts[v].edges) {
      if (s.eOwn[e] !== p || used.has(e)) continue;
      used.add(e);
      const { a, b } = s.edges[e];
      dfs(a === v ? b : a, len + 1);
      used.delete(e);
    }
  };
  s.eOwn.forEach((o, e) => {
    if (o !== p) return;
    dfs(s.edges[e].a, 0);
    dfs(s.edges[e].b, 0);
  });
  return best;
}

// Can player p do anything at all on their main phase? Used to auto-pass the turn.
export function hasAnyMove(s, p) {
  const P = s.players[p];
  if (s.phase === 'roads') return P.left.road > 0 && legalRoads(s, p, false).length > 0;
  if (s.phase !== 'main') return true;
  if (afford(P, COST.road) && P.left.road && legalRoads(s, p, false).length) return true;
  if (afford(P, COST.settlement) && P.left.settlement && legalSettles(s, p, false).length) return true;
  if (afford(P, COST.city) && P.left.city && upgradable(s, p).length) return true;
  if (afford(P, COST.dev) && s.devDeck.length) return true;
  if (!s.devPlayed && P.devs.some(d => d !== 'vp')) return true;
  return RES.some(r => P.res[r] >= ratio(s, p, r));
}

// The resources a player most wants next (used by the bot, e.g. for Year of Plenty).
export function wantedResources(s, p) {
  const P = s.players[p];
  const goal = upgradable(s, p).length && P.left.city ? COST.city : COST.settlement;
  const want = [];
  for (const r of RES) for (let i = P.res[r]; i < (goal[r] || 0); i++) want.push(r);
  return want.concat(['ore', 'wheat', 'sheep', 'wood', 'brick']);
}

// ---------- mutations ----------

const fmt = res => RES.filter(r => res[r]).map(r => ICON[r].repeat(res[r])).join('');

function log(s, msg) {
  s.log.push(msg);
  if (s.log.length > 60) s.log.shift();
}

function updateLongest(s) {
  const lens = [0, 1].map(p => (s.players[p].roadLen = roadLength(s, p)));
  const h = s.lr;
  if (h >= 0 && lens[h] >= 5 && lens[h] >= lens[1 - h]) return;
  const c = lens[0] > lens[1] ? 0 : lens[1] > lens[0] ? 1 : -1;
  const next = c >= 0 && lens[c] >= 5 ? c : -1;
  if (next !== h) {
    s.lr = next;
    if (next >= 0) log(s, `@${next} takes Longest Road (+2)`);
  }
}

function updateArmy(s, p) {
  const k = s.players[p].knights;
  if (k >= 3 && s.la !== p && (s.la < 0 || k > s.players[s.la].knights)) {
    s.la = p;
    log(s, `@${p} takes Largest Army (+2)`);
  }
}

function startTurn(s) {
  const d = [1 + rnd(6), 1 + rnd(6)];
  const sum = d[0] + d[1];
  s.dice = d;
  s.rollId++;
  log(s, `@${s.cur} rolled ${sum}`);
  if (sum === 7) {
    s.players.forEach((P, i) => {
      const n = Math.floor(total(P) / 2);
      if (total(P) <= 7) return;
      for (let k = 0; k < n; k++) {
        const max = Math.max(...RES.map(r => P.res[r]));
        const pick = shuffle(RES.filter(r => P.res[r] === max))[0];
        P.res[pick]--;
      }
      log(s, `@${i} discarded ${n} cards`);
    });
    s.phase = 'robber';
    return;
  }
  const gains = [{}, {}];
  s.hexes.forEach((h, hi) => {
    if (h.num !== sum || hi === s.robber) return;
    for (const v of h.v) {
      const o = s.vOwn[v];
      if (o < 0) continue;
      const n = s.vCity[v] ? 2 : 1;
      s.players[o].res[h.res] += n;
      gains[o][h.res] = (gains[o][h.res] || 0) + n;
    }
  });
  gains.forEach((g, i) => { if (Object.keys(g).length) log(s, `@${i} got ${fmt(g)}`); });
  s.phase = 'main';
}

const fail = err => ({ ok: false, err });

export function applyAction(s, p, a) {
  if (s.phase === 'over') return fail('The game is over');
  if (p !== s.cur) return fail('Not your turn');
  const P = s.players[p];
  const setup = s.phase === 'setup';

  switch (a && a.t) {
    case 'settle': {
      const v = a.v;
      if (setup) {
        if (s.setupNeed !== 'settlement' || !canSettle(s, p, v, true)) return fail('Cannot place a settlement there');
        s.vOwn[v] = p;
        P.left.settlement--;
        s.lastSettle = v;
        s.setupNeed = 'road';
        if (s.setupStep >= 2) {
          const g = {};
          for (const h of s.verts[v].hexes) { P.res[s.hexes[h].res]++; g[s.hexes[h].res] = (g[s.hexes[h].res] || 0) + 1; }
          log(s, `@${p} got ${fmt(g)}`);
        }
        return { ok: true };
      }
      if (s.phase !== 'main') return fail('Not now');
      if (!P.left.settlement) return fail('No settlements left');
      if (!afford(P, COST.settlement)) return fail('Not enough resources');
      if (!canSettle(s, p, v, false)) return fail('Cannot build there');
      pay(P, COST.settlement);
      s.vOwn[v] = p;
      P.left.settlement--;
      log(s, `@${p} built a settlement`);
      updateLongest(s);
      break;
    }
    case 'road': {
      const e = a.e;
      if (setup) {
        if (s.setupNeed !== 'road' || !canRoad(s, p, e, true)) return fail('Road must touch your new settlement');
        s.eOwn[e] = p;
        P.left.road--;
        s.setupStep++;
        if (s.setupStep >= 4) {
          s.phase = 'main';
          s.cur = s.first;
          s.lastSettle = -1;
          updateLongest(s);
          startTurn(s);
        } else {
          s.cur = s.setupOrder[s.setupStep];
          s.setupNeed = 'settlement';
          s.lastSettle = -1;
        }
        return { ok: true };
      }
      if (s.phase === 'roads') {
        if (!P.left.road || !canRoad(s, p, e, false)) return fail('Cannot build a road there');
        s.eOwn[e] = p;
        P.left.road--;
        s.freeRoads--;
        if (s.freeRoads <= 0 || !P.left.road || !legalRoads(s, p, false).length) s.phase = 'main';
      } else {
        if (s.phase !== 'main') return fail('Not now');
        if (!P.left.road) return fail('No roads left');
        if (!afford(P, COST.road)) return fail('Not enough resources');
        if (!canRoad(s, p, e, false)) return fail('Cannot build a road there');
        pay(P, COST.road);
        s.eOwn[e] = p;
        P.left.road--;
      }
      updateLongest(s);
      break;
    }
    case 'city': {
      const v = a.v;
      if (s.phase !== 'main') return fail('Not now');
      if (!P.left.city) return fail('No cities left');
      if (!afford(P, COST.city)) return fail('Not enough resources');
      if (s.vOwn[v] !== p || s.vCity[v]) return fail('Upgrade one of your settlements');
      pay(P, COST.city);
      s.vCity[v] = true;
      P.left.city--;
      P.left.settlement++;
      log(s, `@${p} built a city`);
      break;
    }
    case 'buydev': {
      if (s.phase !== 'main') return fail('Not now');
      if (!s.devDeck.length) return fail('No development cards left');
      if (!afford(P, COST.dev)) return fail('Not enough resources');
      pay(P, COST.dev);
      const card = s.devDeck.pop();
      if (card === 'vp') P.vpCards++;
      else P.fresh.push(card);
      log(s, `@${p} bought a development card`);
      break;
    }
    case 'play': {
      const i = P.devs.indexOf(a.card);
      if (s.phase !== 'main') return fail('Not now');
      if (s.devPlayed) return fail('Only one development card per turn');
      if (i < 0 || a.card === 'vp') return fail('You do not have that card');
      const pick = a.res;
      if (a.card === 'plenty' && !(Array.isArray(pick) && pick.length === 2 && pick.every(r => RES.includes(r)))) {
        return fail('Pick two resources');
      }
      P.devs.splice(i, 1);
      s.devPlayed = true;
      log(s, `@${p} played ${DEV_NAMES[a.card]}`);
      if (a.card === 'knight') {
        P.knights++;
        updateArmy(s, p);
        s.phase = 'robber';
      } else if (a.card === 'roads') {
        s.freeRoads = 2;
        if (P.left.road && legalRoads(s, p, false).length) s.phase = 'roads';
      } else if (a.card === 'plenty') {
        const g = {};
        pick.forEach(r => { P.res[r]++; g[r] = (g[r] || 0) + 1; });
        log(s, `@${p} took ${fmt(g)}`);
      }
      break;
    }
    case 'robber': {
      const h = a.h;
      if (s.phase !== 'robber') return fail('Not now');
      if (!(h >= 0 && h < s.hexes.length) || h === s.robber) return fail('Move the robber to another tile');
      s.robber = h;
      const o = 1 - p, O = s.players[o];
      if (s.hexes[h].v.some(v => s.vOwn[v] === o) && total(O) > 0) {
        const pool = RES.flatMap(r => Array(O.res[r]).fill(r));
        const r = pool[rnd(pool.length)];
        O.res[r]--;
        P.res[r]++;
        log(s, `@${p} stole ${ICON[r]} from @${o}`);
      }
      s.phase = 'main';
      break;
    }
    case 'trade': {
      const { give, get } = a;
      if (s.phase !== 'main') return fail('Not now');
      if (!RES.includes(give) || !RES.includes(get) || give === get) return fail('Invalid trade');
      const n = ratio(s, p, give);
      if (P.res[give] < n) return fail(`You need ${n} ${give}`);
      P.res[give] -= n;
      P.res[get]++;
      log(s, `@${p} traded ${ICON[give].repeat(n)} → ${ICON[get]}`);
      break;
    }
    case 'end': {
      if (s.phase !== 'main' && s.phase !== 'roads') return fail('Finish your move first');
      P.devs.push(...P.fresh);
      P.fresh = [];
      s.devPlayed = false;
      s.freeRoads = 0;
      s.cur = 1 - p;
      s.turn++;
      startTurn(s);
      return { ok: true };
    }
    default:
      return fail('Unknown action');
  }

  if (vp(s, p) >= WIN_VP) {
    s.winner = p;
    s.phase = 'over';
    log(s, `@${p} wins with ${vp(s, p)} points!`);
  }
  return { ok: true };
}
