import { absJson } from './abs-json';
import { indexAbsAbi } from './abs-abi-index';
import { AbsAbiWorkspace, AbsProjectionContracts, AbsSyncError } from './abs-state';

/** Identity/argument structure is stable; dropdown domains are current validation
 * data, not a reason to invalidate an unchanged ABI. No library/field names. */
export function compareAbsContracts(before: AbsProjectionContracts, current: AbsProjectionContracts, workspace: AbsAbiWorkspace) {
  const changes: Array<{ blockType?: string; field?: string; reason: string }> = [];
  let compatible = true, count = 0;
  const record = (reason: string, valid: boolean, blockType?: string, field?: string) => {
    compatible &&= valid; count++;
    if (changes.length < 8) changes.push({ reason, ...(blockType ? { blockType } : {}), ...(field ? { field } : {}) });
  };
  const { fields: oldFields, ...oldStructure } = before, { fields, ...structure } = current;
  if (absJson(oldStructure) !== absJson(structure)) record('structure-or-model-contract-changed', false);
  const blocks = indexAbsAbi(workspace);
  for (const id of new Set([...Object.keys(oldFields), ...Object.keys(fields)])) {
    for (const name of new Set([...Object.keys(oldFields[id] ?? {}), ...Object.keys(fields[id] ?? {})])) {
      const old = oldFields[id]?.[name], next = fields[id]?.[name], block = blocks.get(id);
      if (absJson(old ?? null) === absJson(next ?? null)) continue;
      if (!old || !next) { record('field-added-or-removed', false, block?.type, name); continue; }
      const { options: oldOptions, ...oldProtocol } = old, { options, ...protocol } = next;
      const allowed = old.type === 'field_dropdown' && Array.isArray(oldOptions) && Array.isArray(options)
        && absJson(oldProtocol) === absJson(protocol)
        && options.some(option => option[1] === block?.fields?.[name]);
      record(allowed ? 'dropdown-domain-changed' : 'field-protocol-or-selected-value-changed', allowed, block?.type, name);
    }
  }
  return { status: compatible ? count ? 'compatible' as const : 'exact' as const : 'incompatible' as const,
    changes, totalChanges: count, truncated: count > changes.length };
}

export function assertAbsContractsCompatible(before: AbsProjectionContracts, current: AbsProjectionContracts, workspace: AbsAbiWorkspace) {
  const result = compareAbsContracts(before, current, workspace);
  if (result.status === 'incompatible') {
    const first = result.changes.find(change => change.reason !== 'dropdown-domain-changed');
    throw new AbsSyncError('ABS_RUNTIME_CONTRACT_STALE', 'Runtime structure, field protocol or selected value changed since export.', undefined, [], {
      ...first, hint: 'Use project_recover(action="inspect") for current readiness and a preserve-draft refresh token. Do not read or overwrite private baseline files.',
    });
  }
  return result;
}
