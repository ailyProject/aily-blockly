/** The immutable private compiler input, independent of the current canvas. */
export interface BuildInput {
  version: 1;
  executionId: string;
  buildRequestId: string;
  inputDigest: string;
  abiHash: string;
}

export function readPreparedBuildInput(value: unknown): BuildInput {
  const input = value as BuildInput | null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 5 || input.version !== 1
    || typeof input.executionId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.executionId)
    || typeof input.buildRequestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.buildRequestId)
    || typeof input.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.inputDigest)
    || typeof input.abiHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.abiHash)) {
    throw Object.assign(new Error('Invalid prepared firmware reference.'), { code: 'PREPARED_FIRMWARE_INVALID' });
  }
  return { version: 1, executionId: input.executionId, buildRequestId: input.buildRequestId,
    inputDigest: input.inputDigest, abiHash: input.abiHash };
}

export function requirePreparedBuildExecution(project: string, input: BuildInput) {
  const observed = window['builder']?.inspectBuildExecution?.(project, input.buildRequestId);
  const execution = observed?.result;
  if (observed?.status !== 'completed' || observed.current !== true
    || observed.executionId !== input.executionId || observed.buildRequestId !== input.buildRequestId
    || observed.inputDigest !== input.inputDigest || observed.buildInput?.abiHash !== input.abiHash
    || execution?.buildRequestId !== input.buildRequestId || execution.inputDigest !== input.inputDigest) {
    throw Object.assign(new Error('Prepared firmware no longer matches the current completed build.'), { code: 'BUILD_ARTIFACT_STALE' });
  }
  return execution;
}

export function capturedBuildInput(execution: any, requestId: string): BuildInput | undefined {
  if (execution?.version !== 1 || execution.buildRequestId !== requestId
    || !/^[a-f0-9-]{36}$/.test(execution.id ?? '')
    || !/^[a-f0-9]{64}$/.test(execution.inputDigest ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(execution.abiHash ?? '')) return undefined;
  return { version: 1, executionId: execution.id, buildRequestId: requestId,
    inputDigest: execution.inputDigest, abiHash: execution.abiHash };
}
