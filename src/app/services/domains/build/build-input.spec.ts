import { capturedBuildInput } from './build-input';

describe('immutable build input references', () => {
  const execution = { version: 1, id: '11111111-1111-1111-1111-111111111111',
    buildRequestId: 'original-request', inputDigest: 'a'.repeat(64), abiHash: 'sha256:' + 'b'.repeat(64) };
  it('keeps the fixed compiler input only for its exact original build request', () => {
    expect(capturedBuildInput(execution, 'original-request')).toEqual({ version: 1,
      executionId: execution.id, buildRequestId: execution.buildRequestId,
      inputDigest: execution.inputDigest, abiHash: execution.abiHash });
    expect(capturedBuildInput(execution, 'new-request')).toBeUndefined();
    expect(capturedBuildInput({ ...execution, abiHash: undefined }, 'original-request')).toBeUndefined();
    expect(capturedBuildInput(undefined, 'original-request')).toBeUndefined();
  });
});
