import type { ProjectSaveReceipt, ProjectSaveReceiptResponse } from '@domain/project/public-api';
import { AbsApplicationJournal } from './abs-application-journal';
import type { AbsSyncStoragePort } from './abs-baseline-store';
import type { NativeSaveIdentity } from './abs-native-save-protocol';
import { nativeSaveAdmissionResponse, nativeSaveObservationResponse, nativeSaveWriterReleaseResponse } from './abs-native-save-result';
import { AbsOperationJournal } from './abs-operation-journal';
import { nativeSaveAdmissionIdentity, OriginalRequestAdmissions } from './original-request-admission';

/** Observe only the requested publication on the physical, already-opened
 * storage port. Writer retirement seals journal evidence without granting save
 * or canvas authority. */
export async function observeNativePublication(port: AbsSyncStoragePort, project: string, identity: NativeSaveIdentity,
  { originalTargetPid, viewRevision, input }: { originalTargetPid?: number; viewRevision?: () => number; input?: ProjectSaveReceipt['input'] } = {},
): Promise<ProjectSaveReceiptResponse | null> {
  const request = { ...identity, input };
  const admission = nativeSaveAdmissionIdentity(identity);
  const admissions = new OriginalRequestAdmissions(port, project);
  if (admission) {
    const rejected = await admissions.observe(admission);
    if (rejected) return nativeSaveAdmissionResponse(rejected, request, port.executor, originalTargetPid);
  }
  const guard = () => undefined;
  const observed = await new AbsApplicationJournal(port, project).observeNativeSave(identity, guard);
  if (admission && originalTargetPid !== undefined && observed.state !== 'completed') {
    if (observed.state === 'not-found') {
      const retired = viewRevision && await admissions.retireSupersededSave(identity, originalTargetPid, viewRevision);
      if (retired) return nativeSaveAdmissionResponse(retired, request, port.executor, originalTargetPid);
      const writer = await admissions.observeExitedSaveWriter(identity, originalTargetPid);
      if (writer) return nativeSaveWriterReleaseResponse(project, request, { ...writer, observer: { hostPid: port.executor?.hostPid ?? null } });
    } else if (observed.ref?.executor.hostPid === originalTargetPid) {
      const writer = await new AbsOperationJournal(port, project).observeSaveWriterSettlement(observed.ref, guard);
      if (writer) return nativeSaveWriterReleaseResponse(project, request, writer);
    }
  }
  const response = nativeSaveObservationResponse(project, identity, observed, port.executor, originalTargetPid);
  return response && input ? { ...response, saveReceipt: { ...response.saveReceipt, input: structuredClone(input) } } : response;
}
