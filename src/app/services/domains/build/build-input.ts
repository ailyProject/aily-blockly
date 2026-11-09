/** The immutable private compiler input, independent of the current canvas. */
export interface BuildInput {
  version: 1;
  executionId: string;
  buildRequestId: string;
  inputDigest: string;
  abiHash: string;
}

export function capturedBuildInput(execution: any, requestId: string): BuildInput | undefined {
  if (execution?.version !== 1 || execution.buildRequestId !== requestId
    || !/^[a-f0-9-]{36}$/.test(execution.id ?? '')
    || !/^[a-f0-9]{64}$/.test(execution.inputDigest ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(execution.abiHash ?? '')) return undefined;
  return { version: 1, executionId: execution.id, buildRequestId: requestId,
    inputDigest: execution.inputDigest, abiHash: execution.abiHash };
}
