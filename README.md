# 🏝️ TinySettler

Speed Catan in the browser. 1v1, first to **8 points**, on a tiny island.

Open the page and you're matched with a random online opponent within ~9 seconds, or you play the bot (you can also skip straight to the bot).

## Speed rules

- **Maps:** *Small* is 1 centre hex with one ring around it (7 hexes, 3 harbours). *Medium* is 2 centre hexes with one ring around them (10 hexes, 4 harbours). No desert.
- **Setup:** 2 settlements and 2 roads each, in snake order. Your second settlement gives you its starting resources.
- **Automatic:** dice rolls, resource payouts, discarding on a 7 (you drop your biggest piles), stealing (there's only one opponent), and **passing your turn when you have nothing left to do**.
- **Your decisions:** where to build, bank/harbour trades (click a resource in your hand), buying and playing development cards, which 2 resources Year of Plenty gives you, and where the robber goes.
- **Scoring:** settlement 1, city 2, Longest Road (5+) 2, Largest Army (3+ knights) 2, Victory Point cards 1.
- **Online:** 60 s per turn (30 s for setup and robber moves). If your opponent is gone for 10 s, the bot takes over their seat (they get it back if they reconnect).
- After a win you can enter your name in the shared **Hall of Fame** (fastest wins).

## No cheating

The game runs on a small server (`worker/`), not in the browser:

- The server rolls the dice, shuffles the development deck and checks every move. A modified browser can only *ask* for moves; illegal ones are refused.
- Each player only receives what they may see: the opponent's resources, development cards and the deck order never leave the server.
- Only the server can add to the Hall of Fame, and only for a win it saw happen.

Without a server (or when it can't be reached), you can still play the bot offline in your browser, but those wins don't count for the Hall of Fame.

## Setting up the server (free, ~5 minutes)

The server is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) with Durable Objects. Both are included in Cloudflare's free plan.

**Option A: from your computer**

```bash
cd worker
npm install
npx wrangler login      # opens the browser; create a free Cloudflare account if needed
npx wrangler deploy
```

**Option B: from GitHub, with no local setup**

1. In Cloudflare, go to **My Profile → API Tokens → Create Token** and use the *Edit Cloudflare Workers* template. Copy the token. Your **Account ID** is on the Workers & Pages overview page.
2. In this repo, go to **Settings → Secrets and variables → Actions** and add the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets.
3. Go to **Actions → Deploy game server → Run workflow**. After that it redeploys by itself whenever the server code changes on `main`.

Either way, the deploy prints the server address, e.g. `https://tinysettler.<you>.workers.dev`. Put it in `js/config.js`:

```js
export const SERVER = 'https://tinysettler.<you>.workers.dev';
```

Then push to `main`.

## Run locally

```bash
cd worker && npm install && npx wrangler dev     # game server on http://localhost:8787
python3 -m http.server 8765                      # in the repo root, in a second terminal
```

Set `SERVER` in `js/config.js` to `'http://localhost:8787'` and open http://localhost:8765.

## Deploy on GitHub Pages

In the repo go to **Settings → Pages → Build and deployment**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save. The game then runs at `https://<user>.github.io/TinySettler/`.

## How it works

| File | What it does |
| --- | --- |
| `js/engine.js` | Rules engine. The state is plain JSON and moves happen through `applyAction(state, seat, action)`. |
| `js/bot.js` | Greedy bot, which also makes the move for a player who runs out of time. |
| `js/table.js` | Runs a game: bot turns, the turn clock, auto-passing, and the per-player view that hides the opponent's cards. Used by the server and by offline games. |
| `js/main.js` | UI: an SVG board and side panel. Talks to the server over a WebSocket, or runs an offline bot game. |
| `js/config.js` | The server address. |
| `worker/src/index.js` | The server: a `Lobby` that pairs players, one `Game` object per match, and the `HallOfFame`. |
