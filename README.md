# Sentinal MT5 — Gold Punisher

XAUUSD algorithmic trading terminal: a responsive web front end over a Node execution
engine that runs **many positions at once**, mirrors them across multiple broker
accounts, and postpones recovery trades until they project a net-positive close.

```
web/      React + Vite terminal (Cobalt Dark, desktop / Android / iOS layouts)
server/   Execution engine, market feed, broker accounts, REST + WebSocket API
shared/   Domain model and trade math used by both sides
```

## Running it

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
npm test             # execution-engine test suite
npm run typecheck    # all workspaces
```

Copy `.env.example` to `.env` to change the port, the simulated feed, or to point
accounts at MetaApi.

### Hosting it

The production build is one Node process serving the API, the WebSocket feed and the
terminal, so any Node host works:

```bash
docker build -t sentinal-mt5 .
docker run -p 4000:4000 sentinal-mt5     # http://localhost:4000
```

On Render / Railway / Fly / a VPS, point the service at this repo with build command
`npm ci && npm run build`, start command `npm start`, and expose `PORT` (the server
reads it). WebSocket support must be enabled on the host — the terminal streams every
tick over `/ws`.

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
- **`metaapi`** — routes real orders through the MetaApi cloud REST API
  (`server/src/broker/metaapi.ts`). Needs `METAAPI_TOKEN` in the server environment plus
  a provisioned MetaApi account id; without them the account reports itself offline
  rather than quietly trading a simulation.

The market feed is a pluggable component (`server/src/market/feed.ts`): it synthesises
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
4. **Connect Broker** — link MT5/MetaApi accounts, set master/follower roles and edit
   copy routing per follower.

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

The default configuration trades a simulated account. Point it at a live MetaApi account
and it will place real orders — several at a time, by design. Check the caps on the Trade
Settings screen before arming anything funded.
