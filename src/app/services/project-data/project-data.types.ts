export const AILY_DATA_REF_SCHEMA_VERSION = 1 as const;
export const AILY_PROJECT_DATA_SCHEMA_VERSION = 1 as const;
export const AILY_PROJECT_DATA_MODE = 'external-only' as const;
export const AILY_PROJECT_DATA_ABS_HEADER = '# Project Data Schema: 1 (external-only)' as const;
export const DEFAULT_PROJECT_DATA_THRESHOLD_BYTES = 32 * 1024;

export type AilyDataLogicalType = 'text' | 'json' | 'binary';
export type AilyDataStorageEncoding = 'raw-v1' | 'deflate-raw-v1';

export interface AilyDataRefValue {
  readonly schemaVersion: typeof AILY_DATA_REF_SCHEMA_VERSION;
  readonly id: `sha256:${string}`;
  readonly logicalType: AilyDataLogicalType;
  readonly codec: string;
  readonly storage: AilyDataStorageEncoding;
  readonly rawLength: number;
  readonly storedLength: number;
}

export interface AilyDataRef {
  readonly $ailyData: AilyDataRefValue;
}

export interface AilyProjectDataMarker {
  readonly schemaVersion: typeof AILY_PROJECT_DATA_SCHEMA_VERSION;
  readonly mode: typeof AILY_PROJECT_DATA_MODE;
}

export interface ProjectDataInspection {
  readonly ref: AilyDataRef;
  readonly path: string;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly error?: string;
}

export interface ProjectDataValidationIssue {
  readonly ref: AilyDataRef;
  readonly error: string;
}

export interface ProjectDataValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ProjectDataValidationIssue[];
}

export interface ProjectDataResourceEntry {
  readonly id: `sha256:${string}`;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly referenced: boolean;
}

export interface ProjectDataStatistics {
  readonly resourceCount: number;
  readonly referencedCount: number;
  readonly unreferencedCount: number;
  readonly storedBytes: number;
  readonly unreferencedBytes: number;
  readonly resources: readonly ProjectDataResourceEntry[];
}

export interface ProjectDataGcResult {
  readonly dryRun: boolean;
  readonly gracePeriodMs: number;
  readonly scannedCount: number;
  readonly deletedCount: number;
  readonly deletedBytes: number;
  readonly retainedCount: number;
  readonly candidates: readonly ProjectDataResourceEntry[];
}

export interface ProjectDataClipboardResource {
  readonly ref: AilyDataRef;
  readonly containerBase64: string;
}

export interface ProjectDataClipboardBundle {
  readonly schemaVersion: 1;
  readonly resources: readonly ProjectDataClipboardResource[];
}

export type ProjectDataErrorCode =
  | 'not-configured'
  | 'invalid-ref'
  | 'unsupported-codec'
  | 'unsupported-storage'
  | 'missing'
  | 'corrupt'
  | 'too-large'
  | 'cancelled'
  | 'io-error';

export class ProjectDataError extends Error {
  constructor(
    readonly code: ProjectDataErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ProjectDataError';
  }
}

const SHA256_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CODEC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function isAilyDataRef(value: unknown): value is AilyDataRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const outer = value as Record<string, unknown>;
  if (Object.keys(outer).length !== 1 || !outer['$ailyData']) return false;

  const data = outer['$ailyData'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const ref = data as Record<string, unknown>;
  const expectedKeys = ['schemaVersion', 'id', 'logicalType', 'codec', 'storage', 'rawLength', 'storedLength'];
  if (Object.keys(ref).length !== expectedKeys.length || expectedKeys.some((key) => !(key in ref))) return false;

  return ref['schemaVersion'] === AILY_DATA_REF_SCHEMA_VERSION
    && typeof ref['id'] === 'string'
    && SHA256_ID_PATTERN.test(ref['id'])
    && (ref['logicalType'] === 'text' || ref['logicalType'] === 'json' || ref['logicalType'] === 'binary')
    && typeof ref['codec'] === 'string'
    && CODEC_ID_PATTERN.test(ref['codec'])
    && (ref['storage'] === 'raw-v1' || ref['storage'] === 'deflate-raw-v1')
    && isSafeLength(ref['rawLength'])
    && isSafeLength(ref['storedLength']);
}

export function assertAilyDataRef(value: unknown): asserts value is AilyDataRef {
  if (!isAilyDataRef(value)) {
    throw new ProjectDataError('invalid-ref', 'Invalid AilyDataRef.');
  }
}

export function areAilyDataRefsEquivalent(left: unknown, right: unknown): boolean {
  if (!isAilyDataRef(left) || !isAilyDataRef(right)) return false;
  const leftData = left.$ailyData;
  const rightData = right.$ailyData;
  return leftData.schemaVersion === rightData.schemaVersion
    && leftData.id === rightData.id
    && leftData.logicalType === rightData.logicalType
    && leftData.codec === rightData.codec
    && leftData.storage === rightData.storage
    && leftData.rawLength === rightData.rawLength
    && leftData.storedLength === rightData.storedLength;
}

export function getAilyDataHash(ref: AilyDataRef): string {
  assertAilyDataRef(ref);
  return ref.$ailyData.id.slice('sha256:'.length);
}

export function createProjectDataMarker(): AilyProjectDataMarker {
  return {
    schemaVersion: AILY_PROJECT_DATA_SCHEMA_VERSION,
    mode: AILY_PROJECT_DATA_MODE,
  };
}

export function isAilyProjectDataMarker(value: unknown): value is AilyProjectDataMarker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker['schemaVersion'] === AILY_PROJECT_DATA_SCHEMA_VERSION
    && marker['mode'] === AILY_PROJECT_DATA_MODE;
}

export function hasAilyProjectDataAbsHeader(value: string): boolean {
  return value.split(/\r?\n/).some((line) => line.trim() === AILY_PROJECT_DATA_ABS_HEADER);
}

function isSafeLength(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}
