import { parse } from 'acorn';

const sourceOf = Function.prototype.toString;
const parsed = new WeakMap<Function, any>();
const patterns = new Map<string, any>();
export function parseBlocklyFunction(source: string): any {
  if (source.length > 16000) throw new Error('Function exceeds proof limit.');
  return (parse('(' + source + ')', { ecmaVersion: 2022 }) as any).body[0].expression;
}

/** Exact AST pattern with explicit, consistent identifier/string captures. Never evaluates code. */
export function matchBlocklyFunction(callback: unknown, pattern: string, captures: Record<string, string>): boolean {
  if (typeof callback !== 'function') return false;
  try {
    if (!parsed.has(callback)) parsed.set(callback, parseBlocklyFunction(sourceOf.call(callback)));
    const capture = (key: string, value: unknown): boolean => {
      if (typeof value !== 'string') return false;
      if (Object.hasOwn(captures, key)) return captures[key] === value;
      captures[key] = value; return true;
    };
    const match = (expected: any, actual: any): boolean => {
      if (expected === null || typeof expected !== 'object') return expected === actual;
      if (!actual || typeof actual !== 'object') return false;
      if (expected.type === 'Identifier' && expected.name.startsWith('$')) {
        return actual.type === 'Identifier' && capture(expected.name, actual.name);
      }
      if (expected.type === 'Literal' && typeof expected.value === 'string' && expected.value.startsWith('$')) {
        return actual.type === 'Literal' && capture(expected.value, actual.value);
      }
      const keys = (node: any) => Object.keys(node).filter(key => !['start', 'end', 'raw'].includes(key));
      const a = keys(expected), b = keys(actual);
      return a.length === b.length && a.every(key => Object.hasOwn(actual, key) && match(expected[key], actual[key]));
    };
    if (!patterns.has(pattern)) patterns.set(pattern, parseBlocklyFunction(pattern));
    return match(patterns.get(pattern), parsed.get(callback));
  } catch { return false; }
}
