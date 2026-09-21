import { AbsSyncError } from './abs-state';

/** Serializable schema paths, never prototype lookup or executable path expressions. */
export function readAbsStatePath(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/u.test(pointer)) {
    throw new AbsSyncError('ABS_SYMBOL_INVALID', 'Invalid model JSON pointer.');
  }
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
