import { absJson } from './abs-json';
import { AbsProjection, AbsAbiBlock, AbsSyntaxNode, AbsSyncError, getAbsFieldDefinition } from './abs-state';
import { AbsSymbols } from './abs-symbols';

/** Matching and retention are different questions. An ordinary serialized block
 * can be rebuilt from ABS; an opaque payload or a referenced identity cannot.
 * This policy knows serialization contracts, never library/block-type names. */
export function absIdentityPolicy(baseline: AbsProjection, ids: ReadonlyMap<AbsSyntaxNode, string>,
  blocks: ReadonlyMap<string, AbsAbiBlock>) {
  const referenced = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { if (blocks.has(value)) referenced.add(value); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const record = value as Record<string, unknown>;
    const definition = typeof record['id'] === 'string' && blocks.get(record['id'])?.type === record['type'];
    for (const [key, child] of Object.entries(record)) {
      if (definition && (key === 'id' || key === 'type')) continue;
      if (definition && key === 'fields' && child && typeof child === 'object') {
        for (const [name, field] of Object.entries(child)) {
          const contract = getAbsFieldDefinition(baseline.contracts, record['id'] as string, name);
          // A declared text/enum value is a literal, not a block reference merely
          // because the user chose a short ID with the same spelling.
          if (typeof field !== 'object' && contract && !contract.symbol
            && ['field_input', 'field_number', 'field_checkbox', 'field_dropdown'].includes(contract.type)) continue;
          visit(field);
        }
      } else visit(child);
    }
  };
  visit(baseline.document);
  const symbols = new AbsSymbols(baseline.workspace, baseline.document, baseline.contracts);
  const required = new Set<AbsSyntaxNode>();
  for (const [node, id] of ids) {
    const block = blocks.get(id)!;
    const hidden = Object.entries(block).some(([key, value]) => {
      if (['type', 'id', 'fields', 'inputs', 'next', 'extraState', 'x', 'y', 'collapsed', 'inline'].includes(key)) return false;
      if (['deletable', 'movable', 'editable', 'enabled'].includes(key)) return value !== true;
      if (key === 'disabled') return value !== false;
      if (key === 'disabledReasons') return !Array.isArray(value) || value.length !== 0;
      return true;
    });
    const hiddenFields = Object.entries(block.fields ?? {}).some(([name, value]) => {
      const token = node.fields[name];
      if (!token) return true;
      const symbol = getAbsFieldDefinition(baseline.contracts, id, name)?.symbol;
      // Re-resolve without the previous payload: only fully reconstructible model
      // references may acquire a new block ID. Model IDs themselves never change.
      try { return absJson(symbol ? symbols.resolve(token, symbol) : token.value) !== absJson(value); }
      catch { return true; }
    });
    const hiddenConnections = Object.values(block.inputs ?? {}).some(input =>
      !!(input.block && input.shadow) || Object.keys(input).some(key => key !== 'block' && key !== 'shadow'))
      || Object.keys(block.next ?? {}).some(key => key !== 'block');
    if (hidden || hiddenFields || hiddenConnections || node.disabled || referenced.has(id)
      || !!baseline.contracts.procedures?.[id]
      || absJson(block.extraState ?? null) !== absJson(node.extraState ?? null)) required.add(node);
  }
  return {
    requiresIdentity: (node: AbsSyntaxNode) => required.has(node),
    assertReferencesPreserved(candidate: ReadonlyMap<string, AbsAbiBlock>) {
      // Dormant shadows have no ABS node but can still retain their identity.
      const missing = [...referenced].filter(id => !candidate.has(id));
      if (missing.length) throw new AbsSyncError('ABS_REFERENCED_BLOCK_MISSING',
        'A block identity referenced by serialized project state cannot be deleted or recreated implicitly.', undefined, missing);
    },
  };
}
