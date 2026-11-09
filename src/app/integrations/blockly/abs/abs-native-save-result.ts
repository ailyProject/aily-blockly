import type { ProjectSaveRequest, ProjectSaveReceiptResponse } from '@domain/project/public-api';
import type { AbsStorageExecutor } from './abs-baseline-store';
import { absJson, hashAbsText } from './abs-identity-map';
import { absProjectionReceipt } from './abs-projection-receipt';
import { readProjectSaveInput } from '../../../services/shared/project-save-input';
import type { NativeSaveIdentity, NativeSaveObservation, NativeSaveResultFacts, NativeSaveBlockStateReceipt } from './abs-native-save-protocol';

/** The input digest describes the original command, never a later GUI capture. */
export async function nativeSaveIdentity(project: string, request: ProjectSaveRequest): Promise<NativeSaveIdentity> {
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/, '');
  const projectKey = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
  const input = readProjectSaveInput(request.input);
  if (input && (request.version !== 2 || request.operation !== 'project_save'))
    throw Object.assign(new Error('Board inputs require the original durable project-save request.'), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
  return { version: 2, requestId: request.requestId, operation: request.operation,
    inputDigest: await hashAbsText(absJson({ version: 2, project: projectKey, operation: request.operation, ...(input ? { input } : {}) })) };
}

/** Maps an already verified publication. It cannot manufacture a commit or
 * prepare a candidate; both direct and restart responses use this same path. */
export function nativeSaveResult(project: string, request: NativeSaveIdentity, facts: NativeSaveResultFacts, current = true) {
  const { blockState, ...publicFacts } = facts as NativeSaveResultFacts & { blockState?: NativeSaveBlockStateReceipt };
  const sourceSaved = facts.publication.status === 'COMMITTED' && facts.projectSaved && !facts.requiresReload && !!facts.evidence;
  const noOp = facts.code === 'BLOCKS_TIDY_NOOP';
  return { ...publicFacts, ok: noOp || sourceSaved && !facts.partial, operation: request.operation, project,
    candidateApplied: false,
    ...(blockState ? { receipt: blockState } : {}),
    ...(noOp ? { noOp: true } : {}),
    ...(sourceSaved && facts.evidence ? {
      generation: facts.evidence.binding.generation,
      projectionReceipt: absProjectionReceipt(request.requestId, facts.evidence, { persisted: true }),
      absPersistence: { verified: current, originalPublicationVerified: true },
      finalValidation: { ok: current, scope: 'complete-source-publication', originalPublicationVerified: true },
    } : {}),
  };
}

export function nativeSaveObservationResponse(
  project: string, request: NativeSaveIdentity, observed: NativeSaveObservation,
  observer: AbsStorageExecutor | undefined, originalTargetPid?: number,
): ProjectSaveReceiptResponse | null {
  if (observed.state === 'not-found') return null;
  const ref = observed.ref;
  if (originalTargetPid !== undefined && ref?.executor.hostPid !== originalTargetPid) return {
    ok: true, operation: 'project_save_status', saveReceipt: { version: 2, requestId: request.requestId,
      project, operation: request.operation, state: 'unknown' }, code: 'PROJECT_SAVE_EXECUTOR_MISMATCH',
  };
  const response = { ok: true as const, operation: 'project_save_status' as const,
    saveReceipt: { version: 2 as const, requestId: request.requestId, project, operation: request.operation,
      state: observed.state === 'completed' ? 'completed' as const
        : observed.state === 'pending' ? 'running' as const : 'unknown' as const },
    ...(observed.state === 'completed' ? { result: nativeSaveResult(project, request, observed.result, observed.current) }
      : { code: observed.code }),
    ...(ref ? { publicationObservation: { version: 1 as const, durable: true, requestId: request.requestId,
      operation: request.operation, operationId: ref.operationId, attachment: ref.attachment,
      executor: ref.executor, observer: { hostPid: observer?.hostPid ?? null },
      current: observed.state === 'completed' && observed.current } } : {}),
  };
  return response;
}
