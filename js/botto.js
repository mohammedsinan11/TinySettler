// Botto: the strong bot. Same interface as botAct in bot.js: given a state and
// a seat, return the next action. It plans around a goal (the most valuable
// thing it can build soon), values resources by what it lacks, steers roads
// to the best free corner, trades towards its goal and keeps its hand small.
// Kept cheap to compute: no search, so it runs well within a server request.
import {
  RES, COST, pips, afford, total, ratio, vp, spotFree, legalSettles, legalRoads, upgradable, roadLength, WIN_VP,
} from './engine.js';

// Tunable knobs (found by self-play against the normal bot, see README).
export const DEFAULTS = {
  wood: 0.98, brick: 0.81, sheep: 0.75, wheat: 1.12, ore: 1.07,
  lack: 2.15,       // extra value of resources we don't produce yet
  deny: 0.16,       // how much taking a corner the opponent wants is worth
  devScore: 6.2,    // how keen we are on development cards
  cityBias: 0.47,   // added to a city's score when choosing between city and settlement
  expand: 1.2,      // build roads towards a corner worth this much more than any free one we have
  handLimit: 7,     // above this many cards, trade some away before ending the turn
  knightOpp: 7,     // play a knight when the opponent holds this many cards
  setupRoad: 1,     // extra weight on wood and brick when placing the starting settlements
  chaseRoad: 1,     // go for Longest Road (cheapest 2 points in this variant)
  chaseArmy: 1,     // buy development cards for Largest Army
};
let K = DEFAULTS;
const BASE = new Proxy({}, { get: (_, r) => K[r] });

function production(s, p) {
  const prod = Object.fromEntries(RES.map(r => [r, 0]));
  s.vOwn.forEach((o, v) => {
    if (o !== p) return;
    for (const h of s.verts[v].hexes) if (h !== s.robber) prod[s.hexes[h].res] += pips(s.hexes[h].num) * (s.vCity[v] ? 2 : 1);
  });
  return prod;
}

// How much one more pip of each resource is worth: resources we lack count more.
function weights(s, p, prod) {
  const w = {};
  for (const r of RES) w[r] = BASE[r] * (1 + K.lack / (1 + prod[r] / 2.5));
  if (s.phase === 'setup') { w.wood *= K.setupRoad; w.brick *= K.setupRoad; }
  return w;
}

function hasPort(s, p, kind) {
  return s.verts.some((v, i) => s.vOwn[i] === p && v.port === kind);
}

// Value of owning (another) settlement on corner v.
function spotValue(s, p, v, w, prod) {
  let val = 0;
  const kinds = new Set();
  for (const h of s.verts[v].hexes) {
    if (h === s.robber) continue;
    const hx = s.hexes[h], pp = pips(hx.num);
    val += pp * w[hx.res];
    if (!kinds.has(hx.res)) { kinds.add(hx.res); if (!prod[hx.res]) val += 2.2; }
  }
  const port = s.verts[v].port;
  if (port === 'any' && !hasPort(s, p, 'any')) val += 1.5;
  else if (port && port !== 'any') val += Math.max(0, (prod[port] + (kinds.has(port) ? 3 : 0)) - 3) * 0.8;
  return val;
}

// A corner's value for us plus what we take away from the opponent by claiming it.
function claimValue(s, p, v, w, prod, ow, oprod) {
  return spotValue(s, p, v, w, prod) + K.deny * spotValue(s, 1 - p, v, ow, oprod);
}

// Best free corner we can reach by building at most `depth` roads, as {v, dist, val, first}.
// `first` is the edge to build next towards it.
function bestTarget(s, p, w, prod, depth = 3) {
  const seen = new Map(); // vertex -> { dist, first }
  const queue = [];
  s.vOwn.forEach((o, v) => { if (o === p) { seen.set(v, { dist: 0, first: -1 }); queue.push(v); } });
  s.eOwn.forEach((o, e) => {
    if (o !== p) return;
    for (const v of [s.edges[e].a, s.edges[e].b]) {
      if (!seen.has(v) && (s.vOwn[v] === -1 || s.vOwn[v] === p)) { seen.set(v, { dist: 0, first: -1 }); queue.push(v); }
    }
  });
  let best = null;
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi], cur = seen.get(v);
    if (cur.dist > 0 && spotFree(s, v)) {
      const val = spotValue(s, p, v, w, prod) / (1 + 0.55 * cur.dist);
      if (!best || val > best.val) best = { v, dist: cur.dist, val, first: cur.first };
    }
    if (cur.dist >= depth) continue;
    if (s.vOwn[v] !== -1 && s.vOwn[v] !== p) continue; // can't pass the opponent's buildings
    for (const e of s.verts[v].edges) {
      if (s.eOwn[e] !== -1 && s.eOwn[e] !== p) continue;
      const u = s.edges[e].a === v ? s.edges[e].b : s.edges[e].a;
      if (seen.has(u)) continue;
      const free = s.eOwn[e] === -1;
      seen.set(u, { dist: cur.dist + (free ? 1 : 0), first: cur.first >= 0 ? cur.first : (free ? e : -1) });
      queue.push(u);
    }
  }
  return best;
}

// How long our longest road would be with one more road on edge e.
function lengthWith(s, p, e) {
  s.eOwn[e] = p;
  const len = roadLength(s, p);
  s.eOwn[e] = -1;
  return len;
}

// The road that best extends our longest road (ties broken towards good corners).
function bestLongRoad(s, p, w, prod) {
  const roads = legalRoads(s, p, false);
  if (!roads.length) return null;
  let best = null;
  for (const e of roads) {
    const len = lengthWith(s, p, e);
    let near = 0;
    for (const v of [s.edges[e].a, s.edges[e].b]) if (spotFree(s, v)) near = Math.max(near, spotValue(s, p, v, w, prod));
    const score = len * 10 + near * 0.3;
    if (!best || score > best.score) best = { e, len, score };
  }
  return best;
}

function bestOf(list, score) {
  let bi = list[0], bs = -Infinity;
  for (const x of list) { const v = score(x); if (v > bs) { bs = v; bi = x; } }
  return bi;
}

function robberHex(s, p) {
  const o = 1 - p, O = s.players[o];
  return bestOf(s.hexes.map((_, h) => h).filter(h => h !== s.robber), h => {
    const hx = s.hexes[h];
    let v = Math.random() * 0.05;
    for (const x of hx.v) {
      const own = s.vOwn[x];
      if (own < 0) continue;
      const amt = pips(hx.num) * (s.vCity[x] ? 2 : 1);
      v += own === o ? amt * (1 + (O.res[hx.res] === 0 ? 0.3 : 0)) : -2.5 * amt;
    }
    if (hx.v.some(x => s.vOwn[x] === o)) v += 1.5; // there's a card to steal
    return v;
  });
}

// What to save up for, in order of preference.
function goals(s, p, w, prod, target) {
  const P = s.players[p];
  const list = [];
  const cities = P.left.city ? upgradable(s, p) : [];
  if (cities.length) {
    const best = bestOf(cities, v => spotValue(s, p, v, w, prod));
    list.push({ kind: 'city', cost: COST.city, v: best, score: 10 + spotValue(s, p, best, w, prod) * 0.9 });
  }
  if (P.left.settlement) {
    const spots = legalSettles(s, p, false);
    if (spots.length) {
      const best = bestOf(spots, v => spotValue(s, p, v, w, prod));
      list.push({ kind: 'settlement', cost: COST.settlement, v: best, score: 10 + spotValue(s, p, best, w, prod) });
    } else if (target && P.left.road) {
      list.push({ kind: 'road', cost: COST.road, e: target.first, score: 4 + target.val * 0.5 });
    }
  }
  if (s.devDeck.length) list.push({ kind: 'dev', cost: COST.dev, score: K.devScore + (K.chaseArmy && s.la !== p ? 3 + P.knights : 0) });
  return list.sort((a, b) => b.score - a.score);
}

const missingFor = (P, cost) => RES.reduce((t, r) => t + Math.max(0, (cost[r] || 0) - P.res[r]), 0);

// One bank trade that moves us towards `cost`, without touching what it needs.
function tradeToward(s, p, cost, force = false) {
  const P = s.players[p];
  const need = RES.filter(r => (cost[r] || 0) > P.res[r]);
  if (!need.length) return null;
  const spare = r => P.res[r] - (cost[r] || 0);
  const offers = RES.filter(r => spare(r) >= ratio(s, p, r)).sort((a, b) => (spare(b) - ratio(s, p, b)) - (spare(a) - ratio(s, p, a)));
  if (!offers.length) return null;
  // Only trade if we can finish the goal this turn, unless the hand is too big anyway.
  const possible = RES.reduce((t, r) => t + Math.max(0, Math.floor(spare(r) / ratio(s, p, r))), 0);
  if (!force && possible < missingFor(P, cost)) return null;
  const get = bestOf(need, r => (cost[r] || 0) - P.res[r]);
  return { t: 'trade', give: offers[0], get };
}

export function bottoAct(s, p, knobs = DEFAULTS) {
  K = knobs;
  const P = s.players[p], O = s.players[1 - p];
  const prod = production(s, p), w = weights(s, p, prod);
  const oprod = production(s, 1 - p), ow = weights(s, 1 - p, oprod);

  if (s.phase === 'setup') {
    if (s.setupNeed === 'settlement') {
      return { t: 'settle', v: bestOf(legalSettles(s, p, true), v => {
        let val = claimValue(s, p, v, w, prod, ow, oprod);
        // look one corner further: good neighbours make the road useful
        let next = 0;
        for (const u of s.verts[v].adj) for (const x of s.verts[u].adj) {
          if (x !== v && spotFree(s, x) && !s.verts[v].adj.includes(x)) next = Math.max(next, spotValue(s, p, x, w, prod));
        }
        return val + next * 0.25 + Math.random() * 0.01;
      }) };
    }
    const roads = legalRoads(s, p, true);
    return { t: 'road', e: bestOf(roads, e => {
      const { a, b } = s.edges[e];
      const far = a === s.lastSettle ? b : a;
      let val = Math.random() * 0.01;
      for (const x of s.verts[far].adj) if (x !== s.lastSettle && spotFree(s, x)) val = Math.max(val, spotValue(s, p, x, w, prod));
      return val;
    }) };
  }

  if (s.phase === 'robber') return { t: 'robber', h: robberHex(s, p) };

  const target = P.left.road ? bestTarget(s, p, w, prod) : null;
  const roadTowardTarget = () => {
    if (!target || target.first < 0) return null;
    return legalRoads(s, p, false).includes(target.first) ? target.first : null;
  };

  if (s.phase === 'roads') {
    const e = roadTowardTarget();
    if (e !== null) return { t: 'road', e };
    const all = legalRoads(s, p, false);
    return all.length ? { t: 'road', e: all[0] } : { t: 'end' };
  }
  if (s.phase !== 'main') return { t: 'end' };

  const myVp = vp(s, p);
  const cities = P.left.city ? upgradable(s, p) : [];
  const spots = P.left.settlement ? legalSettles(s, p, false) : [];

  // 1. Points first: city or settlement, whichever is worth more.
  const canCity = cities.length && afford(P, COST.city);
  const canSettle = spots.length && afford(P, COST.settlement);
  if (canCity || canSettle) {
    const cityV = canCity ? bestOf(cities, v => spotValue(s, p, v, w, prod)) : -1;
    const setV = canSettle ? bestOf(spots, v => claimValue(s, p, v, w, prod, ow, oprod)) : -1;
    const cityScore = canCity ? spotValue(s, p, cityV, w, prod) + K.cityBias : -Infinity;
    const setScore = canSettle ? claimValue(s, p, setV, w, prod, ow, oprod) : -Infinity;
    return cityScore >= setScore ? { t: 'city', v: cityV } : { t: 'settle', v: setV };
  }

  // 2. Development cards.
  if (!s.devPlayed) {
    const robberOnMe = s.robber >= 0 && s.hexes[s.robber].v.some(v => s.vOwn[v] === p);
    const armyClose = P.devs.includes('knight') && P.knights + 1 >= 3 && (s.la !== p) && P.knights + 1 > O.knights;
    const winByArmy = armyClose && myVp + 2 >= (s.winVp || WIN_VP);
    if (P.devs.includes('knight') && (robberOnMe || armyClose || winByArmy || total(O) >= K.knightOpp)) return { t: 'play', card: 'knight' };
    if (P.devs.includes('roads') && P.left.road >= 1 && roadTowardTarget() !== null && !spots.length) return { t: 'play', card: 'roads' };
    if (P.devs.includes('plenty')) {
      const g = goals(s, p, w, prod, target).find(x => missingFor(P, x.cost) <= 2 && missingFor(P, x.cost) > 0);
      if (g) {
        const res = [];
        const tmp = { ...P.res };
        for (let i = 0; i < 2; i++) {
          const r = RES.find(x => (g.cost[x] || 0) > tmp[x]) || 'ore';
          res.push(r); tmp[r]++;
        }
        return { t: 'play', card: 'plenty', res };
      }
    }
  }

  // 3. Roads: towards the best free corner when there is none to build on, or to win Longest Road.
  const plan = goals(s, p, w, prod, target);
  const top = plan[0];
  const nearSettlementCheck = () => spots.length && missingFor(P, COST.settlement) <= 1;
  if (afford(P, COST.road) && P.left.road) {
    const e = roadTowardTarget();
    const bestHere = spots.length ? Math.max(...spots.map(v => spotValue(s, p, v, w, prod))) : 0;
    const needSpot = P.left.settlement && e !== null && target && target.dist >= 1 &&
      (!spots.length || spotValue(s, p, target.v, w, prod) > bestHere * K.expand);
    const lr = K.chaseRoad && (s.lr !== p || O.roadLen >= P.roadLen - 1) ? bestLongRoad(s, p, w, prod) : null;
    const lrGain = lr && lr.len > P.roadLen && lr.len + 2 >= 5 && lr.len >= O.roadLen;
    if (lrGain && (!nearSettlementCheck() || !spots.length)) return { t: 'road', e: lr.e };
    const lrRace = P.roadLen >= 4 && s.lr !== p && P.roadLen + 1 > O.roadLen && e !== null;
    const roadIsGoal = top && top.kind === 'road';
    // don't spend wood/brick a settlement needs when we're one card away from it
    const nearSettlement = spots.length && missingFor(P, COST.settlement) <= 1;
    if ((needSpot || lrRace || roadIsGoal) && (!nearSettlement || !spots.length)) return { t: 'road', e };
  }

  // 4. Trade towards the best goal we can finish now.
  for (const g of plan) {
    const tr = tradeToward(s, p, g.cost);
    if (tr) return tr;
  }

  // 5. Buy a development card if nothing better is coming.
  if (afford(P, COST.dev) && s.devDeck.length) {
    const saving = !(K.chaseArmy && s.la !== p) && top && top.kind !== 'dev' && missingFor(P, top.cost) <= 1 && RES.some(r => (top.cost[r] || 0) > 0 && (COST.dev[r] || 0) > 0 && P.res[r] - (COST.dev[r] || 0) < (top.cost[r] || 0));
    if (!saving) return { t: 'buydev' };
  }

  // 6. Too many cards: a 7 would cost half of them, so trade some away.
  if (total(P) > K.handLimit && top) {
    const tr = tradeToward(s, p, top.cost, true);
    if (tr) return tr;
  }
  return { t: 'end' };
}
