import { absJson, indexAbsSyntax } from './abs-identity-map';
import { inspectAbsSourceEdits, type AbsSourceEdit, type AbsSourceEditOrigin } from './abs-edit-provenance';
import { samePreservedAbsCall } from './abs-native-preservation';
import { parseAbsSyntax, readAbsSyntax } from './abs-syntax';
import { bindAbsSyntax, walkAbsRawSyntax } from './abs-syntax-binding';
import { absSyntaxOptions } from './abs-syntax-contracts';
import { prepareAbsStructuralSyntax } from './abs-structural-syntax';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import type { AbsProjection } from './abs-state';

/** Called only for a verified accepted input. The same program can use different
 * spelling. Its original identities are usable only when the full trees agree. */
export function acceptedInputEditProof(baseline: AbsProjection, input: string,
  blockContract?: (type: string) => AbsBlockShapeContract | undefined): AbsSourceEdit[] | AbsSourceEditOrigin | undefined {
  try {
    const shapes = new Map<string, AbsBlockShapeContract | undefined>();
    const options = absSyntaxOptions(baseline.workspace, baseline.contracts, {
      prepareExtraState: node => {
        if (!shapes.has(node.type)) shapes.set(node.type, blockContract?.(node.type));
        const shape = shapes.get(node.type);
        return prepareAbsStructuralSyntax(node, shape?.mutation, shape?.argumentOrder);
      },
    });
    const raw = readAbsSyntax(input);
    const original = parseAbsSyntax(baseline.abs, options), authored = bindAbsSyntax(raw, options);
    const before = indexAbsSyntax(original), after = indexAbsSyntax(authored);
    if (before.length !== after.length) return undefined;
    const byPath = new Map(after.map(entry => [entry.path, entry]));
    const ids = new Map(baseline.map.nodes.map(node => [node.start, node.blockId]));
    const pairs = before.map(entry => ({ before: entry, after: byPath.get(entry.path) }));
    for (const pair of pairs) {
      const old = pair.before, next = pair.after;
      const id = ids.get(old.node.start);
      const knownInputs = new Set((id ? baseline.contracts.syntax?.[id] : undefined)
        ?.filter(arg => arg.kind !== 'field').map(arg => arg.name));
      // Omitted and explicitly empty declared inputs both have no connection.
      const occupiedInputs = (node: typeof old.node) => Object.keys(node.inputs)
        .filter(name => node.inputs[name] !== null || !knownInputs.has(name)).sort();
      if (!next || old.parent !== next.parent || old.slot !== next.slot
        || !samePreservedAbsCall(old.node, next.node, id ? baseline.contracts.fields[id] : undefined)
        || absJson({ protection: old.node.protection ?? null, comment: old.node.comment ?? null, shadowFields: old.node.shadowFields ?? null,
          inputs: occupiedInputs(old.node), next: !!old.node.next,
          omitted: Object.entries(old.node.fields).filter(([, token]) => token.omitted).map(([name]) => name).sort() })
          !== absJson({ protection: next.node.protection ?? null, comment: next.node.comment ?? null, shadowFields: next.node.shadowFields ?? null,
            inputs: occupiedInputs(next.node), next: !!next.node.next,
            omitted: Object.entries(next.node.fields).filter(([, token]) => token.omitted).map(([name]) => name).sort() })) return undefined;
    }
    pairs.sort((a, b) => a.before.node.start - b.before.node.start);
    const rawCalls = new Map([...walkAbsRawSyntax(raw)].map(({ node }) => [node.start, node]));
    const anchors: AbsSourceEditOrigin['anchors'] = [];
    const edits: AbsSourceEdit[] = [];
    let previous = 0, current = 0, changedToken = false;
    const gap = (end: number, nextEnd: number) => {
      const text = input.slice(current, nextEnd);
      if (baseline.abs.slice(previous, end) !== text) edits.push({ start: previous, end, text });
    };
    for (const pair of pairs) {
      const old = pair.before.node, next = pair.after!.node;
      const call = rawCalls.get(next.start);
      // The binder expands value shorthands from one token, with no raw call.
      const end = call ? next.start + call.type.length : next.end;
      if (old.start < previous || next.start < current || end <= next.start || end > input.length
        || baseline.abs.slice(old.start, old.start + old.type.length) !== old.type) return undefined;
      gap(old.start, next.start);
      anchors.push({ originalStart: old.start, start: next.start, end });
      changedToken ||= call?.type !== next.type;
      previous = old.start + old.type.length; current = end;
    }
    // A literal or alias has no unchanged canonical token to carry from the
    // frozen text. Start the exact edit replay at its verified authored token.
    if (changedToken) return { source: input, anchors };
    gap(baseline.abs.length, input.length);
    if (!edits.length) return undefined;
    const replay = inspectAbsSourceEdits(baseline.abs, input, original, authored, [edits]);
    return replay.matches.size === before.length ? edits : undefined;
  } catch {
    // Unknown syntax or an incomplete mapping grants no edit provenance.
    return undefined;
  }
}
