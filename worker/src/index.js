// TinySettler game server: a Cloudflare Worker with three Durable Objects.
//   Lobby       pairs up players looking for a game (one instance for everyone)
//   Game        one per match; owns the state, rolls the dice and runs the bot,
//               and sends each player only what they are allowed to see
//   HallOfFame  the shared leaderboard; only Game objects can add to it
//
// Routes (all WebSockets except /hof):
//   /match?size=small|medium   wait for an opponent -> {k:'match', game, token}
//   /bot?size=small|medium     start a game against the bot right away
//   /game?id=…&token=…         join (or rejoin) a game
//   /hof                       GET the top 10
import { DurableObject } from 'cloudflare:workers';
import { newTable, act, step, refresh, viewFor } from '../../js/table.js';

const SIZES = ['small', 'medium'];
const GRACE_MS = 10000;          // a player who disconnects this long is replaced by the bot
const IDLE_MS = 30 * 60000;      // games with no activity for this long are deleted
const CORS = { 'Access-Control-Allow-Origin': '*' };

const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET' } });
    if (url.pathname === '/hof') return json(await env.HOF.get(env.HOF.idFromName('global')).top());

    const isWs = req.headers.get('Upgrade') === 'websocket';
    if (url.pathname === '/' && !isWs) return new Response('TinySettler server is running.', { headers: CORS });
    if (!isWs) return new Response('Expected a WebSocket', { status: 426, headers: CORS });

    const size = url.searchParams.get('size');
    if (url.pathname === '/match') {
      if (!SIZES.includes(size)) return new Response('Bad size', { status: 400 });
      return env.LOBBY.get(env.LOBBY.idFromName('lobby')).fetch(req);
    }
    if (url.pathname === '/bot') {
      if (!SIZES.includes(size)) return new Response('Bad size', { status: 400 });
      const id = env.GAME.newUniqueId();
      const t = token();
      await env.GAME.get(id).init({ mode: 'bot', size, tokens: [t, null] });
      return env.GAME.get(id).fetch(new Request(`https://game/connect?token=${t}`, req));
    }
    if (url.pathname === '/game') {
      let id;
      try { id = env.GAME.idFromString(url.searchParams.get('id') || ''); } catch { return new Response('Unknown game', { status: 404 }); }
      return env.GAME.get(id).fetch(new Request(`https://game/connect?token=${encodeURIComponent(url.searchParams.get('token') || '')}`, req));
    }
    return new Response('Not found', { status: 404 });
  },
};

export class Lobby extends DurableObject {
  async fetch(req) {
    const size = new URL(req.url).searchParams.get('size');
    const [client, server] = Object.values(new WebSocketPair());
    const waiting = this.ctx.getWebSockets(size).find(ws => ws.readyState === WebSocket.OPEN && !ws.deserializeAttachment());
    if (!waiting) {
      this.ctx.acceptWebSocket(server, [size]);
      return new Response(null, { status: 101, webSocket: client });
    }
    waiting.serializeAttachment({ taken: true }); // before the await, so nobody else grabs them
    const id = this.env.GAME.newUniqueId();
    const tokens = [token(), token()];
    await this.env.GAME.get(id).init({ mode: 'online', size, tokens });
    server.accept();
    // The clients hang up once they have their ticket.
    [[waiting, 0], [server, 1]].forEach(([ws, seat]) => {
      try { ws.send(JSON.stringify({ k: 'match', game: id.toString(), token: tokens[seat] })); } catch { /* they left; the game's bot takes over their seat */ }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ } }
}

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.g = null;
    // Keep-alive pings are answered without waking the object up.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async load() {
    if (!this.g) this.g = (await this.ctx.storage.get('g')) || null;
    return this.g;
  }

  async init({ mode, size, tokens }) {
    const now = Date.now();
    const human = [true, mode === 'online'];
    this.g = {
      mode, tokens, human,
      t: newTable({ size, bots: human.map(h => !h), timed: mode === 'online', now }),
      // Online, a seat nobody has joined yet counts as gone. Against the bot the game just waits.
      gone: human.map(h => (h && mode === 'online' ? now : 0)),
      touched: now, hofDone: false,
    };
    await this.save();
  }

  async save() {
    const g = this.g;
    await this.ctx.storage.put('g', g);
    const times = [g.t.autoAt, g.touched + IDLE_MS];
    g.gone.forEach((at, seat) => { if (at && !g.t.bots[seat] && g.t.s.winner < 0) times.push(at + GRACE_MS); });
    await this.ctx.storage.setAlarm(Math.min(...times.filter(Boolean)));
  }

  seatOf(ws) {
    const tag = this.ctx.getTags(ws).find(x => x[0] === 's');
    return tag ? +tag[1] : -1;
  }

  openSeat(seat, except) {
    return this.ctx.getWebSockets(`s${seat}`).some(ws => ws !== except && ws.readyState === WebSocket.OPEN);
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket closed */ }
  }

  broadcast(extra) {
    const g = this.g, now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatOf(ws);
      if (seat < 0) continue;
      const o = 1 - seat;
      this.send(ws, {
        k: 'state', seat, view: viewFor(g.t.s, seat),
        remaining: g.t.deadline ? Math.max(0, g.t.deadline - now) : 0,
        opp: g.human[o] && !g.t.bots[o] ? 'Opponent' : 'Bot',
        online: g.mode === 'online',
      });
      if (extra && extra.seat !== seat) this.send(ws, extra.msg);
    }
  }

  async fetch(req) {
    const g = await this.load();
    const url = new URL(req.url);
    const seat = g ? g.tokens.indexOf(url.searchParams.get('token')) : -1;
    if (seat < 0 || !url.searchParams.get('token')) return new Response('Unknown game', { status: 404 });

    for (const old of this.ctx.getWebSockets(`s${seat}`)) { try { old.close(4000, 'replaced'); } catch { /* gone */ } }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`s${seat}`]);
    const now = Date.now();
    g.gone[seat] = 0;
    g.touched = now;
    const reclaimed = g.t.bots[seat] && g.t.s.winner < 0;
    if (reclaimed) { g.t.bots[seat] = false; refresh(g.t, now); }
    this.send(server, { k: 'hello', game: this.ctx.id.toString(), token: g.tokens[seat], seat });
    this.broadcast(reclaimed ? { seat, msg: { k: 'toast', msg: 'Your opponent is back' } } : null);
    await this.save();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const g = await this.load();
    if (!g) { ws.close(4004, 'game over'); return; }
    const seat = this.seatOf(ws);
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const now = Date.now();
    g.touched = now;

    if (m.k === 'act') {
      const r = act(g.t, seat, m.a, now);
      if (r.ok) this.broadcast();
      else this.send(ws, { k: 'err', msg: r.err });
    } else if (m.k === 'name') {
      const s = g.t.s;
      const name = String(m.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20);
      if (s.winner !== seat || g.t.bots[seat] || g.hofDone || !name) return;
      g.hofDone = true;
      const hof = await this.env.HOF.get(this.env.HOF.idFromName('global')).add({
        name, rounds: Math.ceil((s.turn + 1) / 2), vs: g.mode === 'online' ? 'Human' : 'Bot', size: s.size, date: new Date().toISOString(),
      });
      for (const o of this.ctx.getWebSockets()) this.send(o, this.seatOf(o) === seat ? { k: 'saved', hof } : { k: 'winner', name });
    }
    await this.save();
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ }
    const g = await this.load();
    if (!g) return;
    const seat = this.seatOf(ws);
    if (seat >= 0 && g.mode === 'online' && !this.openSeat(seat, ws)) {
      g.gone[seat] = Date.now();
      await this.save();
    }
  }

  async webSocketError(ws) { await this.webSocketClose(ws, 1011); }

  async alarm() {
    const g = await this.load();
    if (!g) return;
    const now = Date.now();
    if (now >= g.touched + IDLE_MS) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4004, 'idle'); } catch { /* gone */ } }
      this.g = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    let changed = false, extra = null;
    g.gone.forEach((at, seat) => {
      if (at && now >= at + GRACE_MS && !g.t.bots[seat] && g.t.s.winner < 0) {
        g.t.bots[seat] = true;
        refresh(g.t, now);
        changed = true;
        extra = { seat, msg: { k: 'toast', msg: 'Opponent left — the bot takes over' } };
      }
    });
    if (g.t.bots.every(Boolean)) { // both players left
      this.g = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    if (step(g.t, now)) changed = true;
    if (changed) this.broadcast(extra);
    await this.save();
  }
}

export class HallOfFame extends DurableObject {
  async top() {
    return ((await this.ctx.storage.get('list')) || []).slice(0, 10);
  }

  async add(entry) {
    const list = (await this.ctx.storage.get('list')) || [];
    list.push(entry);
    list.sort((a, b) => a.rounds - b.rounds || a.date.localeCompare(b.date));
    await this.ctx.storage.put('list', list.slice(0, 100));
    return list.slice(0, 10);
  }
}
