import { linesDiffComputers } from 'monaco-editor/esm/vs/editor/common/diff/linesDiffComputers.js';
import type { DetailedLineRangeMapping, RangeMapping } from 'monaco-editor/esm/vs/editor/common/diff/rangeMapping.js';
import type { MovedText } from 'monaco-editor/esm/vs/editor/common/diff/linesDiffComputer.js';
import type {
  EditingTextCharChange,
  EditingTextDiffOptions,
  EditingTextDiffResult,
  EditingTextLineChange,
  EditingTextMove,
} from './editing-text-diff.types';

export function computeTextDiffSync(
  original: string,
  modified: string,
  options: EditingTextDiffOptions,
): EditingTextDiffResult {
  const diffComputer = linesDiffComputers.getDefault();
  const result = diffComputer.computeDiff(splitLines(original), splitLines(modified), options);

  return {
    identical: result.changes.length === 0 ? original === modified : false,
    quitEarly: result.hitTimeout,
    changes: serializeLineChanges(result.changes),
    moves: result.moves.map(serializeMove),
  };
}

function splitLines(value: string): string[] {
  return value.split(/\r\n|\r|\n/);
}

function serializeMove(move: MovedText): EditingTextMove {
  return {
    originalStartLineNumber: move.lineRangeMapping.original.startLineNumber,
    originalEndLineNumberExclusive: move.lineRangeMapping.original.endLineNumberExclusive,
    modifiedStartLineNumber: move.lineRangeMapping.modified.startLineNumber,
    modifiedEndLineNumberExclusive: move.lineRangeMapping.modified.endLineNumberExclusive,
    changes: serializeLineChanges(move.changes),
  };
}

function serializeLineChanges(changes: readonly DetailedLineRangeMapping[]): EditingTextLineChange[] {
  return changes.map(change => ({
    originalStartLineNumber: change.original.startLineNumber,
    originalEndLineNumberExclusive: change.original.endLineNumberExclusive,
    modifiedStartLineNumber: change.modified.startLineNumber,
    modifiedEndLineNumberExclusive: change.modified.endLineNumberExclusive,
    ...(change.innerChanges ? { charChanges: change.innerChanges.map(serializeCharChange) } : {}),
  }));
}

function serializeCharChange(change: RangeMapping): EditingTextCharChange {
  return {
    originalStartLineNumber: change.originalRange.startLineNumber,
    originalStartColumn: change.originalRange.startColumn,
    originalEndLineNumber: change.originalRange.endLineNumber,
    originalEndColumn: change.originalRange.endColumn,
    modifiedStartLineNumber: change.modifiedRange.startLineNumber,
    modifiedStartColumn: change.modifiedRange.startColumn,
    modifiedEndLineNumber: change.modifiedRange.endLineNumber,
    modifiedEndColumn: change.modifiedRange.endColumn,
  };
}