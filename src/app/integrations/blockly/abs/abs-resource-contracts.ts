import { indexAbsAbi } from './abs-abi-index';
import { absJson } from './abs-identity-map';
import { AbsAbiWorkspace, AbsProjectionContracts, AbsSyncError } from './abs-state';
import { readAbsStatePath } from './abs-state-path';

/** Storage envelopes must not hide model paths still consumed by the pure projection/contracts. */
export function assertAbsResourceContracts(
  before: AbsAbiWorkspace, after: AbsAbiWorkspace, contracts: AbsProjectionContracts,
): void {
  const check = (left: unknown, right: unknown, path: string, blockId?: string) => {
    const previous = readAbsStatePath(left, path);
    const current = readAbsStatePath(right, path);
    if (previous === undefined && current === undefined) return;
    if (previous === undefined || current === undefined || absJson(previous) !== absJson(current)) {
      throw new AbsSyncError('ABS_DATA_MODEL_PATH',
        `Resource externalization would hide a declared model path ${path}; a model-aware storage adapter is required.`,
        undefined, blockId ? [blockId] : []);
    }
  };
  const original = indexAbsAbi(before);
  const compact = indexAbsAbi(after);
  for (const [id, block] of original) {
    const next = compact.get(id);
    if (!next) throw new AbsSyncError('ABS_DATA_MODEL_PATH', 'Externalization removed a block identity.', undefined, [id]);
    const fields = Object.hasOwn(contracts.fields, id) ? contracts.fields[id] : {};
    for (const [name, field] of Object.entries(fields)) {
      if (field.symbol) check(block.fields, next.fields, '/' + name.replace(/~/g, '~0').replace(/\//g, '~1'), id);
    }
    const procedure = contracts.procedures && Object.hasOwn(contracts.procedures, id) ? contracts.procedures[id] : undefined;
    if (procedure) {
      check(block, next, procedure.namePath, id);
      check(block, next, procedure.parametersPath, id);
    }
  }
  for (const table of contracts.symbolTables ?? []) {
    if (table.source !== 'workspace') continue; // This stage does not externalize the full host document.
    const previous = readAbsStatePath(before, table.path);
    const next = readAbsStatePath(after, table.path);
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) {
      throw new AbsSyncError('ABS_DATA_MODEL_PATH', `Resource externalization hid model table ${table.path}.`);
    }
    previous.forEach((row, index) => {
      for (const path of [table.idPath, table.namePath, table.typePath].filter(path => path !== undefined)) {
        check(row, next[index], path);
      }
    });
  }
}
