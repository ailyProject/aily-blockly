import { cloneBlocklyJson } from '@domain/project/public-api';
import { createAbsProjection, indexAbsAbi, indexAbsSyntax } from './abs-identity-map';
import { reconcileAbs } from './abs-reconciler';
import { parseAbsSyntax } from './abs-syntax';
import { absSyntaxOptions } from './abs-syntax-contracts';
import type { AbsAbiBlock, AbsProjectionContracts } from './abs-state';
import { createAbsReadbackVerifier } from './abs-readback';
import { cloneNativeCandidateRequest, encodeNativeCandidateRequest, decodeNativeCandidateRequest,
  encodeNativeCandidateResult, decodeNativeCandidateResult } from '../../../editors/blockly-editor/services/blockly-native-transfer';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';

function sequential(size: number) {
  const root: AbsAbiBlock = { id: 'root', type: 'root' };
  const contracts: AbsProjectionContracts = { fields: { root: {} }, syntax: {
    root: [{ kind: 'statementInput', name: 'BODY' }],
  } };
  let tail: AbsAbiBlock | undefined;
  for (let n = 0; n < size; n++) {
    const block: AbsAbiBlock = { id: `b${n}`, type: 'step', fields: { NUM: n } };
    contracts.fields[block.id] = { NUM: { type: 'field_number' } };
    contracts.syntax![block.id] = [{ kind: 'field', name: 'NUM' }];
    if (tail) tail.next = { block };
    else root.inputs = { BODY: { block } };
    tail = block;
  }
  return { workspace: { blocks: { blocks: [root] } }, contracts };
}

describe('ABS large sequential projects', () => {
  it('admits long next chains while preserving order and rejecting real excessive input nesting or duplicate identities', () => {
    const { workspace } = sequential(5000);
    const blocks = indexAbsAbi(workspace);
    expect(blocks.size).toBe(5001);
    expect([...blocks.keys()].slice(0, 4)).toEqual(['root', 'b0', 'b1', 'b2']);
    const duplicate = cloneBlocklyJson(workspace);
    duplicate.blocks.blocks.push({ id: 'b4999', type: 'step' });
    expect(() => indexAbsAbi(duplicate)).toThrowError(/Repeated identity/);
    let block: AbsAbiBlock = { id: 'nested', type: 'step' };
    const nested = { blocks: { blocks: [block] } };
    for (let n = 0; n < 129; n++) {
      const child = { id: `input${n}`, type: 'step' };
      block.inputs = { VALUE: { block: child } }; block = child;
    }
    try { indexAbsAbi(nested); fail('accepted nesting'); }
    catch (error) { expect(error.diagnostic.capacity).toEqual({ phase: 'index', resource: 'inputDepth', actual: 129, limit: 128 }); }
  });

  it('exports, edits and rebuilds a long program without losing unrelated identities, connections or protected state', async () => {
    const { workspace, contracts } = sequential(1500);
    indexAbsAbi(workspace).get('b1499')!['deletable'] = false;
    const baseline = await createAbsProjection(workspace, { document: workspace, contracts,
      generation: 'large', baselineRef: 'large', scope: { projectKey: 'large', pageId: 'main' }, savedAbiHash: null });
    expect(indexAbsSyntax(parseAbsSyntax(baseline.abs, absSyntaxOptions(workspace, contracts))).length).toBe(1501);
    const result = await reconcileAbs(baseline, baseline.abs.replace('step(1000)', 'step(5000)'));
    const actual = indexAbsAbi(result.workspace);
    expect(actual.get('b1000')!.fields!['NUM']).toBe(5000);
    expect(actual.get('b1499')!['deletable']).toBeFalse();
    expect(result.added).toEqual([]); expect(result.removed).toEqual([]);
    const expected = cloneBlocklyJson(workspace);
    indexAbsAbi(expected).get('b1000')!.fields!['NUM'] = 5000;
    createAbsReadbackVerifier(expected)(result.workspace);
  });

  it('transfers deep verification state and syntax while retaining binary resources and detached ownership', () => {
    const { workspace, contracts } = sequential(2000);
    const request = { steps: [], blocks: [], values: [{ ref: {} as any, value: new Uint8Array([1, 2]) }], verify: { state: workspace, contracts } };
    const detached = cloneNativeCandidateRequest(request);
    const decoded = decodeNativeCandidateRequest(structuredClone(encodeNativeCandidateRequest(detached)));
    indexAbsAbi(workspace).get('b1999')!.fields!['NUM'] = -1;
    expect(indexAbsAbi(decoded.verify!.state).get('b1999')!.fields!['NUM']).toBe(1999);
    expect(decoded.values![0].value).toEqual(new Uint8Array([1, 2]));
    const result = decodeNativeCandidateResult(structuredClone(encodeNativeCandidateResult({ state: decoded.verify!.state, structures: [] })));
    createAbsReadbackVerifier(decoded.verify!.state)(result.state as any);
  });

  it('executes and reads back more than 4096 blocks in the real isolated native runtime', async () => {
    const size = 5000;
    const result = await evaluateNativeCandidate({
      steps: [{ kind: 'definitions', definitions: [{ type: 'large_native', message0: '%1',
        args0: [{ type: 'field_input', name: 'TEXT', text: '' }], output: null }] }],
      blocks: Array.from({ length: size }, (_, n) => ({ id: `native${n}`, type: 'large_native', fields: [{ name: 'TEXT', value: String(n) }] })),
    }, { assertCurrent: () => {}, timeoutMs: 30000 });
    expect(indexAbsAbi(result.state as any).size).toBe(size);
    expect(indexAbsAbi(result.state as any).get('native4999')!.fields!['TEXT']).toBe('4999');
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  }, 40000);
});
