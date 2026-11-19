import * as Blockly from 'blockly';
import { createBlocklyBlockActivity, isBlocklyBlockActive } from '../../../editors/blockly-editor/services/blockly-block-activity';
import { indexAbsBlockActivity } from './abs-block-activity';
import type { AbsAbiBlock, AbsAbiWorkspace } from './abs-state';

describe('Blockly executable block activity', () => {
  it('matches native own/surround semantics for value, statement and next connections', () => {
    const parentType = 'activity_parent_test', statementType = 'activity_statement_test', valueType = 'activity_value_test';
    Blockly.Blocks[parentType] = { init() { this.appendStatementInput('DO'); this.appendValueInput('VALUE'); this.setNextStatement(true); } };
    Blockly.Blocks[statementType] = { init() { this.setPreviousStatement(true); this.setNextStatement(true); } };
    Blockly.Blocks[valueType] = { init() { this.setOutput(true); } };
    const workspace = new Blockly.Workspace();
    try {
      const parent = workspace.newBlock(parentType), first = workspace.newBlock(statementType), second = workspace.newBlock(statementType);
      const outside = workspace.newBlock(statementType), value = workspace.newBlock(valueType);
      parent.getInput('DO')!.connection!.connect(first.previousConnection!);
      first.nextConnection!.connect(second.previousConnection!);
      parent.nextConnection!.connect(outside.previousConnection!);
      parent.getInput('VALUE')!.connection!.connect(value.outputConnection!);
      first.setDisabledReason(true, 'MANUALLY_DISABLED');
      let active = createBlocklyBlockActivity();
      expect(active(first)).toBeFalse();
      expect(active(second)).toBeTrue();
      expect(active(value)).toBeTrue();
      parent.setDisabledReason(true, 'MANUALLY_DISABLED');
      active = createBlocklyBlockActivity();
      for (const block of [parent, first, second, value]) expect(active(block)).toBeFalse();
      expect(active(outside)).toBeTrue();
      for (const block of workspace.getAllBlocks(false)) {
        expect(isBlocklyBlockActive(block)).toBe(block.isEnabled() && !block.getInheritedDisabled());
      }
      parent.setDisabledReason(false, 'MANUALLY_DISABLED');
      expect(isBlocklyBlockActive(second)).toBeTrue();
    } finally {
      workspace.dispose();
      for (const type of [parentType, statementType, valueType]) delete Blockly.Blocks[type];
    }
  });

  for (const nextChain of [false, true]) it(`bounds a 6000-block ${nextChain ? 'next' : 'surround'} chain to linear reads without recursion`, () => {
    let parentReads = 0, nextReads = 0, ownReads = 0;
    const blocks: any[] = [];
    for (let index = 0; index < 6000; index++) {
      blocks.push({ isEnabled: () => { ownReads++; return index !== 0; },
        getParent: () => { parentReads++; return blocks[index - 1] ?? null; },
        getNextBlock: () => { nextReads++; return nextChain ? blocks[index + 1] ?? null : null; } });
    }
    const active = createBlocklyBlockActivity();
    expect(active(blocks[5999])).toBe(nextChain);
    for (const [index, block] of blocks.entries()) expect(active(block)).toBe(nextChain && index !== 0);
    expect(parentReads).toBeLessThanOrEqual(blocks.length);
    expect(nextReads).toBeLessThanOrEqual(blocks.length);
    expect(ownReads).toBe(blocks.length);
  });

  it('does not turn cyclic custom topology into a cached active result', () => {
    const first: any = { isEnabled: () => true, getParent: () => second, getNextBlock: () => null };
    const second: any = { isEnabled: () => true, getParent: () => first, getNextBlock: () => null };
    expect(() => createBlocklyBlockActivity()(first)).toThrowError(/acyclic/);
    first.getNextBlock = () => second; second.getNextBlock = () => first;
    expect(() => createBlocklyBlockActivity()(first)).toThrowError(/acyclic/);
  });
});

describe('serialized ABI executable block activity', () => {
  const block = (id: string, attributes: Partial<AbsAbiBlock> = {}): AbsAbiBlock => ({ id, type: 'activity_test', ...attributes });
  it('inherits input activity but keeps enabled next statements outside disabled predecessors active', () => {
    const state: AbsAbiWorkspace = { blocks: { blocks: [block('container', { disabledReasons: ['MANUALLY_DISABLED'],
      inputs: { DO: { block: block('inner', { next: { block: block('inner-next') } }) } }, next: { block: block('outside') } }),
      block('disabled-first', { enabled: false, next: { block: block('enabled-next') } })] } };
    const original = JSON.stringify(state), active = indexAbsBlockActivity(state);
    expect([...active]).toEqual([['container', false], ['inner', false], ['inner-next', false], ['outside', true],
      ['disabled-first', false], ['enabled-next', true]]);
    expect(JSON.stringify(state)).toBe(original);
  });
  it('keeps covered shadows and their complete descendants inactive while retaining uncovered shadows', () => {
    const state: AbsAbiWorkspace = { blocks: { blocks: [block('parent', { inputs: {
      REAL: { block: block('real'), shadow: block('dormant', { inputs: { VALUE: { block: block('dormant-child') } }, next: { block: block('dormant-next') } }) },
      DEFAULT: { shadow: block('uncovered') },
    } })] } };
    const active = indexAbsBlockActivity(state);
    for (const id of ['parent', 'real', 'uncovered']) expect(active.get(id)).toBeTrue();
    for (const id of ['dormant', 'dormant-child', 'dormant-next']) expect(active.get(id)).toBeFalse();
  });
  it('indexes a 6000-statement next chain iteratively without inheriting its first disabled state', () => {
    const root = block('b0', { disabled: true }); let last = root;
    for (let index = 1; index < 6000; index++) { const next = block(`b${index}`); last.next = { block: next }; last = next; }
    const active = indexAbsBlockActivity({ blocks: { blocks: [root] } });
    expect(active.size).toBe(6000); expect(active.get('b0')).toBeFalse(); expect(active.get('b5999')).toBeTrue();
  });
  it('keeps full identity and input-depth admission even for inactive blocks', () => {
    const duplicate = block('duplicate', { disabled: true });
    expect(() => indexAbsBlockActivity({ blocks: { blocks: [duplicate, duplicate] } })).toThrowMatching(error => error.code === 'ABS_DUPLICATE_ID');
    const root = block('root', { disabled: true }); let last = root;
    for (let index = 0; index < 130; index++) { const child = block(`child-${index}`); last.inputs = { VALUE: { block: child } }; last = child; }
    expect(() => indexAbsBlockActivity({ blocks: { blocks: [root] } })).toThrowMatching(error => error.code === 'ABS_LIMIT');
  });
});
