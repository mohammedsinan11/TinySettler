// A simple greedy bot. Given a state and a seat, returns the next action.
import {
  RES, COST, pips, afford, spotFree, legalSettles, legalRoads, upgradable, ratio, total,
} from './engine.js';

function production(s, p) {
  const prod = Object.fromEntries(RES.map(r => [r, 0]));
  s.vOwn.forEach((o, v) => {
    if (o !== p) return;
    for (const h of s.verts[v].hexes) prod[s.hexes[h].res] += pips(s.hexes[h].num) * (s.vCity[v] ? 2 : 1);
  });
  return prod;
}

function vertexScore(s, v, p) {
  const prod = p === undefined ? null : production(s, p);
  const seen = new Set();
  let sc = 0;
  for (const h of s.verts[v].hexes) {
    const hx = s.hexes[h];
    sc += pips(hx.num) * (h === s.robber ? 0.3 : 1);
    if (!seen.has(hx.res)) {
      seen.add(hx.res);
      sc += 0.8;
      if (prod && !prod[hx.res]) sc += 1.5;
    }
  }
  if (s.verts[v].port) sc += 0.8;
  return sc;
}

function roadScore(s, p, e) {
  const { a, b } = s.edges[e];
  let sc = 0.05 * Math.random();
  for (const x of [a, b]) {
    if (s.vOwn[x] === p) continue;
    if (spotFree(s, x)) sc = Math.max(sc, vertexScore(s, x, p) + 5);
    for (const y of s.verts[x].adj) {
      if (y !== a && y !== b && spotFree(s, y)) sc = Math.max(sc, vertexScore(s, y, p) * 0.6 + 1);
    }
  }
  return sc;
}

function best(list, score) {
  let bi = list[0], bs = -Infinity;
  for (const x of list) {
    const v = score(x);
    if (v > bs) { bs = v; bi = x; }
  }
  return bi;
}

export function robberTarget(s, p) {
  return best(s.hexes.map((_, h) => h).filter(h => h !== s.robber), h => {
    const hx = s.hexes[h];
    let v = Math.random() * 0.1;
    for (const x of hx.v) {
      const o = s.vOwn[x];
      if (o < 0) continue;
      const w = (s.vCity[x] ? 2 : 1) * pips(hx.num);
      v += o === p ? -2 * w : w;
    }
    return v;
  });
}

function tradeToward(s, p, cost) {
  const P = s.players[p];
  const need = r => Math.max(0, (cost[r] || 0) - P.res[r]);
  const missing = RES.filter(r => need(r) > 0);
  if (!missing.length) return null;
  const surplus = r => P.res[r] - (cost[r] || 0);
  const possible = RES.reduce((t, r) => t + Math.max(0, Math.floor(surplus(r) / ratio(s, p, r))), 0);
  if (possible < missing.reduce((t, r) => t + need(r), 0)) return null;
  const give = RES.filter(r => surplus(r) >= ratio(s, p, r)).sort((x, y) => surplus(y) - surplus(x))[0];
  return give ? { t: 'trade', give, get: missing[0] } : null;
}

export function botAct(s, p) {
  const P = s.players[p];

  if (s.phase === 'setup') {
    if (s.setupNeed === 'settlement') return { t: 'settle', v: best(legalSettles(s, p, true), v => vertexScore(s, v, p)) };
    return { t: 'road', e: best(legalRoads(s, p, true), e => roadScore(s, p, e)) };
  }
  if (s.phase === 'robber') return { t: 'robber', h: robberTarget(s, p) };
  if (s.phase === 'roads') {
    const es = legalRoads(s, p, false);
    return es.length ? { t: 'road', e: best(es, e => roadScore(s, p, e)) } : { t: 'end' };
  }
  if (s.phase !== 'main') return { t: 'end' };

  const settles = P.left.settlement ? legalSettles(s, p, false) : [];
  const upg = P.left.city ? upgradable(s, p) : [];

  if (upg.length && afford(P, COST.city)) return { t: 'city', v: best(upg, v => vertexScore(s, v)) };
  if (settles.length && afford(P, COST.settlement)) return { t: 'settle', v: best(settles, v => vertexScore(s, v, p)) };

  if (!s.devPlayed) {
    const robberOnMe = s.robber >= 0 && s.hexes[s.robber].v.some(v => s.vOwn[v] === p);
    const armyChase = P.knights >= 2 && s.la !== p;
    if (P.devs.includes('knight') && (robberOnMe || armyChase || total(s.players[1 - p]) >= 5)) return { t: 'play', card: 'knight' };
    if (P.devs.includes('plenty')) return { t: 'play', card: 'plenty' };
    if (P.devs.includes('roads') && P.left.road && legalRoads(s, p, false).length) return { t: 'play', card: 'roads' };
  }

  const roads = P.left.road ? legalRoads(s, p, false) : [];
  let roadPick = -1, roadVal = 0;
  if (roads.length) {
    roadPick = best(roads, e => roadScore(s, p, e));
    roadVal = roadScore(s, p, roadPick);
  }
  const wantRoad = roads.length && (
    (!settles.length && P.left.settlement && roadVal >= 1) ||
    (P.roadLen >= 3 && s.lr !== p && P.res.wood >= 2 && P.res.brick >= 2));
  if (wantRoad && afford(P, COST.road)) return { t: 'road', e: roadPick };

  if (afford(P, COST.dev) && s.devDeck.length && (!upg.length || P.res.ore >= 4 || s.turn % 3 === 0)) return { t: 'buydev' };

  const goals = [];
  if (upg.length) goals.push(COST.city);
  if (settles.length) goals.push(COST.settlement);
  if (wantRoad) goals.push(COST.road);
  if (s.devDeck.length) goals.push(COST.dev);
  for (const g of goals) {
    const t = tradeToward(s, p, g);
    if (t) return t;
  }
  return { t: 'end' };
}

// Used when a human runs out of time.
export function autoAct(s, p) {
  if (s.phase === 'main' || s.phase === 'roads') return { t: 'end' };
  return botAct(s, p);
}
