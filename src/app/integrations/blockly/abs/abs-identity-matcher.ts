import { absJson, fingerprintAbsNodes, indexAbsSyntax } from './abs-identity-map';
import { inspectAbsSourceEdits, type AbsSourceEdits } from './abs-edit-provenance';
import { AbsSyncError, type AbsSyntaxNode } from './abs-state';

type Node = AbsSyntaxNode;
const chain = (head: Node | null | undefined): Node[] => {
  const result: Node[] = [];
  for (let node = head; node; node = node.next) result.push(node);
  return result;
};
function group<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item), values = result.get(id);
    if (values) values.push(item); else result.set(id, [item]);
  }
  return result;
}

/** Identity is independent of placement. Only exact evidence may cross owners;
 * type-only updates remain scoped to already matched owners. No ABI/UI access. */
export async function matchAbsIdentities(beforeText: string, afterText: string,
  original: Node[], edited: Node[], sourceEdits?: AbsSourceEdits,
  requiresIdentity: (node: Node) => boolean = () => false): Promise<ReadonlyMap<Node, Node>> {
  const oldNodes = indexAbsSyntax(original).map(entry => entry.node);
  const newNodes = indexAbsSyntax(edited).map(entry => entry.node);
  const signatures = new Map<Node, string>();
  for (const roots of [original, edited]) {
    const entries = indexAbsSyntax(roots), fingerprints = await fingerprintAbsNodes(entries);
    const byNode = new Map(entries.map(entry => [entry.node, fingerprints.get(entry.path)!]));
    for (const { node } of entries) signatures.set(node, absJson({
      type: node.type, fields: Object.fromEntries(Object.entries(node.fields).map(([name, token]) => [name, token.value])),
      disabled: node.disabled,
      ...(Object.hasOwn(node, 'extraState') ? { extraState: node.extraState } : {}),
      inputs: Object.fromEntries(Object.keys(node.inputs).sort().map(name => [name,
        node.inputs[name] ? byNode.get(node.inputs[name]!) : null])),
    }));
  }
  const signature = (node: Node) => signatures.get(node)!;
  const matches = new Map<Node, Node>(), used = new Set<Node>();
  const match = (before: Node, after: Node) => {
    if (matches.get(after) === before) return;
    if (used.has(before) || matches.has(after) || before.type !== after.type) {
      throw new AbsSyncError('ABS_IDENTITY_AMBIGUOUS', 'Identity matched more than once.', after);
    }
    used.add(before); matches.set(after, before);
  };
  const evidence = inspectAbsSourceEdits(beforeText, afterText, original, edited, sourceEdits);
  for (const [after, before] of evidence.matches) match(before, after);

  const pairs = (): Array<[Node[], Node[]]> => {
    const result: Array<[Node[], Node[]]> = [[original, edited]];
    for (const [after, before] of matches) {
      for (const name of new Set([...Object.keys(before.inputs), ...Object.keys(after.inputs)])) {
        result.push([chain(before.inputs[name]), chain(after.inputs[name])]);
      }
      if (original.includes(before) && edited.includes(after)) result.push([chain(before.next), chain(after.next)]);
    }
    return result;
  };
  const pending = (before: Node[], after: Node[]): [Node[], Node[]] =>
    [before.filter(node => !used.has(node)), after.filter(node => !matches.has(node))];
  const exact = (before: Node[], after: Node[], ordered: boolean, firstOnly = false) => {
    [before, after] = pending(before, after);
    if (ordered && before.length === after.length && before.every((node, i) => signature(node) === signature(after[i]))) {
      before.forEach((node, i) => match(node, after[i]));
      return;
    }
    const old = group(before, signature), current = group(after, signature);
    for (const [key, nodes] of current) {
      const previous = old.get(key);
      if (nodes.length === 1 && previous?.length === 1) {
        match(previous[0], nodes[0]);
        if (firstOnly) return;
      }
    }
  };
  const allGroups = (roots: Node[], nodes: Node[]) => [roots, ...roots.map(node => chain(node.next)),
    ...nodes.flatMap(node => Object.values(node.inputs).map(chain))];
  const oldGroups = allGroups(original, oldNodes), newGroups = allGroups(edited, newNodes);
  const sequenceKey = (nodes: Node[]) => absJson(nodes.map(signature));
  const exactSequences = () => {
    const old = group(oldGroups.filter(nodes => nodes.length > 1 && nodes.every(node => !used.has(node))), sequenceKey);
    const current = group(newGroups.filter(nodes => nodes.length > 1 && nodes.every(node => !matches.has(node))), sequenceKey);
    for (const [key, nodes] of current) {
      const previous = old.get(key);
      if (nodes.length === 1 && previous?.length === 1
        && nodes[0].every(node => !matches.has(node)) && previous[0].every(node => !used.has(node))) {
        previous[0].forEach((node, i) => match(node, nodes[0][i]));
      }
    }
  };
  // Owner-local edits take precedence over relocation. After matching a moved
  // parent, settle its children before considering unrelated global leaf matches.
  while (true) {
    let size: number;
    do {
      size = matches.size;
      for (const [before, after] of pairs()) exact(before, after, true);
      for (const pair of pairs()) {
        const [before, after] = pending(...pair), old = group(before, node => node.type), current = group(after, node => node.type);
        for (const [type, nodes] of current) {
          const previous = old.get(type);
          if (nodes.length === 1 && previous?.length === 1) match(previous[0], nodes[0]);
        }
      }
    } while (matches.size !== size);
    size = matches.size;
    exactSequences();
    if (matches.size !== size) continue;
    exact(oldNodes, newNodes, false, true);
    if (matches.size === size) break;
  }
  const ambiguous = (node: Node, reason: string, before: Node[], after: Node[]): never => {
    const range = (node: Node) => ({ start: node.start, end: node.start + node.type.length });
    const replaced = before.filter(node => evidence.replaced.has(node));
    const detail = !sourceEdits ? 'No hash-bound edit history is available.'
      : replaced.length ? 'Recorded edits replaced baseline call-name tokens.'
      : 'Tracked edits do not distinguish these remaining calls.';
    throw new AbsSyncError('ABS_IDENTITY_AMBIGUOUS', 'Cannot safely preserve protected or non-reconstructible state for these calls.', node, [], {
      blockType: node.type, reason, received: before.length,
      identity: {
        evidence: sourceEdits ? 'tracked' : 'missing', batches: sourceEdits?.length ?? 0,
        edits: sourceEdits?.reduce((n, batch) => n + batch.length, 0) ?? 0,
        baselineCount: before.length, candidateCount: after.length,
        baselineRanges: before.slice(0, 8).map(range), candidateRanges: after.slice(0, 8).map(range),
        replacedBaselineRanges: replaced.slice(0, 8).map(range),
      },
      ...(Math.max(before.length, after.length) > 8 ? { truncated: true } : {}),
      hint: `${detail} Keep draft/generation. Do not change literals or apply interim deletions. Preserve stateful call tokens or clarify hidden state before retrying; block_info cannot resolve identity.`,
    });
  };
  for (const pair of pairs()) {
    const [before, after] = pending(...pair), old = group(before, node => node.type);
    for (const node of after) if (old.get(node.type)?.some(requiresIdentity)) ambiguous(node, 'repeated-owner-calls', old.get(node.type)!, after.filter(item => item.type === node.type));
  }
  const old = group(oldNodes.filter(node => !used.has(node)), signature);
  for (const node of newNodes) {
    if (!matches.has(node) && old.get(signature(node))?.some(requiresIdentity)) ambiguous(node, 'indistinguishable-relocation', old.get(signature(node))!,
      newNodes.filter(item => !matches.has(item) && signature(item) === signature(node)));
  }
  // An unmatched owner can also hide changed descendants. Do not bypass their
  // state policy merely because the owner's identity was not retained.
  const remaining = group(oldNodes.filter(node => !used.has(node)), node => node.type);
  for (const node of newNodes) if (!matches.has(node) && remaining.get(node.type)?.some(requiresIdentity)) {
    ambiguous(node, 'unresolved-stateful-calls', remaining.get(node.type)!,
      newNodes.filter(item => !matches.has(item) && item.type === node.type));
  }
  // Unmatched ordinary content is deletion + creation within ONE transaction.
  // Protected deletion, scope and native connection checks remain downstream.
  return matches;
}
