# 🏝️ TinySettler

Speed Catan in the browser. 1v1, first to **8 points**, on a tiny island.

Open the page and you're matched with a random online opponent within ~9 seconds, or you play the bot (you can also skip straight to the bot).

## Speed rules

- **Maps:** *Small* is 1 centre hex with one ring around it (7 hexes, 3 harbours). *Medium* is 2 centre hexes with one ring around them (10 hexes, 4 harbours). No desert.
- **Setup:** 2 settlements and 2 roads each, in snake order. Your second settlement gives you its starting resources.
- **Automatic:** dice rolls, resource payouts, discarding on a 7 (you drop your biggest piles), stealing (there's only one opponent), Year of Plenty picks, and **passing your turn when you have nothing left to do**.
- **Your decisions:** where to build, bank/harbour trades (click a resource in your hand), buying and playing development cards, and where the robber goes.
- **Scoring:** settlement 1, city 2, Longest Road (5+) 2, Largest Army (3+ knights) 2, Victory Point cards 1.
- **Online:** 60 s per turn (30 s for setup and robber moves). If your opponent leaves, the bot takes over their seat.
- After a win you can enter your name for the **Hall of Fame** (fastest wins, stored in your browser).

## Run locally

It's a static site with no build step:

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Deploy on GitHub Pages

In the repo go to **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save. The game then runs at `https://<user>.github.io/TinySettler/`.

To host it anywhere else, upload these files to any static web host.

## How it works

| File | What it does |
| --- | --- |
| `js/engine.js` | Rules engine. The state is plain JSON and moves happen through `applyAction(state, seat, action)`. |
| `js/bot.js` | Greedy bot, which also makes the move for a player who runs out of time. |
| `js/net.js` | Matchmaking without a server, over WebRTC using the free public [PeerJS](https://peerjs.com) broker. Hosts claim one of 8 lobby IDs per map size and guests probe them. |
| `js/main.js` | UI: an SVG board and side panel. The host runs the game and sends the full state to the guest after every move. |

### Moving to your own webpage later

- **Leaderboard:** the Hall of Fame lives in `localStorage`. For a shared one, replace `loadHof`/the name-form handler in `js/main.js` with calls to a small API.
- **Matchmaking:** the public PeerJS broker is free with no guarantees. You can run your own [PeerServer](https://github.com/peers/peerjs-server) and pass `{ host, port, path }` to `new Peer(...)` in `js/net.js`.
- **Anti-cheat:** the guest gets the full state, so it could see the opponent's hand. A server that owns the game state would fix this. The engine has no DOM dependencies, so it runs unchanged on Node.
