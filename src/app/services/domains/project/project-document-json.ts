import { ProjectDataError } from './project-data/project-data.types';

const MAX_DOCUMENT_DEPTH = 32_768;
const MAX_DOCUMENT_NODES = 2_000_000;

/** Stack-safe detached copies, without encoding and parsing a megabyte-sized
 * Blockly graph on every preview/snapshot. Strict copies retain canonical JSON
 * validation; legacy editor state retains JSON.stringify's normalization rules. */
export function cloneProjectJson<T>(value: T): T { return copyDocument(value, true); }
export function cloneBlocklyJson<T>(value: T): T { return copyDocument(value, false); }

function copyDocument<T>(value: T, strict: boolean): T {
  type Frame = { source: any; target: any; keys: string[] | null; length: number; index: number; key: string };
  const stack: Frame[] = [], active = new Set<object>();
  const omitted = Symbol('omitted');
  let nodes = 0;
  const reject = (message: string, key: string): never => {
    const location = ['$', ...stack.slice(1).map(frame => frame.key), key]
      .map((part, i) => i ? part.replace(/~/g, '~0').replace(/\//g, '~1') : part).join('/');
    throw new ProjectDataError('corrupt', `${message} at ${location}.`);
  };
  const visit = (source: any, key: string): any => {
    if (++nodes > MAX_DOCUMENT_NODES || stack.length > MAX_DOCUMENT_DEPTH) {
      throw new ProjectDataError('too-large', 'Project document JSON exceeds its complexity limit.', {
        maxNodes: MAX_DOCUMENT_NODES, maxDepth: MAX_DOCUMENT_DEPTH,
      });
    }
    const kind = typeof source;
    if (!strict && source !== null && (kind === 'object' || kind === 'function' || kind === 'bigint')
      && typeof source.toJSON === 'function') source = source.toJSON(key);
    if (!strict && typeof source === 'object' && (source instanceof Number || source instanceof String || source instanceof Boolean)) source = source.valueOf();
    if (source === null || typeof source === 'string' || typeof source === 'boolean') return source;
    if (typeof source === 'number') {
      if (!Number.isFinite(source)) { if (strict) reject('Non-finite JSON number', key); return null; }
      return source === 0 ? 0 : source;
    }
    if (typeof source !== 'object') {
      if (!strict && ['undefined', 'function', 'symbol'].includes(typeof source)) return omitted;
      return reject('Unsupported JSON value', key);
    }
    if (active.has(source)) reject('Circular JSON object', key);
    const array = Array.isArray(source);
    if (strict && !array && ![null, Object.prototype].includes(Object.getPrototypeOf(source))) reject('Unsupported JSON object', key);
    const keys = array ? null : Object.keys(source);
    if (strict) keys?.sort();
    const length = array ? source.length : keys!.length;
    if (length > MAX_DOCUMENT_NODES - nodes) throw new ProjectDataError('too-large', 'Project document JSON exceeds the node limit.');
    const target = array ? new Array(length) : {};
    active.add(source); stack.push({source, target, keys, length, index: 0, key});
    return target;
  };
  const result = visit(value, '');
  if (result === omitted) reject('Unsupported JSON value', '');
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.length) { active.delete(frame.source); stack.pop(); continue; }
    const key = frame.keys?.[frame.index] ?? String(frame.index); frame.index++;
    const child = !frame.keys && !(key in frame.source) ? null : visit(frame.source[key], key);
    if (child === omitted && frame.keys) continue;
    // Define rather than assign: __proto__ is JSON data, never a prototype setter.
    const copied = child === omitted ? null : child;
    if (key === '__proto__') Object.defineProperty(frame.target, key, {value: copied, enumerable: true, writable: true, configurable: true});
    else frame.target[key] = copied;
  }
  return result;
}

/** Canonical snapshots of Blockly documents, whose next/block links add two
 * levels per statement. Keep the external canonical-json-v1 payload codec's
 * 512-level contract separate. This writer never recurses or calls toJSON.
 * Output ordering matches canonicalJsonStringify, including integer keys.
 */
export function canonicalProjectJsonStringify(value: unknown): string {
  type Frame = { value: any; keys: string[] | null; length: number; index: number; key: string };
  const stack: Frame[] = [], parts: string[] = [], active = new Set<object>();
  // Blockly documents repeat the same property names across thousands of
  // blocks. Cache only their encoding/order within this observation; every
  // value is still read and validated, including changes without native events.
  const encodedKeys = new Map<string, string>(), indexKeys = new Map<string, boolean>();
  let nodes = 0;
  const isIndex = (key: string): boolean => {
    let result = indexKeys.get(key);
    if (result === undefined) { result = String(Number(key) >>> 0) === key && Number(key) < 0xffffffff; indexKeys.set(key, result); }
    return result;
  };
  const reject = (message: string, key: string): never => {
    const pointer = ['$', ...stack.slice(1).map(frame => frame.key), key]
      .map((part, i) => i ? part.replace(/~/g, '~0').replace(/\//g, '~1') : part).join('/');
    throw new ProjectDataError('corrupt', `${message} at ${pointer}.`);
  };
  const visit = (current: unknown, key: string) => {
    if (++nodes > MAX_DOCUMENT_NODES || stack.length > MAX_DOCUMENT_DEPTH) {
      throw new ProjectDataError('too-large', 'Project document JSON exceeds its complexity limit.', {
        maxNodes: MAX_DOCUMENT_NODES, maxDepth: MAX_DOCUMENT_DEPTH,
      });
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number') {
      if (typeof current === 'number' && !Number.isFinite(current)) reject('Non-finite JSON number', key);
      parts.push(JSON.stringify(current)); return;
    }
    if (!current || typeof current !== 'object') reject('Unsupported JSON value', key);
    const object = current as object;
    if (active.has(object)) reject('Circular JSON object', key);
    const array = Array.isArray(object);
    if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(object))) reject('Unsupported JSON object', key);
    // JSON.stringify orders array-index object keys numerically, even after the
    // original canonical normalizer inserted all keys in lexical order.
    const keys = array ? null : Object.keys(object).sort((a, b) => {
      const ai = isIndex(a), bi = isIndex(b);
      return ai && bi ? Number(a) - Number(b) : ai ? -1 : bi ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
    const length = array ? (object as unknown[]).length : keys!.length;
    if (length > MAX_DOCUMENT_NODES - nodes) throw new ProjectDataError('too-large', 'Project document JSON exceeds the node limit.');
    active.add(object); parts.push(array ? '[' : '{');
    stack.push({value: object, keys, length, index: 0, key});
  };
  visit(value, '');
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index === frame.length) {
      parts.push(frame.keys ? '}' : ']'); active.delete(frame.value); stack.pop(); continue;
    }
    if (frame.index) parts.push(',');
    const key = frame.keys?.[frame.index] ?? String(frame.index);
    frame.index++;
    if (frame.keys) {
      let encoded = encodedKeys.get(key);
      if (encoded === undefined) { encoded = JSON.stringify(key); encodedKeys.set(key, encoded); }
      parts.push(encoded, ':');
    }
    // Preserve the existing codec's JSON representation of sparse arrays.
    if (!frame.keys && !(key in frame.value)) {parts.push('null'); continue;}
    visit(frame.value[key], key);
  }
  return parts.join('');
}
