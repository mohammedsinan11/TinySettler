import {
  RES, ICON, COST, WIN_VP, DEV_NAMES, afford, vp, ratio, legalSettles, legalRoads, upgradable, hasAnyMove,
} from './engine.js';
import { newTable, act, step, viewFor, turnLength } from './table.js';
import { SERVER } from './config.js';

const $ = id => document.getElementById(id);
const R = 60;                      // hex radius in SVG units
const SEARCH_MS = 9000;            // how long to look for a human before falling back to the bot
const COLORS = { me: '#2f7de1', opp: '#e0533d' };
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// The game runs on the server, which sends us only what our seat may see.
// Without a server (or if it can't be reached) a bot game runs in the browser.
let S = null;            // my view of the game
let me = 0;              // my seat
let oppLabel = 'Bot', online = false;
let session = null;      // the game in progress: { act, name, close, connected, local }
let lobbyWs = null, serverDown = !SERVER;
let tradeGive = null, plenty = null, buildMode = null;
let deadline = 0, lastRoll = 0, savedResult = false;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
let size = store.get('tinysettler.size') || 'small';

// ---------- helpers ----------

const name = p => (p === me ? 'You' : oppLabel);
const color = p => (p === me ? COLORS.me : COLORS.opp);
const myTurn = () => S && S.cur === me && S.winner < 0;
const costStr = c => RES.filter(r => c[r]).map(r => ICON[r].repeat(c[r])).join('');
const wsUrl = path => SERVER.replace(/^http/, 'ws').replace(/\/$/, '') + path;

function toast(msg, ms = 1600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), ms);
}

// ---------- lobby / matchmaking ----------

function showLobby() {
  $('over').hidden = true;
  $('lobby').hidden = false;
  document.querySelectorAll('.sizes button').forEach(b => b.classList.toggle('sel', b.dataset.size === size));
  loadHof();
  startSearch();
}

function startSearch() {
  cancelSearch();
  if (serverDown) {
    $('mmStatus').classList.add('off');
    $('mmText').textContent = SERVER ? 'Online play is unavailable right now.' : 'Online play is not set up yet.';
    return;
  }
  $('mmStatus').classList.remove('off');
  let left = SEARCH_MS / 1000;
  $('mmText').textContent = `Looking for an opponent… ${left}s`;
  startSearch.tick = setInterval(() => {
    left = Math.max(0, left - 1);
    $('mmText').textContent = left ? `Looking for an opponent… ${left}s` : 'Starting a bot game…';
  }, 1000);
  startSearch.timeout = setTimeout(startBot, SEARCH_MS);

  const ws = new WebSocket(wsUrl(`/match?size=${size}`));
  lobbyWs = ws;
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.k !== 'match' || lobbyWs !== ws) return;
    cancelSearch();
    joinGame(`/game?id=${m.game}&token=${m.token}`);
  };
  ws.onclose = () => {
    if (lobbyWs !== ws) return;
    lobbyWs = null;
    serverDown = true;
    startSearch();
  };
}

function cancelSearch() {
  clearInterval(startSearch.tick);
  clearTimeout(startSearch.timeout);
  if (lobbyWs) { const ws = lobbyWs; lobbyWs = null; ws.close(); }
}

function startBot() {
  cancelSearch();
  if (serverDown) startLocal();
  else joinGame(`/bot?size=${size}`);
}

function enterGame() {
  $('lobby').hidden = true;
  $('over').hidden = true;
  $('game').hidden = false;
  tradeGive = plenty = buildMode = null;
  resetFx();
  savedResult = false;
  lastRoll = 0;
}

// Called with every new view of the game.
function show(view, meta) {
  if ($('game').hidden) enterGame();
  S = view;
  me = meta.seat;
  oppLabel = meta.opp;
  online = meta.online;
  deadline = meta.remaining ? Date.now() + meta.remaining : 0;
  render();
  if (S.winner >= 0) setTimeout(showOver, 900);
}

// ---------- offline game against a bot in the browser ----------

function startLocal() {
  const t = newTable({ size, bots: [false, true] });
  let timer = 0;
  const pump = () => {
    clearTimeout(timer);
    show(viewFor(t.s, 0), { seat: 0, opp: 'Bot', online: false, remaining: 0 });
    if (t.autoAt) timer = setTimeout(() => { step(t, Date.now()); pump(); }, Math.max(0, t.autoAt - Date.now()));
  };
  session = {
    local: true, connected: true,
    act(a) {
      const r = act(t, 0, a, Date.now());
      if (!r.ok) toast(r.err);
      pump();
    },
    name() {},
    close() { clearTimeout(timer); },
  };
  pump();
}

// ---------- game on the server ----------

function joinGame(path) {
  let url = wsUrl(path), tries = 0, ws = null, lastPong = 0;
  const sess = {
    local: false, connected: false, closed: false,
    act(a) { send({ k: 'act', a }); },
    name(n) { send({ k: 'name', name: n }); },
    close() {
      sess.closed = true;
      clearInterval(ping);
      if (ws) ws.close();
    },
  };
  const send = m => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  session = sess;

  // Pings are answered by the server without waking the game up; no answer means the line is dead.
  const ping = setInterval(() => {
    if (!sess.connected) return;
    if (Date.now() - lastPong > 15000) ws.close();
    else ws.send('ping');
  }, 5000);

  const connect = () => {
    const w = new WebSocket(url);
    ws = w;
    w.onopen = () => { sess.connected = true; tries = 0; lastPong = Date.now(); if (S) render(); };
    w.onmessage = e => {
      if (sess.closed || ws !== w) return;
      lastPong = Date.now();
      if (e.data === 'pong') return;
      const m = JSON.parse(e.data);
      if (m.k === 'hello') url = wsUrl(`/game?id=${m.game}&token=${m.token}`); // where to reconnect
      else if (m.k === 'state') show(m.view, m);
      else if (m.k === 'err' || m.k === 'toast') toast(m.msg, 2500);
      else if (m.k === 'winner') $('overText').textContent = `${m.name} won this one.`;
      else if (m.k === 'saved') renderHof(m.hof);
    };
    w.onclose = () => {
      if (sess.closed || ws !== w) return;
      sess.connected = false;
      if (!S) { // never got into the game
        sess.close();
        serverDown = true;
        toast('Server unreachable — playing offline', 2500);
        startLocal();
        return;
      }
      if (S.winner >= 0) return;
      render();
      if (tries++ < 6) setTimeout(() => { if (!sess.closed) connect(); }, 1500);
      else toast('Lost connection to the server', 4000);
    };
  };
  S = null;
  connect();
}

function dispatch(a) {
  tradeGive = a.t === 'trade' ? null : tradeGive;
  if (a.t === 'road' || a.t === 'settle' || a.t === 'city') buildMode = null;
  if (session) session.act(a);
}

// ---------- rendering ----------

const RES_NAME = { wood: 'Wood', brick: 'Brick', sheep: 'Sheep', wheat: 'Wheat', ore: 'Ore' };
const DEV_INFO = {
  knight: ['⚔️', 'Move the robber and steal a card'],
  roads: ['🛣️', 'Build 2 roads for free'],
  plenty: ['🎁', 'Take any 2 resources'],
  vp: ['⭐', '+1 point, hidden from your opponent'],
};

// Short-lived effects (pop-ins, flashes). The board is redrawn often, so each
// effect remembers when it started and resumes with a negative animation delay.
const fx = new Map();
let seen = null, prevRes = null, gains = {};
function fxStart(key) { fx.set(key, performance.now()); }
function fxStyle(key, ms) {
  const t = fx.get(key);
  if (t === undefined) return null;
  const age = performance.now() - t;
  return age < ms ? `animation-delay:-${age | 0}ms` : null;
}
function resetFx() { fx.clear(); seen = null; prevRes = null; gains = {}; }

// Notice what changed since the last view, so it can be animated.
function trackChanges() {
  const first = !seen;
  const keys = new Set();
  S.vOwn.forEach((o, v) => { if (o >= 0) keys.add(`v${v}${S.vCity[v] ? 'c' : 's'}`); });
  S.eOwn.forEach((o, e) => { if (o >= 0) keys.add(`e${e}`); });
  if (seen) for (const k of keys) if (!seen.has(k)) fxStart(k);
  seen = keys;
  if (!first && S.rollId !== lastRoll) fxStart('roll');
  const res = S.players[me].res;
  if (!first) RES.forEach(r => { if (res[r] > prevRes[r]) { gains[r] = res[r] - prevRes[r]; fxStart(`gain-${r}`); } });
  prevRes = { ...res };
}

function render() {
  trackChanges();
  renderBoard();
  renderPanel();
  renderDice();
}

function renderDice() {
  const d = $('dice');
  if (!S.dice) { d.classList.remove('on'); return; }
  d.innerHTML = `<span class="die">${DIE[S.dice[0]]}</span><span class="die">${DIE[S.dice[1]]}</span><b>${S.dice[0] + S.dice[1]}</b>` +
    `<small>${S.cur === me ? 'You' : name(S.cur)} rolled</small>`;
  d.classList.add('on');
  d.style.setProperty('--who', color(S.cur));
  if (S.rollId !== lastRoll) {
    lastRoll = S.rollId;
    d.classList.remove('roll');
    void d.offsetWidth;
    d.classList.add('roll');
  }
}

function targets() {
  const t = { verts: [], edges: [], cities: [], hexes: [] };
  if (!myTurn() || !session || !session.connected) return t;
  const P = S.players[me];
  const want = k => !buildMode || buildMode === k;
  if (S.phase === 'setup') {
    if (S.setupNeed === 'settlement') t.verts = legalSettles(S, me, true);
    else t.edges = legalRoads(S, me, true);
  } else if (S.phase === 'robber') {
    t.hexes = S.hexes.map((_, h) => h).filter(h => h !== S.robber);
  } else if (S.phase === 'roads') {
    t.edges = legalRoads(S, me, false);
  } else if (S.phase === 'main') {
    if (want('settlement') && P.left.settlement && afford(P, COST.settlement)) t.verts = legalSettles(S, me, false);
    if (want('road') && P.left.road && afford(P, COST.road)) t.edges = legalRoads(S, me, false);
    if (want('city') && P.left.city && afford(P, COST.city)) t.cities = upgradable(S, me);
  }
  return t;
}

// Tile textures, lighting and shadows.
const DEFS = `<defs>
  <pattern id="tx-wood" width="26" height="24" patternUnits="userSpaceOnUse"><rect width="26" height="24" fill="#3b7a34"/>
    <path d="M6 18 L11 6 L16 18Z M17 22 L21 12 L25 22Z" fill="#2a5c25"/><path d="M11 6 L13.5 12 L11 11Z" fill="#5a9a48"/></pattern>
  <pattern id="tx-brick" width="24" height="14" patternUnits="userSpaceOnUse"><rect width="24" height="14" fill="#c4612c"/>
    <path d="M0 0.5H24M0 7.5H24M6 0V7M18 7V14" stroke="#9b4720" stroke-width="1.6"/></pattern>
  <pattern id="tx-sheep" width="22" height="22" patternUnits="userSpaceOnUse"><rect width="22" height="22" fill="#95c447"/>
    <path d="M3 8q2-4 4 0M13 18q2-4 4 0M15 5q1.5-3 3 0" stroke="#79a836" stroke-width="1.6" fill="none"/></pattern>
  <pattern id="tx-wheat" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="12" height="12" fill="#e6c044"/>
    <path d="M0 3H12M0 9H12" stroke="#d1a72f" stroke-width="2"/></pattern>
  <pattern id="tx-ore" width="34" height="26" patternUnits="userSpaceOnUse"><rect width="34" height="26" fill="#8d939b"/>
    <path d="M0 26 L11 8 L19 19 L25 11 L34 26Z" fill="#727880"/><path d="M11 8 L14 13 L11 12 L8 13Z" fill="#e8ecef"/></pattern>
  <radialGradient id="light" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#fff" stop-opacity=".28"/>
    <stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></radialGradient>
  <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="2.5" stdDeviation="2" flood-opacity=".45"/></filter>
</defs>`;

function renderBoard() {
  const svg = $('board');
  const xs = S.verts.map(v => v.x * R), ys = S.verts.map(v => v.y * R);
  const pad = R * 1.05;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  svg.setAttribute('viewBox', `${minX} ${minY} ${Math.max(...xs) - minX + pad} ${Math.max(...ys) - minY + pad}`);
  const t = targets();
  const X = v => S.verts[v].x * R, Y = v => S.verts[v].y * R;
  const ring = (h, k) => h.v.map(v => `${(h.x * R + (X(v) - h.x * R) * k).toFixed(1)},${(h.y * R + (Y(v) - h.y * R) * k).toFixed(1)}`).join(' ');
  const out = [DEFS];
  const sum = S.dice ? S.dice[0] + S.dice[1] : 0;
  const rollFx = fxStyle('roll', 2400);

  // shallow water and sandy shore
  S.hexes.forEach(h => out.push(`<polygon class="shallow" points="${ring(h, 1.18)}"/>`));
  S.hexes.forEach(h => out.push(`<polygon class="sand" points="${ring(h, 1.12)}"/>`));

  // harbours
  S.edges.forEach(e => {
    if (!e.port) return;
    const a = S.verts[e.a], b = S.verts[e.b], h = S.hexes[e.hexes[0]];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = mx - h.x, dy = my - h.y, len = Math.hypot(dx, dy);
    const px = (mx + dx / len * 0.62) * R, py = (my + dy / len * 0.62) * R;
    const label = e.port === 'any' ? '3:1' : `2:1`;
    out.push(`<g class="port"><title>Harbour: trade ${e.port === 'any' ? '3 of a kind' : `2 ${RES_NAME[e.port]}`} for 1</title>` +
      `<line x1="${px}" y1="${py}" x2="${a.x * R}" y2="${a.y * R}"/><line x1="${px}" y1="${py}" x2="${b.x * R}" y2="${b.y * R}"/>` +
      `<circle cx="${px}" cy="${py}" r="19" filter="url(#shadow)"/>` +
      (e.port === 'any' ? `<text x="${px}" y="${py}">${label}</text>`
        : `<text x="${px}" y="${py - 6}" class="pi">${ICON[e.port]}</text><text x="${px}" y="${py + 9}" class="ps">${label}</text>`) + '</g>');
  });

  // tiles
  S.hexes.forEach((h, i) => {
    const cx = h.x * R, cy = h.y * R;
    const target = t.hexes.includes(i);
    const pts = ring(h, 0.97);
    out.push(`<g class="tile${target ? ' target' : ''}"${target ? ` data-h="${i}"` : ''}><title>${RES_NAME[h.res]} — produces on a roll of ${h.num}</title>` +
      `<polygon class="hex" points="${pts}" fill="url(#tx-${h.res})"/><polygon points="${pts}" fill="url(#light)" pointer-events="none"/>`);
    if (rollFx && h.num === sum && i !== S.robber) out.push(`<polygon class="prod" points="${pts}" style="${rollFx}"/>`);
    if (i === S.robber) out.push(`<polygon points="${pts}" fill="rgba(20,20,30,.38)" pointer-events="none"/>`);
    out.push(`<text class="tileIcon" x="${cx}" y="${cy - R * 0.48}">${ICON[h.res]}</text>`);
    const hot = h.num === 6 || h.num === 8;
    const dots = 6 - Math.abs(7 - h.num);
    out.push(`<g pointer-events="none"><circle class="token" cx="${cx}" cy="${cy + 4}" r="18" filter="url(#shadow)"/>` +
      `<text class="num${hot ? ' hot' : ''}" x="${cx}" y="${cy + 1}">${h.num}</text>`);
    for (let d = 0; d < dots; d++) out.push(`<circle cx="${cx + (d - (dots - 1) / 2) * 4.6}" cy="${cy + 14}" r="1.7" fill="${hot ? '#c62828' : '#3a2f27'}"/>`);
    out.push('</g></g>');
  });

  // roads
  S.edges.forEach((e, i) => {
    const o = S.eOwn[i];
    if (o < 0) return;
    const k = 0.15, a = e.a, b = e.b;
    const c = `x1="${X(a) + (X(b) - X(a)) * k}" y1="${Y(a) + (Y(b) - Y(a)) * k}" x2="${X(b) + (X(a) - X(b)) * k}" y2="${Y(b) + (Y(a) - Y(b)) * k}"`;
    const pop = fxStyle(`e${i}`, 700);
    out.push(`<g class="road${pop ? ' pop' : ''}"${pop ? ` style="${pop}"` : ''} filter="url(#shadow)">` +
      `<line ${c} stroke="#1f1a17" stroke-width="12" stroke-linecap="round"/><line ${c} stroke="${color(o)}" stroke-width="8" stroke-linecap="round"/>` +
      `<line ${c} stroke="#fff" stroke-opacity=".35" stroke-width="2.5" stroke-linecap="round" transform="translate(0,-1.5)"/></g>`);
  });

  // road targets
  t.edges.forEach(i => {
    const e = S.edges[i], k = 0.22;
    const c = `x1="${X(e.a) + (X(e.b) - X(e.a)) * k}" y1="${Y(e.a) + (Y(e.b) - Y(e.a)) * k}" x2="${X(e.b) + (X(e.a) - X(e.b)) * k}" y2="${Y(e.b) + (Y(e.a) - Y(e.b)) * k}"`;
    out.push(`<g class="etarget" data-e="${i}"><title>Build a road here</title><line class="ehit" ${c}/><line class="espot" ${c}/></g>`);
  });

  // buildings
  S.vOwn.forEach((o, v) => {
    if (o < 0) return;
    const x = X(v), y = Y(v), city = S.vCity[v];
    const pop = fxStyle(`v${v}${city ? 'c' : 's'}`, 700);
    const body = city
      ? `M${x - 15} ${y + 11} V${y - 3} L${x - 8} ${y - 11} L${x - 1} ${y - 3} V${y - 1} H${x + 15} V${y + 11} Z`
      : `M${x - 10} ${y + 9} V${y - 2} L${x} ${y - 12} L${x + 10} ${y - 2} V${y + 9} Z`;
    const roof = city ? `M${x - 15} ${y - 3} L${x - 8} ${y - 11} L${x - 8} ${y + 11} H${x - 15} Z` : `M${x - 10} ${y - 2} L${x} ${y - 12} L${x} ${y + 9} H${x - 10} Z`;
    const door = city ? `<rect x="${x + 4}" y="${y + 3}" width="5" height="8" fill="#1f1a17" opacity=".55"/>` : `<rect x="${x - 2.5}" y="${y + 2}" width="5" height="7" fill="#1f1a17" opacity=".55"/>`;
    out.push(`<g class="bldg${pop ? ' pop' : ''}"${pop ? ` style="${pop};transform-origin:${x}px ${y}px"` : ''} filter="url(#shadow)">` +
      `<path d="${body}" fill="${color(o)}" stroke="#1f1a17" stroke-width="2.2" stroke-linejoin="round"/>` +
      `<path d="${roof}" fill="#fff" opacity=".22" pointer-events="none"/>${door}</g>`);
    if (pop && o !== me) out.push(`<circle class="ping" cx="${x}" cy="${y}" r="14" style="${pop}" stroke="${color(o)}"/>`);
  });

  // robber
  if (S.robber >= 0) {
    const h = S.hexes[S.robber], cx = h.x * R + 25, cy = h.y * R - 2;
    out.push(`<g pointer-events="none" filter="url(#shadow)"><title>Robber: this tile produces nothing</title>` +
      `<path d="M${cx - 9} ${cy + 16} Q${cx - 10} ${cy + 2} ${cx - 4} ${cy - 2} A7 7 0 1 1 ${cx + 4} ${cy - 2} Q${cx + 10} ${cy + 2} ${cx + 9} ${cy + 16} Z" fill="#2d2d33" stroke="#0e0e10" stroke-width="1.5"/>` +
      `<ellipse cx="${cx - 2}" cy="${cy - 9}" rx="2.2" ry="1.6" fill="#fff" opacity=".35"/></g>`);
  }

  // build spots
  t.verts.forEach(v => out.push(`<g class="vtarget" data-v="${v}"><title>Build a settlement here</title><circle class="spot" cx="${X(v)}" cy="${Y(v)}" r="11"/></g>`));
  t.cities.forEach(v => out.push(`<g class="vtarget" data-c="${v}"><title>Upgrade to a city</title><circle class="spot city" cx="${X(v)}" cy="${Y(v)}" r="17"/></g>`));

  svg.innerHTML = out.join('');
}

function banner() {
  if (S.winner >= 0) return [`${S.winner === me ? 'You' : name(S.winner)} won!`, ''];
  if (session && !session.connected) return ['Reconnecting…', 'Hold on, the connection to the server dropped.'];
  if (!myTurn()) {
    if (S.phase === 'setup') return [`${name(S.cur)} is placing…`, 'Each player places 2 settlements with a road.'];
    if (S.phase === 'robber') return [`${name(S.cur)} is moving the robber…`, ''];
    return [`${name(S.cur)}’s turn`, 'Their moves appear on the board and under “What happened”.'];
  }
  switch (S.phase) {
    case 'setup': return S.setupNeed === 'settlement'
      ? [`Place your ${S.setupStep < 2 ? 'first' : 'second'} settlement`, 'Tap a white circle. Settlements collect resources from the tiles they touch. Numbers with more dots are rolled more often.' +
        (S.setupStep >= 2 ? ' This one gives you its starting resources right away.' : '')]
      : ['Place a road next to it', 'Tap a glowing line. Roads let you reach new corners to build on.'];
    case 'robber': return ['🥷 Move the robber', 'Tap a tile to block it. If your opponent has a building there, you steal one of their cards.'];
    case 'roads': return [`Place ${S.freeRoads} free road${S.freeRoads > 1 ? 's' : ''}`, 'Tap a glowing line.'];
    default:
      if (!hasAnyMove(S, me)) return ['Nothing you can do — passing…', 'You can’t afford anything this turn.'];
      return ['Your turn', 'Build, trade or play a card. Press “End turn” when you’re done.'];
  }
}

function buildCards(canAct) {
  const P = S.players[me];
  const kinds = [
    ['road', '🛣️ Road', 'needed to expand', COST.road, P.left.road, () => legalRoads(S, me, false).length],
    ['settlement', '🏠 Settlement', '+1 point', COST.settlement, P.left.settlement, () => legalSettles(S, me, false).length],
    ['city', '🏰 City', '+1 point, double resources', COST.city, P.left.city, () => upgradable(S, me).length],
    ['dev', '📜 Dev card', 'random bonus card', COST.dev, S.devDeck.length, () => 1],
  ];
  return kinds.map(([k, label, what, cost, left, spots]) => {
    const missing = {};
    RES.forEach(r => { if ((cost[r] || 0) > P.res[r]) missing[r] = cost[r] - P.res[r]; });
    const icons = RES.flatMap(r => Array.from({ length: cost[r] || 0 }, (_, i) =>
      `<span class="${i >= P.res[r] ? 'miss' : 'have'}" title="${RES_NAME[r]}">${ICON[r]}</span>`)).join('');
    let status, ok = false;
    if (!left) status = k === 'dev' ? 'Deck is empty' : 'None left';
    else if (Object.keys(missing).length) status = `Need ${costStr(missing)}`;
    else if (!spots()) status = k === 'settlement' ? 'Build a road to a free corner first' : k === 'city' ? 'Build a settlement first' : 'No free spot';
    else { ok = true; status = k === 'dev' ? 'Tap to buy' : 'Tap a glowing spot'; }
    const active = canAct && ok;
    return `<button class="bcard${active ? ' ok' : ''}${buildMode === k ? ' sel' : ''}" data-build="${k}" ${active ? '' : 'aria-disabled="true"'}>` +
      `<span class="bname">${label}</span><span class="bwhat">${what}</span><span class="bcost">${icons}</span>` +
      `<span class="bstat">${canAct || !left ? status : `${left} left`}</span></button>`;
  }).join('');
}

function renderPanel() {
  const meP = S.players[me];

  const pcard = p => {
    const P = S.players[p];
    const shown = p === me ? vp(S, p) : vp(S, p, false);
    return `<div class="pcard${S.cur === p && S.winner < 0 ? ' turn' : ''}" style="--who:${color(p)}">
      <div class="name">${name(p)}${S.cur === p && S.winner < 0 ? ' <span class="now">playing</span>' : ''}</div>
      <div class="vp">${shown}<small> / ${WIN_VP} points</small></div>
      <div class="bar"><div style="width:${Math.min(100, 100 * shown / WIN_VP)}%"></div></div>
      <div class="meta"><span title="Resource cards in hand">🃏 ${P.hand}</span><span title="Development cards">📜 ${P.devCount}</span>
      <span title="Knights played">⚔️ ${P.knights}</span><span title="Longest road">🛣️ ${P.roadLen}</span></div>
      ${S.lr === p ? '<span class="badge" title="5+ roads in a row: +2 points">Longest Road +2</span>' : ''}
      ${S.la === p ? '<span class="badge" title="3+ knights played: +2 points">Largest Army +2</span>' : ''}
    </div>`;
  };
  $('scores').innerHTML = pcard(me) + pcard(1 - me);
  const [title, hint] = banner();
  $('prompt').textContent = title;
  $('hint').textContent = hint;
  $('turn').classList.toggle('mine', myTurn());
  $('turn').style.setProperty('--who', color(S.cur));

  const canAct = myTurn() && S.phase === 'main' && session && session.connected;
  if (!canAct) buildMode = null;

  $('hand').innerHTML = RES.map(r => {
    const n = meP.res[r];
    const g = fxStyle(`gain-${r}`, 1600);
    return `<div class="chip${n ? '' : ' zero'}" title="${RES_NAME[r]}"><span class="ic">${ICON[r]}</span><span class="n">${n}</span>` +
      `<span class="rn">${RES_NAME[r]}</span>${g ? `<span class="gain" style="${g}">+${gains[r]}</span>` : ''}</div>`;
  }).join('');

  $('build').innerHTML = buildCards(canAct);

  // bank trade
  const tradeSec = $('tradeSec');
  tradeSec.hidden = !canAct;
  if (canAct) {
    if (plenty && !S.devPlayed && meP.devs.includes('plenty')) {
      tradeGive = null;
      tradeSec.querySelector('h4').textContent = '🎁 Year of Plenty';
      $('trade').innerHTML = `<p class="note">Pick 2 resources${plenty.length ? `: ${plenty.map(r => ICON[r]).join('')} + …` : ''}</p>` +
        RES.map(r => `<button class="res" data-pick="${r}">${ICON[r]}<small>${RES_NAME[r]}</small></button>`).join('') +
        '<button class="res cancel" data-cancel>Cancel</button>';
    } else {
      plenty = null;
      tradeSec.querySelector('h4').textContent = 'Trade with the bank';
      if (tradeGive && meP.res[tradeGive] >= ratio(S, me, tradeGive)) {
        $('trade').innerHTML = `<p class="note">Give ${ICON[tradeGive].repeat(ratio(S, me, tradeGive))} and get 1 of:</p>` +
          RES.filter(r => r !== tradeGive).map(r => `<button class="res" data-get="${r}">${ICON[r]}<small>${RES_NAME[r]}</small></button>`).join('') +
          '<button class="res cancel" data-cancel>Cancel</button>';
      } else {
        tradeGive = null;
        const offers = RES.map(r => {
          const q = ratio(S, me, r), can = meP.res[r] >= q;
          return `<button class="res" data-give="${r}" ${can ? '' : 'disabled'} title="Give ${q} ${RES_NAME[r]} for any 1 resource">` +
            `${ICON[r]}<small>${q} → 1</small></button>`;
        }).join('');
        $('trade').innerHTML = `<p class="note">Swap ${RES.some(r => ratio(S, me, r) < 4) ? 'resources at the rates shown (harbours give better rates)' : '4 of one kind for any 1 (harbours give better rates)'}:</p>${offers}`;
      }
    }
  }

  const devBtns = meP.devs.filter(d => d !== 'vp').map(d =>
    `<button class="dev" data-play="${d}" ${canAct && !S.devPlayed ? '' : 'disabled'}><b>${DEV_INFO[d][0]} ${DEV_NAMES[d]}</b><small>${DEV_INFO[d][1]}</small></button>`);
  meP.fresh.forEach(d => devBtns.push(`<button class="dev" disabled><b>${DEV_INFO[d][0]} ${DEV_NAMES[d]}</b><small>New — usable next turn</small></button>`));
  if (meP.vpCards) devBtns.push(`<button class="dev" disabled><b>⭐ Victory Point ×${meP.vpCards}</b><small>${DEV_INFO.vp[1]}</small></button>`);
  $('devSec').hidden = !devBtns.length;
  $('devs').innerHTML = devBtns.join('') + (devBtns.length && S.devPlayed && canAct ? '<p class="note">One development card per turn.</p>' : '');

  $('endBtn').disabled = !(myTurn() && (S.phase === 'main' || S.phase === 'roads') && session && session.connected);

  $('log').innerHTML = S.log.slice(-12).reverse()
    .map(l => `<li>${l.replace(/@(\d)/g, (_, p) => `<b style="color:${color(+p)}">${name(+p)}</b>`)}</li>`).join('');
}

function tickTimer() {
  const el = $('timer');
  const on = online && S && S.winner < 0 && deadline > 0 && $('lobby').hidden;
  el.classList.toggle('on', !!on);
  if (!on) return;
  const left = Math.max(0, deadline - Date.now());
  el.firstElementChild.style.width = `${(100 * left / turnLength(S)).toFixed(1)}%`;
  el.classList.toggle('low', left < 10000);
  el.title = `${Math.ceil(left / 1000)} s left`;
}

// ---------- game over + hall of fame ----------

function loadHof() {
  if (serverDown) { renderHof(null); return; }
  fetch(SERVER.replace(/\/$/, '') + '/hof').then(r => r.json()).then(renderHof, () => renderHof(null));
}

function renderHof(list) {
  const html = list && list.length ? `<h3>🏆 Hall of Fame — fastest wins</h3><ol>${list.map(e =>
    `<li><b>${escapeHtml(e.name)}</b> <span>${e.rounds} rounds · vs ${escapeHtml(e.vs)} · ${escapeHtml(e.size)}</span></li>`).join('')}</ol>` : '';
  document.querySelectorAll('.hof').forEach(el => { el.innerHTML = html; });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showOver() {
  if (!S || S.winner < 0 || !$('over').hidden) return;
  const won = S.winner === me;
  const offline = session && session.local;
  $('overTitle').textContent = won ? '🏆 You won!' : '😵 You lost';
  $('overText').textContent = won
    ? `${vp(S, me)} points in ${Math.ceil((S.turn + 1) / 2)} rounds. ` +
      (offline ? 'This was an offline game, so it doesn’t count for the Hall of Fame.' : 'Enter your name for the Hall of Fame:')
    : `${name(S.winner)} reached ${vp(S, S.winner)} points.${online && oppLabel !== 'Bot' ? ' Waiting for their name…' : ''}`;
  $('nameForm').hidden = !won || offline || savedResult;
  $('nameInput').value = store.get('tinysettler.name') || '';
  loadHof();
  $('over').hidden = false;
  if (won && !offline) $('nameInput').focus();
}

$('nameForm').addEventListener('submit', e => {
  e.preventDefault();
  const n = $('nameInput').value.trim().slice(0, 20);
  if (!n || savedResult || !session) return;
  savedResult = true;
  store.set('tinysettler.name', n);
  session.name(n); // the server checks that we really won and answers with the new list
  $('nameForm').hidden = true;
  $('overText').textContent = `Well played, ${n}!`;
});

$('againBtn').addEventListener('click', () => {
  if (session) session.close();
  session = null;
  S = null;
  $('game').hidden = true;
  showLobby();
});

// ---------- input ----------

$('board').addEventListener('click', e => {
  const el = e.target.closest('[data-v],[data-e],[data-c],[data-h]');
  if (!el || !myTurn()) return;
  const d = el.dataset;
  if (d.v !== undefined) dispatch({ t: 'settle', v: +d.v });
  else if (d.e !== undefined) dispatch({ t: 'road', e: +d.e });
  else if (d.c !== undefined) dispatch({ t: 'city', v: +d.c });
  else if (d.h !== undefined) dispatch({ t: 'robber', h: +d.h });
});

$('panel').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled || !S) return;
  const d = b.dataset;
  if (d.build) {
    if (b.getAttribute('aria-disabled')) return;
    if (d.build === 'dev') dispatch({ t: 'buydev' });
    else { buildMode = buildMode === d.build ? null : d.build; renderBoard(); renderPanel(); }
  }
  else if (d.give) { tradeGive = d.give; plenty = null; renderPanel(); }
  else if (d.get) dispatch({ t: 'trade', give: tradeGive, get: d.get });
  else if (d.cancel !== undefined) { tradeGive = plenty = null; renderPanel(); }
  else if (d.play === 'plenty') { plenty = []; tradeGive = null; renderPanel(); }
  else if (d.play) dispatch({ t: 'play', card: d.play });
  else if (d.pick) {
    plenty.push(d.pick);
    if (plenty.length < 2) renderPanel();
    else { const res = plenty; plenty = null; dispatch({ t: 'play', card: 'plenty', res }); }
  }
  else if (b.id === 'endBtn') dispatch({ t: 'end' });
});

document.querySelectorAll('.sizes button').forEach(b => b.addEventListener('click', () => {
  if (size === b.dataset.size) return;
  size = b.dataset.size;
  store.set('tinysettler.size', size);
  document.querySelectorAll('.sizes button').forEach(x => x.classList.toggle('sel', x === b));
  startSearch();
}));

$('botNow').addEventListener('click', startBot);
$('helpBtn').addEventListener('click', () => { $('help').hidden = false; });
$('help').addEventListener('click', e => { if (e.target.id === 'help' || e.target.closest('[data-close]')) $('help').hidden = true; });
setInterval(tickTimer, 250);

// Debug hook for testing in the console.
window.tinysettler = { get state() { return S; }, get seat() { return me; }, get session() { return session; } };

showLobby();
