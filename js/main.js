import {
  RES, ICON, COST, WIN_VP, DEV_NAMES, afford, vp, ratio, legalSettles, legalRoads, upgradable, hasAnyMove,
} from './engine.js';
import { newTable, act, step, viewFor, turnLength } from './table.js';
import { SERVER } from './config.js';

const $ = id => document.getElementById(id);
const R = 60;                      // hex radius in SVG units
const SEARCH_MS = 9000;            // how long to look for a human before falling back to the bot
const COLORS = { me: '#2f7de1', opp: '#e0533d' };
const TILE = { wood: '#3f7d3a', brick: '#c4622d', sheep: '#9bc53d', wheat: '#e8c547', ore: '#8a8f98' };
const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// The game runs on the server, which sends us only what our seat may see.
// Without a server (or if it can't be reached) a bot game runs in the browser.
let S = null;            // my view of the game
let me = 0;              // my seat
let oppLabel = 'Bot', online = false;
let session = null;      // the game in progress: { act, name, close, connected, local }
let lobbyWs = null, serverDown = !SERVER;
let tradeGive = null, plenty = null;
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
  tradeGive = plenty = null;
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
  if (session) session.act(a);
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
  if (!myTurn() || !session || !session.connected) return t;
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
  if (session && !session.connected) return 'Reconnecting…';
  if (!myTurn()) return `${name(S.cur)} is playing…`;
  if ((S.phase === 'main' || S.phase === 'roads') && !hasAnyMove(S, me)) return 'Nothing to build — passing…';
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

    return `<div class="pcard${S.cur === p && S.winner < 0 ? ' turn' : ''}" style="color:${color(p)}">
      <div class="name">${name(p)}</div>
      <div class="vp">${shown}<small> / ${WIN_VP}</small></div>
      <div class="meta"><span title="Cards in hand">🃏 ${P.hand}</span><span title="Development cards">📜 ${P.devCount}</span>
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

  if (plenty && canAct && !S.devPlayed && meP.devs.includes('plenty')) {
    tradeGive = null;
    $('trade').innerHTML = `🎁 Take 2: ${plenty.map(r => ICON[r]).join('')}` +
      RES.map(r => `<button data-pick="${r}" title="${r}">${ICON[r]}</button>`).join('') +
      '<button data-cancel title="Cancel">✕</button>';
  } else if (tradeGive && canAct && meP.res[tradeGive] >= ratio(S, me, tradeGive)) {
    plenty = null;
    $('trade').innerHTML = `Give ${ICON[tradeGive].repeat(ratio(S, me, tradeGive))} for:` +
      RES.filter(r => r !== tradeGive).map(r => `<button data-get="${r}" title="${r}">${ICON[r]}</button>`).join('') +
      '<button data-cancel title="Cancel">✕</button>';
  } else {
    tradeGive = plenty = null;
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
  const on = online && S && S.winner < 0 && deadline > 0 && $('lobby').hidden;
  el.classList.toggle('on', !!on);
  if (!on) return;
  const left = Math.max(0, deadline - Date.now());
  const full = turnLength(S);
  el.firstElementChild.style.width = `${(100 * left / full).toFixed(1)}%`;
  el.classList.toggle('low', left < 10000);
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
  if (d.give) { tradeGive = tradeGive === d.give ? null : d.give; plenty = null; renderPanel(); }
  else if (d.get) dispatch({ t: 'trade', give: tradeGive, get: d.get });
  else if (d.cancel !== undefined) { tradeGive = plenty = null; renderPanel(); }
  else if (d.buy !== undefined) dispatch({ t: 'buydev' });
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
setInterval(tickTimer, 250);

// Debug hook for testing in the console.
window.tinysettler = { get state() { return S; }, get seat() { return me; }, get session() { return session; } };

showLobby();
