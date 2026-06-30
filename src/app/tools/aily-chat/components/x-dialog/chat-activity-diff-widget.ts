import type { StateDetailOutputGroup, StateDetailRow } from './x-aily-state-viewer/activity-detail-items';

export interface DiffDisplayLine {
  id: string;
  kind: 'context' | 'add' | 'delete';
  marker: ' ' | '+' | '-';
  text: string;
  leftLine?: number;
  rightLine?: number;
}

export interface DiffDisplayHunk {
  id: string;
  header: string;
  lines: readonly DiffDisplayLine[];
  addedCount: number;
  removedCount: number;
}

export interface DiffDisplayFile {
  id: string;
  title: string;
  subtitle?: string;
  href?: string;
  language?: string;
  addedCount: number;
  removedCount: number;
  hunks: readonly DiffDisplayHunk[];
}

export function isDiffOutputRow(row: StateDetailRow): boolean {
  return row.outputKind === 'code' && row.outputMimeType === 'text/x-diff';
}

export function getDiffOutputHref(row: StateDetailRow): string | null {
  return row.outputKind === 'code' && row.outputUri ? row.outputUri : null;
}

export function isGroupedDiffOutputGroup(group: StateDetailOutputGroup): boolean {
  return group.kind === 'code' && group.rows.length > 0 && group.rows.every(isDiffOutputRow);
}

export function getGroupedDiffFiles(rows: readonly StateDetailRow[]): readonly DiffDisplayFile[] {
  return rows
    .filter(isDiffOutputRow)
    .map((row) => {
      const lines = getDiffDisplayLines(row);
      return {
        id: row.id,
        title: row.title,
        subtitle: row.subtitle,
        href: getDiffOutputHref(row) || undefined,
        language: row.outputLanguage,
        addedCount: lines.filter((line) => line.kind === 'add').length,
        removedCount: lines.filter((line) => line.kind === 'delete').length,
        hunks: buildDiffHunks(row.id, lines),
      };
    });
}

export function getDiffDisplayLines(row: StateDetailRow): readonly DiffDisplayLine[] {
  if (!isDiffOutputRow(row) || !row.outputCode) {
    return [];
  }

  let leftLine = 1;
  let rightLine = 1;

  return row.outputCode.split('\n').map((line, index) => {
    if (line.startsWith('+ ')) {
      const rendered: DiffDisplayLine = {
        id: `${row.id}:diff:${index}`,
        kind: 'add',
        marker: '+',
        text: line.slice(2),
        rightLine,
      };
      rightLine += 1;
      return rendered;
    }

    if (line.startsWith('- ')) {
      const rendered: DiffDisplayLine = {
        id: `${row.id}:diff:${index}`,
        kind: 'delete',
        marker: '-',
        text: line.slice(2),
        leftLine,
      };
      leftLine += 1;
      return rendered;
    }

    const text = line.startsWith('  ') ? line.slice(2) : line;
    const rendered: DiffDisplayLine = {
      id: `${row.id}:diff:${index}`,
      kind: 'context',
      marker: ' ',
      text,
      leftLine,
      rightLine,
    };
    leftLine += 1;
    rightLine += 1;
    return rendered;
  });
}

function buildDiffHunks(rowId: string, lines: readonly DiffDisplayLine[]): readonly DiffDisplayHunk[] {
  const changedIndices = lines
    .map((line, index) => line.kind !== 'context' ? index : -1)
    .filter((index) => index >= 0);

  if (changedIndices.length === 0) {
    return [{
      id: `${rowId}:hunk:0`,
      header: '@@ -1,0 +1,0 @@',
      lines,
      addedCount: 0,
      removedCount: 0,
    }];
  }

  const contextRadius = 2;
  const windows: Array<{ start: number; end: number }> = [];
  for (const index of changedIndices) {
    const start = Math.max(0, index - contextRadius);
    const end = Math.min(lines.length - 1, index + contextRadius);
    const previous = windows[windows.length - 1];
    if (!previous || start > previous.end) {
      windows.push({ start, end });
    } else {
      previous.end = Math.max(previous.end, end);
    }
  }

  return windows.map((window, index) => {
    const hunkLines = lines.slice(window.start, window.end + 1);
    return {
      id: `${rowId}:hunk:${index}`,
      header: formatHunkHeader(hunkLines),
      lines: hunkLines,
      addedCount: hunkLines.filter((line) => line.kind === 'add').length,
      removedCount: hunkLines.filter((line) => line.kind === 'delete').length,
    };
  });
}

function formatHunkHeader(lines: readonly DiffDisplayLine[]): string {
  const leftNumbers = lines.map((line) => line.leftLine).filter((value): value is number => typeof value === 'number');
  const rightNumbers = lines.map((line) => line.rightLine).filter((value): value is number => typeof value === 'number');
  const leftStart = leftNumbers[0] ?? 1;
  const rightStart = rightNumbers[0] ?? 1;
  return `@@ -${leftStart},${leftNumbers.length} +${rightStart},${rightNumbers.length} @@`;
}