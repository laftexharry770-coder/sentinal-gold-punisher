# Sentinal MT5 — Gold Punisher

XAUUSD trading terminal for MetaTrader 4 and 5, connected through
[MetaApi](https://metaapi.cloud). It runs **your own expert advisor** — upload the
`.mq5` and it compiles and trades inside Sentinal — or its built-in models, and it
copies the master account to any number of follower accounts, sending every order to
all of them **in the same instant**.

```
web/      React + Vite terminal (phone, tablet and desktop layouts)
engine/   Isomorphic trading engine: accounts, bot, dispatcher/copier, recovery, MetaApi adapter
mql5/     MQL5 compiler and runtime: an uploaded .mq5 becomes a running expert advisor
server/   REST + WebSocket API, and static hosting for the client/server build
shared/   Domain model and trade math used everywhere
```

The engine has no transport or filesystem dependencies, so it runs unchanged in Node
and in a browser tab. That is what makes the two builds below possible.

## Two ways to run it

**In the browser (the GitHub Pages site).** The engine runs in the page. Sign in with
your MetaApi token, pick the master and the followers, and trade. The token stays in
your browser and goes only to MetaApi. The bot runs **while the page is open** — close
the tab and it stops watching the market (positions stay open at the broker, with their
stops).

**On a server (always on).** The Node execution server runs the same engine and keeps
trading and copying with every browser closed. Configure it with environment variables
(below) and open its address to watch and control it. This is the right setup for a
copier that must never miss a trade.

## Connecting MetaApi

1. Create a MetaApi account and copy the **API access token** from
   [app.metaapi.cloud/token](https://app.metaapi.cloud/token).
2. Add your MetaTrader logins to MetaApi — at app.metaapi.cloud, or on Sentinal's
   sign-in screen under **+ Add a MetaTrader account to MetaApi** (login, trading
   password, server exactly as MetaTrader shows them; MetaApi checks them with the broker).
3. On the sign-in screen, paste the token, **Show my MetaTrader accounts**, choose the
   **Master** and mark the accounts that **Follow** it.
4. Leave **Gold symbol** blank to find each broker's gold automatically (`XAUUSD`,
   `XAUUSDm`, `GOLD`, `XAUUSD.raw`…) or type the master's.
5. **Send real orders to MetaTrader** is off by default, every session: fills are then
   simulated against your broker's real quotes. Turn it on to trade.

Accounts that MetaApi has stopped are started on connect (up to a minute the first
time). Every account gets its own streaming connection, opened at sign-in, so nothing is
dialled when an order is due.

## Strategies — change them any time

Choose on the MT5 Control screen (**Burst** or **your EA**) or Settings → **Strategy**.
An uploaded EA stays saved while Burst trades, so switching back needs no second upload;
whatever is chosen is kept for the next visit (browser) or the next restart (server).

- **Burst** (the default) trades the way the MT5 Control recording does. When the book is
  flat it opens a burst of **0.01-lot positions all at once** — **16 for every $10 of
  balance, never more than 50** — in the direction of the trend (EMA 20 over EMA 50 on M1,
  with a minimum gap so a flat market opens nothing). Every position carries a **take
  profit 5.00 from its entry, set at the broker**, so they close together even with the
  terminal closed; there is **no stop loss** unless you set one. The moment the last one
  has closed, the next burst goes out, sized from the new balance. In the recording that
  took $10 → 16 positions → $90 → 50 positions → $341 → 50 positions → $591. Every number
  is editable (lot, positions per balance step, cap, take profit, optional stop, direction:
  trend / buy only / sell only, trend timeframe and EMAs, delay before the next burst), and
  the Settings card shows, for your balance, what the next burst makes at take profit —
  and how small a move against it costs the whole balance when it has no stop. Followers
  copy each position; a follower with **balance-ratio** sizing opens the burst its own
  balance calls for instead (a $5 follower opens 8).
- **Other built-in models** — adaptive scalp, momentum breakout, mean reversion, with the
  multi-position, basket and zero-loss controls described below.
- **An `.mq5` expert advisor** (e.g. `Angel_Bot.mq5`) — drop the file in, with any
  `.mqh` headers it includes. Sentinal compiles it and runs it on the master account:
  `OnInit`/`OnTick`/`OnTimer`/`OnTrade`/`OnTradeTransaction`/`OnDeinit`, `CTrade` and the
  rest of the Trade library, `OrderSend`, positions, orders, deals and history, account
  and symbol properties, `Copy*` series, the standard indicators (MA, RSI, ATR, ADX,
  Bands, MACD, Stochastic, CCI, SAR, Ichimoku, Alligator, Fractals and more, computed the
  way MT5 computes them), chart objects, global variables and files. Its inputs appear as
  a form (groups, enums, colours, timeframes); applying them restarts the EA the way MT5
  does. Its `OrderSend` goes to the master **and every follower at once**. A compile
  error names the file and line, and the previous strategy stays in place. Not
  available: DLL `#import`, `iCustom` (a custom indicator's own code), `WebRequest`.
- **An `.ex5`** — compiled code runs only inside MetaTrader, and MetaApi's cloud
  terminals cannot host custom MT5 experts. So an `.ex5` switches Sentinal to **mirror
  mode**: attach the EA to the master account's chart in your own MT5 (desktop or VPS)
  with Algo Trading on, start the bot here, and every position the EA opens, modifies or
  closes is copied to the followers the moment MetaApi reports it. Uploading the `.mq5`
  instead removes the need to keep a MetaTrader terminal running.
- **Load sample EA** loads `mql5/samples/Sentinal.mq5`, a complete trend-adaptive EA,
  to see the pipeline work end to end.

## Latency, honestly

No copier can make the gap between accounts zero: every broker takes its own round trip
to fill an order. What Sentinal controls, it removes:

- **Simultaneous dispatch** — one order goes to the master and every follower in the
  same event-loop turn. Followers never wait to hear that the master filled; the time
  between the first and the last send is the time to write a request on an open socket,
  shown in microseconds.
- **Warm connections** — every account's MetaApi streaming socket is open and
  synchronised before the first order, so no order waits for a handshake.
- **One price for every account** — a money stop is converted once, at the master's
  price, so every copy holds its stop at the same level; the master's own money stops are
  sent as `RELATIVE_CURRENCY` so the broker sets them exactly at the fill.
- **Tick-by-tick quotes** — accounts added from Sentinal stream every tick; for older
  ones, Accounts → **Stream every tick** switches them (MetaApi's default is one quote
  every 2.5 s).
- **Measured, not claimed** — Accounts & Copying shows each order's send gap and each
  broker's acknowledgement time, and every account's average.

To make the unavoidable part smallest: keep all MetaApi accounts in one region, and run
the server beside it (the Fly config uses `iad`, next to MetaApi's `vint-hill` and
`new-york` regions). In mirror mode, add the time MetaApi takes to report the EA's trade
from MetaTrader.

## Development

```bash
npm install
npm run dev          # server on :4000, terminal on :5173 (proxied)
```

```bash
npm test             # mql5, engine and web test suites
npm run typecheck    # all workspaces
npm run build        # every package, then the served terminal
```

Commit the built page along with the source that produced it:

```bash
npm run publish:local   # builds the standalone page into the repository root
```

The publish workflow (`.github/workflows/pages.yml`) runs the tests, rebuilds the page on
pushes to `main`, and publishes it to the repository root and the `gh-pages` branch.

## Hosting the server

| Variable | Purpose |
| --- | --- |
| `METAAPI_TOKEN` | MetaApi API access token. Without it the server runs the demo market. |
| `METAAPI_MASTER_ID` | MetaApi id of the master account (the server lists the ids in its log if missing). |
| `METAAPI_FOLLOWER_IDS` | Comma-separated MetaApi ids of the followers. |
| `METAAPI_SYMBOL` | The master's gold symbol; blank finds it. |
| `FOLLOWER_MULTIPLIER` | Follower lot = master lot × this (default 1; editable per follower later). |
| `LIVE_EXECUTION` | `true` sends real orders; anything else fills on paper against real quotes. |
| `ACCESS_KEY` | Required on every API call and the WebSocket; **mandatory with `LIVE_EXECUTION=true`**. Open the site once as `https://your-host/?key=YOUR_KEY` and the browser remembers it. |
| `AUTO_START_BOT` | `true` starts the bot by itself after every restart or deploy. |
| `STRATEGY_FILE` | An `.mq5`/`.ex5` on disk to load when none has been uploaded. |
| `STATE_DIR` | Where the uploaded strategy, settings and EA global variables are kept (default `./data`). |

**Fly.io** — `fly.toml` builds the Dockerfile, keeps one machine awake and mounts
`/data`:

```bash
fly launch --copy-config --no-deploy
fly volumes create sentinal_data --size 1 --region iad
fly secrets set METAAPI_TOKEN=… METAAPI_MASTER_ID=… METAAPI_FOLLOWER_IDS=… ACCESS_KEY=…
fly deploy
```

**Render** — `render.yaml` is a blueprint; set the secrets in the dashboard. Use an
always-on instance for trading (the free one sleeps).

**Docker / a VPS** — `docker build -t sentinal . && docker run -p 4000:4000 -v sentinal:/data --env-file .env sentinal`.

WebSockets must be enabled on the host: the terminal streams every tick over `/ws`.

## Multiple trades at once

Every layer of the engine is built around a book of concurrent legs rather than a single
position (built-in models).

| Control | Default | What it does |
| --- | --- | --- |
| `entriesPerSignal` | 4 | Legs fired **together** on one qualified signal |
| `maxConcurrentPositions` | 24 | Hard cap on simultaneously open bot legs |
| `maxPositionsPerDirection` | 12 | Longs and shorts capped separately |
| `entrySpacingUsd` | 0.15 | Minimum gold-price distance from the nearest same-side leg |
| `allowHedging` | on | Long and short legs open at the same time |
| `signalCooldownMs` | 1500 | Pause between two entry bursts |
| `basketTakeProfitUsd` / `basketStopLossUsd` | $15 / off | Close the entire book together on its combined result |

A burst is truncated, never over-filled. Manual trading uses the same path — the
**Quick trade** ticket has a `Legs` field, and `POST /api/orders` accepts `legs: n`.

## Zero-Loss Recovery

Losing trades are pooled into a running **deficit** per account. A recovery is released
only when its projected close clears the whole deficit *plus* the configured minimum
profit; otherwise it stays queued with a readable hold reason. Oversized recoveries are
split across legs fired together, one recovery works the deficit at a time, and fresh
entries pause above `maxDeficitUsd`. (Built-in models; an EA manages its own exits.)

## Copy trading

The strategy trades the **master**. Each order goes to the master and every follower at
once, in the follower's own symbol and with its own sizing (`multiplier`, `fixed` lot or
`balance-ratio`), optional direction inversion (stop and target swap with it), optional
stop/target copying, and a slippage tolerance that cancels a copy filled too far away. If
the master's broker rejects an order the followers already filled, those copies are
closed at once. Closes, partial closes and stop changes follow the same path. Trades
started in MetaTrader itself (mirror mode) are copied as soon as MetaApi reports them.

Every order carries a client id — the same on the master and its copies — so after a
reload or a server restart the copies are matched to their master again from the
brokers' own books. A copy whose master closed while nothing was watching is reported,
not closed behind your back. Session guards (daily loss, trade cap) apply to EAs too:
once tripped, the EA's orders are refused the way MetaTrader refuses them with Algo
Trading off.

## Brokers

- **`metaapi`** — a MetaTrader 4/5 account through MetaApi (`engine/src/broker/metaapi.ts`).
  Positions, pending orders, deals, balance, equity and margin are MetaTrader's own,
  kept current by the streaming connection; stops and targets are held by the broker;
  closes are booked from the broker's exit deals. Removing an account from Sentinal never
  closes its positions.
- **`sim`** — full local simulation: spread, commission, margin, stop/target and pending
  execution. Demo mode and paper trading use it.

## Screens

1. **MT5 Control** — connection, the MT5 account (broker, login, server, account type),
   live analysis whose every light reports measured state, and Start/Stop.
2. **Chart & Trades** — candlestick chart with entry lines, portfolio tiles, multi-leg
   quick trade, open book, fills and the log.
3. **Bot Control Center** — statistics, per-account terminals, position management, the
   recovery queue and the copy log.
4. **Trade Settings** — strategy upload and EA inputs, copy dispatch, built-in model
   risk, multi-position, basket, zero-loss and daily circuit breakers.
5. **Accounts & Copying** — linked accounts with measured latency, follower routing,
   adding followers, and the per-order copy latency log.

## API (server build)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness (no key needed) |
| `GET` | `/api/session`, `/api/state` | Connection and the full snapshot (also pushed over `/ws`) |
| `GET/POST` | `/api/metaapi/accounts` | List the token's accounts, or add a MetaTrader login to MetaApi |
| `POST` | `/api/metaapi/followers` | Link another MetaApi account as a follower |
| `GET/POST/PATCH/DELETE` | `/api/accounts[/:id]` | Link, retag or unlink accounts |
| `POST` | `/api/accounts/:id/stream-every-tick` | Switch an account to tick-by-tick quotes |
| `POST` | `/api/strategy` | Upload `{ files: [{ name, content, encoding }] }` — `.mq5`/`.mqh` text, `.ex5` base64 |
| `POST` | `/api/strategy/builtin` | Back to the built-in models |
| `PATCH` | `/api/strategy/expert` | EA inputs and chart timeframe |
| `POST` | `/api/orders` | Manual order, `legs` for multi-entry |
| `POST` | `/api/positions/:id/close`, `/api/positions/close-all` | Close one leg or a filtered set |
| `PATCH` | `/api/positions/:id` | Move stop / target (copies follow) |
| `GET/PATCH` | `/api/bot[/config]` | Read or update the configuration |
| `POST` | `/api/bot/start`, `/api/bot/stop` | Start, stop (`closePositions` to flatten) |
| `GET` | `/api/recoveries`, `/api/logs`, `/api/history` | Recovery queue, journal, closed trades |

## Security

The MetaApi token can trade every account on it. In the browser build it stays in that
browser (only if **Stay signed in** is on) and is sent only to MetaApi; MetaApi's SDK
warns about full-access tokens in browsers — for a shared device, create a token limited
to the accounts it needs with MetaApi's Token Management API. The server keeps it in its
environment, and refuses to send real orders without an `ACCESS_KEY`.

## Risk note

Burst with no stop loss is the highest-risk way this terminal can trade: with $10 and 16
positions of 0.01, a move of about $0.63 against the burst costs the whole balance, and
only the broker's stop-out ends it. The recording shows a market that ran straight to the
take profit three times; a market that turns first ends the account. Run it on a demo
account before real money, and consider the optional stop.

Connecting alone never trades: fills are simulated against your broker's real quotes
until you turn on **Send real orders to MetaTrader** (or `LIVE_EXECUTION=true`). With it
on, the strategy trades the master and every follower — several positions at a time, by
design. Try it on demo accounts first, and check the caps in Trade Settings before
starting anything funded.
