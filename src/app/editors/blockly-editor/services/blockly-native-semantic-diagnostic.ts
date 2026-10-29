import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import type { AbsDiagnostic } from '../../../integrations/blockly/abs/abs-diagnostics';

type JsonObject = Record<string, any>;
type Change = { path: string[]; before: unknown; after: unknown };
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const primitive = (value: unknown): value is string | number | boolean | null => value === null
  || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);

/** Iterative traversal keeps error reporting independent of block nesting depth. */
function firstChange(before: unknown, after: unknown): Change | undefined {
  const pending: Change[] = [{ path: [], before, after }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (Object.is(entry.before, entry.after)) continue;
    if (!entry.before || !entry.after || typeof entry.before !== 'object' || typeof entry.after !== 'object'
      || Array.isArray(entry.before) !== Array.isArray(entry.after)) return entry;
    const keys = [...new Set([...Object.keys(entry.before), ...Object.keys(entry.after)])];
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      pending.push({ path: [...entry.path, key], before: (entry.before as JsonObject)[key], after: (entry.after as JsonObject)[key] });
    }
  }
  return undefined;
}

function context(snapshot: any, path: readonly string[]): { blockId?: string; blockType?: string; field?: string; modelName?: string; options?: unknown[] } {
  let value = snapshot;
  const result: ReturnType<typeof context> = {};
  for (let i = 0; i <= path.length; i++) {
    const ownerPath = path.slice(0, i);
    const blockLocation = path[0] === 'shapes' && i === 2 || path[0] === 'state' && ownerPath.includes('blocks')
      && !ownerPath.some(key => ['fields', 'extraState', 'variables'].includes(key));
    if (blockLocation && object(value) && typeof value['id'] === 'string' && typeof value['type'] === 'string') {
      result.blockId = value['id']; result.blockType = value['type'];
    }
    if (path[0] === 'state' && path[1] === 'variables' && i === 3 && typeof value?.name === 'string') result.modelName = value.name;
    if (path[i] === 'fields' && value?.fields) {
      const key = path[i + 1];
      if (Array.isArray(value.fields)) {
        const field = value.fields[Number(key)];
        if (typeof field?.name === 'string') result.field = field.name;
        if (Array.isArray(field?.options)) result.options = field.options;
      } else if (key !== undefined) result.field = key;
    }
    value = value?.[path[i]];
  }
  return result;
}

/** Bounded data-only context, never a receipt, retry authority or full snapshot. */
export function nativeSemanticChange(before: string, after: string, phase: 'initialization' | 'ui',
  message = 'Native deferred UI task changed persisted state, structure or field constraints'): AbsSyncError {
  const diagnostic: AbsDiagnostic = { reason: 'native-ui-semantic-change', phase,
    hint: 'Preserve ABS and source. Unchanged chunk, reload or apply cannot repair this deterministic native contract failure. Retry only after the reported cause is corrected.' };
  const text = (value: string, limit = 256) => {
    if (value.length > limit) diagnostic.truncated = true;
    return value.slice(0, limit);
  };
  const values = (items: unknown[]) => {
    if (items.length > 64) diagnostic.truncated = true;
    return items.slice(0, 64).filter(primitive).filter(value => value !== null)
      .map(value => typeof value === 'string' ? text(value) : value);
  };
  let path = '/';
  try {
    const previous = JSON.parse(before), current = JSON.parse(after), change = firstChange(previous, current);
    if (change) {
      path = '/' + change.path.map(key => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
      const oldContext = context(previous, change.path), newContext = context(current, change.path);
      const { options: previousOptions, ...oldOwner } = oldContext;
      const { options: currentOptions, ...newOwner } = newContext;
      for (const [key, value] of Object.entries({ ...oldOwner, ...newOwner })) {
        if (typeof value === 'string') (diagnostic as Record<string, unknown>)[key] = text(value);
      }
      // Only primitive differences and dropdown keys are exposed, not state bodies.
      if (primitive(change.before)) diagnostic.expected = typeof change.before === 'string' ? text(change.before) : change.before;
      if (primitive(change.after)) diagnostic.received = typeof change.after === 'string' ? text(change.after) : change.after;
      if (previousOptions) diagnostic.previousAllowedValues = values(previousOptions);
      if (currentOptions) diagnostic.allowedValues = values(currentOptions);
    }
  } catch { /* Keep a useful typed failure even if snapshot diagnostics fail. */ }
  diagnostic.path = text(path, 512);
  return new AbsSyncError('ABS_NATIVE_UI_CONTRACT_CHANGED', `${message} at ${path.slice(0, 512)}.`, undefined,
    diagnostic.blockId ? [diagnostic.blockId] : [], diagnostic);
}
