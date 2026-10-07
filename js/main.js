import {
  RES, ICON, COST, WIN_VP, DEV_NAMES, newGame, applyAction, afford, vp, total, ratio,
  legalSettles, legalRoads, upgradable, hasAnyMove,
} from './engine.js';
import { botAct, autoAct } from './bot.js';
import { findMatch } from './net.js';

const $ = id => document.getElementById(id);
const R = 60;                      // hex radius in SVG units
const SEARCH_MS = 9000;            // how long to look for a human before falling back to the bot
const TURN_MS = 60000, SETUP_MS = 30000, HEARTBEAT_MS = 10000;
const HOF_KEY = 'tinysettler.hof';
const COLORS = { me: '#2f7de1', opp: '#e0533d' };
const TILE = { wood: '#3f7d3a', brick: '#c4622d', sheep: '#9bc53d', wheat: '#e8c547', ore: '#8a8f98' };
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

let S = null;            // game state
let mode = null;         // 'bot' | 'host' | 'guest'
let me = 0;              // my seat
let bots = new Set();    // seats played by the local bot
let conn = null, peer = null, match = null;
let tradeGive = null;
let botTimer = 0, autoTimer = 0, turnTimer = 0;
let deadline = 0, deadlineKey = '';
let lastSeen = 0, lastRoll = 0, oppLabel = 'Bot', savedResult = false;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
let size = store.get('tinysettler.size') || 'small';

// ---------- helpers ----------

const name = p => (p === me ? 'You' : oppLabel);
const color = p => (p === me ? COLORS.me : COLORS.opp);
const myTurn = () => S && S.cur === me && S.winner < 0 && !bots.has(me);
const costStr = c => RES.filter(r => c[r]).map(r => ICON[r].repeat(c[r])).join('');

function toast(msg, ms = 1600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), ms);
}

function send(m) {
  try { if (conn && conn.open) conn.send(m); } catch { /* connection gone */ }
}

// ---------- lobby / matchmaking ----------

function showLobby() {
  stopTimers();
  $('over').hidden = true;
  $('lobby').hidden = false;
  document.querySelectorAll('.sizes button').forEach(b => b.classList.toggle('sel', b.dataset.size === size));
  renderHof();
  startSearch();
}

function startSearch() {
  if (match) match.cancel();
  let left = SEARCH_MS / 1000;
  $('mmText').textContent = `Looking for an opponent… ${left}s`;
  clearInterval(startSearch.t);
  startSearch.t = setInterval(() => {
    left = Math.max(0, left - 1);
    $('mmText').textContent = left ? `Looking for an opponent… ${left}s` : 'Starting a bot game…';
  }, 1000);
  const m = findMatch(size, SEARCH_MS);
  match = m;
  m.promise.then(res => {
    if (match !== m) return; // cancelled / superseded
    clearInterval(startSearch.t);
    match = null;
    if (!res) startBot();
    else if (res.role === 'host') startHost(res);
    else startGuest(res);
  });
}

function cancelSearch() {
  clearInterval(startSearch.t);
  if (match) { const m = match; match = null; m.cancel(); }
}

function enterGame() {
  $('lobby').hidden = true;
  $('over').hidden = true;
  $('game').hidden = false;
  tradeGive = null;
  savedResult = false;
  lastRoll = 0;
  deadlineKey = '';
}

function startBot() {
  cancelSearch();
  mode = 'bot';
  me = 0;
  bots = new Set([1]);
  oppLabel = 'Bot';
  conn = peer = null;
  S = newGame({ size });
  enterGame();
  update();
}

function attachConn(c) {
  lastSeen = Date.now();
  c.on('data', m => { lastSeen = Date.now(); onNet(m); });
  c.on('close', onDisconnect);
  c.on('error', onDisconnect);
}

// Heartbeat: WebRTC can take a long time to notice a vanished peer.
setInterval(() => {
  if (!conn) return;
  send({ k: 'ping' });
  if (Date.now() - lastSeen > HEARTBEAT_MS) onDisconnect();
}, 2000);
window.addEventListener('pagehide', () => send({ k: 'bye' }));

function startHost({ conn: c, peer: p }) {
  mode = 'host';
  me = 0;
  bots = new Set();
  oppLabel = 'Opponent';
  conn = c; peer = p;
  S = newGame({ size });
  attachConn(c);
  enterGame();
  toast('Opponent found!');
  send({ k: 'welcome', seat: 1, state: S, remaining: remaining() });
  update();
}

function startGuest({ conn: c, peer: p, welcome }) {
  mode = 'guest';
  me = welcome.seat;
  bots = new Set();
  oppLabel = 'Opponent';
  conn = c; peer = p;
  S = welcome.state;
  attachConn(c);
  enterGame();
  toast('Opponent found!');
  setDeadline(welcome.remaining);
  update();
}

function onNet(m) {
  if (mode === 'host' && m.k === 'act') {
    const r = applyAction(S, 1 - me, m.a);
    if (!r.ok) send({ k: 'err', msg: r.err });
    update();
  } else if (mode === 'guest' && m.k === 'state') {
    S = m.state;
    setDeadline(m.remaining);
    update();
  } else if (m.k === 'bye') {
    onDisconnect();
  } else if (m.k === 'err') {
    toast(m.msg);
  } else if (m.k === 'winner') {
    $('overText').textContent = `${m.name} won this one.`;
  }
}

function onDisconnect() {
  if (!conn) return;
  const c = conn;
  conn = null;
  try { c.close(); } catch { /* already closed */ }
  if (!S || S.winner >= 0) return;
  toast('Opponent left — the bot takes over', 2500);
  mode = 'bot';
  bots = new Set([1 - me]);
  oppLabel = 'Bot';
  update();
}

// ---------- game flow ----------

function dispatch(a) {
  tradeGive = a.t === 'trade' ? null : tradeGive;
  if (mode === 'guest') { send({ k: 'act', a }); return; }
  const r = applyAction(S, me, a);
  if (!r.ok) toast(r.err);
  update();
}

function remaining() {
  return deadline ? Math.max(0, deadline - Date.now()) : 0;
}

function setDeadline(ms) {
  deadline = ms ? Date.now() + ms : 0;
}

function stopTimers() {
  clearTimeout(botTimer); clearTimeout(autoTimer); clearTimeout(turnTimer);
}

// Called after every state change.
function update() {
  stopTimers();
  if (mode === 'host') {
    // Online turns are timed so nobody can stall the game.
    const key = `${S.turn}|${S.phase}|${S.setupStep}|${S.setupNeed}`;
    if (key !== deadlineKey) {
      deadlineKey = key;
      setDeadline(S.winner >= 0 ? 0 : S.phase === 'setup' || S.phase === 'robber' ? SETUP_MS : TURN_MS);
    }
    send({ k: 'state', state: S, remaining: remaining() });
    if (S.winner < 0) {
      turnTimer = setTimeout(() => {
        applyAction(S, S.cur, autoAct(S, S.cur));
        update();
      }, remaining());
    }
  } else if (mode === 'bot') {
    deadline = 0;
  }

  render();

  if (S.winner >= 0) { setTimeout(showOver, 900); return; }

  if (bots.has(S.cur) && mode !== 'guest') {
    const delay = S.phase === 'setup' ? 450 : S.rollId !== update.lastBotRoll ? 1000 : 500;
    update.lastBotRoll = S.rollId;
    botTimer = setTimeout(() => {
      const p = S.cur;
      let r = applyAction(S, p, botAct(S, p));
      if (!r.ok) r = applyAction(S, p, autoAct(S, p)); // safety net
      update();
    }, delay);
  } else if (myTurn() && (S.phase === 'main' || S.phase === 'roads') && !hasAnyMove(S, me)) {
    // Speed rule: nothing you can do -> the turn passes by itself.
    const key = `${S.turn}`;
    autoTimer = setTimeout(() => {
      if (myTurn() && `${S.turn}` === key && !hasAnyMove(S, me)) {
        toast('Nothing to build — next turn');
        dispatch({ t: 'end' });
      }
    }, 1200);
  }
}

// ---------- rendering ----------

function render() {
  renderBoard();
  renderPanel();
  renderDice();
}

function renderDice() {
  const d = $('dice');
  if (!S.dice) { d.classList.remove('on'); return; }
  d.innerHTML = `${DIE[S.dice[0]]}${DIE[S.dice[1]]}<b>${S.dice[0] + S.dice[1]}</b>`;
  d.classList.add('on');
  d.style.color = color(S.cur);
  if (S.rollId !== lastRoll) {
    lastRoll = S.rollId;
    d.classList.remove('roll');
    void d.offsetWidth;
    d.classList.add('roll');
  }
}

function targets() {
  const t = { verts: [], edges: [], cities: [], hexes: [] };
  if (!myTurn() || (mode === 'guest' && !conn)) return t;
  const P = S.players[me];
  if (S.phase === 'setup') {
    if (S.setupNeed === 'settlement') t.verts = legalSettles(S, me, true);
    else t.edges = legalRoads(S, me, true);
  } else if (S.phase === 'robber') {
    t.hexes = S.hexes.map((_, h) => h).filter(h => h !== S.robber);
  } else if (S.phase === 'roads') {
    t.edges = legalRoads(S, me, false);
  } else if (S.phase === 'main') {
    if (P.left.settlement && afford(P, COST.settlement)) t.verts = legalSettles(S, me, false);
    if (P.left.road && afford(P, COST.road)) t.edges = legalRoads(S, me, false);
    if (P.left.city && afford(P, COST.city)) t.cities = upgradable(S, me);
  }
  return t;
}

function renderBoard() {
  const svg = $('board');
  const xs = S.verts.map(v => v.x * R), ys = S.verts.map(v => v.y * R);
  const pad = R * 0.95;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  svg.setAttribute('viewBox', `${minX} ${minY} ${Math.max(...xs) - minX + pad} ${Math.max(...ys) - minY + pad}`);
  const t = targets();
  const P = (v) => `${(S.verts[v].x * R).toFixed(1)},${(S.verts[v].y * R).toFixed(1)}`;
  const out = [];

  // ports (behind tiles)
  S.edges.forEach(e => {
    if (!e.port) return;
    const a = S.verts[e.a], b = S.verts[e.b], h = S.hexes[e.hexes[0]];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = mx - h.x, dy = my - h.y, len = Math.hypot(dx, dy);
    const px = (mx + dx / len * 0.5) * R, py = (my + dy / len * 0.5) * R;
    const label = e.port === 'any' ? '3:1' : `2:1${ICON[e.port]}`;
    out.push(`<g class="port"><line x1="${px}" y1="${py}" x2="${a.x * R}" y2="${a.y * R}"/><line x1="${px}" y1="${py}" x2="${b.x * R}" y2="${b.y * R}"/>` +
      `<circle cx="${px}" cy="${py}" r="17"/><text x="${px}" y="${py}">${label}</text></g>`);
  });

  // tiles
  S.hexes.forEach((h, i) => {
    const cx = h.x * R, cy = h.y * R;
    const target = t.hexes.includes(i);
    out.push(`<polygon class="hex${target ? ' target' : ''}" ${target ? `data-h="${i}"` : ''} points="${h.v.map(P).join(' ')}" fill="${TILE[h.res]}"/>`);
    out.push(`<text class="tileIcon" x="${cx}" y="${cy - R * 0.45}">${ICON[h.res]}</text>`);
    const hot = h.num === 6 || h.num === 8;
    const dots = 6 - Math.abs(7 - h.num);
    out.push(`<g pointer-events="none"><circle class="token" cx="${cx}" cy="${cy + 4}" r="17"/><text class="num${hot ? ' hot' : ''}" x="${cx}" y="${cy + 1}">${h.num}</text>`);
    for (let d = 0; d < dots; d++) out.push(`<circle cx="${cx + (d - (dots - 1) / 2) * 4.5}" cy="${cy + 14}" r="1.6" fill="${hot ? '#c62828' : '#2b2420'}"/>`);
    out.push('</g>');
    if (i === S.robber) {
      out.push(`<g pointer-events="none" transform="translate(${cx + 22},${cy - 4})"><ellipse cx="0" cy="16" rx="10" ry="4" fill="rgba(0,0,0,.3)"/>` +
        `<path d="M-8 15 Q-9 2 -4 -2 A6 6 0 1 1 4 -2 Q9 2 8 15 Z" fill="#333" stroke="#111" stroke-width="1.5"/></g>`);
    }
  });

  // roads
  S.edges.forEach((e, i) => {
    const o = S.eOwn[i];
    if (o < 0) return;
    const a = S.verts[e.a], b = S.verts[e.b];
    const k = 0.14;
    const x1 = (a.x + (b.x - a.x) * k) * R, y1 = (a.y + (b.y - a.y) * k) * R;
    const x2 = (b.x + (a.x - b.x) * k) * R, y2 = (b.y + (a.y - b.y) * k) * R;
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1d1d1d" stroke-width="11" stroke-linecap="round"/>`);
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color(o)}" stroke-width="7" stroke-linecap="round"/>`);
  });

  // road targets
  t.edges.forEach(i => {
    const e = S.edges[i], a = S.verts[e.a], b = S.verts[e.b];
    const k = 0.2;
    const c = `x1="${(a.x + (b.x - a.x) * k) * R}" y1="${(a.y + (b.y - a.y) * k) * R}" x2="${(b.x + (a.x - b.x) * k) * R}" y2="${(b.y + (a.y - b.y) * k) * R}"`;
    out.push(`<line class="ehit" data-e="${i}" ${c}/><line class="espot" data-e="${i}" ${c}/>`);
  });

  // buildings
  S.vOwn.forEach((o, v) => {
    if (o < 0) return;
    const x = S.verts[v].x * R, y = S.verts[v].y * R;
    const shape = S.vCity[v]
      ? `M${x - 14} ${y + 10} V${y - 4} L${x - 7} ${y - 12} L${x} ${y - 4} H${x + 14} V${y + 10} Z`
      : `M${x - 9} ${y + 8} V${y - 3} L${x} ${y - 12} L${x + 9} ${y - 3} V${y + 8} Z`;
    out.push(`<path d="${shape}" fill="${color(o)}" stroke="#1d1d1d" stroke-width="2.5" stroke-linejoin="round"/>`);
  });

  // spots
  t.verts.forEach(v => { out.push(`<circle class="spot" data-v="${v}" cx="${S.verts[v].x * R}" cy="${S.verts[v].y * R}" r="11"/>`); });
  t.cities.forEach(v => { out.push(`<circle class="spot city" data-c="${v}" cx="${S.verts[v].x * R}" cy="${S.verts[v].y * R}" r="15"/>`); });

  svg.innerHTML = out.join('');
}

function promptText() {
  if (S.winner >= 0) return `${name(S.winner)} won!`;
  if (!myTurn()) {
    if (mode === 'guest' && !conn) return 'Disconnected.';
    return `${name(S.cur)} ${S.cur === me ? 'are' : 'is'} playing…`;
  }
  switch (S.phase) {
    case 'setup': return S.setupNeed === 'settlement'
      ? `Place your ${S.setupStep < 2 ? 'first' : 'second'} settlement`
      : 'Place a road next to it';
    case 'robber': return '🥷 Move the robber — click a tile';
    case 'roads': return `Place ${S.freeRoads} free road${S.freeRoads > 1 ? 's' : ''}`;
    default: return 'Your turn — click a glowing spot to build';
  }
}

function renderPanel() {
  const meP = S.players[me];

  const pcard = p => {
    const P = S.players[p];
    const shown = p === me ? vp(S, p) : vp(S, p, false);
    const devCount = P.devs.length + P.fresh.length + (p === me ? 0 : P.vpCards);
    return `<div class="pcard${S.cur === p && S.winner < 0 ? ' turn' : ''}" style="color:${color(p)}">
      <div class="name">${name(p)}</div>
      <div class="vp">${shown}<small> / ${WIN_VP}</small></div>
      <div class="meta"><span title="Cards in hand">🃏 ${total(P)}</span><span title="Development cards">📜 ${devCount}</span>
      <span title="Knights played">⚔️ ${P.knights}</span><span title="Longest road">🛣️ ${P.roadLen}</span>
      ${S.lr === p ? '<span class="badge">Road</span>' : ''}${S.la === p ? '<span class="badge">Army</span>' : ''}</div>
    </div>`;
  };
  $('scores').innerHTML = pcard(me) + pcard(1 - me);
  $('prompt').textContent = promptText();

  const canAct = myTurn() && S.phase === 'main';
  $('hand').innerHTML = RES.map(r => {
    const n = meP.res[r], q = ratio(S, me, r);
    const can = canAct && n >= q;
    return `<button class="chip${can ? ' can' : ''}${tradeGive === r ? ' sel' : ''}${n ? '' : ' zero'}" data-give="${r}" ${can ? '' : 'disabled'} title="${can ? `Trade ${q} ${r} with the bank` : r}">
      <span class="ic">${ICON[r]}</span><span class="n">${n}</span>${q < 4 ? `<span class="r">${q}:1</span>` : ''}</button>`;
  }).join('');

  if (tradeGive && canAct && meP.res[tradeGive] >= ratio(S, me, tradeGive)) {
    $('trade').innerHTML = `Give ${ICON[tradeGive].repeat(ratio(S, me, tradeGive))} for:` +
      RES.filter(r => r !== tradeGive).map(r => `<button data-get="${r}" title="${r}">${ICON[r]}</button>`).join('') +
      '<button data-cancel title="Cancel">✕</button>';
  } else {
    tradeGive = null;
    $('trade').innerHTML = '';
  }

  const rows = [
    ['Road', COST.road, meP.left.road],
    ['Settlement', COST.settlement, meP.left.settlement],
    ['City', COST.city, meP.left.city],
  ];
  $('costs').innerHTML = rows.map(([label, c, left]) =>
    `<div class="cost${canAct && afford(meP, c) && left ? ' ok' : ''}"><span class="what">${label} <small>(${left} left)</small></span><span>${costStr(c)}</span></div>`).join('') +
    `<div class="cost${canAct && afford(meP, COST.dev) && S.devDeck.length ? ' ok' : ''}"><span class="what">Dev card <small>(${S.devDeck.length})</small></span>` +
    `<span>${costStr(COST.dev)} <button data-buy ${canAct && afford(meP, COST.dev) && S.devDeck.length ? '' : 'disabled'}>Buy</button></span></div>`;

  const icons = { knight: '⚔️', roads: '🛣️', plenty: '🎁' };
  const devBtns = meP.devs.filter(d => d !== 'vp').map(d =>
    `<button data-play="${d}" ${canAct && !S.devPlayed ? '' : 'disabled'}>${icons[d]} ${DEV_NAMES[d]}</button>`);
  meP.fresh.forEach(d => devBtns.push(`<button disabled>${icons[d]} ${DEV_NAMES[d]} <small>(next turn)</small></button>`));
  if (meP.vpCards) devBtns.push(`<button disabled>⭐ Victory Point ×${meP.vpCards}</button>`);
  $('devs').innerHTML = devBtns.join('');

  $('endBtn').disabled = !(myTurn() && (S.phase === 'main' || S.phase === 'roads'));

  $('log').innerHTML = S.log.slice(-10).reverse()
    .map(l => `<li>${l.replace(/@(\d)/g, (_, p) => `<b style="color:${color(+p)}">${name(+p)}</b>`)}</li>`).join('');
}

function tickTimer() {
  const el = $('timer');
  const on = mode !== 'bot' && S && S.winner < 0 && deadline > 0 && $('lobby').hidden;
  el.classList.toggle('on', !!on);
  if (!on) return;
  const left = remaining();
  const full = S.phase === 'setup' || S.phase === 'robber' ? SETUP_MS : TURN_MS;
  el.firstElementChild.style.width = `${(100 * left / full).toFixed(1)}%`;
  el.classList.toggle('low', left < 10000);
}

// ---------- game over + hall of fame ----------

function loadHof() {
  try { return JSON.parse(store.get(HOF_KEY)) || []; } catch { return []; }
}

function renderHof() {
  const list = loadHof().sort((a, b) => a.rounds - b.rounds).slice(0, 10);
  const html = list.length ? `<h3>🏆 Hall of Fame — fastest wins</h3><ol>${list.map(e =>
    `<li><b>${escapeHtml(e.name)}</b> <span>${e.rounds} rounds · vs ${e.vs} · ${e.size}</span></li>`).join('')}</ol>` : '';
  document.querySelectorAll('.hof').forEach(el => { el.innerHTML = html; });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function showOver() {
  if (!S || S.winner < 0 || !$('over').hidden) return;
  const won = S.winner === me;
  $('overTitle').textContent = won ? '🏆 You won!' : '😵 You lost';
  $('overText').textContent = won
    ? `${vp(S, me)} points in ${Math.ceil((S.turn + 1) / 2)} rounds. Enter your name for the Hall of Fame:`
    : `${name(S.winner)} reached ${vp(S, S.winner)} points.${mode === 'bot' ? '' : ' Waiting for their name…'}`;
  $('nameForm').hidden = !won || savedResult;
  $('nameInput').value = store.get('tinysettler.name') || '';
  renderHof();
  $('over').hidden = false;
  if (won) $('nameInput').focus();
}

$('nameForm').addEventListener('submit', e => {
  e.preventDefault();
  const n = $('nameInput').value.trim().slice(0, 20);
  if (!n || savedResult) return;
  savedResult = true;
  store.set('tinysettler.name', n);
  const hof = loadHof();
  hof.push({ name: n, rounds: Math.ceil((S.turn + 1) / 2), vs: oppLabel === 'Bot' ? 'Bot' : 'Human', size: S.size, date: new Date().toISOString() });
  store.set(HOF_KEY, JSON.stringify(hof.slice(-100)));
  send({ k: 'winner', name: n });
  $('nameForm').hidden = true;
  $('overText').textContent = `Well played, ${n}!`;
  renderHof();
});

$('againBtn').addEventListener('click', () => {
  stopTimers();
  if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
  conn = peer = null;
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
  if (d.give) { tradeGive = tradeGive === d.give ? null : d.give; renderPanel(); }
  else if (d.get) dispatch({ t: 'trade', give: tradeGive, get: d.get });
  else if (d.cancel !== undefined) { tradeGive = null; renderPanel(); }
  else if (d.buy !== undefined) dispatch({ t: 'buydev' });
  else if (d.play) dispatch({ t: 'play', card: d.play });
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
setInterval(tickTimer, 250);

// Debug hook for testing in the console.
window.tinysettler = { get state() { return S; }, get seat() { return me; }, get mode() { return mode; } };

showLobby();
