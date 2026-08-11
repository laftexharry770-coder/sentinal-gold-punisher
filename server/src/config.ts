export const config = {
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Milliseconds between simulated ticks when no live feed is attached. */
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 400),
  /** Opening price for the simulated XAUUSD feed. */
  seedPrice: Number(process.env.SEED_PRICE ?? 3312.4),
  /** Deterministic feed seed — set for reproducible runs and tests. */
  randomSeed: process.env.RANDOM_SEED ? Number(process.env.RANDOM_SEED) : null,
  /** MetaApi cloud REST root, used when an account is linked with provider=metaapi. */
  metaApiRegion: process.env.METAAPI_REGION ?? 'new-york',
  metaApiToken: process.env.METAAPI_TOKEN ?? '',
  /** Serve the built web terminal from the API process. */
  serveWeb: process.env.SERVE_WEB !== 'false',
  historyBars: Number(process.env.HISTORY_BARS ?? 240),
};
