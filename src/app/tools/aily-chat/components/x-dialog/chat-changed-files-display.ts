import { isChangedFilesToolName as isNormalizedChangedFilesToolName } from '../../core/tool-name-normalizer';

export type ChangedFilesTone = 'info' | 'success' | 'warn' | 'error' | 'neutral';

export interface ChangedFileDisplayEntry {
  path: string;
  name: string;
  directory?: string;
  previousPath?: string;
  statusCode: string;
  statusBadge: string;
  statusLabel: string;
  tone: ChangedFilesTone;
}

export interface ChangedFilesDisplaySummary {
  label: string;
  subtitle?: string;
}

export function isChangedFilesToolName(toolName: string | undefined): boolean {
  return isNormalizedChangedFilesToolName(toolName);
}

export function collectChangedFilesEntriesFromToolMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ChangedFileDisplayEntry[] {
  const record = asRecord(metadata);
  if (!record) {
    return [];
  }

  const timeline = asRecordArray(record['timeline']);
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entries = collectChangedFilesEntriesFromToolResultEntry(timeline[index]);
    if (entries.length > 0) {
      return entries;
    }
  }

  return collectChangedFilesEntriesFromToolResultEntry(record);
}

export function collectChangedFilesEntriesFromToolResultEntry(
  entry: Record<string, unknown> | null | undefined,
): ChangedFileDisplayEntry[] {
  const record = asRecord(entry);
  if (!record) {
    return [];
  }

  const candidates = [
    getStructuredResultText(record['resultContent']),
    asString(record['resultText']),
    asString(asRecord(record['toolSpecificData'])?.['result']),
  ].filter((value): value is string => !!value?.trim());

  for (const candidate of candidates) {
    const entries = parseChangedFilesOutput(candidate);
    if (entries.length > 0) {
      return entries;
    }
  }

  return [];
}

export function parseChangedFilesOutput(text: string | undefined): ChangedFileDisplayEntry[] {
  const normalized = asString(text)?.trim();
  if (!normalized || /^no changes found\.?$/i.test(normalized)) {
    return [];
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const entries: ChangedFileDisplayEntry[] = [];
  for (const line of lines) {
    const entry = parseChangedFilesLine(line);
    if (!entry) {
      return [];
    }
    entries.push(entry);
  }

  return entries;
}

export function buildChangedFilesDisplaySummary(
  entries: readonly ChangedFileDisplayEntry[],
): ChangedFilesDisplaySummary | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const primary = entries[0];
  const primaryName = primary.name || primary.path;

  return {
    label: entries.length === 1 ? 'Changed File' : `Changed Files (${entries.length})`,
    subtitle: entries.length === 1 ? primaryName : `${primaryName} +${entries.length - 1} more`,
  };
}

function parseChangedFilesLine(line: string): ChangedFileDisplayEntry | undefined {
  const tabParts = line.split('\t');
  let rawStatus = '';
  let rawPaths: string[] = [];

  if (tabParts.length >= 2) {
    rawStatus = tabParts[0].trim();
    rawPaths = tabParts.slice(1).map((part) => part.trim()).filter(Boolean);
  } else {
    const match = /^([^\s]+)\s+(.+)$/.exec(line);
    if (!match) {
      return undefined;
    }

    rawStatus = match[1].trim();
    rawPaths = [match[2].trim()];
  }

  if (!rawStatus || rawPaths.length === 0) {
    return undefined;
  }

  const status = normalizeChangedFileStatus(rawStatus);
  if (!status) {
    return undefined;
  }

  let currentPath = normalizePath(rawPaths[rawPaths.length - 1]);
  let previousPath: string | undefined;

  if (status.kind === 'renamed' || status.kind === 'copied') {
    if (rawPaths.length >= 2) {
      previousPath = normalizePath(rawPaths[0]);
    } else {
      const renamePair = parseRenameTarget(currentPath);
      if (renamePair) {
        previousPath = renamePair.from;
        currentPath = renamePair.to;
      }
    }
  }

  if (!currentPath) {
    return undefined;
  }

  const { name, directory } = splitPath(currentPath);
  return {
    path: currentPath,
    name,
    directory,
    previousPath,
    statusCode: rawStatus,
    statusBadge: status.badge,
    statusLabel: status.label,
    tone: status.tone,
  };
}

function parseRenameTarget(value: string): { from: string; to: string } | undefined {
  const match = /^(.+?)\s+->\s+(.+)$/.exec(value);
  if (!match) {
    return undefined;
  }

  const from = normalizePath(match[1]);
  const to = normalizePath(match[2]);
  if (!from || !to) {
    return undefined;
  }

  return { from, to };
}

function normalizeChangedFileStatus(rawStatus: string): {
  badge: string;
  label: string;
  tone: ChangedFilesTone;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict';
} | undefined {
  const trimmed = rawStatus.trim();
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();

  if (upper === '??' || lower.includes('untracked')) {
    return { badge: '??', label: '未跟踪', tone: 'info', kind: 'untracked' };
  }

  if (upper.includes('U') || lower.includes('conflict')) {
    return { badge: upper.replace(/[^A-Z?]/g, '').slice(0, 2) || 'U', label: '冲突', tone: 'warn', kind: 'conflict' };
  }

  if (upper.startsWith('A') || lower.startsWith('add')) {
    return { badge: 'A', label: '已新增', tone: 'success', kind: 'added' };
  }

  if (upper.startsWith('M') || lower.startsWith('modif')) {
    return { badge: 'M', label: '已修改', tone: 'info', kind: 'modified' };
  }

  if (upper.startsWith('D') || lower.startsWith('delet') || lower.startsWith('remov')) {
    return { badge: 'D', label: '已删除', tone: 'error', kind: 'deleted' };
  }

  if (upper.startsWith('R') || lower.startsWith('renam')) {
    return { badge: 'R', label: '已重命名', tone: 'info', kind: 'renamed' };
  }

  if (upper.startsWith('C') || lower.startsWith('cop')) {
    return { badge: 'C', label: '已复制', tone: 'info', kind: 'copied' };
  }

  return undefined;
}

function splitPath(path: string): { name: string; directory?: string } {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  const name = segments.pop() || normalized;
  const directory = segments.join('/') || undefined;
  return { name, directory };
}

function normalizePath(path: string): string {
  return path.replace(/\\+/g, '/').trim();
}

function getStructuredResultText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const texts = value
    .map((part) => asRecord(part))
    .map((part) => asString(part?.['text']))
    .filter((text): text is string => !!text?.trim());

  return texts.length > 0 ? texts.join('\n') : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!asRecord(item))
    : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}