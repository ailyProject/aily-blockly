import { canTransferProjectAbi } from './project-abi-transfer';

describe('deep ABI worker transport selection', () => {
  it('keeps wide documents in the worker but avoids structured clone for deep chains', () => {
    expect(canTransferProjectAbi(JSON.stringify({blocks: Array.from({length: 9000}, (_, id) => ({type: 'text', id}))}))).toBeTrue();
    expect(canTransferProjectAbi('['.repeat(256) + '0' + ']'.repeat(256))).toBeTrue();
    const deep = '['.repeat(2400) + '0' + ']'.repeat(2400);
    expect(canTransferProjectAbi(deep)).toBeFalse();
    expect(() => JSON.parse(deep)).not.toThrow();
  });
  it('ignores brackets inside escaped strings and leaves malformed JSON to the parser', () => {
    expect(canTransferProjectAbi(JSON.stringify({text: '\\"' + '[{"'.repeat(5000)}))).toBeTrue();
    expect(canTransferProjectAbi('{"invalid":')).toBeTrue();
  });
});
