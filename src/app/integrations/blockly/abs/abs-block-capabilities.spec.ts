import * as Blockly from 'blockly';
import { BlocklyDeclarativeBlockCatalog } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { describeAbsBlockCapability } from './abs-block-capabilities';

describe('readonly ABS capability discovery', () => {
  it('reuses verified declarations, omits defaults and never instantiates blocks', () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), entry = { init() { throw new Error('must not run'); } };
    catalog.record({ type: 'payload', args0: [{ type: 'field_input', name: 'DATA', text: 'x'.repeat(20000) }] }, entry);
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    const report = describeAbsBlockCapability(catalog.capture({ payload: entry }), 'payload');
    expect(report.level).toBe('create'); expect((report as any).shape.fields.DATA.type).toBe('field_input');
    expect(JSON.stringify(report).length).toBeLessThan(500); expect(probe).not.toHaveBeenCalled();
  });
  it('distinguishes unknown registrations and missing prepared dynamic protocols without executing callbacks', () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), entry = { init() { throw new Error('must not run'); } };
    catalog.record({ type: 'custom', mutator: 'new_library_mutator' }, entry);
    const snapshot = catalog.capture({ custom: entry, code_only: entry });
    expect(describeAbsBlockCapability(snapshot, 'custom').level).toBe('preserve-only');
    expect(describeAbsBlockCapability(snapshot, 'code_only').level).toBe('preserve-only');
    expect(describeAbsBlockCapability(snapshot, 'missing').level).toBe('unavailable');
  });
  it('reports only proven bundled procedures as reshapable and fails closed after replacement', () => {
    const catalog = new BlocklyDeclarativeBlockCatalog(), registry = { ...Blockly.Blocks };
    const snapshot = catalog.capture(registry);
    const report = describeAbsBlockCapability(snapshot, 'procedures_defnoreturn');
    expect(report.level).toBe('reshape'); expect((report as any).procedure).toEqual({ role: 'definition', returns: false });
    registry['procedures_defnoreturn'] = { init() {} };
    expect(() => snapshot.assertCurrent()).toThrow();
    expect(describeAbsBlockCapability(catalog.capture(registry), 'procedures_defnoreturn').level).toBe('preserve-only');
  });
});
