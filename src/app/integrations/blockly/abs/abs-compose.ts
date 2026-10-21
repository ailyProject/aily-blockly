import { renderAbs } from './abs-renderer';
import { authoringExtraState, precheckAbs, type AbsAuthoringContracts } from './abs-precheck';
import { AbsSyncError, type AbsAbiBlock, type AbsAbiWorkspace, type AbsProjectionContracts } from './abs-state';
import type { AbsFieldDefinition } from './abs-field-values';

/** Authoring data only. No persisted identities, model creation or ABI writes. */
export interface AbsStructuredBlock {
  type: string;
  fields?: Record<string, string | number | boolean | null | { variable: string }>;
  values?: Record<string, AbsStructuredBlock | null>;
  statements?: Record<string, AbsStructuredBlock[]>;
  extraState?: unknown;
  disabled?: boolean;
}

export function composeAbs(program: unknown, definitions: AbsAuthoringContracts) {
  const bad = (message: string): never => { throw new AbsSyncError('ABS_COMPOSE_INVALID', message); };
  const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(program) || Object.keys(program).some(key => key !== 'blocks') || !Array.isArray(program['blocks']) || !program['blocks'].length) bad('Expected {blocks: [structured block, ...]}.');
  const contracts: AbsProjectionContracts = { fields: Object.create(null), syntax: Object.create(null) };
  let count = 0;
  const block = (value: unknown, depth: number, pointer: string): AbsAbiBlock => {
    if (++count > 10000 || depth > 96) bad('Structured candidate exceeds 10000 blocks or 96 nesting levels.');
    if (!record(value) || Object.keys(value).some(key => !['type', 'fields', 'values', 'statements', 'extraState', 'disabled'].includes(key))
      || typeof value['type'] !== 'string' || !/^[A-Za-z_]\w*$/.test(value['type'])
      || value['disabled'] !== undefined && typeof value['disabled'] !== 'boolean') bad(`Invalid block at ${pointer}; IDs and raw ABS are not accepted.`);
    const node = value as Record<string, any>;
    for (const key of ['fields', 'values', 'statements']) if (node[key] !== undefined && !record(node[key])) bad(`${pointer}/${key} must be an object.`);
    const fields: Record<string, unknown> = Object.create(null);
    const references = new Set<string>();
    for (const [name, scalar] of Object.entries(node['fields'] ?? {})) {
      if (record(scalar) && Object.keys(scalar).length === 1 && typeof scalar['variable'] === 'string' && scalar['variable']) {
        fields[name] = scalar['variable']; references.add(name);
      } else if (scalar === null || ['string', 'boolean'].includes(typeof scalar) || typeof scalar === 'number' && Number.isFinite(scalar)) fields[name] = scalar;
      else bad(`${pointer}/fields/${name} must be a JSON scalar or {variable: "name"}.`);
    }
    const deferred = definitions.deferType?.(node['type']);
    const extra = deferred ? node['extraState'] : authoringExtraState({ type: node['type'], parameters: [],
      sections: [...Object.keys(node['values'] ?? {}), ...Object.keys(node['statements'] ?? {})]
        .map(name => ({ name, children: [], start: 0, end: 0 })), disabled: false, start: 0, end: 0,
      ...(Object.hasOwn(node, 'extraState') ? { extraState: node['extraState'] } : {}) }, definitions);
    const shape = deferred ? undefined : definitions.blockContract(node['type'], extra, fields);
    const fieldContracts: Record<string, AbsFieldDefinition> = Object.create(null);
    for (const name of Object.keys(fields)) {
      const definition = shape?.fields[name];
      if (references.has(name) && definition && definition.symbol?.kind !== 'variable') bad(`${pointer}/fields/${name} does not accept a variable reference.`);
      fieldContracts[name] = references.has(name) || definition?.symbol?.kind === 'variable'
        ? { type: 'field_variable', symbol: { kind: 'variable', storage: 'name' } }
        : definition ?? { type: 'field_input' };
    }
    const result: AbsAbiBlock = { type: node['type'], id: `compose-${count}`, fields, inputs: Object.create(null),
      ...(Object.hasOwn(node, 'extraState') ? { extraState: node['extraState'] } : {}), ...(node['disabled'] ? { disabled: true } : {}) };
    const order = [...Object.keys(fields).map(name => ({ name, kind: 'field' as const }))];
    const inputs = result.inputs!;
    for (const [name, child] of Object.entries(node['values'] ?? {})) {
      if (name === 'next' || Object.hasOwn(node['statements'] ?? {}, name) || shape && shape.inputs[name] !== 'value') bad(`Invalid value slot ${pointer}/${name}.`);
      inputs[name] = child === null ? {} : { block: block(child, depth + 1, `${pointer}/values/${name}`) };
    }
    for (const [name, children] of Object.entries(node['statements'] ?? {})) {
      if (name === 'next' || !Array.isArray(children) || shape && shape.inputs[name] !== 'statement') bad(`Invalid statement slot ${pointer}/${name}.`);
      const chain = (children as unknown[]).map((child, index) => block(child, depth + 1, `${pointer}/statements/${name}/${index}`));
      chain.slice(0, -1).forEach((child, index) => child.next = { block: chain[index + 1] });
      inputs[name] = chain.length ? { block: chain[0] } : {};
    }
    contracts.fields[result.id] = fieldContracts;
    // The canonical renderer gets explicit slot roles from this structured input;
    // the host's real contracts still independently check the emitted source.
    contracts.syntax![result.id] = [...order,
      ...Object.keys(node['values'] ?? {}).map(name => ({ name, kind: 'valueInput' as const })),
      ...Object.keys(node['statements'] ?? {}).map(name => ({ name, kind: 'statementInput' as const }))];
    return result;
  };
  const workspace: AbsAbiWorkspace = { blocks: { blocks: (program as { blocks: unknown[] }).blocks.map((value, index) => block(value, 0, `/blocks/${index}`)) } };
  const rendered = renderAbs(workspace, contracts, { project(value, contract) {
    if (typeof value !== 'string' || !value) bad('A model reference requires a nonempty name.');
    return { value: value as string, kind: contract.kind, modelId: '' };
  } }, undefined, { namedArguments: true });
  return { abs: rendered.abs, blockCount: count, precheck: precheckAbs(rendered.abs, definitions) };
}
