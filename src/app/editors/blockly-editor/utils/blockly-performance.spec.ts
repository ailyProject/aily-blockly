import * as Blockly from 'blockly';
import {
  installBlocklyVariableComparator,
  WorkspaceCodeChangeTracker,
  isBlocklyWorkspaceInteracting,
} from './blockly-performance';
import { ArduinoGenerator } from '../components/blockly/generators/arduino/arduino';
import { findOversizedInlineValues, ProjectDataStore, type ProjectDataFileSystem } from '@domain/project/public-api';

describe('large Blockly workspaces', () => {
  let workspace: Blockly.Workspace;
  beforeEach(() => {
    Blockly.Events.disable();
    workspace = new Blockly.Workspace();
    Blockly.Blocks['large_workspace_statement'] = { init() {
      this.setPreviousStatement(true);
      this.setNextStatement(true);
      this.appendStatementInput('BODY');
      this.appendValueInput('VALUE');
    } };
    Blockly.Blocks['large_workspace_value'] = { init() { this.setOutput(true); } };
  });
  afterEach(() => {
    // Dispose each node independently; this test concerns generation, not
    // Blockly core's recursive destruction of a very long connected stack.
    for (const block of workspace.getAllBlocks(false)) block.unplug(false);
    workspace.dispose();
    delete Blockly.Blocks['large_workspace_statement'];
    delete Blockly.Blocks['large_workspace_value'];
    Blockly.Events.enable();
  });

  it('generates 6000 connected statements in order without consuming a call frame per sibling', () => {
    const generator = new ArduinoGenerator();
    generator.forBlock['large_workspace_statement'] = block => `${block.id};\n`;
    const blocks = Array.from({ length: 6000 }, (_, index) => workspace.newBlock('large_workspace_statement', `line_${index}`));
    for (let index = blocks.length - 2; index >= 0; index--) {
      blocks[index].nextConnection!.connect(blocks[index + 1].previousConnection!);
    }
    generator.init(workspace);
    expect(generator.blockToCode(blocks[0])).toBe(blocks.map(block => `${block.id};\n`).join(''));
    expect(generator.blockToCode(blocks[0], true)).toBe('line_0;\n');
  });

  it('preserves nested inputs, comments, disabled blocks, null results and stack cleanup after an error', () => {
    const generator = new ArduinoGenerator();
    const [outer, nested, tail] = ['outer', 'nested', 'tail'].map(id => workspace.newBlock('large_workspace_statement', id));
    const value = workspace.newBlock('large_workspace_value', 'value');
    outer.getInput('BODY')!.connection!.connect(nested.previousConnection!);
    outer.getInput('VALUE')!.connection!.connect(value.outputConnection!);
    outer.nextConnection!.connect(tail.previousConnection!);
    nested.setCommentText('nested comment');
    generator.forBlock['large_workspace_statement'] = (block, gen) => {
      return `${block.id}(${gen.valueToCode(block, 'VALUE', 99)});\n${gen.statementToCode(block, 'BODY')}`;
    };
    generator.forBlock['large_workspace_value'] = () => ['42', 0];
    generator.init(workspace);
    expect(generator.blockToCode(outer)).toBe('outer(42);\n  // nested comment\n  nested();\ntail();\n');
    outer.setDisabledReason(true, 'test');
    expect(generator.blockToCode(outer)).toBe('tail();\n');
    outer.setDisabledReason(false, 'test');
    generator.forBlock['large_workspace_statement'] = () => null as unknown as string;
    expect(generator.blockToCode(outer)).toBe('');
    generator.forBlock['large_workspace_statement'] = () => { throw new Error('test failure'); };
    expect(() => generator.blockToCode(outer)).toThrowError('test failure');
    expect((generator as any)._blockIdStack).toEqual([]);
    expect((generator as any)._statementFrames).toEqual([]);
  });

  it('keeps locale ordering including non-ASCII and case variants', () => {
    const names = ['Z', 'a', 'A', 'ä', '变量', '变量2', 'é', 'e'];
    const variables = names.map(name => new Blockly.VariableModel(workspace, name, ''));
    const expected = [...variables].sort(Blockly.VariableModel.compareByName).map(variable => variable.name);
    installBlocklyVariableComparator();
    expect(variables.sort(Blockly.VariableModel.compareByName).map(variable => variable.name)).toEqual(expected);
  });

  it('retains the tail and precedence of a value block with a next connection', () => {
    const value = workspace.newBlock('large_workspace_value');
    const statement = workspace.newBlock('large_workspace_statement');
    value.setNextStatement(true);
    value.nextConnection!.connect(statement.previousConnection!);
    const generator = new ArduinoGenerator();
    generator.forBlock['large_workspace_value'] = () => ['value', 3];
    generator.forBlock['large_workspace_statement'] = () => 'tail;\n';
    generator.init(workspace);
    expect(generator.blockToCode(value)).toEqual(['valuetail;\n', 3]);
    expect(generator.blockToCode(value, true)).toEqual(['value', 3]);
  });

  it('skips position-only moves but retains top-level reorder, connections, fields and variable changes', () => {
    const tracker = new WorkspaceCodeChangeTracker();
    const block = workspace.newBlock('large_workspace_statement');
    const second = workspace.newBlock('large_workspace_statement');
    const topBlocks = spyOn(workspace, 'getTopBlocks').and.returnValue([block, second]);
    expect(tracker.affectsCode(undefined, workspace)).toBeTrue();
    expect(tracker.affectsCode({ type: 'move' }, workspace)).toBeFalse();
    topBlocks.and.returnValue([second, block]);
    expect(tracker.affectsCode({ type: 'move' }, workspace)).toBeTrue();
    expect(tracker.affectsCode({ type: 'move', newParentId: second.id }, workspace)).toBeTrue();
    expect(tracker.affectsCode({ type: 'change', element: 'field' }, workspace)).toBeTrue();
    expect(tracker.affectsCode({ type: 'var_rename' }, workspace)).toBeTrue();
    expect(tracker.affectsCode({ type: 'change', element: 'collapsed' }, workspace)).toBeFalse();
    expect(tracker.affectsCode({ type: 'selected' }, workspace)).toBeFalse();
    topBlocks.and.callThrough();
  });

  it('defers for pointer gestures, editors, dropdowns and focused text including IME pauses', () => {
    const widget = spyOn(Blockly.WidgetDiv, 'isVisible').and.returnValue(false);
    const dropdown = spyOn(Blockly.DropDownDiv, 'isVisible').and.returnValue(false);
    const target = { currentGesture_: null, isDragging: () => false,
      getInjectionDiv: () => document.body } as any;
    expect(isBlocklyWorkspaceInteracting(target)).toBeFalse();
    target.currentGesture_ = {};
    expect(isBlocklyWorkspaceInteracting(target)).toBeTrue();
    target.currentGesture_ = null;
    widget.and.returnValue(true);
    expect(isBlocklyWorkspaceInteracting(target)).toBeTrue();
    widget.and.returnValue(false); dropdown.and.returnValue(true);
    expect(isBlocklyWorkspaceInteracting(target)).toBeTrue();
    dropdown.and.returnValue(false);
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const input = document.createElement(tag);
      if (tag === 'div') input.contentEditable = 'true';
      document.body.append(input);
      try {
        input.focus();
        expect(isBlocklyWorkspaceInteracting(target)).withContext(tag).toBeTrue();
        input.blur();
        expect(isBlocklyWorkspaceInteracting(target)).withContext(`${tag} blurred`).toBeFalse();
      } finally { input.remove(); }
    }
  });

  it('scans deeply nested data without overflowing and keeps diagnostic paths and reference validation', () => {
    const ref = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`, logicalType: 'text', codec: 'utf8-v1', storage: 'raw-v1', rawLength: 1, storedLength: 1 } } as const;
    // No IO is required to traverse/validate metadata.
    const store = new ProjectDataStore({} as ProjectDataFileSystem);
    let document: any = { id: 'leaf', type: 'test', fields: { TEXT: 'oversized' } };
    for (let index = 0; index < 12000; index++) document = { type: 'test', next: { block: document } };
    const diagnostics = findOversizedInlineValues(document, 3);
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].blockId).toBe('leaf');
    expect(diagnostics[0].jsonPointer).toBe('/next/block'.repeat(12000) + '/fields/TEXT');
    expect(store.collectReferences(document)).toEqual([]);
    const references: any = { first: ref, encoded: JSON.stringify(ref), document };
    references.cycle = references;
    expect(store.collectReferences(references)).toEqual([ref]);
    expect(() => store.collectReferences([ref, { $ailyData: { ...ref.$ailyData, rawLength: 2 } }])).toThrow();
    expect(() => store.collectReferences({ $ailyData: {} })).toThrow();
    expect(() => store.collectReferences('{"$ailyData":')).toThrow();
  });
});
