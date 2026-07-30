import {
  AilyDataLogicalType,
  ProjectDataError,
} from './project-data.types';

export interface ProjectDataCodec<TValue = unknown> {
  readonly id: string;
  readonly logicalType: AilyDataLogicalType;
  readonly maxRawLength: number;
  encode(value: TValue): Promise<Uint8Array>;
  decode(canonicalBytes: Uint8Array): Promise<TValue>;
}

const DEFAULT_MAX_RAW_LENGTH = 128 * 1024 * 1024;
const MAX_CANONICAL_JSON_DEPTH = 256;
const MAX_CANONICAL_JSON_NODES = 2_000_000;

export class ProjectDataCodecRegistry {
  private readonly codecs = new Map<string, ProjectDataCodec>();

  register<TValue>(codec: ProjectDataCodec<TValue>): void {
    if (!codec?.id || this.codecs.has(codec.id)) {
      throw new ProjectDataError(
        'unsupported-codec',
        `Project data codec is already registered or invalid: ${codec?.id || '<empty>'}`,
      );
    }
    this.codecs.set(codec.id, codec as ProjectDataCodec);
  }

  get<TValue = unknown>(id: string): ProjectDataCodec<TValue> {
    const codec = this.codecs.get(id);
    if (!codec) {
      throw new ProjectDataError('unsupported-codec', `Unsupported project data codec: ${id}`);
    }
    return codec as ProjectDataCodec<TValue>;
  }

  has(id: string): boolean {
    return this.codecs.has(id);
  }

  list(): readonly ProjectDataCodec[] {
    return [...this.codecs.values()];
  }
}

export function createDefaultProjectDataCodecRegistry(): ProjectDataCodecRegistry {
  const registry = new ProjectDataCodecRegistry();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });

  registry.register<string>({
    id: 'utf8-v1',
    logicalType: 'text',
    maxRawLength: DEFAULT_MAX_RAW_LENGTH,
    async encode(value) {
      if (typeof value !== 'string') {
        throw new ProjectDataError('corrupt', 'utf8-v1 expects a string value.');
      }
      return encoder.encode(value);
    },
    async decode(bytes) {
      return decoder.decode(bytes);
    },
  });

  registry.register<unknown>({
    id: 'canonical-json-v1',
    logicalType: 'json',
    maxRawLength: DEFAULT_MAX_RAW_LENGTH,
    async encode(value) {
      return encoder.encode(canonicalJsonStringify(value));
    },
    async decode(bytes) {
      try {
        const value = JSON.parse(decoder.decode(bytes));
        assertCanonicalJsonComplexity(value);
        return value;
      } catch (error) {
        if (error instanceof ProjectDataError) throw error;
        throw new ProjectDataError('corrupt', 'canonical-json-v1 payload is invalid.', {
          cause: String(error),
        });
      }
    },
  });

  registry.register<Uint8Array>({
    id: 'raw-binary-v1',
    logicalType: 'binary',
    maxRawLength: DEFAULT_MAX_RAW_LENGTH,
    async encode(value) {
      if (!(value instanceof Uint8Array)) {
        throw new ProjectDataError('corrupt', 'raw-binary-v1 expects Uint8Array data.');
      }
      return value.slice();
    },
    async decode(bytes) {
      return bytes.slice();
    },
  });

  for (const id of [
    'tft-rgb565-be-frames-v1',
    'tft-rgb332-frames-v1',
    'u8g2-xbm-frames-v1',
    'u8g2-xbm-v1',
    'led-matrix-mono-v1',
    'led-matrix-rgba8888-v1',
    'image-original-v1',
  ]) {
    registry.register<Uint8Array>({
      id,
      logicalType: 'binary',
      maxRawLength: DEFAULT_MAX_RAW_LENGTH,
      async encode(value) {
        if (!(value instanceof Uint8Array)) {
          throw new ProjectDataError('corrupt', `${id} expects Uint8Array frame data.`);
        }
        return value.slice();
      },
      async decode(bytes) {
        return bytes.slice();
      },
    });
  }

  return registry;
}

export function canonicalJsonStringify(value: unknown): string {
  const active = new Set<object>();
  let nodeCount = 0;

  const normalize = (current: unknown, path: string, depth: number): unknown => {
    nodeCount++;
    if (nodeCount > MAX_CANONICAL_JSON_NODES) {
      throw new ProjectDataError('too-large', 'Canonical JSON exceeds the node limit.', {
        maxNodes: MAX_CANONICAL_JSON_NODES,
      });
    }
    if (depth > MAX_CANONICAL_JSON_DEPTH) {
      throw new ProjectDataError('too-large', `Canonical JSON exceeds the depth limit at ${path}.`, {
        maxDepth: MAX_CANONICAL_JSON_DEPTH,
      });
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw new ProjectDataError('corrupt', `Non-finite JSON number at ${path}.`);
      }
      return current;
    }
    if (Array.isArray(current)) {
      if (active.has(current)) {
        throw new ProjectDataError('corrupt', `Circular JSON array at ${path}.`);
      }
      active.add(current);
      const normalized = current.map((item, index) => (
        normalizeJsonMember(item, `${path}/${index}`, (member, memberPath) => (
          normalize(member, memberPath, depth + 1)
        ))
      ));
      active.delete(current);
      return normalized;
    }
    if (current && typeof current === 'object') {
      if (active.has(current)) {
        throw new ProjectDataError('corrupt', `Circular JSON object at ${path}.`);
      }
      if (Object.getPrototypeOf(current) !== Object.prototype) {
        throw new ProjectDataError('corrupt', `Unsupported JSON object at ${path}.`);
      }
      active.add(current);
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        const member = (current as Record<string, unknown>)[key];
        normalized[key] = normalizeJsonMember(
          member,
          `${path}/${escapeJsonPointer(key)}`,
          (value, memberPath) => normalize(value, memberPath, depth + 1),
        );
      }
      active.delete(current);
      return normalized;
    }
    throw new ProjectDataError('corrupt', `Unsupported JSON value at ${path}.`);
  };

  return JSON.stringify(normalize(value, '$', 0));
}

function normalizeJsonMember(
  value: unknown,
  path: string,
  normalize: (value: unknown, path: string) => unknown,
): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new ProjectDataError('corrupt', `Unsupported JSON member at ${path}.`);
  }
  return normalize(value, path);
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function assertCanonicalJsonComplexity(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodeCount++;
    if (nodeCount > MAX_CANONICAL_JSON_NODES) {
      throw new ProjectDataError('too-large', 'Canonical JSON exceeds the node limit.', {
        maxNodes: MAX_CANONICAL_JSON_NODES,
      });
    }
    if (current.depth > MAX_CANONICAL_JSON_DEPTH) {
      throw new ProjectDataError('too-large', 'Canonical JSON exceeds the depth limit.', {
        maxDepth: MAX_CANONICAL_JSON_DEPTH,
      });
    }
    if (!current.value || typeof current.value !== 'object') continue;
    const members = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const member of members) pending.push({ value: member, depth: current.depth + 1 });
  }
}
