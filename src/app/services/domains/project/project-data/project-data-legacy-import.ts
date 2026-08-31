import { PutProjectDataRequest } from './project-data-store';
import { assertNoOversizedInlineValues } from './project-data-policy';
import {
  externalizeGenericProjectDataValues,
  GenericProjectDataValueEntry,
} from './project-data-generic-values';
import {
  AilyDataRef,
  createProjectDataMarker,
  isAilyProjectDataMarker,
  ProjectDataError,
  ProjectDataValidationResult,
} from './project-data.types';

interface ProjectDataWriter {
  put<TValue>(request: PutProjectDataRequest<TValue>): Promise<AilyDataRef>;
}

interface ProjectDataImportStore extends ProjectDataWriter {
  flushPending(): Promise<void>;
  collectReferences(value: unknown): AilyDataRef[];
  validateReferences(refs: readonly AilyDataRef[]): Promise<ProjectDataValidationResult>;
}

export interface LegacyProjectDataMigrationEntry {
  readonly path: string;
  readonly codec: string;
  readonly rawLength: number;
  readonly ref: AilyDataRef;
}

export interface LegacyProjectDataMigrationResult {
  readonly migrated: readonly LegacyProjectDataMigrationEntry[];
}

export interface ExternalProjectDataImportResult {
  readonly document: Record<string, unknown>;
  readonly upgradedLegacyDocument: boolean;
  readonly documentChanged: boolean;
  readonly migration: LegacyProjectDataMigrationResult;
  readonly genericExternalized: readonly GenericProjectDataValueEntry[];
}

/**
 * Normalizes an ABI into the external-only schema. Known legacy payloads use
 * specialized codecs; remaining oversized string/JSON field values use the
 * generic persistence envelope. The input is cloned so a failed migration
 * cannot mutate the caller's parsed project document.
 */
export async function ensureExternalProjectDataDocument(
  document: unknown,
  store: ProjectDataImportStore,
): Promise<ExternalProjectDataImportResult> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new ProjectDataError('corrupt', 'project.abi root must be a JSON object.');
  }

  const source = document as Record<string, unknown>;
  const hasMarker = Object.prototype.hasOwnProperty.call(source, '$ailyProjectData');
  if (hasMarker && !isAilyProjectDataMarker(source['$ailyProjectData'])) {
    throw new ProjectDataError(
      'corrupt',
      'Unsupported project.abi $ailyProjectData schema marker.',
    );
  }

  // Always work on a clone. A failed normalization must not partially mutate a
  // parsed ABI that may still be displayed or retried by the caller.
  let candidate = cloneJsonDocument(source);
  const migration = await migrateLegacyInlineProjectData(candidate, store);
  const generic = await externalizeGenericProjectDataValues(candidate, store);
  candidate = generic.document;

  await store.flushPending();
  assertNoOversizedInlineValues(candidate);
  if (!hasMarker) {
    candidate['$ailyProjectData'] = createProjectDataMarker();
  }

  const validation = await store.validateReferences(store.collectReferences(candidate));
  if (!validation.valid) {
    throw new ProjectDataError(
      'missing',
      `Project data validation failed: ${validation.issues.map((issue) => issue.error).join('; ')}`,
      { issues: validation.issues },
    );
  }

  return {
    document: hasMarker && migration.migrated.length === 0 && generic.externalized.length === 0
      ? source
      : candidate,
    upgradedLegacyDocument: !hasMarker,
    documentChanged: !hasMarker || migration.migrated.length > 0 || generic.externalized.length > 0,
    migration,
    genericExternalized: generic.externalized,
  };
}

/**
 * Converts the known pre-v1 inline field payloads at a project import/copy
 * boundary. Runtime ABI loading remains external-only; this is deliberately a
 * one-way import migration rather than a compatibility reader.
 */
export async function migrateLegacyInlineProjectData(
  document: unknown,
  writer: ProjectDataWriter,
): Promise<LegacyProjectDataMigrationResult> {
  const migrated: LegacyProjectDataMigrationEntry[] = [];
  const pending: Array<{ value: unknown; path: string }> = [{ value: document, path: '$' }];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!current.value || typeof current.value !== 'object') continue;

    if (isInlineTftAnimation(current.value)) {
      const entry = await migrateInlineTftAnimation(current.value, current.path, writer);
      migrated.push(entry);
      continue;
    }
    if (isInlineU8g2Animation(current.value)) {
      const entry = await migrateInlineU8g2Animation(current.value, current.path, writer);
      migrated.push(entry);
      continue;
    }

    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        pending.push({ value: current.value[index], path: `${current.path}/${index}` });
      }
      continue;
    }
    const entries = Object.entries(current.value as Record<string, unknown>);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, value] = entries[index];
      pending.push({ value, path: `${current.path}/${escapeJsonPointer(key)}` });
    }
  }

  return { migrated };
}

interface InlineTftAnimation extends Record<string, unknown> {
  version: 1;
  format: 'rgb565' | 'rgb332';
  encoding: 'rgb565-be-base64' | 'rgb332-base64';
  width: number;
  height: number;
  frames: string[];
}

interface InlineU8g2Animation extends Record<string, unknown> {
  width: number;
  height: number;
  frames: number[][][];
}

function isInlineTftAnimation(value: object): value is InlineTftAnimation {
  const candidate = value as Partial<InlineTftAnimation>;
  return candidate.version === 1
    && (candidate.format === 'rgb565' || candidate.format === 'rgb332')
    && (candidate.encoding === 'rgb565-be-base64' || candidate.encoding === 'rgb332-base64')
    && isPositiveSafeInteger(candidate.width)
    && isPositiveSafeInteger(candidate.height)
    && Array.isArray(candidate.frames)
    && candidate.frames.length > 0
    && candidate.frames.every((frame) => typeof frame === 'string');
}

function isInlineU8g2Animation(value: object): value is InlineU8g2Animation {
  const candidate = value as Record<string, unknown>;
  const width = candidate['width'];
  const height = candidate['height'];
  const frames = candidate['frames'];
  return isPositiveSafeInteger(width)
    && isPositiveSafeInteger(height)
    && typeof candidate['dither'] === 'boolean'
    && typeof candidate['threshold'] === 'number'
    && Number.isFinite(candidate['threshold'])
    && Array.isArray(frames)
    && frames.length > 0
    && frames.every((frame) => (
      Array.isArray(frame)
      && frame.length === height
      && frame.every((row) => (
        Array.isArray(row)
        && row.length === width
        && row.every((cell) => cell === 0 || cell === 1)
      ))
    ));
}

async function migrateInlineTftAnimation(
  value: InlineTftAnimation,
  path: string,
  writer: ProjectDataWriter,
): Promise<LegacyProjectDataMigrationEntry> {
  const bytesPerPixel = value.format === 'rgb332' ? 1 : 2;
  const frameByteLength = checkedByteLength(value.width, value.height, bytesPerPixel, path);
  const totalByteLength = checkedByteLength(frameByteLength, value.frames.length, 1, path);
  const packedFrames = new Uint8Array(totalByteLength);
  value.frames.forEach((frame, index) => {
    const bytes = decodeBase64Frame(frame, frameByteLength, `${path}/frames/${index}`);
    packedFrames.set(bytes, index * frameByteLength);
  });

  const codec = value.format === 'rgb332'
    ? 'tft-rgb332-frames-v1'
    : 'tft-rgb565-be-frames-v1';
  const ref = await writer.put({ codec, storage: 'raw-v1', value: packedFrames });
  const mutable = value as Record<string, unknown>;
  delete mutable['version'];
  mutable['schemaVersion'] = 1;
  mutable['encoding'] = value.format === 'rgb332' ? 'rgb332' : 'rgb565-be';
  mutable['frameCount'] = value.frames.length;
  mutable['frames'] = ref;

  return { path, codec, rawLength: packedFrames.byteLength, ref };
}

async function migrateInlineU8g2Animation(
  value: InlineU8g2Animation,
  path: string,
  writer: ProjectDataWriter,
): Promise<LegacyProjectDataMigrationEntry> {
  const bytesPerRow = Math.ceil(value.width / 8);
  const frameByteLength = checkedByteLength(bytesPerRow, value.height, 1, path);
  const packedFrames = new Uint8Array(
    checkedByteLength(frameByteLength, value.frames.length, 1, path),
  );
  value.frames.forEach((frame, frameIndex) => {
    const frameOffset = frameIndex * frameByteLength;
    frame.forEach((row, y) => row.forEach((cell, x) => {
      if (cell === 1) {
        packedFrames[frameOffset + y * bytesPerRow + Math.floor(x / 8)] |= 1 << (x % 8);
      }
    }));
  });

  const codec = 'u8g2-xbm-frames-v1';
  const ref = await writer.put({ codec, storage: 'raw-v1', value: packedFrames });
  const mutable = value as Record<string, unknown>;
  mutable['schemaVersion'] = 1;
  mutable['encoding'] = 'xbm-lsb-row-v1';
  mutable['frameCount'] = value.frames.length;
  mutable['frames'] = ref;

  return { path, codec, rawLength: packedFrames.byteLength, ref };
}

function decodeBase64Frame(encoded: string, expectedLength: number, path: string): Uint8Array {
  const maximumEncodedLength = Math.ceil(expectedLength / 3) * 4;
  if (encoded.length > maximumEncodedLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new ProjectDataError('corrupt', `Legacy project data Base64 is invalid at ${path}.`);
  }
  let binary: string;
  try {
    binary = globalThis.atob(encoded);
  } catch (error) {
    throw new ProjectDataError('corrupt', `Legacy project data Base64 cannot be decoded at ${path}.`, {
      cause: String(error),
    });
  }
  if (binary.length !== expectedLength) {
    throw new ProjectDataError(
      'corrupt',
      `Legacy project data has ${binary.length} bytes at ${path}; expected ${expectedLength}.`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function checkedByteLength(left: number, right: number, factor: number, path: string): number {
  const result = left * right * factor;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 128 * 1024 * 1024) {
    throw new ProjectDataError('too-large', `Legacy project data dimensions are invalid at ${path}.`);
  }
  return result;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function cloneJsonDocument(document: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(document));
  } catch (error) {
    throw new ProjectDataError('corrupt', 'Legacy project.abi is not valid serializable JSON.', {
      cause: String(error),
    });
  }
}
