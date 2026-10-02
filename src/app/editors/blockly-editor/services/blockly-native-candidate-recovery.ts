import type { NativeCandidateOptions, NativeCandidateRequest, NativeCandidateResult } from './blockly-native-candidate-protocol';

/** One recovery allowance for an entire preparation, shared by binding and
 * verification. Only disposable executions may use this; never wrap apply/save.
 * execute must finish disposing its realm before rejecting. */
export function createNativeCandidateRecovery(
  execute: (request: NativeCandidateRequest, options: NativeCandidateOptions) => Promise<NativeCandidateResult>,
  assertCurrent: () => void,
) {
  let recovered = false;
  return async (request: NativeCandidateRequest): Promise<NativeCandidateResult> => {
    const snapshot = structuredClone(request);
    assertCurrent();
    try {
      return await execute(structuredClone(snapshot), { assertCurrent });
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
