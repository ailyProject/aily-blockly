import type { AbsProjection } from './abs-state';
import { AbsSyntaxAdviceIndex } from './abs-syntax-advice';

export interface AbsBlockContext { snippet: string; lineRange: string; generation: string }

/** Read-only view of a committed ABS/map pair. Never re-renders ABI or guesses an ID. */
export class AbsBlockContextIndex {
  private readonly nodes: Map<string, { start: number; end: number }>;
  private readonly source: string;
  private readonly generation: string;
  private readonly syntax: AbsSyntaxAdviceIndex;

  constructor(projection: AbsProjection) {
    this.source = projection.abs;
    this.generation = projection.map.generation;
    this.nodes = new Map(projection.map.nodes.map(node => [node.blockId, { start: node.start, end: node.end }]));
    this.syntax = new AbsSyntaxAdviceIndex(projection.workspace, projection.contracts,
      projection.map.nodes.map(node => ({ id: node.blockId, start: node.start })));
  }

  describeSyntax(types: readonly string[]) {
    return { scope: 'current-workspace' as const, generation: this.generation, ...this.syntax.describe(types) };
  }

  get(blockId: string): AbsBlockContext | undefined {
    const node = this.nodes.get(blockId);
    if (!node || node.start < 0 || node.end <= node.start || node.end > this.source.length) return undefined;
    const text = this.source.slice(node.start, node.end).trimEnd();
    const startLine = this.source.slice(0, node.start).split('\n').length;
    const endLine = startLine + text.split('\n').length - 1;
    return { snippet: truncateAbsContext(text), generation: this.generation,
      lineRange: startLine === endLine ? `${startLine}` : `${startLine}-${endLine}` };
  }
}

/** Context is a preview, not an editable candidate. Bound both lines and single-line data. */
export function truncateAbsContext(source: string): string {
  const lines = source.split('\n');
  const preview = (lines.length <= 6 ? lines : [...lines.slice(0, 3),
    `    ... (${lines.length - 6} lines omitted)`, ...lines.slice(-3)]).join('\n');
  return preview.length <= 2000 ? preview : `${preview.slice(0, 1500)}\n... (preview truncated)\n${preview.slice(-400)}`;
}
