import path from 'node:path';

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Milliseconds between simulated ticks when no live feed is attached. */
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 400),
  /** Opening price for the simulated XAUUSD feed. */
  seedPrice: Number(process.env.SEED_PRICE ?? 3312.4),
  /** Deterministic feed seed — set for reproducible runs and tests. */
  randomSeed: process.env.RANDOM_SEED ? Number(process.env.RANDOM_SEED) : null,
  /** Serve the built web terminal from the API process. */
  serveWeb: process.env.SERVE_WEB !== 'false',
  historyBars: Number(process.env.HISTORY_BARS ?? 240),

  /**
   * Required on every API call and on the WebSocket when set. A server that
   * sends real orders must have one: the terminal is otherwise open to anyone
   * who finds its address.
   */
  accessKey: process.env.ACCESS_KEY ?? '',

  /** Where the uploaded strategy, settings and EA global variables are kept across restarts. */
  stateDir: path.resolve(process.env.STATE_DIR ?? 'data'),
  /** An .mq5 or .ex5 to load at start when no uploaded strategy is saved. */
  strategyFile: process.env.STRATEGY_FILE ?? '',
  /**
   * Start the bot by itself once the accounts are connected, so a restart or
   * a redeploy does not leave the copier idle. Off unless set to "true".
   */
  autoStartBot: process.env.AUTO_START_BOT === 'true',

  metaApi: {
    /** API access token from app.metaapi.cloud; without it the server runs the demo market. */
    token: process.env.METAAPI_TOKEN ?? '',
    masterId: process.env.METAAPI_MASTER_ID ?? '',
    followerIds: list(process.env.METAAPI_FOLLOWER_IDS),
    /** The master's gold symbol; found automatically when blank. */
    symbol: process.env.METAAPI_SYMBOL ?? '',
    /** Real orders only when this is exactly "true"; otherwise paper fills on real quotes. */
    liveExecution: process.env.LIVE_EXECUTION === 'true',
    followerMultiplier: Number(process.env.FOLLOWER_MULTIPLIER ?? 1) || 1,
  },
};

export type ServerConfig = typeof config;
