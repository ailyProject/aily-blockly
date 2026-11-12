import { AbsApplicationJournal } from './abs-application-journal';
import { AbsOperationJournal, type AbsUnpublishedDocumentSave } from './abs-operation-journal';
import { openAbsHostStorage } from './abs-host-storage';
import { absJson } from './abs-identity-map';
import { AbsSyncError } from './abs-state';
import type { NativeSaveObservation, NativeSaveOperationRef } from './abs-native-save-protocol';

export interface RuntimePublicationObservation {
  observation: NativeSaveObservation;
  unpublishedSource?: AbsUnpublishedDocumentSave;
}

/** Activation may need source facts before the old Working document can load
 * against its correct environment. No GUI instance or program replay is used. */
export async function observeRuntimePublication(path: string, ref: NativeSaveOperationRef,
  guard: () => void): Promise<RuntimePublicationObservation> {
  const port = await openAbsHostStorage(path, guard), project = port.attachment?.root ?? path;
  const observation = await new AbsApplicationJournal(port, project).observeNativeSave(ref.request, guard);
  if ('ref' in observation && observation.ref && absJson(observation.ref) !== absJson(ref)) {
    throw new AbsSyncError('ABS_NATIVE_SAVE_REQUEST_CONFLICT', 'The environment refers to a different original source publication.');
  }
  const unpublishedSource = observation.state !== 'completed'
    ? await new AbsOperationJournal(port, project).inspectUnpublishedDocumentSave(ref, guard) : null;
  guard();
  return { observation, ...(unpublishedSource ? { unpublishedSource } : {}) };
}
