import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  AccountState,
  Candle,
  ClosedTrade,
  EquityPoint,
  LogEntry,
  RecoveryTask,
  ServerMessage,
  Tick,
} from '@sentinal/shared';
import { createServerRuntime } from './app.js';
import { config } from './config.js';
import { createRouter } from './routes.js';

const runtime = createServerRuntime();

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use('/api', createRouter(runtime));

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

wss.on('connection', (socket) => {
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

/* ------------------------------ startup ------------------------------ */

runtime.start();

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`[sentinal] execution server listening on http://${config.host}:${config.port}`);
});

function shutdown(): void {
  runtime.stop();
  for (const client of clients) client.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
