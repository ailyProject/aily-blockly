import { absJson, hashAbsText } from './abs-identity-map';
import type { AbsSyncStorageAccess } from './abs-baseline-store';
import type { AbsOperationSnapshot } from './abs-operation-journal';
import { AbsSyncError } from './abs-state';

const invalid = () => new AbsSyncError('ABS_OPERATION_CORRUPT', 'The original save input is missing or changed.');
const inputKey = (hash: string) => `recoveries/save-input-${hash.slice(7)}.json`;

/** Invoked inside the project lock. Request identity and its committed pointer stay in its own record. */
export async function encodeSaveSnapshot(storage: AbsSyncStorageAccess, snapshot: AbsOperationSnapshot): Promise<string> {
  if (snapshot.nativeSave?.operation !== 'project_save') return absJson(snapshot);
  const { document, disk, ...request } = snapshot;
  const input = absJson({ document, disk });
  const saveInputHash = await hashAbsText(input);
  const key = inputKey(saveInputHash);
  let existing: string | null;
  try { existing = await storage.read(key); }
  catch (error) {
    if ((error as { code?: string }).code === 'ABS_STORAGE_ENCODING_INVALID') return absJson(snapshot);
    throw error;
  }
  if (existing === null) {
    if (!await storage.replace(key, null, input)) throw invalid();
  } else if (existing !== input) return absJson(snapshot);
  return absJson({ ...request, saveInputHash });
}

export async function readSaveSnapshot(storage: Pick<AbsSyncStorageAccess, 'read'>, text: string) {
  const record = JSON.parse(text);
  if (!Object.prototype.hasOwnProperty.call(record, 'saveInputHash')) return record;
  const { saveInputHash, ...request } = record;
  if (request.version !== 1 || request.kind !== 'document-save' || request.nativeSave?.operation !== 'project_save'
    || typeof saveInputHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(saveInputHash)
    || 'document' in request || 'disk' in request) throw invalid();
  const input = await storage.read(inputKey(saveInputHash));
  if (input === null || await hashAbsText(input) !== saveInputHash) throw invalid();
  const { document, disk } = JSON.parse(input);
  return { ...request, document, disk };
}
