import { canonicalJsonStringify } from './project-data-codec.registry';
import { PutProjectDataRequest } from './project-data-store';
import {
  AilyDataRef,
  AilyProjectDataValue,
  createAilyProjectDataValue,
  DEFAULT_PROJECT_DATA_THRESHOLD_BYTES,
  isAilyDataRef,
  isAilyProjectDataValue,
  ProjectDataError,
} from './project-data.types';

interface GenericProjectDataWriter {
  put<TValue>(request: PutProjectDataRequest<TValue>): Promise<AilyDataRef>;
}

interface GenericProjectDataReader {
  resolve<TValue>(ref: AilyDataRef): Promise<TValue>;
}

interface BlockContext {
  readonly blockId?: string;
  readonly blockType?: string;
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

/**
 * Externalizes oversized direct `fields` and `extraState` values without
 * knowing the owning library, block type, field name, or custom field class.
 * Existing refs are never hidden inside a second resource because GC roots
 * must remain directly discoverable in ABI/ABS.
 */
export async function externalizeGenericProjectDataValues<TDocument>(
  document: TDocument,
  writer: GenericProjectDataWriter,
  threshold = DEFAULT_PROJECT_DATA_THRESHOLD_BYTES,
): Promise<ExternalizeGenericProjectDataResult<TDocument>> {
  const candidate = cloneJsonValue(document) as TDocument;
  const externalized: GenericProjectDataValueEntry[] = [];

  const externalizeCandidate = async (
    value: unknown,
    jsonPointer: string,
    context: BlockContext,
    fieldName?: string,
  ): Promise<unknown> => {
    assertValidEnvelopeIfPresent(value, jsonPointer);
    if (value === null || value === undefined || isAilyDataRef(value) || isAilyProjectDataValue(value)) {
      return value;
    }

    const codec = typeof value === 'string'
      ? 'utf8-v1' as const
      : isPlainJsonContainer(value)
        ? 'canonical-json-v1' as const
        : null;
    if (!codec) return value;

    const canonicalLength = getGenericCanonicalLength(value, codec);
    if (canonicalLength <= threshold) return value;
    if (containsProjectDataReference(value)) {
      // A dedicated Data Slot must externalize only the payload subtree. The
      // final oversized-inline assertion will retain an actionable failure.
      return value;
    }

    const ref = codec === 'utf8-v1'
      ? await writer.put({ codec, storage: 'raw-v1', value: value as string })
      : await writer.put({ codec, storage: 'raw-v1', value });
    externalized.push({
      ...context,
      fieldName,
      jsonPointer,
      codec,
      canonicalLength,
      ref,
    });
    return createAilyProjectDataValue(ref);
  };

  const visit = async (value: unknown, pointer: string, inheritedContext: BlockContext): Promise<void> => {
    assertValidEnvelopeIfPresent(value, pointer);
    if (!value || typeof value !== 'object' || isAilyDataRef(value) || isAilyProjectDataValue(value)) return;

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        await visit(value[index], `${pointer}/${index}`, inheritedContext);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const context: BlockContext = {
      blockId: typeof record['id'] === 'string' ? record['id'] : inheritedContext.blockId,
      blockType: typeof record['type'] === 'string' ? record['type'] : inheritedContext.blockType,
    };
    const fields = record['fields'];
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [fieldName, fieldValue] of Object.entries(fields as Record<string, unknown>)) {
        (fields as Record<string, unknown>)[fieldName] = await externalizeCandidate(
          fieldValue,
          `${pointer}/fields/${escapePointer(fieldName)}`,
          context,
          fieldName,
        );
      }
    }
    if (Object.prototype.hasOwnProperty.call(record, 'extraState')) {
      record['extraState'] = await externalizeCandidate(
        record['extraState'],
        `${pointer}/extraState`,
        context,
      );
    }

    for (const [key, member] of Object.entries(record)) {
      if (key === 'fields' || key === 'extraState') continue;
      await visit(member, `${pointer}/${escapePointer(key)}`, context);
    }
  };

  await visit(candidate, '', {});
  return { document: candidate, externalized };
}

/** Restores generic persistence envelopes before any Blockly consumer sees them. */
export async function materializeGenericProjectDataValues<TDocument>(
  document: TDocument,
  reader: GenericProjectDataReader,
): Promise<TDocument> {
  return transformGenericProjectDataValues(
    document,
    (ref) => reader.resolve(ref),
  );
}

/**
 * Synchronous counterpart used for dirty-state comparisons after project load.
 * The resolver must read an already prepared value and must not perform I/O.
 */
export function materializePreparedGenericProjectDataValues<TDocument>(
  document: TDocument,
  resolvePrepared: (ref: AilyDataRef) => unknown,
): TDocument {
  const candidate = cloneJsonValue(document) as TDocument;
  transformPreparedValue(candidate, '', resolvePrepared);
  return candidate;
}

async function transformGenericProjectDataValues<TDocument>(
  document: TDocument,
  resolve: (ref: AilyDataRef) => Promise<unknown>,
): Promise<TDocument> {
  const candidate = cloneJsonValue(document) as TDocument;

  const visit = async (value: unknown, pointer: string): Promise<void> => {
    if (!value || typeof value !== 'object' || isAilyDataRef(value)) return;
    assertValidEnvelopeIfPresent(value, pointer);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) await visit(value[index], `${pointer}/${index}`);
      return;
    }

    const record = value as Record<string, unknown>;
    const fields = record['fields'];
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [fieldName, fieldValue] of Object.entries(fields as Record<string, unknown>)) {
        const fieldPointer = `${pointer}/fields/${escapePointer(fieldName)}`;
        (fields as Record<string, unknown>)[fieldName] = isAilyProjectDataValue(fieldValue)
          ? await resolveAndValidate(fieldValue, resolve, fieldPointer)
          : fieldValue;
      }
    }
    if (Object.prototype.hasOwnProperty.call(record, 'extraState')) {
      const extraStatePointer = `${pointer}/extraState`;
      record['extraState'] = isAilyProjectDataValue(record['extraState'])
        ? await resolveAndValidate(record['extraState'], resolve, extraStatePointer)
        : record['extraState'];
    }

    for (const [key, member] of Object.entries(record)) {
      if (key === 'fields' || key === 'extraState') continue;
      await visit(member, `${pointer}/${escapePointer(key)}`);
    }
  };

  await visit(candidate, '');
  return candidate;
}

function transformPreparedValue(
  value: unknown,
  pointer: string,
  resolvePrepared: (ref: AilyDataRef) => unknown,
): void {
  if (!value || typeof value !== 'object' || isAilyDataRef(value)) return;
  assertValidEnvelopeIfPresent(value, pointer);
  if (Array.isArray(value)) {
    value.forEach((member, index) => transformPreparedValue(member, `${pointer}/${index}`, resolvePrepared));
    return;
  }

  const record = value as Record<string, unknown>;
  const fields = record['fields'];
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    for (const [fieldName, fieldValue] of Object.entries(fields as Record<string, unknown>)) {
      if (!isAilyProjectDataValue(fieldValue)) continue;
      const fieldPointer = `${pointer}/fields/${escapePointer(fieldName)}`;
      (fields as Record<string, unknown>)[fieldName] = validateResolvedValue(
        fieldValue,
        resolvePrepared(fieldValue.$ailyProjectDataValue.ref),
        fieldPointer,
      );
    }
  }
  if (isAilyProjectDataValue(record['extraState'])) {
    const extraStatePointer = `${pointer}/extraState`;
    record['extraState'] = validateResolvedValue(
      record['extraState'],
      resolvePrepared(record['extraState'].$ailyProjectDataValue.ref),
      extraStatePointer,
    );
  }

  for (const [key, member] of Object.entries(record)) {
    if (key === 'fields' || key === 'extraState') continue;
    transformPreparedValue(member, `${pointer}/${escapePointer(key)}`, resolvePrepared);
  }
}

async function resolveAndValidate(
  envelope: AilyProjectDataValue,
  resolve: (ref: AilyDataRef) => Promise<unknown>,
  pointer: string,
): Promise<unknown> {
  return validateResolvedValue(
    envelope,
    await resolve(envelope.$ailyProjectDataValue.ref),
    pointer,
  );
}

function validateResolvedValue(
  envelope: AilyProjectDataValue,
  value: unknown,
  pointer: string,
): unknown {
  const ref = envelope.$ailyProjectDataValue.ref.$ailyData;
  if (ref.codec === 'utf8-v1' && typeof value !== 'string') {
    throw new ProjectDataError('corrupt', `Generic text project data did not resolve to a string at ${pointer}.`);
  }
  if (ref.codec === 'canonical-json-v1' && !isPlainJsonContainer(value)) {
    throw new ProjectDataError('corrupt', `Generic JSON project data did not resolve to an array/object at ${pointer}.`);
  }
  return value;
}

function getGenericCanonicalLength(
  value: unknown,
  codec: 'utf8-v1' | 'canonical-json-v1',
): number {
  return encoder.encode(codec === 'utf8-v1' ? value as string : canonicalJsonStringify(value)).byteLength;
}

function isPlainJsonContainer(value: unknown): value is unknown[] | Record<string, unknown> {
  return Array.isArray(value)
    || (!!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
}

function containsProjectDataReference(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (isAilyDataRef(current) || isAilyProjectDataValue(current)) return true;
    if (Array.isArray(current)) pending.push(...current);
    else pending.push(...Object.values(current as Record<string, unknown>));
  }
  return false;
}

function assertValidEnvelopeIfPresent(value: unknown, pointer: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, '$ailyProjectDataValue')
    && !isAilyProjectDataValue(value)) {
    throw new ProjectDataError('invalid-ref', `Invalid generic project data value at ${pointer || '/'}.`);
  }
}

function cloneJsonValue<TValue>(value: TValue): TValue {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new ProjectDataError('corrupt', 'Project document is not valid serializable JSON.', {
      cause: String(error),
    });
  }
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
