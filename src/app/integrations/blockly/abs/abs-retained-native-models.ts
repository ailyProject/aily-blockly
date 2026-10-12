import { readAbsSyntax } from './abs-syntax';
import { walkAbsRawSyntax, type AbsRawNode } from './abs-syntax-binding';

/** Exact unchanged producer subtrees only. Counts must also match: adding an
 * identical initializer cannot borrow another producer's retained authority.
 * This is transaction-local evidence from the committed ABS, never user input. */
export function retainedAbsNativeModelCalls(baseline: string, source: string, syntax: AbsRawNode[]): number[] {
  const group = (text: string, roots: AbsRawNode[]) => {
    const groups = new Map<string, number[]>();
    for (const { node } of walkAbsRawSyntax(roots)) {
      const key = text.slice(node.start, node.end);
      const starts = groups.get(key) ?? [];
      starts.push(node.start); groups.set(key, starts);
    }
    return groups;
  };
  const previous = group(baseline, readAbsSyntax(baseline));
  return [...group(source, syntax)].flatMap(([text, starts]) =>
    previous.get(text)?.length === starts.length ? starts : []);
}
