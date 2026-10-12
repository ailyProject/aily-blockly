import type { NativeCandidateOptions, NativeCandidateRequest, NativeCandidateResult } from './blockly-native-candidate-protocol';
import { cloneNativeCandidateRequest } from './blockly-native-transfer';
import { readAbsSyntax } from '../../../integrations/blockly/abs/abs-syntax';
import { walkAbsRawSyntax } from '../../../integrations/blockly/abs/abs-syntax-binding';
import { indexAbsAbi } from '../../../integrations/blockly/abs/abs-abi-index';

/** One recovery allowance for an entire preparation, shared by binding and
 * verification. Only disposable executions may use this; never wrap apply/save.
 * execute must finish disposing its realm before rejecting. */
export function createNativeCandidateRecovery(
  execute: (request: NativeCandidateRequest, options: NativeCandidateOptions) => Promise<NativeCandidateResult>,
  assertCurrent: () => void,
) {
  let recovered = false;
  return async (request: NativeCandidateRequest): Promise<NativeCandidateResult> => {
    const snapshot = cloneNativeCandidateRequest(request);
    assertCurrent();
    // Large complete workspaces need the existing recovery allowance up front.
    // Avoid discarding a healthy 10s run and repeating its full preparation.
    // A 30s timeout still ends preparation; it must not trigger another 30s run.
    const large = snapshot.abs !== undefined
      ? [...walkAbsRawSyntax(readAbsSyntax(snapshot.abs))].length >= 2000
      : snapshot.verify !== undefined ? indexAbsAbi(snapshot.verify.state).size >= 2000 : false;
    if (large) recovered = true;
    try {
      return await execute(cloneNativeCandidateRequest(snapshot), { assertCurrent, ...(large ? { timeoutMs: 30000 } : {}) });
    } catch (error) {
      if (error?.code !== 'ABS_NATIVE_TIMEOUT' || recovered) throw error;
      // A stale project, cancellation or changed program must not get another run.
      assertCurrent();
      recovered = true;
      // 30s bounds the complete retry, including both verification passes.
      // No text change, partial result, cached realm or transport replay is used.
      return execute(snapshot, { assertCurrent, timeoutMs: 30000 });
    }
  };
}
