import { createLocalBackend } from './backend/local';
import { createRemoteBackend } from './backend/remote';
import type { TerminalBackend } from './backend/types';

export type {
  AddedExpert,
  ClaudeKeyState,
  MetaApiAccountSummary,
  NewAccountPayload,
  OrderPayload,
  ProvisionInput,
  StrategyFile,
  StrategyLoadOutcome,
  TerminalBackend,
} from './backend/types';

/**
 * The standalone build ships the engine inside the page; the served build talks
 * to the execution server. Screens import `api` and never learn which is active.
 */
const STANDALONE = import.meta.env.VITE_STANDALONE === 'true';

let backend: TerminalBackend = STANDALONE ? createLocalBackend() : createRemoteBackend();

export const isStandalone = STANDALONE;

export function getBackend(): TerminalBackend {
  return backend;
}

/** Swaps the execution host — used by tests and by the build entry points. */
export function setBackend(next: TerminalBackend): void {
  backend = next;
}

export const api: TerminalBackend = {
  subscribe: (handlers) => backend.subscribe(handlers),
  sessionState: () => backend.sessionState(),
  onSession: (listener) => backend.onSession(listener),
  listMetaApiAccounts: (token) => backend.listMetaApiAccounts(token),
  provisionMetaApiAccount: (token, input) => backend.provisionMetaApiAccount(token, input),
  connectBroker: (input) => backend.connectBroker(input),
  startDemo: () => backend.startDemo(),
  signOut: () => backend.signOut(),
  savedCredentials: () => backend.savedCredentials(),
  addAccount: (payload) => backend.addAccount(payload),
  addMetaApiFollower: (metaApiId, copy) => backend.addMetaApiFollower(metaApiId, copy),
  updateAccount: (id, patch) => backend.updateAccount(id, patch),
  removeAccount: (id) => backend.removeAccount(id),
  streamEveryTick: (id) => backend.streamEveryTick(id),
  order: (payload) => backend.order(payload),
  closePosition: (id) => backend.closePosition(id),
  closeAll: (payload) => backend.closeAll(payload),
  saveBotConfig: (patch) => backend.saveBotConfig(patch),
  startBot: () => backend.startBot(),
  stopBot: (closePositions) => backend.stopBot(closePositions),
  useBuiltinStrategy: (strategy) => backend.useBuiltinStrategy(strategy),
  addExperts: (files, options) => backend.addExperts(files, options),
  setExpertEnabled: (id, enabled) => backend.setExpertEnabled(id, enabled),
  configureExpert: (id, patch) => backend.configureExpert(id, patch),
  removeExpert: (id) => backend.removeExpert(id),
  reviewAi: () => backend.reviewAi(),
  approveAiSuggestion: () => backend.approveAiSuggestion(),
  dismissAiSuggestion: () => backend.dismissAiSuggestion(),
  resumeAi: () => backend.resumeAi(),
  claudeKey: () => backend.claudeKey(),
  setClaudeKey: (key) => backend.setClaudeKey(key),
};
