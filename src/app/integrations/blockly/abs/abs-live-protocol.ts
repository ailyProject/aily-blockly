import { assertGenerationCandidate, assertGenerationProjectionRequest, assertGenerationRequest, readGenerationApplyValidation } from './abs-generation-protocol';
import { serializeAbsFailure } from './abs-diagnostics';
import { AbsSyncError } from './abs-state';

// Only obsolete remote writes are retired. Native UI editing is unrelated to this boundary.
const retiredWrites = new Set(['abi_add', 'abi_delete', 'abi_connect', 'abi_set_field', 'abi_move']);
const generationOperations = new Set(['abs_projection', 'abs_validate', 'abs_apply', 'abs_recovery']);

export const ABS_LIVE_PROTOCOL = Object.freeze({ generation: 2, absSchema: 2, legacyAbiWrites: false });

/** Pure admission before file reads, runtime loading, lifecycle ownership or workspace mutation. */
export function rejectAbsLiveRequest(operation: string, input: Record<string, any>) {
  try {
    if (retiredWrites.has(operation)) {
      throw new AbsSyncError('ABS_PROTOCOL_REQUIRED', 'Legacy ABI writes are retired. Use the current Agent ABS apply tool.', undefined, [], {
        reason: 'legacy-abi-write', hint: 'Update/reconnect Chat or the MCP client. Do not fall back to offline ABI writes after an ABS failure.',
      });
    }
    if (!generationOperations.has(operation)) return null;
    assertGenerationRequest(input);
    if (operation === 'abs_projection') assertGenerationProjectionRequest(input);
    if (operation === 'abs_validate') assertGenerationCandidate(input);
    if (operation === 'abs_apply') {
      const receipt = readGenerationApplyValidation(input);
      if (typeof receipt['libraryRuntimeFingerprint'] !== 'string' || !/^[a-f0-9]{64}$/.test(receipt['libraryRuntimeFingerprint'])) {
        throw new AbsSyncError('ABS_REQUEST_INVALID', 'The preparation receipt lacks a valid library runtime fingerprint.', undefined, [], {
          reason: 'invalid-runtime-fingerprint', hint: 'Update/reconnect the Agent and prepare the candidate again. Do not fabricate a runtime fingerprint.',
        });
      }
    }
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
    publication: { status: 'NOT_COMMITTED' },
    diagnostic: { reason: unavailable ? 'library-runtime-unavailable' : 'library-runtime-changed' },
    message: unavailable ? 'The current library runtime is not ready; ABS was not applied.'
      : 'Library runtime content does not match the validation receipt; ABS was not applied.',
    recovery: unavailable
      ? 'Retain the candidate. Wait for or repair host library loading, then prepare it again. Do not replay apply or edit ABI/map data.'
      : 'Retain the candidate. Synchronize the library runtime and prepare against the current generation. Do not replay the old validation receipt.',
  };
}
