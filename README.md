# Sentinal MT5 — Gold Punisher

XAUUSD algorithmic trading terminal: a responsive web front end over a Node execution
engine that runs **many positions at once**, mirrors them across multiple broker
accounts, and postpones recovery trades until they project a net-positive close.

```
web/      React + Vite terminal (Cobalt Dark, desktop / Android / iOS layouts)
engine/   Isomorphic trading engine: feed, accounts, bot, copier, recovery
server/   REST + WebSocket API and static hosting for the client/server build
shared/   Domain model and trade math used everywhere
```

The engine has no transport or filesystem dependencies, so it runs unchanged in
Node and in a browser tab. That is what makes the two builds below possible.

## Two ways to run it

**Standalone (no server) — an installable web app.** The engine runs in the page,
so the build is a static site you can open, install and use offline:

- installable from the browser (an **Install** button appears in the header when
  the browser offers it), running in its own window with the app icon;
- works with **no network at all** — a service worker caches the shell, and the
  engine, feed and book are local anyway;
- screens are addressable (`?screen=bot`), so the back button and the app
  shortcuts on the icon both work.

Build it with:

```bash
npm install
npm run build --workspace shared && npm run build --workspace engine
npm run build:standalone --workspace web    # -> web/dist-standalone/index.html
```

Push the folder to any static host. The committed workflow does this on every
push: it runs the tests, builds the page and force-pushes it to the `gh-pages`
branch, which GitHub Pages serves. This is the build that trades: live orders go
straight from the page to Deriv with your own API token, which never leaves the
browser.

**Client/server.** The Node execution server owns the book and streams it to any
number of connected terminals — use this when the engine must keep running while
no browser is open. It runs the same engine on a simulated feed; live Deriv
routing lives in the standalone build so the token stays on your machine.

## Development

```bash
npm install
npm run dev          # server on :4000, terminal on :5173 (proxied)
```

Production build — the API process also serves the built terminal:

```bash
npm run build
npm start            # http://localhost:4000
```

```bash
npm test             # engine and web test suites
npm run typecheck    # all workspaces
```

Commit the built page along with the source that produced it:

```bash
npm run publish:local   # builds the standalone page into the repository root
```

The publish workflow rebuilds and commits those same files when a push leaves
them stale. Running it here first means the workflow finds nothing to do, which
matters because it commits onto whichever branch it ran on — two branches
publishing the same source is how they drift apart.

Copy `.env.example` to `.env` to change the port or the simulated feed.

### Hosting it

The production build is one Node process serving the API, the WebSocket feed and the
terminal, so any Node host works.

**Render** — `render.yaml` is a ready blueprint. In the Render dashboard choose
**New → Blueprint**, pick this repo and branch, and it builds and deploys with no
further configuration. Health check is `/api/health`.

**Fly.io** — `fly.toml` builds from the Dockerfile and keeps one machine awake so the
position book survives:

```bash
fly auth login
fly launch --copy-config --no-deploy   # choose a unique app name when prompted
fly deploy
fly open                               # opens the terminal in your browser
```

`app = "sentinal-mt5"` in `fly.toml` is almost certainly taken globally — `fly launch`
will ask for another name and rewrite the file.

`fly logs` tails the engine; `/api/health` is wired as the health check.

**Railway / Koyeb / a VPS** — the Dockerfile is picked up automatically:

```bash
docker build -t sentinal-mt5 .
docker run -p 4000:4000 sentinal-mt5     # http://localhost:4000
```

Two things to know before hosting it:

- **WebSockets must be enabled** on the host. The terminal streams every tick over
  `/ws`; without it the screens render but never update.
- **State lives in memory.** Accounts, the position book and the recovery queue are
  rebuilt from the seed accounts on every restart, so a host that sleeps on idle (such
  as Render's free instance type) stops the engine and clears the session. Use an
  always-on instance if you want it trading continuously.

## Multiple trades at once

Every layer of the engine is built around a book of concurrent legs rather than a
single position.

| Control | Default | What it does |
| --- | --- | --- |
| `entriesPerSignal` | 4 | Legs fired **together** on one qualified signal |
| `maxConcurrentPositions` | 24 | Hard cap on simultaneously open bot legs |
| `maxPositionsPerDirection` | 12 | Longs and shorts capped separately |
| `entrySpacingUsd` | 0.15 | Minimum gold-price distance from the nearest same-side leg, so stacked entries are not all at one price |
| `allowHedging` | on | Long and short legs open at the same time |
| `signalCooldownMs` | 1500 | Pause between two entry bursts |
| `basketTakeProfitUsd` / `basketStopLossUsd` | $15 / off | Close the entire book together on its combined result |

A full book at these defaults is 24 legs × 0.01 lots = 0.24 lots, roughly $158 of
margin at 1:500, risking $48 of stops against $24 of targets. The daily guards
($150 loss, 1200 trades) are sized to match. Every value is editable on the Trade
Settings screen and takes effect on the next tick.

A burst is truncated, never over-filled: the engine opens
`min(entriesPerSignal, remaining global capacity, remaining directional capacity)`
legs and logs how full the book is after each burst.

Manual trading uses the same path — the **Quick trade** ticket on the dashboard has a
`Legs` field, and `POST /api/orders` accepts `legs: n` to fire *n* market orders in one
request.

## Zero-Loss Recovery

Losing trades are pooled into a running **deficit** per account. A recovery is released
only when its projected close clears the whole deficit *plus* the configured minimum
profit; otherwise it stays queued with a readable hold reason
("postponed — waiting for an aligned signal", "needs 0.62 lots, above the 0.50 cap").

- Recovery size is derived from the deficit and the target distance, then scaled by
  `recoveryMultiplier`.
- If one leg would exceed `maxRecoveryLot`, the plan is **split across several legs
  fired simultaneously**, one per remaining layer.
- One recovery works the deficit at a time — the next layer is not released while the
  previous legs are still open, so attempts never stack on the same loss.
- While the outstanding deficit is above `maxDeficitUsd`, fresh entries pause.

The queue, including postponed tasks and their hold reasons, is visible on the Bot
Control Center screen.

## Copy trading

The engine trades the **master** account. Each leg it opens — every leg of a burst and
every recovery leg — is mirrored onto each follower with that follower's own sizing
(`multiplier`, `fixed` lot, or `balance-ratio`), optional direction inversion, optional
stop/target copying, and a slippage tolerance that cancels a mirrored fill filled too
far away. Closes propagate too, so a basket exit on the master flattens the followers in
the same pass.

## Brokers

- **`sim`** — full local simulation: spread, commission, margin, stop/target execution.
  This is what the demo accounts use.
- **`deriv`** — trades your real Deriv account over Deriv's WebSocket API
  (`web/src/broker/derivClient.ts` and `derivAccount.ts`, registered onto the engine as a
  provider by the browser build). It needs nothing but an API token with the Read and
  Trade scopes, entered on the sign-in screen and held in that browser only.

  Deriv also reports the user's MetaTrader 5 accounts, and the Connect Broker screen
  lists them with their balances. They are read-only: Deriv's API manages MT5 accounts
  but exposes no call that places an order on one, so the bot cannot trade them and the
  screen says so. Trading an MT5 account needs a bridge that speaks the MetaTrader
  protocol; live orders from this terminal go to the Deriv account that signed in.

  Account ids name their own kind — `DOT…` is demo, `ROT…` is real, and the older accounts
  use `VRTC…` and `CR…`. The sign-in screen says which kind it is reading, and the
  live-trading warning names the account, so arming the bot on real money is never a
  silent difference from arming it on practice money. An unrecognised prefix is treated
  as real, which is the safe way to be wrong about that.

  Signing in follows Deriv's current scheme: the access token is presented as a bearer
  credential to `POST /trading/v1/options/accounts/{accountId}/otp`, with the app id in a
  `Deriv-App-ID` header, and Deriv answers with a WebSocket URL that is already
  authenticated. No `authorize` message is sent over that socket — the URL carries the
  identity. Leaving the account id blank falls back to the older flow, which puts the app
  id in the query string and signs in over the socket instead.

  Deriv does not expose MetaTrader order entry over its API, so an API token trades
  Deriv's own **multiplier contracts**: you commit a stake, Deriv multiplies the
  exposure, and the stop loss and take profit are money amounts rather than price
  levels. That suits this engine, which already sizes every leg by money risk. The lot
  figures on screen are converted at `stake = lots x 100 oz x price / multiplier`, so a
  lot here earns exactly what the same lot earns on MetaTrader; `web/src/broker/__tests__`
  holds the conversion to that. Stops, targets, running profit and the position book are
  read back from Deriv rather than simulated, and nothing is filled locally when an order
  is rejected.

The market feed is a pluggable component (`engine/src/market/feed.ts`): it synthesises
XAUUSD ticks with volatility clustering by default, and anything downstream only
consumes its `tick` / `candle` events, so a live feed can replace it without touching
the engine.

## Screens

1. **Trading Dashboard** — MT5-style candlestick chart with live entry lines, portfolio
   tiles, multi-leg quick trade ticket, open book, fills and terminal log.
2. **Bot Control Center** — arm/disarm/flatten, engine statistics, per-broker terminals,
   position management filtered by account, the recovery queue and the copy-trade log.
3. **Trade Settings** — strategy, dollar-based risk, all multi-position controls, basket
   management, zero-loss parameters and daily circuit breakers.
4. **Connect Broker** — review the linked Deriv account, add simulated followers, set
   master/follower roles and edit copy routing per follower.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Full snapshot (also pushed over `ws://…/ws` on connect) |
| `GET/POST/PATCH/DELETE` | `/api/accounts[/:id]` | Link, retag or unlink accounts |
| `POST` | `/api/orders` | Manual order, `legs` for multi-entry |
| `POST` | `/api/positions/:id/close`, `/api/positions/close-all` | Close one leg or a filtered set |
| `PATCH` | `/api/positions/:id` | Move stop / target |
| `GET/PATCH` | `/api/bot[/config]` | Read or update the strategy configuration |
| `POST` | `/api/bot/start`, `/api/bot/stop` | Arm, disarm (`closePositions` to flatten) |
| `GET` | `/api/recoveries`, `/api/logs`, `/api/history` | Recovery queue, journal, closed trades |

The WebSocket at `/ws` streams ticks, candles, position/account/portfolio updates, log
lines, recovery-queue changes and equity samples.

## Risk note

Connecting alone never trades: fills are simulated against Deriv's real prices until you
turn on **Send orders to Deriv** at sign-in. With it on, the bot buys real multiplier
contracts — several at a time, by design, each staking real money. Try it on a Deriv demo
account first, and check the caps on the Trade Settings screen before arming anything
funded.
