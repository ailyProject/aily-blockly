import * as Blockly from 'blockly';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { assertAbsReadback } from './abs-readback';
import { assertAbsWorkspaceReadback, captureAbsWorkspaceState } from './abs-workspace-state';

describe('captured workspace readback declaration boundary', () => {
  let workspace: Blockly.Workspace, previousBlockly: unknown;
  let catalog: BlocklyDeclarativeBlockCatalog;
  let sources: Array<Record<string, any>>;
  beforeEach(() => {
    previousBlockly = window['Blockly']; window['Blockly'] = Blockly;
    workspace = new Blockly.Workspace(); catalog = new BlocklyDeclarativeBlockCatalog();
    sources = Array.from({ length: 4 }, (_, i) => ({ type: `abs_readback_boundary_${i}`, message0: '%1 %2', args0: [
      { type: 'field_number', name: 'NUM', value: i }, { type: 'field_checkbox', name: 'CHECK', checked: false },
    ] }));
    for (const source of sources) {
      Blockly.defineBlocksWithJsonArray([source]); catalog.record(source, Blockly.Blocks[source['type']]);
    }
    for (let i = 0; i < 40; i++) workspace.newBlock(sources[i % 4]['type'], `block-${i}`);
  });
  afterEach(() => {
    workspace.dispose(); for (const source of sources) delete Blockly.Blocks[source['type']];
    window['Blockly'] = previousBlockly;
  });

  it('checks every field but scans used declarations only at the two pure readback boundaries', () => {
    const definitions = catalog.capture(Blockly.Blocks);
    let scopeChecks = 0;
    const guard = () => { scopeChecks++; definitions.assertCurrent(); };
    const captured = captureAbsWorkspaceState(workspace, guard, definitions);
    const stringify = spyOn(JSON, 'stringify').and.callThrough();
    const sourceReads = () => stringify.calls.allArgs().filter(args => sources.includes(args[0])).length;
    scopeChecks = 0;
    assertAbsReadback(captured.state, captured.state, captured);
    const unbatched = sourceReads(), perFieldChecks = scopeChecks;
    stringify.calls.reset(); scopeChecks = 0;
    assertAbsWorkspaceReadback(captured.state, captured.state, captured, definitions);
    expect(perFieldChecks).toBe(40 * 2 * 2);
    expect(scopeChecks).toBe(perFieldChecks);
    expect(unbatched).toBe(perFieldChecks * sources.length);
    expect(sourceReads()).toBe(2 * sources.length);
  });

  for (const timing of ['before', 'during']) it(`rejects source changes ${timing} the pure comparison`, () => {
    const definitions = catalog.capture(Blockly.Blocks);
    let mutate = false;
    const captured = captureAbsWorkspaceState(workspace, () => {
      if (mutate) sources[0]['message0'] = 'changed';
      definitions.assertCurrent();
    }, definitions);
    if (timing === 'before') sources[0]['message0'] = 'changed'; else mutate = true;
    expect(() => assertAbsWorkspaceReadback(captured.state, captured.state, captured, definitions))
      .toThrowError(/definitions changed/);
    // Failure must release the read scope, not suppress later standalone checks.
    expect(() => definitions.assertCurrent()).toThrowError(/definitions changed/);
  });

  it('continues checking the project/page/runtime scope for every captured field', () => {
    const definitions = catalog.capture(Blockly.Blocks);
    let reads = 0, invalidateAt = Infinity;
    const captured = captureAbsWorkspaceState(workspace, () => {
      if (++reads >= invalidateAt) throw new Error('scope changed');
      definitions.assertCurrent();
    }, definitions);
    reads = 0; invalidateAt = 3;
    expect(() => assertAbsWorkspaceReadback(captured.state, captured.state, captured, definitions)).toThrowError('scope changed');
    expect(reads).toBe(3);
    invalidateAt = Infinity;
    expect(() => assertAbsWorkspaceReadback(captured.state, captured.state, captured, definitions)).not.toThrow();
  });

  for (const change of ['field', 'metadata', 'block']) it(`retains complete ${change} readback and releases a failed comparison`, () => {
    const definitions = catalog.capture(Blockly.Blocks);
    const captured = captureAbsWorkspaceState(workspace, definitions.assertCurrent, definitions);
    const changed = structuredClone(captured.state);
    if (change === 'field') changed.blocks.blocks[0].fields!['NUM'] = 99;
    if (change === 'metadata') changed.blocks.blocks[0]['deletable'] = false;
    if (change === 'block') changed.blocks.blocks.pop();
    expect(() => assertAbsWorkspaceReadback(captured.state, changed, captured, definitions))
      .toThrowMatching(error => error.code === 'ABS_READBACK_MISMATCH');
    sources[0]['message0'] = 'changed after failure';
    expect(() => definitions.assertCurrent()).toThrowError(/definitions changed/);
  });

  it('uses the supplied baseline contracts for rollback checkbox normalization', () => {
    const definitions = catalog.capture(Blockly.Blocks);
    const baseline = captureAbsWorkspaceState(workspace, definitions.assertCurrent, definitions);
    const restored = structuredClone(baseline.state), expected = structuredClone(baseline.state);
    expected.blocks.blocks[0].fields!['CHECK'] = 'FALSE';
    expect(restored.blocks.blocks[0].fields!['CHECK']).toBeFalse();
    expect(() => assertAbsWorkspaceReadback(expected, restored, baseline, definitions)).not.toThrow();
  });

  it('preserves compatibility with snapshots without the optional batching capability', () => {
    const definitions = catalog.capture(Blockly.Blocks);
    const captured = captureAbsWorkspaceState(workspace, definitions.assertCurrent, definitions);
    const withoutBatch = { ...definitions, withSynchronousRead: undefined };
    expect(() => assertAbsWorkspaceReadback(captured.state, captured.state, captured, withoutBatch)).not.toThrow();
    sources[0]['message0'] = 'changed';
    expect(() => assertAbsWorkspaceReadback(captured.state, captured.state, captured, withoutBatch)).toThrowError(/definitions changed/);
  });
});
