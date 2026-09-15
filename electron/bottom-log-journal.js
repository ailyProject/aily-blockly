'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');

const FLUSH_BYTES = 64 * 1024;
const FLUSH_DELAY_MS = 50;
const READ_BLOCK_BYTES = 64 * 1024;
const MAX_PAGE_ITEMS = 1000;
const MAX_PAGE_BYTES = 256 * 1024;
const RETENTION_DAYS = 7;
const RETENTION_BYTES = 512 * 1024 * 1024;

class BottomLogJournal {
  constructor(appDataPath) {
    this.rootDir = path.join(appDataPath, 'logs', 'bottom-panel');
    this.sessionDir = path.join(this.rootDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${randomUUID()}`);
    this.streams = new Map();
    void this.pruneOldSessions().catch(error => console.warn('清理底部日志失败:', error));
  }

  stream(streamId) {
    const id = normalizeStreamId(streamId);
    let state = this.streams.get(id);
    if (!state) {
      state = this.createState(id, 0);
      this.streams.set(id, state);
    }
    return state;
  }

  createState(id, generation) {
    return {
      id,
      generation,
      filePath: path.join(this.sessionDir, `${id}-${generation}.jsonl`),
      nextSeq: 0,
      pending: [],
      pendingBytes: 0,
      timer: null,
      writeChain: Promise.resolve(),
      lastError: null,
    };
  }

  append(streamId, entry) {
    const state = this.stream(streamId);
    const record = normalizeEntry(entry, ++state.nextSeq);
    if (!record) return;
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    state.pending.push(line);
    state.pendingBytes += line.length;
    if (state.pendingBytes >= FLUSH_BYTES) {
      void this.flush(state).catch(() => undefined);
    } else if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        void this.flush(state).catch(() => undefined);
      }, FLUSH_DELAY_MS);
    }
  }

  async flush(state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    if (state.pending.length) {
      const content = Buffer.concat(state.pending, state.pendingBytes);
      state.pending = [];
      state.pendingBytes = 0;
      state.writeChain = state.writeChain.catch(() => undefined).then(async () => {
        await fs.promises.mkdir(this.sessionDir, { recursive: true });
        await fs.promises.appendFile(state.filePath, content);
        state.lastError = null;
      }).catch(error => {
        state.lastError = error;
        throw error;
      });
    }
    await state.writeChain;
    if (state.lastError) throw state.lastError;
  }

  async read(streamId, options = {}) {
    const state = this.stream(streamId);
    await this.flush(state);
    const size = await fileSize(state.filePath);
    const generation = state.generation;
    const limit = Math.min(MAX_PAGE_ITEMS, Math.max(1, Number(options.limit) || 500));
    const maxBytes = Math.min(MAX_PAGE_BYTES, Math.max(1024, Number(options.maxBytes) || MAX_PAGE_BYTES));
    const filter = {
      errorsOnly: options.errorsOnly === true,
      keyword: String(options.keyword || '').trim().toLowerCase().slice(0, 256),
    };
    if (options.generation !== undefined && options.generation !== generation) {
      return { reset: true, generation, entries: [], nextOffset: 0, beforeOffset: 0, hasMore: false };
    }
    if (options.mode === 'after') {
      return { generation, ...await readAfter(state.filePath, size, options.afterOffset, limit, maxBytes, filter) };
    }
    const beforeOffset = options.mode === 'before' ? options.beforeOffset : size;
    return { generation, ...await readBackward(state.filePath, size, beforeOffset, limit, maxBytes, filter) };
  }

  async clear(streamId) {
    const previous = this.stream(streamId);
    const flushing = this.flush(previous);
    const next = this.createState(previous.id, previous.generation + 1);
    this.streams.set(previous.id, next);
    await flushing;
    return { generation: next.generation };
  }

  async readEntry(streamId, options = {}) {
    const state = this.stream(streamId);
    await this.flush(state);
    if (options.generation !== state.generation) throw new Error('Log segment changed');
    const size = await fileSize(state.filePath);
    let position = Number(options.offset);
    if (!Number.isSafeInteger(position) || position < 0 || position >= size) throw new Error('Invalid log offset');
    const chunks = [];
    let bytes = 0;
    const handle = await fs.promises.open(state.filePath, 'r');
    try {
      while (position < size) {
        const length = Math.min(READ_BLOCK_BYTES, size - position);
        const chunk = Buffer.allocUnsafe(length);
        await handle.read(chunk, 0, length, position);
        const newline = chunk.indexOf(10);
        const part = newline < 0 ? chunk : chunk.subarray(0, newline);
        bytes += part.length;
        if (bytes > 16 * 1024 * 1024) throw new Error('Log entry is too large; export the log file');
        chunks.push(part);
        if (newline >= 0) break;
        position += length;
      }
    } finally {
      await handle.close();
    }
    const entry = parseEntry(Buffer.concat(chunks, bytes).toString('utf8'));
    if (!entry) throw new Error('Log entry could not be read');
    return entry;
  }

  async exportText(streamId, targetPath) {
    if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('Missing export path');
    const state = this.stream(streamId);
    await this.flush(state);
    const source = state.filePath;
    if (!(await fileSize(source))) return { count: 0 };
    const target = await fs.promises.open(targetPath, 'w');
    const input = fs.createReadStream(source, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let count = 0;
    let outputBuffer = '';
    try {
      for await (const line of lines) {
        const entry = parseEntry(line);
        if (!entry) continue;
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const detail = cleanExportText(entry.detail || '');
        const output = `[${time}] ${entry.title ? `${entry.title} ` : ''}${detail}\n`;
        outputBuffer += output;
        if (Buffer.byteLength(outputBuffer, 'utf8') >= FLUSH_BYTES) {
          await target.writeFile(outputBuffer, 'utf8');
          outputBuffer = '';
        }
        count += 1;
      }
      if (outputBuffer) await target.writeFile(outputBuffer, 'utf8');
      return { count };
    } finally {
      lines.close();
      input.destroy();
      await target.close();
    }
  }

  async pruneOldSessions() {
    const entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(this.rootDir, entry.name);
      if (fullPath === this.sessionDir) continue;
      const stat = await fs.promises.stat(fullPath).catch(() => null);
      if (!stat) continue;
      const files = await fs.promises.readdir(fullPath, { withFileTypes: true }).catch(() => []);
      let bytes = 0;
      let mtimeMs = stat.mtimeMs;
      for (const file of files) {
        if (!file.isFile()) continue;
        const fileStat = await fs.promises.stat(path.join(fullPath, file.name)).catch(() => null);
        bytes += fileStat?.size || 0;
        mtimeMs = Math.max(mtimeMs, fileStat?.mtimeMs || 0);
      }
      sessions.push({ fullPath, mtimeMs, bytes });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    for (const session of sessions) {
      total += session.bytes;
      if (Date.now() - session.mtimeMs > RETENTION_DAYS * 86400000 || total > RETENTION_BYTES) {
        await fs.promises.rm(session.fullPath, { recursive: true, force: true });
        total -= session.bytes;
      }
    }
  }
}

function normalizeStreamId(value) {
  const id = String(value || 'main');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid bottom log stream id');
  return id;
}

function normalizeEntry(value, seq) {
  if (!value || typeof value !== 'object') return null;
  const title = String(value.title || '');
  const detail = String(value.detail || '');
  if (!title && !detail) return null;
  return {
    seq,
    timestamp: Number.isFinite(value.timestamp) ? value.timestamp : Date.now(),
    title,
    detail,
    state: String(value.state || ''),
    mergeKey: String(value.mergeKey || ''),
  };
}

async function fileSize(filePath) {
  try { return (await fs.promises.stat(filePath)).size; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

function parseEntry(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function matches(entry, filter) {
  if (filter.errorsOnly && entry.state !== 'error') return false;
  if (!filter.keyword) return true;
  return [entry.state, entry.title, entry.detail].join('\n').replace(/\u001b\[[0-9;]*m/g, '').toLowerCase().includes(filter.keyword);
}

function displayEntry(entry) {
  const detail = String(entry.detail || '');
  const title = String(entry.title || '');
  return {
    ...entry,
    title: title.length > 1024 ? `${title.slice(0, 1023)}…` : title,
    detail: detail.length > 32768 ? `${detail.slice(0, 32767)}…` : detail,
    state: String(entry.state || '').slice(0, 64),
    mergeKey: String(entry.mergeKey || '').slice(0, 128),
    previewTruncated: title.length > 1024 || detail.length > 32768,
  };
}

async function readBackward(filePath, size, requestedOffset, limit, maxBytes, filter) {
  let position = Math.min(size, Math.max(0, Number(requestedOffset) || 0));
  const entries = [];
  let firstOffset = position;
  let returnedBytes = 0;
  let carry = Buffer.alloc(0);
  if (!position) return { entries, beforeOffset: 0, nextOffset: size, hasMore: false };
  const handle = await fs.promises.open(filePath, 'r');
  try {
    while (position > 0 && entries.length < limit) {
      const length = Math.min(READ_BLOCK_BYTES, position);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, start);
      const combined = Buffer.concat([chunk, carry]);
      let end = combined.length;
      let stop = false;
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] !== 10) continue;
        const entry = parseEntry(combined.subarray(i + 1, end).toString('utf8'));
        end = i;
        if (!entry || !matches(entry, filter)) continue;
        const shown = displayEntry(entry);
        const bytes = Buffer.byteLength(JSON.stringify(shown));
        if (entries.length && returnedBytes + bytes > maxBytes) { stop = true; break; }
        entries.push({ ...shown, offset: start + i + 1 });
        returnedBytes += bytes;
        firstOffset = start + i + 1;
        if (entries.length >= limit) { stop = true; break; }
      }
      if (stop) break;
      carry = combined.subarray(0, end);
      position = start;
    }
    if (position === 0 && carry.length && entries.length < limit) {
      const entry = parseEntry(carry.toString('utf8'));
      if (entry && matches(entry, filter)) {
        const shown = displayEntry(entry);
        if (!entries.length || returnedBytes + Buffer.byteLength(JSON.stringify(shown)) <= maxBytes) {
          entries.push({ ...shown, offset: 0 });
          firstOffset = 0;
        }
      }
    }
  } finally {
    await handle.close();
  }
  entries.reverse();
  if (!entries.length && position === 0) firstOffset = 0;
  return { entries, beforeOffset: firstOffset, nextOffset: size, hasMore: firstOffset > 0 };
}

async function readAfter(filePath, size, requestedOffset, limit, maxBytes, filter) {
  let cursor = Math.min(size, Math.max(0, Number(requestedOffset) || 0));
  const entries = [];
  let returnedBytes = 0;
  if (cursor >= size) return { entries, nextOffset: size, beforeOffset: cursor, hasMore: false };
  const handle = await fs.promises.open(filePath, 'r');
  let carry = Buffer.alloc(0);
  let position = cursor;
  try {
    while (position < size) {
      const length = Math.min(READ_BLOCK_BYTES, size - position);
      const chunk = Buffer.allocUnsafe(length);
      await handle.read(chunk, 0, length, position);
      const base = position - carry.length;
      const combined = Buffer.concat([carry, chunk]);
      let start = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] !== 10) continue;
        const endOffset = base + i + 1;
        const entryOffset = base + start;
        const entry = parseEntry(combined.subarray(start, i).toString('utf8'));
        start = i + 1;
        if (entry && matches(entry, filter)) {
          const shown = displayEntry(entry);
          const bytes = Buffer.byteLength(JSON.stringify(shown));
          if (entries.length && returnedBytes + bytes > maxBytes) {
            return { entries, nextOffset: cursor, beforeOffset: requestedOffset, hasMore: true };
          }
          entries.push({ ...shown, offset: entryOffset });
          returnedBytes += bytes;
        }
        cursor = endOffset;
        if (entries.length >= limit) {
          return { entries, nextOffset: cursor, beforeOffset: requestedOffset, hasMore: cursor < size };
        }
      }
      carry = combined.subarray(start);
      position += length;
    }
  } finally {
    await handle.close();
  }
  return { entries, nextOffset: cursor, beforeOffset: requestedOffset, hasMore: cursor < size };
}

function cleanExportText(value) {
  const stripped = String(value).replace(/\u001b\[[0-9;]*m/g, '');
  const characters = [];
  for (const character of stripped) {
    if (character === '\b') {
      if (characters.length && characters.at(-1) !== '\n' && characters.at(-1) !== '\r') characters.pop();
    } else {
      characters.push(character);
    }
  }
  return characters.join('').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/^\s*\[(ERROR|INFO|WARN|WARNING|DEBUG|TRACE|FATAL)\]\s*/gim, '');
}

module.exports = { BottomLogJournal };
