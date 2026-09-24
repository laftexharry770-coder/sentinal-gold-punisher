# Sentinal MT5 — Gold Punisher

XAUUSD trading terminal for MetaTrader 4 and 5, connected through
[MetaApi](https://metaapi.cloud). It runs **as many of your own expert advisors as you
like** — upload the `.mq5` files and they compile and trade inside Sentinal, several at
once — beside a built-in model: **Burst**, or an **AI** that learns the market as it
trades, which Claude can review. It copies the master account to any number of follower
accounts, sending every order to all of them **in the same instant**.

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

Two things decide the trades, and both can be changed at any moment, even while the bot
runs (MT5 control screen, or Trade settings → **Strategy**):

- **The built-in model** — **Burst**, **AI** or **Off**. Changing it stops the bot first,
  so a new model never inherits a book it did not open; open positions stay open.
- **The EA library** — every `.mq5` and `.ex5` you add, **as many as you like, several
  switched on at once**. Each has its own switch, inputs and chart timeframe; switching
  one on or off takes effect at once, even while the bot runs. Every EA switched on runs
  on the master beside the built-in model, and each one's orders reach every follower in
  the same instant. Positions stay with whoever opened them: the built-in model manages
  only its own (magic `20260811`), and each EA sees its own.

The library is kept for the next visit (browser: IndexedDB) or the next restart (server:
`STATE_DIR/experts/`). A single EA saved by an earlier version is moved into it, and
Angel Bot is added once, switched off.

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
  balance calls for instead (a $5 follower opens 8). With direction **AI** (the default),
  each burst goes the way the AI calls it when it is confident, follows the trend when it
  is not, and is held back when the AI expects the market to turn against the trend or
  reads it as dangerous — a burst has no stop, so staying out is the AI's most useful call.
- **AI** — the learning model described below trades on its own: one position at a
  time by default, with a stop and target at the broker.
- **Angel Bot** ships with the terminal (`mql5/samples/Angel_Bot.mq5`, v1.10) and sits
  in the library, switched off, ready to switch on; it runs through the MQL5 runtime
  below. It brackets price with a **buy stop
  and a sell stop**, re-prices them as price moves, tops up to its position cap, and trails
  one stop per basket, with a hard stop, a take profit and a daily target/loss lock. Its
  pending orders are **mirrored**: each follower holds the same stop orders at the same
  prices, moved with the master's, so every broker fills its own copy when price reaches
  it (see Copy trading). Its 28 inputs are editable in Settings; the default lot is
  **0.10** — $10 per $1 of gold per position — so lower `InpLots` for a small account.
  The bundled copy carries one fix to v1.10: `ClosePosition` wrote to `gClosingMs[n]`
  without resizing `gClosingMs`, which MetaTrader 5 answers with *array out of range* and
  removes the EA the first time it closes a position itself (a trailing exit or the daily
  lock). The Angel Bot button always loads the bundled copy; an uploaded v1.10 behaves as
  it would in MT5.
- **Other built-in models** — adaptive scalp, momentum breakout, mean reversion, with the
  multi-position, basket and zero-loss controls described below.
- **`.mq5` expert advisors** (e.g. `Angel_Bot.mq5`) — drop in as many files as you like
  at once, with any `.mqh` headers they include. Sentinal compiles each one and runs it on
  the master account:
  `OnInit`/`OnTick`/`OnTimer`/`OnTrade`/`OnTradeTransaction`/`OnDeinit`, `CTrade` and the
  rest of the Trade library, `OrderSend`, positions, orders, deals and history, account
  and symbol properties, `Copy*` series, the standard indicators (MA, RSI, ATR, ADX,
  Bands, MACD, Stochastic, CCI, SAR, Ichimoku, Alligator, Fractals and more, computed the
  way MT5 computes them), chart objects, global variables and files. Its inputs appear as
  a form (groups, enums, colours, timeframes); applying them restarts that EA the way MT5
  does. Its `OrderSend` goes to the master **and every follower at once**. A compile
  error names the file and line, and the rest of the library is added regardless. Not
  available: DLL `#import`, `iCustom` (a custom indicator's own code), `WebRequest`.
- **`.ex5` files** — compiled code runs only inside MetaTrader, and MetaApi's cloud
  terminals cannot host custom MT5 experts. So switching an `.ex5` on turns on **mirror
  mode**: attach the EA to the master account's chart in your own MT5 (desktop or VPS)
  with Algo Trading on, start the bot here, and every position it opens, modifies or
  closes is copied to the followers the moment MetaApi reports it. Uploading the `.mq5`
  instead removes the need to keep a MetaTrader terminal running.
- **Add sample EA** adds `mql5/samples/Sentinal.mq5`, a complete trend-adaptive EA,
  to see the pipeline work end to end.

## The AI

The AI is a model that learns from the gold market it watches, in the page or on the
server. It does three jobs, each with its own switch in Trade settings → **AI**:

1. **It trades** when it is the built-in model.
2. **It directs Burst** when Burst's direction is **AI**.
3. **It guards your EAs**: when it reads the market as dangerous, or is confident the
   market is about to go against an EA's new entry, it refuses that entry the way a
   broker would (`TRADE_RETCODE_REJECT`, "AI guard: …"). Closes, stop moves and cancels
   always go through.

**How it decides.** It builds one-minute bars from history and every quote, and classes
the market as trend-up, trend-down, range, volatile or quiet. Eight experts read it:
trend, momentum, breakout, mean reversion, volatility squeeze, order flow (upticks
against downticks), candle patterns and time of day. Each regime has its own weights for
the experts, learned from how often each one was right a few bars later. A calibrated
logistic model turns their vote into a probability that price is higher after the
horizon, refitted on its latest 500 outcomes. If its recent calls have no edge, it asks
for more confidence before trading. It asks for more after a run of losses and in a
regime that keeps losing. It stays out when it rates the market dangerous: volatility
far above normal, a wide spread, a price jump or a burst of ticks.

**How it trades.** An entry needs the probability to clear the threshold (60% by
default). The stop is 1.5 × ATR, widened in volatile markets and tightened in ranges. The
target is 1.5–3 R, further when it is surer, and at most 1.8 R in a range. The size risks
1% of equity (never more than the cap, 2%); an entry is skipped when even the broker's
minimum lot would risk more. The position moves to break-even after 1 ATR, then trails.
It is closed when the AI's read flips against it. A daily loss limit stops it for the
day. It waits 1 bar after a win and 3 after a loss.

**What it cannot do is know the future.** Measured on simulated markets it has never
seen: in pure noise it trades on 0–5.5% of bars and is right about half the time. In a
weak trend it trades on 68–79% of bars and is right 68–75% of the time. In a strong trend
it is right 90–93% of the time. Real gold is closer to the noise than any of these. The
panel on the MT5 control screen shows what it sees: its call and confidence, each
expert's vote and weight, the regime, the danger reading and its hit rate. The state it
has learned is saved (browser storage, or `STATE_DIR` on the server), so it resumes where
it left off.

### Claude reviews

With an Anthropic API key, Claude (the model is chosen in Settings → AI) reviews the AI every
30 minutes and after every 10 trades (both editable), or when you press **Review now**.
Claude reads the AI's recent trades, its accuracy per regime, its expert weights and its
settings, then writes a short assessment. It may change a few settings, and only within
limits the terminal enforces:

- risk no higher than the cap, and at most twice its current value;
- fewer open positions, never more;
- trading in volatile markets only switched off;
- expert weights scaled between 0.5× and 1.5×;
- a pause of up to 4 hours.

Changes apply at once, or wait for your **Approve** if auto-apply is off.

In the browser the key is kept in that browser only and sent only to Anthropic. On the
server, set `ANTHROPIC_API_KEY`. Reviews are billed to that key; the AI trades the same
without one.

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
| `STRATEGY_FILE` | An `.mq5`/`.ex5` on disk to add to the library when the library is empty. |
| `STATE_DIR` | Where the EA library, settings, the AI's learned state and EA global variables are kept (default `./data`). |
| `ANTHROPIC_API_KEY` | Lets Claude review the AI. Optional; reviews are billed to this key. |

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

**Pending orders are mirrored, not waited for.** An EA's buy stop, sell stop or limit
order is placed on the master and on every follower in the same instant, at the same
price (with the follower's own sizing; a reversing follower gets the opposite order).
When the EA moves it, the copies move too; an EA that re-prices on every tick would flood
a broker, so each follower has at most one modify in flight and is then sent only the
newest price. Cancels go to all at once. When price reaches the order, every broker fills
its own copy — no follower waits to hear that the master filled. A follower whose broker
has not quite reached the price 1.5 s after the master filled is filled at market; a
follower that filled before the master's order was cancelled has that fill closed.

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
  execution, with MetaTrader's placement rule (a stop order beyond the price, a limit
  short of it, at least the stops level away — otherwise *invalid price*). Every account
  takes each quote at the same instant, and followers' own stops run before the master's
  close is copied, as on real brokers — so a follower's book matches the master's trade
  for trade. Demo mode and paper trading use it.

## Screens

1. **MT5 control** — the master's equity, balance and floating result with Start/Stop.
   Next to them: live analysis, where every light reports measured state; the built-in
   model and each EA's switch; the AI panel; and the followers.
2. **Chart & trades** — candlestick chart with entry lines, portfolio tiles, multi-leg
   quick trade, open book, fills and the log.
3. **Bot control center** — statistics, per-account terminals, position management, the
   recovery queue and the copy log.
4. **Trade settings** — the built-in model and the EA library (inputs per EA), Burst,
   the AI and Claude, copy dispatch, built-in model risk, multi-position, basket,
   zero-loss, daily circuit breakers and appearance.
5. **Accounts & copying** — linked accounts with measured latency, follower routing,
   adding followers, and the per-order copy latency log.

**Light and dark.** The terminal follows the device's light or dark setting. The sun/moon
button, or Trade settings → **Appearance** (System, Light, Dark), overrides it for that
browser. Ice blue is the only accent colour: green and red mean profit and loss, and gold
marks the gold price.

## API (server build)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness (no key needed) |
| `GET` | `/api/session`, `/api/state` | Connection and the full snapshot (also pushed over `/ws`) |
| `GET/POST` | `/api/metaapi/accounts` | List the token's accounts, or add a MetaTrader login to MetaApi |
| `POST` | `/api/metaapi/followers` | Link another MetaApi account as a follower |
| `GET/POST/PATCH/DELETE` | `/api/accounts[/:id]` | Link, retag or unlink accounts |
| `POST` | `/api/accounts/:id/stream-every-tick` | Switch an account to tick-by-tick quotes |
| `GET` | `/api/experts` | The EA library, with each EA's status |
| `POST` | `/api/experts` | Add EAs: `{ files: [{ name, content, encoding }], enabled? }` — `.mq5`/`.mqh` text, `.ex5` base64, many at once |
| `PATCH` | `/api/experts/:id` | Switch an EA on or off (`enabled`), or change its `inputs` and chart `timeframe` |
| `DELETE` | `/api/experts/:id` | Remove an EA from the library |
| `POST` | `/api/strategy/builtin` | The built-in model: `{ strategy: "burst" \| "ai" \| "none" \| … }` |
| `GET` | `/api/ai` | The AI's reading, reviews, pause and guard statistics |
| `POST` | `/api/ai/review` | Ask Claude for a review now (needs `ANTHROPIC_API_KEY`) |
| `POST` | `/api/ai/pending/approve`, `/api/ai/pending/dismiss` | Apply or drop a review's suggestion waiting for approval |
| `POST` | `/api/ai/resume` | End a pause Claude set |
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

The Anthropic key is handled the same way: in the browser build it is kept in that
browser and sent only to Anthropic; on the server it is `ANTHROPIC_API_KEY` and never
leaves it.

## Risk note

Burst with no stop loss is the highest-risk way this terminal can trade: with $10 and 16
positions of 0.01, a move of about $0.63 against the burst costs the whole balance, and
only the broker's stop-out ends it. The recording shows a market that ran straight to the
take profit three times; a market that turns first ends the account. Run it on a demo
account before real money, and consider the optional stop.

Angel Bot at its default 0.10 lot risks about $2 per position at its 2-pip hard stop and
can hold 5 positions a side; on a $10 account one stopped basket is the balance. It
re-prices its stop orders often: through MetaApi each re-price is a request, and MetaApi
limits how many an account may send, so test it on a demo account and watch the journal
for refused modifies.

The AI is a statistical model, not a forecast. It trades when its measured confidence
clears a threshold, and it is wrong a large share of the time even then. Its stop limits
each loss, not a run of them; the daily loss limit is what stops a bad day. Claude's
reviews change settings within fixed limits; they cannot make the market predictable.

Connecting alone never trades: fills are simulated against your broker's real quotes
until you turn on **Send real orders to MetaTrader** (or `LIVE_EXECUTION=true`). With it
on, the strategy trades the master and every follower — several positions at a time, by
design. Try it on demo accounts first, and check the caps in Trade Settings before
starting anything funded.
