// Serverless matchmaking over WebRTC using PeerJS' free public broker.
// Hosts claim one of a few well-known lobby IDs; guests probe those IDs.
// Handshake: guest "hello" -> host "offer" -> guest "accept" -> host "welcome" (sent by the game).

const PREFIX = 'tinysettler-v1-';
const SLOTS = 8;
const PROBE_MS = 2500;

export function findMatch(size, maxMs, onPhase = () => {}) {
  let done = false, matched = false, pending = null;
  let peers = [], timer = 0, probeTimer = 0, resolveFn;
  const promise = new Promise(r => { resolveFn = r; });
  const ids = Array.from({ length: SLOTS }, (_, i) => `${PREFIX}${size}-${i}`);

  const finish = res => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearInterval(probeTimer);
    for (const p of peers) if (!res || p !== res.peer) p.destroy();
    resolveFn(res);
  };

  if (!window.Peer) { finish(null); return { promise, cancel() {} }; }
  timer = setTimeout(() => finish(null), maxMs);

  // Try to join someone who is already waiting.
  const probe = (peer, targets) => targets.forEach(id => {
    const c = peer.connect(id, { reliable: true, serialization: 'json' });
    c.on('open', () => c.send({ k: 'hello' }));
    c.on('data', m => {
      if (m.k === 'offer') {
        if (done || matched || pending) { c.close(); return; }
        pending = c;
        matched = true;
        c.send({ k: 'accept' });
      } else if (m.k === 'welcome' && c === pending) {
        finish({ role: 'guest', peer, conn: c, welcome: m });
      } else if (m.k === 'busy') {
        if (c === pending) { pending = null; matched = false; }
        c.close();
      }
    });
  });

  const host = slot => {
    if (done) return;
    if (slot >= SLOTS) { finish(null); return; }
    const peer = new Peer(ids[slot], { debug: 0 });
    peers.push(peer);
    peer.on('error', err => {
      if (err.type === 'unavailable-id') { peer.destroy(); host(slot + 1); }
      else if (err.type !== 'peer-unavailable') finish(null);
    });
    peer.on('open', () => {
      onPhase('waiting');
      // Keep checking lower slots, so two people who both started hosting still find each other.
      if (slot > 0) probeTimer = setInterval(() => { if (!matched) probe(peer, ids.slice(0, slot)); }, 3000);
    });
    peer.on('connection', c => {
      c.on('data', m => {
        if (m.k === 'hello') c.send({ k: matched || done ? 'busy' : 'offer' });
        else if (m.k === 'accept') {
          if (matched || done) { c.send({ k: 'busy' }); return; }
          matched = true;
          finish({ role: 'host', peer, conn: c });
        }
      });
    });
  };

  let hosting = false;
  const scout = new Peer({ debug: 0 });
  const startHosting = () => {
    if (done || hosting) return;
    if (pending) { setTimeout(startHosting, 1000); return; } // a handshake is in flight
    hosting = true;
    scout.destroy();
    host(0);
  };
  peers.push(scout);
  scout.on('error', err => { if (err.type !== 'peer-unavailable') startHosting(); });
  scout.on('open', () => {
    onPhase('probing');
    probe(scout, ids);
    setTimeout(startHosting, PROBE_MS);
  });

  return { promise, cancel: () => finish(null) };
}
