import { assertSynchronousNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate-policy';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';

describe('synchronous native replay policy', () => {
  const request = (source: string): NativeCandidateRequest => ({ blocks: [], steps: [{ kind: 'script', label: 'library', source }] });

  it('does not rewrite source or mistake strings/comments and ordinary async-named methods for async code', () => {
    const input = request(`// async function ignored() {}
      const label = "await import('text')";
      const hooks = { async() { return label; } };`);
    const before = structuredClone(input);
    Object.freeze(input.steps[0]); Object.freeze(input.steps); Object.freeze(input);
    assertSynchronousNativeCandidate(input);
    expect(input).toEqual(before);
  });

  for (const source of [
    'async function unused() {}',
    'const unused = async () => 1;',
    'class Field { async prepare() { await 0; } }',
    'async function* stream() { yield 1; }',
    "function unused() { return import('./module.js'); }",
  ]) it('rejects unsupported syntax before executing any library code: ' + source, () => {
    expect(() => assertSynchronousNativeCandidate(request(source))).toThrowError(/does not support/);
  });
});
