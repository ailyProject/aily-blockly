import { absJson, indexAbsSyntax } from './abs-identity-map';
import { inspectAbsSourceEdits, type AbsSourceEdit } from './abs-edit-provenance';
import { samePreservedAbsCall } from './abs-native-preservation';
import { parseAbsSyntax } from './abs-syntax';
import { absSyntaxOptions } from './abs-syntax-contracts';
import type { AbsProjection } from './abs-state';

/** Called only for the exact input of this baseline's verified accepted
 * generation. Equivalent syntax may differ in formatting, never in program
 * structure, field/reference values or protected metadata. No call-name token
 * is replaced, so subsequent tracked edits retain each original identity. */
export function acceptedInputFormattingEdits(baseline: AbsProjection, input: string): AbsSourceEdit[] | undefined {
  try {
    const options = absSyntaxOptions(baseline.workspace, baseline.contracts);
    const original = parseAbsSyntax(baseline.abs, options), authored = parseAbsSyntax(input, options);
    const before = indexAbsSyntax(original), after = indexAbsSyntax(authored);
    if (before.length !== after.length) return undefined;
    const byPath = new Map(after.map(entry => [entry.path, entry]));
    const pairs = before.map(entry => ({ before: entry, after: byPath.get(entry.path) }));
    for (const pair of pairs) {
      const old = pair.before, next = pair.after;
      if (!next || old.parent !== next.parent || old.slot !== next.slot || !samePreservedAbsCall(old.node, next.node)
        || absJson({ protection: old.node.protection ?? null, comment: old.node.comment ?? null, shadowFields: old.node.shadowFields ?? null,
          inputs: Object.keys(old.node.inputs).sort(), next: !!old.node.next,
          omitted: Object.entries(old.node.fields).filter(([, token]) => token.omitted).map(([name]) => name).sort() })
          !== absJson({ protection: next.node.protection ?? null, comment: next.node.comment ?? null, shadowFields: next.node.shadowFields ?? null,
            inputs: Object.keys(next.node.inputs).sort(), next: !!next.node.next,
            omitted: Object.entries(next.node.fields).filter(([, token]) => token.omitted).map(([name]) => name).sort() })) return undefined;
    }
    pairs.sort((a, b) => a.before.node.start - b.before.node.start);
    const edits: AbsSourceEdit[] = [];
    let previous = 0, current = 0;
    const gap = (end: number, nextEnd: number) => {
      const text = input.slice(current, nextEnd);
      if (baseline.abs.slice(previous, end) !== text) edits.push({ start: previous, end, text });
    };
    for (const pair of pairs) {
      const old = pair.before.node, next = pair.after!.node;
      if (old.start < previous || next.start < current || baseline.abs.slice(old.start, old.start + old.type.length) !== old.type
        || input.slice(next.start, next.start + next.type.length) !== next.type) return undefined;
      gap(old.start, next.start);
      previous = old.start + old.type.length; current = next.start + next.type.length;
    }
    gap(baseline.abs.length, input.length);
    if (!edits.length) return undefined;
    const replay = inspectAbsSourceEdits(baseline.abs, input, original, authored, [edits]);
    return replay.matches.size === before.length ? edits : undefined;
  } catch {
    // Unknown syntax or an incomplete mapping grants no edit provenance.
    return undefined;
  }
}
