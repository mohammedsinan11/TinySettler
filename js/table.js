// Game driver shared by the server and offline bot games in the browser.
// A "table" is a game state plus everything needed to run it without a human:
// bot seats, the turn clock and when the next automatic move is due.
// Everything here is plain JSON so the server can store it between messages.
import { RES, newGame, applyAction, hasAnyMove, total } from './engine.js';
import { botAct, autoAct } from './bot.js';

export const TURN_MS = 60000, SHORT_MS = 30000;
const PASS_MS = 1200; // speed rule: a player with nothing to do passes after this pause

export function newTable({ size = 'small', bots = [false, false], timed = false, now = Date.now() } = {}) {
  const t = { s: newGame({ size }), bots, timed, deadline: 0, dkey: '', botRoll: -1, autoAt: 0 };
  refresh(t, now);
  return t;
}

export const turnLength = s => (s.phase === 'setup' || s.phase === 'robber' ? SHORT_MS : TURN_MS);

// Call after every change: restarts the turn clock when the game moved on and
// works out when the next automatic move is due (0 = waiting for a human).
export function refresh(t, now) {
  const s = t.s;
  const key = `${s.turn}|${s.phase}|${s.setupStep}|${s.setupNeed}`;
  if (!t.timed || s.winner >= 0) { t.deadline = 0; t.dkey = ''; }
  else if (key !== t.dkey) { t.dkey = key; t.deadline = now + turnLength(s); }

  if (s.winner >= 0) t.autoAt = 0;
  else if (t.bots[s.cur]) t.autoAt = now + (s.phase === 'setup' ? 450 : s.rollId !== t.botRoll ? 1000 : 500);
  else if ((s.phase === 'main' || s.phase === 'roads') && !hasAnyMove(s, s.cur)) t.autoAt = now + PASS_MS;
  else t.autoAt = t.deadline;
}

export function act(t, seat, a, now) {
  const r = applyAction(t.s, seat, a);
  if (r.ok) refresh(t, now);
  return r;
}

// Makes the automatic move if one is due. Returns true if the state changed.
export function step(t, now) {
  const s = t.s;
  if (!t.autoAt || now < t.autoAt - 25) return false;
  const p = s.cur;
  let a;
  if (t.bots[p]) { a = botAct(s, p); t.botRoll = s.rollId; }
  else if ((s.phase === 'main' || s.phase === 'roads') && !hasAnyMove(s, p)) a = { t: 'end' };
  else a = autoAct(s, p); // out of time
  if (!applyAction(s, p, a).ok) applyAction(s, p, autoAct(s, p)); // safety net
  refresh(t, now);
  return true;
}

// What one seat is allowed to see: the opponent's hand, development cards and
// the order of the deck stay hidden.
export function viewFor(s, seat) {
  return {
    ...s,
    devDeck: s.devDeck.map(() => '?'),
    players: s.players.map((P, i) => {
      const hand = total(P), devCount = P.devs.length + P.fresh.length + P.vpCards;
      if (i === seat) return { ...P, hand, devCount };
      return { ...P, res: Object.fromEntries(RES.map(r => [r, 0])), devs: [], fresh: [], vpCards: 0, hand, devCount };
    }),
  };
}
