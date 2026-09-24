import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AccountState,
  AiStatus,
  ExpertSlot,
  Candle,
  ClosedTrade,
  DispatchReport,
  EquityPoint,
  LogEntry,
  PendingOrder,
  RecoveryTask,
  ServerMessage,
  StrategyInfo,
  Tick,
} from '@sentinal/shared';
import { createServerContext } from './app.js';
import { config } from './config.js';
import { createRouter } from './routes.js';

// Real orders from a server anyone can reach would let anyone trade the
// accounts: refuse to start that way.
if (config.metaApi.token && config.metaApi.liveExecution && !config.accessKey) {
  // eslint-disable-next-line no-console
  console.error('[sentinal] LIVE_EXECUTION=true needs ACCESS_KEY set, so only you can reach the terminal. Refusing to start.');
  process.exit(1);
}

/** The access key from a header, a bearer token or a ?key= query parameter. */
function presentedKey(req: IncomingMessage): string {
  const header = req.headers['x-sentinal-key'];
  if (typeof header === 'string') return header;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return new URL(req.url ?? '/', 'http://localhost').searchParams.get('key') ?? '';
}

function authorised(req: IncomingMessage): boolean {
  if (!config.accessKey) return true;
  const given = Buffer.from(presentedKey(req));
  const expected = Buffer.from(config.accessKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const context = createServerContext();
const { runtime } = context;

const app = express();
app.use(cors());
app.use(compression());
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), session: context.session().status }));
app.use('/api', (req, res, next) => {
  if (authorised(req)) return next();
  res.status(401).json({ error: 'This terminal needs its access key.' });
});
// Strategy uploads set their own, larger limit.
app.use('/api', (req, res, next) => (req.path === '/strategy' ? next() : express.json({ limit: '256kb' })(req, res, next)));
app.use('/api', createRouter(context));

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../../web/dist');
if (config.serveWeb && existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set<WebSocket>();

function broadcast(message: ServerMessage): void {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

wss.on('connection', (socket, req) => {
  if (!authorised(req)) {
    socket.close(4401, 'access key required');
    return;
  }
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'snapshot', payload: runtime.snapshot() } satisfies ServerMessage));
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

/* --------------------------- event fan-out --------------------------- */

let lastBookPush = 0;

runtime.feed.on('tick', (tick: Tick) => {
  broadcast({ type: 'tick', payload: tick });
  // The book is pushed on a slower cadence than the quote to keep frames light.
  if (tick.time - lastBookPush >= 500) {
    lastBookPush = tick.time;
    broadcast({ type: 'positions', payload: runtime.accounts.allPositions() });
    broadcast({ type: 'accounts', payload: runtime.accounts.states() });
    broadcast({ type: 'portfolio', payload: runtime.accounts.portfolio() });
  }
});

runtime.feed.on('candle', (payload: { candle: Candle; closed: boolean }) => {
  broadcast({ type: 'candle', payload });
});

runtime.feed.on('equity', (payload: EquityPoint) => {
  broadcast({ type: 'equity', payload });
});

runtime.journal.on('log', (entry: LogEntry) => broadcast({ type: 'log', payload: entry }));

runtime.accounts.on('accounts', (states: AccountState[]) => broadcast({ type: 'accounts', payload: states }));

runtime.accounts.on('opened', () => {
  broadcast({ type: 'positions', payload: runtime.accounts.allPositions() });
  broadcast({ type: 'accounts', payload: runtime.accounts.states() });
});

runtime.accounts.on('closed', (_trade: ClosedTrade) => {
  broadcast({ type: 'positions', payload: runtime.accounts.allPositions() });
  broadcast({ type: 'history', payload: runtime.accounts.allHistory() });
  broadcast({ type: 'accounts', payload: runtime.accounts.states() });
  broadcast({ type: 'portfolio', payload: runtime.accounts.portfolio() });
});

runtime.bot.on('bot', (payload: { config: typeof runtime.bot.config; stats: ReturnType<typeof runtime.bot.stats> }) => {
  broadcast({ type: 'bot', payload });
});

runtime.bot.on('recoveries', (payload: RecoveryTask[]) => broadcast({ type: 'recoveries', payload }));
runtime.bot.on('strategy', (payload: StrategyInfo) => broadcast({ type: 'strategy', payload }));
runtime.bot.on('experts', (payload: ExpertSlot[]) => broadcast({ type: 'experts', payload }));
runtime.bot.on('ai', (payload: AiStatus) => broadcast({ type: 'ai', payload }));
runtime.copier.on('dispatch', (payload: DispatchReport) => broadcast({ type: 'dispatch', payload }));
runtime.accounts.on('orders', (payload: PendingOrder[]) => broadcast({ type: 'orders', payload }));
runtime.accounts.on('partial', () => broadcast({ type: 'history', payload: runtime.accounts.allHistory() }));

// Broker accounts change between ticks (fills, balance, reconnections):
// batch those into one push rather than dropping them.
let bookTimer: NodeJS.Timeout | null = null;
runtime.accounts.on('changed', () => {
  bookTimer ??= setTimeout(() => {
    bookTimer = null;
    broadcast({ type: 'positions', payload: runtime.accounts.allPositions() });
    broadcast({ type: 'accounts', payload: runtime.accounts.states() });
    broadcast({ type: 'portfolio', payload: runtime.accounts.portfolio() });
  }, 150);
});

/* ------------------------------ startup ------------------------------ */

runtime.start();

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`[sentinal] execution server listening on http://${config.host}:${config.port}`);
});

function shutdown(): void {
  context.stop();
  for (const client of clients) client.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
