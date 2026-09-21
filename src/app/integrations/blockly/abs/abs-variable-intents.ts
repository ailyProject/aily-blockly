import { AbsAbiWorkspace, AbsSyncError } from './abs-state';

/** Explicit model intent, separate from ABS syntax and C++ declaration blocks. */
export interface AbsVariableCreation { name: string; type?: string }
export interface AbsVariableCreationIntent { requestId: string; variables: readonly AbsVariableCreation[] }
export interface AbsPreparedVariable { id: string; name: string; type: string }

export function assertAbsVariableCreations(value: unknown): asserts value is AbsVariableCreation[] | undefined {
  if (value === undefined) return;
  const text = (value: unknown, empty = false) => typeof value === 'string' && (empty || value.length > 0)
    && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(item => !item || typeof item !== 'object'
    || Object.keys(item).some(key => key !== 'name' && key !== 'type') || !text(item.name)
    || item.type !== undefined && !text(item.type, true))) {
    throw new AbsSyncError('ABS_VARIABLE_INTENT_INVALID', 'createVariables requires 1–128 {name, type?} records; IDs and rename/delete operations are host-owned.');
  }
}

/** Pure preparation. Native loading creates these exact models in the same generation transaction. */
export function planAbsVariableCreations(intent: AbsVariableCreationIntent): AbsPreparedVariable[] {
  assertAbsVariableCreations(intent.variables);
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(intent.requestId)) throw new AbsSyncError('ABS_VARIABLE_INTENT_INVALID', 'A generation request ID is required.');
  return intent.variables.map((variable, index) => ({ name: variable.name, id: `abs-variable:${intent.requestId}:${index}`, type: variable.type ?? '' }));
}

export function prepareAbsVariableCreations(workspace: AbsAbiWorkspace, intent?: AbsVariableCreationIntent): void {
  if (!intent) return;
  const additions = planAbsVariableCreations(intent);
  const variables = workspace['variables'];
  if (variables !== undefined && !Array.isArray(variables)) throw new AbsSyncError('ABS_VARIABLE_INTENT_INVALID', 'The native variable table is not an array.');
  const current: any[] = variables as any[] ?? [];
  const names = new Set(current.map(variable => String(variable.name).toLowerCase()));
  const ids = new Set(current.map(variable => variable.id));
  for (const variable of additions) {
    const name = variable.name.toLowerCase();
    // Keep the shared namespace unambiguous across types, as well as Blockly's case-insensitive lookup.
    if (names.has(name)) throw new AbsSyncError('ABS_VARIABLE_EXISTS', `Variable ${JSON.stringify(variable.name)} already exists. Reference it without createVariables.`);
    names.add(name);
    if (ids.has(variable.id)) throw new AbsSyncError('ABS_DUPLICATE_ID', 'Prepared variable ID already exists. Export a new generation.');
    ids.add(variable.id);
  }
  workspace['variables'] = [...current, ...additions];
}
