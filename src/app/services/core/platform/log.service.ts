import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface LogOptions {
  id?: number;
  title?: string;
  detail?: string;
  state?: string;
  timestamp?: number;
  mergeKey?: string;
  seq?: number;
  offset?: number;
  previewTruncated?: boolean;
}

export interface LogPage {
  generation: number;
  entries: LogOptions[];
  beforeOffset: number;
  nextOffset: number;
  hasMore: boolean;
  reset?: boolean;
}

export interface LogReadOptions {
  mode?: 'tail' | 'before' | 'after';
  beforeOffset?: number;
  afterOffset?: number;
  generation?: number;
  limit?: number;
  maxBytes?: number;
  errorsOnly?: boolean;
  keyword?: string;
}

@Injectable({ providedIn: 'root' })
export class LogService {
  readonly stateSubject = new Subject<LogOptions>();

  // The journal is authoritative; this small cache serves synchronous consumers.
  private readonly recent: LogOptions[] = [];
  private readonly maxRecent = 500;
  private streamId = 'main';
  private displaySource: LogService | null = null;
  private pendingEntries: LogOptions[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private writeFailure: unknown = null;

  get list(): LogOptions[] {
    return this.displaySource?.recent || this.recent;
  }

  setStreamId(streamId: string): void {
    if (this.recent.length) throw new Error('Cannot change a log stream after writing');
    this.streamId = streamId;
  }

  setDisplaySource(source: LogService | null): void {
    this.displaySource = source && source !== this ? source : null;
    this.stateSubject.next({});
  }

  update(opts: LogOptions): void {
    if (!opts.title && !opts.detail) return;
    const entry: LogOptions = {
      ...opts,
      title: opts.title === 'undefined' ? '' : opts.title,
      detail: opts.detail === 'undefined' ? '' : opts.detail,
      timestamp: Date.now(),
    };
    const ipc = this.ipc();
    const cachedEntry = ipc ? { ...entry, detail: entry.detail?.slice(0, 8192) } : entry;

    if (entry.mergeKey) {
      const index = this.recent.findIndex(item => item.mergeKey === entry.mergeKey);
      if (index !== -1) this.recent[index] = { ...this.recent[index], ...cachedEntry };
      else this.recent.push(cachedEntry);
    } else {
      this.recent.push(cachedEntry);
    }
    if (this.recent.length > this.maxRecent) {
      this.recent.splice(0, this.recent.length - this.maxRecent);
    }

    if (ipc && !this.writeFailure) {
      this.pendingEntries.push(entry);
      this.pendingBytes += (entry.title?.length || 0) + (entry.detail?.length || 0) + 128;
      if (this.pendingBytes >= 64 * 1024) {
        void this.flushQueued().catch(error => console.error('写入底部日志失败:', error));
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flushQueued().catch(error => console.error('写入底部日志失败:', error));
        }, 50);
      }
    }
    this.stateSubject.next(entry);
  }

  async readPage(options: LogReadOptions = {}): Promise<LogPage> {
    const source = this.displaySource || this;
    const ipc = this.ipc();
    if (ipc) {
      await source.flushQueued();
      return await ipc.invoke('bottom-log:read', { streamId: source.streamId, options });
    }
    return this.readMemoryPage(source.recent, options);
  }

  async clear(): Promise<void> {
    const source = this.displaySource || this;
    const ipc = this.ipc();
    if (ipc) {
      await source.flushQueued();
      await ipc.invoke('bottom-log:clear', { streamId: source.streamId });
    }
    source.recent.length = 0;
    this.stateSubject.next({});
  }

  async exportText(targetPath: string): Promise<number> {
    const ipc = this.ipc();
    if (!ipc) throw new Error('Log export requires the desktop runtime');
    const source = this.displaySource || this;
    await source.flushQueued();
    const result = await ipc.invoke('bottom-log:export', { streamId: source.streamId, targetPath });
    return Number(result?.count || 0);
  }

  async readEntry(item: LogOptions, generation: number): Promise<LogOptions> {
    if (!item.previewTruncated || item.offset === undefined) return item;
    const ipc = this.ipc();
    if (!ipc) return item;
    const source = this.displaySource || this;
    return await ipc.invoke('bottom-log:entry', {
      streamId: source.streamId,
      options: { generation, offset: item.offset },
    });
  }

  private ipc(): any {
    return window['electronAPI']?.ipcRenderer || window['ipcRenderer'];
  }

  private flushQueued(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.writeFailure) return Promise.reject(this.writeFailure);
    if (!this.pendingEntries.length) return this.writeChain;
    const entries = this.pendingEntries;
    this.pendingEntries = [];
    this.pendingBytes = 0;
    const ipc = this.ipc();
    this.writeChain = this.writeChain.then(async () => {
      await ipc.invoke('bottom-log:append-batch', { streamId: this.streamId, entries });
    }).catch(error => {
      this.writeFailure = error;
      throw error;
    });
    return this.writeChain;
  }

  private readMemoryPage(list: LogOptions[], options: LogReadOptions): LogPage {
    const matches = (item: LogOptions) =>
      (!options.errorsOnly || item.state === 'error') &&
      (!options.keyword || [item.state, item.title, item.detail].join('\n').toLowerCase().includes(options.keyword.toLowerCase()));
    const limit = Math.max(1, Math.min(1000, options.limit || 500));
    if (options.mode === 'after') {
      const start = Math.max(0, options.afterOffset || 0);
      const entries = list.slice(start).filter(matches).slice(0, limit);
      return { generation: 0, entries, beforeOffset: start, nextOffset: list.length, hasMore: false };
    }
    const end = options.mode === 'before' ? Math.max(0, options.beforeOffset || 0) : list.length;
    const entries = list.slice(0, end).filter(matches).slice(-limit);
    return { generation: 0, entries, beforeOffset: Math.max(0, end - entries.length), nextOffset: list.length, hasMore: end > entries.length };
  }
}
