import {
  AilyDataStorageEncoding,
  DEFAULT_PROJECT_DATA_THRESHOLD_BYTES,
  isAilyDataRef,
  isAilyProjectDataValue,
  ProjectDataError,
} from './project-data.types';
import { assertProjectDataEnvelope, collectProjectDataPayloads, containsProjectDataReference, projectDataChildPointer } from './project-data-payloads';

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

  const inspectCandidate = (
    value: unknown,
    jsonPointer: string,
    context: BlockContext,
    fieldName?: string,
  ) => {
    assertProjectDataEnvelope(value, jsonPointer);
    if (value === null || value === undefined || isAilyDataRef(value) || isAilyProjectDataValue(value)) return;
    if (containsProjectDataReference(value)) {
      for (const [key, member] of Object.entries(value as object)) {
        inspectCandidate(member, projectDataChildPointer(jsonPointer, key), context, fieldName);
      }
      return;
    }
    const canonicalLength = getCanonicalLength(value);
    if (canonicalLength <= threshold) return;
    diagnostics.push({ ...context, fieldName, jsonPointer, canonicalLength, threshold });
  };

  for (const { owner, key, jsonPointer, fieldName, ...context } of collectProjectDataPayloads(document)) {
    inspectCandidate(owner[key], jsonPointer, context, fieldName);
  }
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
    `Project contains ${diagnostics.length} oversized inline payload(s). Prepare Project Data before saving.`,
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
