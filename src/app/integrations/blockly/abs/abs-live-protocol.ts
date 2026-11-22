import { assertGenerationCandidate, assertGenerationProjectionRequest, assertGenerationProtocolVersion, assertGenerationRequest, readGenerationApplyValidation } from './abs-generation-protocol';
import { serializeAbsFailure } from './abs-diagnostics';
import { AbsSyncError } from './abs-state';
import { readAbsBlockStateRequest } from './abs-block-state';
import { assertProgramDriftShape } from './abs-program-drift';

// Only obsolete remote writes are retired. Native UI editing is unrelated to this boundary.
const retiredWrites = new Set(['abi_add', 'abi_delete', 'abi_connect', 'abi_set_field', 'abi_move']);
const generationOperations = new Set(['abs_projection', 'abs_validate', 'abs_apply', 'abs_recovery']);

export const ABS_LIVE_PROTOCOL = Object.freeze({ generation: 2, absSchema: 2, legacyAbiWrites: false, workingCandidateVersion: 1 });

/** Protocol support is static; it grants no workspace, candidate or write authority. */
export function absProtocolReply(project: string, input: Record<string, unknown>) {
  if (input['version'] !== 1 || Object.keys(input).some(key => key !== 'version'))
    return { ok: false, operation: 'abs_protocol', project, code: 'ABS_REQUEST_INVALID',
      message: 'Protocol discovery requires version 1 and no runtime query fields.' };
  return { ok: true, operation: 'abs_protocol', project, protocol: { version: 1, ...ABS_LIVE_PROTOCOL } };
}

function requireCurrentWriter(value: unknown) {
  if (value === undefined) throw new AbsSyncError('ABS_PROTOCOL_REQUIRED',
    'This writer requires an immutable WorkingCandidate. The system retains the original draft for automatic migration.',
    undefined, [], { reason: 'legacy-baseline-writer-retired' });
}

/** Pure admission before file reads, runtime loading, lifecycle ownership or workspace mutation. */
export function rejectAbsLiveRequest(operation: string, input: Record<string, any>) {
  try {
    if (retiredWrites.has(operation)) {
      throw new AbsSyncError('ABS_PROTOCOL_REQUIRED', 'Legacy ABI writes are retired. Use the current Agent ABS apply tool.', undefined, [], {
        reason: 'legacy-abi-write', hint: 'Update/reconnect Chat or the MCP client. Do not fall back to offline ABI writes after an ABS failure.',
      });
    }
    if (operation === 'blocks_set_state') { readAbsBlockStateRequest(input); return null; }
    if (!generationOperations.has(operation)) return null;
    if (operation === 'abs_recovery' && ['recover_project', 'cancel_project'].includes(input['action'])) {
      assertGenerationProtocolVersion(input);
      if (typeof input['requestId'] !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(input['requestId'])) {
        throw new AbsSyncError('ABS_REQUEST_INVALID', 'A valid original project recovery requestId is required.',
          undefined, [], { reason: 'invalid-request-id' });
      }
      return null;
    }
    assertGenerationRequest(input);
    if (operation === 'abs_recovery' && input['action'] === 'reconcile_program') {
      if (Object.keys(input).some(key => !['version', 'requestId', 'action', 'observation'].includes(key)))
        throw new AbsSyncError('ABS_REQUEST_INVALID', 'Program reconciliation accepts only its exact observation.');
      assertProgramDriftShape(input['observation']);
    }
    if (operation === 'abs_projection') {
      assertGenerationProjectionRequest(input);
      throw new AbsSyncError('ABS_PROTOCOL_REQUIRED', 'Legacy projection is retired; capture the current Working view using the current tools.',
        undefined, [], { reason: 'legacy-projection-retired' });
    }
    if (operation === 'abs_validate') { assertGenerationCandidate(input); requireCurrentWriter(input['workingCandidate']); }
    if (operation === 'abs_apply') {
      const receipt = readGenerationApplyValidation(input);
      if (typeof receipt['libraryRuntimeFingerprint'] !== 'string' || !/^[a-f0-9]{64}$/.test(receipt['libraryRuntimeFingerprint'])) {
        throw new AbsSyncError('ABS_REQUEST_INVALID', 'The preparation receipt lacks a valid library runtime fingerprint.', undefined, [], {
          reason: 'invalid-runtime-fingerprint', hint: 'Update/reconnect the Agent and prepare the candidate again. Do not fabricate a runtime fingerprint.',
        });
      }
      requireCurrentWriter(receipt['workingCandidate']);
    }
    if (operation === 'abs_recovery' && ['preserve_candidate', 'repair', 'refresh', 'resolve', 'reopen', 'prepare_native', 'abandon'].includes(input['action'])
      && !(input['observe'] === true && ['resolve', 'prepare_native'].includes(input['action'])))
      throw new AbsSyncError('ABS_PROTOCOL_REQUIRED', 'Legacy baseline mutations are retired. Retained records remain readable for automatic recovery.',
        undefined, [], { reason: 'legacy-baseline-writer-retired' });
    if (operation === 'abs_validate' || operation === 'abs_apply') {
      const text = typeof input['abs'] === 'string', file = typeof input['absPath'] === 'string';
      if (text === file || !(text ? input['abs'] : input['absPath']).trim()) {
        throw new AbsSyncError('ABS_REQUEST_INVALID', 'Provide exactly one nonempty ABS text or file path.', undefined, [], { reason: 'invalid-abs-source' });
      }
    }
    return null;
  } catch (error) {
    return absPrecommitFailure(operation, error);
  }
}

/** Only for errors before entering the publisher, never for an uncertain publication. */
export function absPrecommitFailure(operation: string, error: unknown) {
  const failure = serializeAbsFailure(error);
  return { ok: false, operation, ...failure, publication: { status: 'NOT_COMMITTED' },
    recovery: failure.diagnostic?.hint ?? (failure.code === 'ABS_PROTOCOL_REQUIRED'
      ? 'Update the host and Agent together and reconnect. Retain the candidate; do not replay unchanged requests or edit internal protocol data.'
      : 'Retain the candidate. Correct the reported request or host input error using the current Agent tool; do not fabricate receipts or overwrite ABI/map data.') };
}

/** Null means unavailable, not proof that a previously validated runtime changed. */
export function rejectAbsRuntime(operation: 'abs_validate' | 'abs_apply', current: string | null, expected?: string) {
  if (current && (expected === undefined || current === expected)) return null;
  const unavailable = !current;
  return {
    ok: false, operation, code: unavailable ? 'ABS_RUNTIME_NOT_READY' : 'ABS_RUNTIME_CONTRACT_STALE',
    application: { status: 'NOT_STARTED' },
    publication: { status: 'NOT_COMMITTED' },
    diagnostic: { reason: unavailable ? 'library-runtime-unavailable' : 'library-runtime-changed' },
    message: unavailable ? 'The current library runtime is not ready; ABS was not applied.'
      : 'Library runtime content does not match the validation receipt; ABS was not applied.',
    recovery: unavailable
      ? 'Retain the candidate. Wait for or repair host library loading, then prepare it again. Do not replay apply or edit ABI/map data.'
      : 'Retain the candidate. Synchronize the library runtime and prepare against the current generation. Do not replay the old validation receipt.',
  };
}
