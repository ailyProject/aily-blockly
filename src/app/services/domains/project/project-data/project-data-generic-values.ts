import { canonicalJsonStringify } from './project-data-codec.registry';
import { PutProjectDataRequest } from './project-data-store';
import {
  assertProjectDataEnvelope, cloneProjectDataJson, collectProjectDataPayloads,
  containsProjectDataReference, projectDataChildPointer,
} from './project-data-payloads';
import {
  AilyDataRef, AilyProjectDataValue, createAilyProjectDataValue,
  DEFAULT_PROJECT_DATA_THRESHOLD_BYTES, isAilyDataRef, isAilyProjectDataValue, ProjectDataError,
} from './project-data.types';

interface GenericProjectDataWriter {
  put<TValue>(request: PutProjectDataRequest<TValue>): Promise<AilyDataRef>;
}
interface GenericProjectDataReader {
  resolve<TValue>(ref: AilyDataRef): Promise<TValue>;
}
export interface GenericProjectDataValueEntry {
  readonly jsonPointer: string;
  readonly blockId?: string;
  readonly blockType?: string;
  readonly fieldName?: string;
  readonly codec: 'utf8-v1' | 'canonical-json-v1';
  readonly canonicalLength: number;
  readonly ref: AilyDataRef;
}
export interface ExternalizeGenericProjectDataResult<TDocument = unknown> {
  readonly document: TDocument;
  readonly externalized: readonly GenericProjectDataValueEntry[];
}
const encoder = new TextEncoder();

/** Payloads only: block state, workspace serializers and model extensions; never the graph. */
export async function externalizeGenericProjectDataValues<TDocument>(
  document: TDocument, writer: GenericProjectDataWriter, threshold = DEFAULT_PROJECT_DATA_THRESHOLD_BYTES,
): Promise<ExternalizeGenericProjectDataResult<TDocument>> {
  const candidate = cloneProjectDataJson(document);
  const externalized: GenericProjectDataValueEntry[] = [];
  for (const { owner, key, jsonPointer, ...context } of collectProjectDataPayloads(candidate)) {
    const visit = async (value: unknown, pointer: string): Promise<unknown> => {
      assertProjectDataEnvelope(value, pointer);
      if (isAilyDataRef(value) || isAilyProjectDataValue(value)) return value;
      const codec = typeof value === 'string' ? 'utf8-v1' : isJsonContainer(value) ? 'canonical-json-v1' : null;
      if (!codec) return value;
      // Recurse into mixed payloads rather than hiding references in another resource.
      if (containsProjectDataReference(value)) {
        for (const [name, member] of Object.entries(value as object)) {
          setMember(value as object, name, await visit(member, projectDataChildPointer(pointer, name)));
        }
        return value;
      }
      const canonicalLength = encoder.encode(codec === 'utf8-v1' ? value as string : canonicalJsonStringify(value)).byteLength;
      if (canonicalLength <= threshold) return value;
      const ref = await writer.put({ codec, storage: 'raw-v1', value });
      externalized.push({ ...context, jsonPointer: pointer, codec, canonicalLength, ref });
      return createAilyProjectDataValue(ref);
    };
    setMember(owner, key, await visit(owner[key], jsonPointer));
  }
  return { document: candidate, externalized };
}

/** Resolve at the same payload boundaries before any Blockly serializer consumes them. */
export async function materializeGenericProjectDataValues<TDocument>(
  document: TDocument, reader: GenericProjectDataReader,
): Promise<TDocument> {
  const candidate = cloneProjectDataJson(document);
  for (const { owner, key, jsonPointer } of collectProjectDataPayloads(candidate)) {
    setMember(owner, key, await materializeProjectDataPayload(owner[key], reader, jsonPointer));
  }
  return candidate;
}

/** One payload or syntax token; does not infer block graphs inside opaque JSON. */
export async function materializeProjectDataPayload<T>(payload: T, reader: GenericProjectDataReader, pointer = ''): Promise<T> {
  const visit = async (value: unknown, pointer: string): Promise<unknown> => {
    assertProjectDataEnvelope(value, pointer);
    if (isAilyProjectDataValue(value)) return validateResolvedValue(value, await reader.resolve(value.$ailyProjectDataValue.ref), pointer);
    if (!value || typeof value !== 'object' || isAilyDataRef(value)) return value;
    for (const [key, member] of Object.entries(value)) setMember(value, key, await visit(member, projectDataChildPointer(pointer, key)));
    return value;
  };
  return await visit(cloneProjectDataJson(payload), pointer) as T;
}

/** Dirty-state comparison uses only prepared values; no filesystem/runtime dependencies. */
export function materializePreparedGenericProjectDataValues<TDocument>(
  document: TDocument, resolvePrepared: (ref: AilyDataRef) => unknown,
): TDocument {
  const candidate = cloneProjectDataJson(document);
  for (const { owner, key, jsonPointer } of collectProjectDataPayloads(candidate)) {
    setMember(owner, key, materializePreparedProjectDataPayload(owner[key], resolvePrepared, jsonPointer));
  }
  return candidate;
}

/** Synchronous counterpart for a host-prepared, read-only native candidate snapshot. */
export function materializePreparedProjectDataPayload<T>(payload: T, resolvePrepared: (ref: AilyDataRef) => unknown, pointer = ''): T {
  const visit = (value: unknown, pointer: string): unknown => {
    assertProjectDataEnvelope(value, pointer);
    if (isAilyProjectDataValue(value)) return validateResolvedValue(value, resolvePrepared(value.$ailyProjectDataValue.ref), pointer);
    if (!value || typeof value !== 'object' || isAilyDataRef(value)) return value;
    for (const [key, member] of Object.entries(value)) setMember(value, key, visit(member, projectDataChildPointer(pointer, key)));
    return value;
  };
  return visit(cloneProjectDataJson(payload), pointer) as T;
}

function validateResolvedValue(envelope: AilyProjectDataValue, value: unknown, pointer: string): unknown {
  const codec = envelope.$ailyProjectDataValue.ref.$ailyData.codec;
  if ((codec === 'utf8-v1' && typeof value !== 'string') || (codec === 'canonical-json-v1' && !isJsonContainer(value))) {
    throw new ProjectDataError('corrupt', `Generic project data resolved to an invalid ${codec} value at ${pointer}.`);
  }
  if (containsProjectDataReference(value)) {
    throw new ProjectDataError('corrupt', `Generic project data hides nested resource references at ${pointer}.`);
  }
  // Never expose the mutable prepared cache to library loadState callbacks.
  return cloneProjectDataJson(value);
}

function isJsonContainer(value: unknown): value is unknown[] | Record<string, unknown> {
  return Array.isArray(value) || (!!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
}
function setMember(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
