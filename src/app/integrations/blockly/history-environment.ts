import { AbsSyncError } from './abs/abs-state';
import { hashAbsText } from './abs/abs-identity-map';

export interface HistoryEnvironmentFile {
  expectedHash: string | null;
  content: string | null;
}
export interface HistoryEnvironmentPlan {
  version: 1;
  requestId: string;
  files: {
    'package.json': HistoryEnvironmentFile & { content: string };
    'package-lock.json'?: HistoryEnvironmentFile;
    '.npmrc'?: HistoryEnvironmentFile;
    'npm-shrinkwrap.json'?: HistoryEnvironmentFile;
    'yarn.lock'?: HistoryEnvironmentFile;
  };
}
export interface HistoryEnvironmentReferenceFile {
  expectedHash: string | null;
  contentHash: string | null;
}
export type HistoryEnvironmentFileInput = HistoryEnvironmentFile | HistoryEnvironmentReferenceFile;
export interface HistoryEnvironmentInput {
  version: 1;
  requestId: string;
  files: {
    'package.json': (HistoryEnvironmentFile & { content: string }) | (HistoryEnvironmentReferenceFile & { contentHash: string });
    'package-lock.json'?: HistoryEnvironmentFileInput;
    '.npmrc'?: HistoryEnvironmentFileInput;
    'npm-shrinkwrap.json'?: HistoryEnvironmentFileInput;
    'yarn.lock'?: HistoryEnvironmentFileInput;
  };
}
export interface HistoryEnvironmentReferencePlan {
  version: 1;
  requestId: string;
  files: {
    'package.json': HistoryEnvironmentReferenceFile & { contentHash: string };
    'package-lock.json'?: HistoryEnvironmentReferenceFile;
    '.npmrc'?: HistoryEnvironmentReferenceFile;
    'npm-shrinkwrap.json'?: HistoryEnvironmentReferenceFile;
    'yarn.lock'?: HistoryEnvironmentReferenceFile;
  };
}

const invalid = (): never => {
  throw new AbsSyncError('ABS_HISTORY_ENVIRONMENT_INVALID', 'History environment inputs must bind only the exact project dependency files.');
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sourceHash = (value: unknown): value is string => typeof value === 'string' && value.length === 71 && /^sha256:[0-9a-f]{64}$/.test(value);
const environmentNames = ['package.json', 'package-lock.json', '.npmrc', 'npm-shrinkwrap.json', 'yarn.lock'];
function readContent(name: string, field: unknown): HistoryEnvironmentFile {
  if (!record(field) || Object.keys(field).length !== 2 || !Object.hasOwn(field, 'content') || !Object.hasOwn(field, 'expectedHash')
    || Object.keys(field).some(key => !['expectedHash', 'content'].includes(key))
    || field['expectedHash'] !== null && (typeof field['expectedHash'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(field['expectedHash']))
    || field['content'] !== null && typeof field['content'] !== 'string'
    || name === 'package.json' && typeof field['content'] !== 'string') invalid();
  const content = field['content'] as string | null;
  if (content !== null && new TextEncoder().encode(content).byteLength > 128 * 1024 * 1024) invalid();
  if (content !== null && name !== '.npmrc' && name !== 'yarn.lock') {
    try { if (!record(JSON.parse(content))) invalid(); } catch { invalid(); }
  }
  return { expectedHash: field['expectedHash'] as string | null, content };
}

/** Internal History input, included in the original publication digest. It
 * grants no native callback, supplied program receipt, or ABS write authority. */
export function readHistoryEnvironment(value: unknown): HistoryEnvironmentPlan | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value['version'] !== 1
    || typeof value['requestId'] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value['requestId'])
    || Object.keys(value).some(key => !['version', 'requestId', 'files'].includes(key)) || !record(value['files'])) invalid();
  const input = value['files'] as Record<string, unknown>;
  if (!Object.hasOwn(input, 'package.json') || Object.keys(input).some(key => !environmentNames.includes(key))) invalid();
  const files: Record<string, HistoryEnvironmentFile> = {};
  for (const [name, field] of Object.entries(input)) {
    files[name] = readContent(name, field);
  }
  return { version: 1, requestId: value['requestId'] as string, files: files as HistoryEnvironmentPlan['files'] };
}

/** Wire descriptors name the existing project History objects, never paths.
 * Source bodies are optional only at this transport/observation boundary. */
export function readHistoryEnvironmentInput(value: unknown): HistoryEnvironmentInput | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || value['version'] !== 1 || typeof value['requestId'] !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value['requestId'])
    || Object.keys(value).some(key => !['version', 'requestId', 'files'].includes(key)) || !record(value['files'])) invalid();
  const input = value['files'] as Record<string, unknown>;
  if (!Object.hasOwn(input, 'package.json') || Object.keys(input).some(key => !environmentNames.includes(key))) invalid();
  const files: Record<string, HistoryEnvironmentFileInput> = {};
  for (const [name, field] of Object.entries(input)) {
    if (!record(field)) return invalid();
    if (Object.keys(field).length !== 2 || !Object.hasOwn(field, 'expectedHash')
      || field['expectedHash'] !== null && !sourceHash(field['expectedHash'])
      || Object.hasOwn(field, 'content') === Object.hasOwn(field, 'contentHash')) invalid();
    if (Object.hasOwn(field, 'content')) files[name] = readContent(name, field);
    else {
      if (Object.keys(field).some(key => !['expectedHash', 'contentHash'].includes(key))
        || field['contentHash'] !== null && !sourceHash(field['contentHash'])
        || name === 'package.json' && field['contentHash'] === null) invalid();
      files[name] = { expectedHash: field['expectedHash'] as string | null, contentHash: field['contentHash'] as string | null };
    }
  }
  return { version: 1, requestId: value['requestId'] as string, files: files as HistoryEnvironmentInput['files'] };
}

/** Hydration happens only for publication, under the original coordinator lock.
 * Observation uses identity descriptors and performs no object reads. */
export async function hydrateHistoryEnvironment(input: HistoryEnvironmentInput | undefined,
  readObject: (hash: string) => Promise<string | null>): Promise<HistoryEnvironmentPlan | undefined> {
  const parsed = readHistoryEnvironmentInput(input);
  if (!parsed) return undefined;
  const files: Record<string, HistoryEnvironmentFile> = {};
  for (const [name, field] of Object.entries(parsed.files)) {
    if ('content' in field) { files[name] = field; continue; }
    let content: string | null = null;
    if (field.contentHash !== null) {
      if (typeof readObject !== 'function') invalid();
      content = await readObject(field.contentHash);
      if (typeof content !== 'string') invalid();
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > 128 * 1024 * 1024 || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== content
        || await hashAbsText(content) !== field.contentHash) invalid();
    }
    files[name] = { expectedHash: field.expectedHash, content };
  }
  return readHistoryEnvironment({ version: parsed.version, requestId: parsed.requestId, files });
}

export async function historyEnvironmentIdentity(input: HistoryEnvironmentInput | undefined): Promise<HistoryEnvironmentReferencePlan | undefined> {
  const parsed = readHistoryEnvironmentInput(input);
  if (!parsed) return undefined;
  const files: Record<string, HistoryEnvironmentReferenceFile> = {};
  for (const [name, field] of Object.entries(parsed.files)) files[name] = {
    expectedHash: field.expectedHash,
    contentHash: 'contentHash' in field ? field.contentHash : field.content === null ? null : await hashAbsText(field.content),
  };
  return { version: parsed.version, requestId: parsed.requestId, files: files as HistoryEnvironmentReferencePlan['files'] };
}
