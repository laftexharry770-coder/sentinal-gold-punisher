import { Emitter } from './emitter.js';
import type { LogEntry, LogLevel } from '@sentinal/shared';
import { uid } from './util.js';

/** In-memory ring buffer of terminal log lines, streamed to the web client. */
export class Journal extends Emitter {
  private entries: LogEntry[] = [];
  private readonly limit: number;

  constructor(limit = 400) {
    super();
    this.limit = limit;
  }

  write(level: LogLevel, accountId: string | null, message: string): LogEntry {
    const entry: LogEntry = { id: uid('log'), time: Date.now(), level, accountId, message };
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) this.entries.pop();
    this.emit('log', entry);
    return entry;
  }

  list(): LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}
