import {
  AilyDataStorageEncoding,
  DEFAULT_PROJECT_DATA_THRESHOLD_BYTES,
  isAilyDataRef,
  ProjectDataError,
} from './project-data.types';

export interface ProjectDataSlotPolicy<TValue = unknown> {
  readonly id: string;
  readonly codec: string;
  readonly storage: AilyDataStorageEncoding;
  readonly mode: 'always-external' | 'threshold';
  readonly thresholdBytes?: number;
  readonly maxRawLength: number;
  readonly _valueType?: TValue;
}

export interface OversizedInlineValueDiagnostic {
  readonly blockId?: string;
  readonly blockType?: string;
  readonly fieldName?: string;
  readonly jsonPointer: string;
  readonly canonicalLength: number;
  readonly threshold: number;
}

interface BlockContext {
  readonly blockId?: string;
  readonly blockType?: string;
}

const encoder = new TextEncoder();

export function findOversizedInlineValues(
  document: unknown,
  threshold = DEFAULT_PROJECT_DATA_THRESHOLD_BYTES,
): OversizedInlineValueDiagnostic[] {
  const diagnostics: OversizedInlineValueDiagnostic[] = [];
  const visited = new WeakSet<object>();

  const inspectCandidate = (
    value: unknown,
    jsonPointer: string,
    context: BlockContext,
    fieldName?: string,
  ) => {
    if (value === null || value === undefined || isAilyDataRef(value)) return;
    const canonicalLength = getCanonicalLength(value);
    if (canonicalLength <= threshold) return;
    diagnostics.push({ ...context, fieldName, jsonPointer, canonicalLength, threshold });
  };

  const visit = (value: unknown, pointer: string, inheritedContext: BlockContext) => {
    if (!value || typeof value !== 'object' || isAilyDataRef(value)) return;
    if (visited.has(value)) return;
    visited.add(value);

    const record = value as Record<string, unknown>;
    const context: BlockContext = {
      blockId: typeof record['id'] === 'string' ? record['id'] : inheritedContext.blockId,
      blockType: typeof record['type'] === 'string' ? record['type'] : inheritedContext.blockType,
    };
    const fields = record['fields'];
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [fieldName, fieldValue] of Object.entries(fields as Record<string, unknown>)) {
        inspectCandidate(fieldValue, `${pointer}/fields/${escapePointer(fieldName)}`, context, fieldName);
      }
    }
    if (Object.prototype.hasOwnProperty.call(record, 'extraState')) {
      inspectCandidate(record['extraState'], `${pointer}/extraState`, context);
    }

    if (Array.isArray(value)) {
      value.forEach((member, index) => visit(member, `${pointer}/${index}`, context));
    } else {
      for (const [key, member] of Object.entries(record)) {
        visit(member, `${pointer}/${escapePointer(key)}`, context);
      }
    }
  };

  visit(document, '', {});
  return diagnostics;
}

export function assertNoOversizedInlineValues(
  document: unknown,
  threshold = DEFAULT_PROJECT_DATA_THRESHOLD_BYTES,
): void {
  const diagnostics = findOversizedInlineValues(document, threshold);
  if (diagnostics.length === 0) return;
  throw new ProjectDataError(
    'too-large',
    `Project contains ${diagnostics.length} oversized inline field value(s). Register a Project Data Slot before saving.`,
    { diagnostics },
  );
}

function getCanonicalLength(value: unknown): number {
  if (typeof value === 'string') return encoder.encode(value).byteLength;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? encoder.encode(json).byteLength : 0;
  } catch (error) {
    throw new ProjectDataError('corrupt', 'Project contains a non-serializable field value.', { error });
  }
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}
