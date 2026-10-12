import {Subject} from 'rxjs';
import {BlocklyService} from '../services/blockly.service';
import * as Blockly from 'blockly';
import { BlocklyFunctionView, BlocklyFunctionViewState, isBlocklyFunctionViewBlockVisible } from './blockly-function-view';
import { ArduinoGenerator } from '../components/blockly/generators/arduino/arduino';
import { exportWorkspaceToSvg } from '../services/workspace-svg-exporter';
import { loadBlocklyWorkspace } from './blockly-performance';
import { withNativeStateLoading } from '../services/blockly-native-state-loading';

for (const virtual of [false, true]) describe(`Blockly function display preserves the complete native workspace (virtual=${virtual})`, () => {
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg, view: BlocklyFunctionView;
  let state: BlocklyFunctionViewState;
  let first: Blockly.BlockSvg, second: Blockly.BlockSvg, line: Blockly.BlockSvg;
  const settle = async () => {
    await Blockly.renderManagement.finishQueuedRenders();
    // Native events run in a timer after an animation frame. A fixed 40 ms
    // sleep can finish before that frame on a busy/headless renderer.
    // Function options then coalesce those events into the following frame.
    for (let i = 0; i < 2; i++) await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
  };
  const make = (type: string, id: string) => {
    const block = workspace.newBlock(type, id); block.initSvg(); block.render(); return block;
  };

  beforeEach(async () => {
    Blockly.Blocks['function_view_def'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('work'), 'NAME');
      this.appendStatementInput('BODY'); this.setColour(210);
    }, getProcedureDef() { return [this.getFieldValue('NAME'), [], false]; } };
    Blockly.Blocks['function_view_line'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('initial'), 'TEXT');
      this.setPreviousStatement(true); this.setNextStatement(true); this.setColour(120);
    } };
    host = document.createElement('div'); host.style.cssText = 'width:800px;height:600px'; document.body.append(host);
    workspace = Blockly.inject(host, { scrollbars: true, comments: true });
    workspace.setViewportRendering(virtual);
    first = make('function_view_def', 'first'); first.moveBy(40, 80);
    second = make('function_view_def', 'second'); second.setFieldValue('other', 'NAME'); second.moveBy(1400, 80);
    line = make('function_view_line', 'line'); first.getInput('BODY')!.connection!.connect(line.previousConnection!);
    await settle(); workspace.clearUndo();
    view = new BlocklyFunctionView(workspace, next => state = next);
  });
  afterEach(() => {
    view.dispose(); workspace.dispose(); host.remove();
    delete Blockly.Blocks['function_view_def']; delete Blockly.Blocks['function_view_line'];
  });

  it('switches only SVG visibility and keeps serialization, positions, variables and top-level order exact', () => {
    workspace.getVariableMap().createVariable('global', 'int', 'variable');
    const before = Blockly.serialization.workspaces.save(workspace);
    const order = workspace.getTopBlocks(true).map(block => block.id);
    view.setScope(first.id);
    expect(state.visibleCount).toBe(2); expect(state.totalCount).toBe(3);
    expect(isBlocklyFunctionViewBlockVisible(line)).toBeTrue();
    expect(isBlocklyFunctionViewBlockVisible(second)).toBeFalse();
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
    expect(workspace.getTopBlocks(true).map(block => block.id)).toEqual(order);
    view.setScope(second.id); view.setScope('');
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
    expect(second.getSvgRoot().style.display).toBe('');
    expect(workspace.getUndoStack()).toEqual([]);
  });

  it('generates the complete program in a single-function view', () => {
    const generator = new ArduinoGenerator();
    generator.forBlock['function_view_def'] = (block, gen) => {
      (gen as ArduinoGenerator).addFunction(block.id, `void ${block.getFieldValue('NAME')}() {\n${gen.statementToCode(block, 'BODY')}}\n`);
      return '';
    };
    generator.forBlock['function_view_line'] = block => `${block.getFieldValue('TEXT')};\n`;
    const before = generator.workspaceToCode(workspace);
    view.setScope(first.id);
    expect(generator.workspaceToCode(workspace)).toBe(before);
    expect(before).toContain('void other()');
  });

  it('preserves edits and native undo/redo across function switches', async () => {
    view.setScope(first.id); line.setFieldValue('changed', 'TEXT'); await settle();
    expect(workspace.getUndoStack().map(event => event.toJson())).withContext('history before view switch').toContain(jasmine.objectContaining({
      type: 'change', blockId: line.id, element: 'field', name: 'TEXT', oldValue: 'initial', newValue: 'changed',
    }));
    const undo = workspace.getUndoStack().length;
    view.setScope(second.id);
    expect(workspace.getUndoStack().length).toBe(undo);
    workspace.undo(false); await settle();
    expect(line.getFieldValue('TEXT')).withContext(JSON.stringify(workspace.getUndoStack().map(event => event.toJson()))).toBe('initial');
    workspace.undo(true); await settle();
    expect(line.getFieldValue('TEXT')).toBe('changed');
    view.setScope(first.id); expect(line.getFieldValue('TEXT')).toBe('changed');
  });

  it('reveals hidden search/code/debug targets synchronously before centering', () => {
    view.setScope(first.id); workspace.centerOnBlock(second.id, false);
    expect(state.scopeId).toBe(second.id); expect(isBlocklyFunctionViewBlockVisible(second)).toBeTrue();
    expect(isBlocklyFunctionViewBlockVisible(first)).toBeFalse();
  });

  it('does not let stale queued selection events revert a manual view switch', async () => {
    line.select(); line.unselect(); view.setScope(second.id); await settle();
    expect(state.scopeId).toBe(second.id);
  });

  it('clears native remembered focus across function navigation instead of revealing the previous function', async () => {
    const editor: any = Object.create(BlocklyService.prototype);
    Object.assign(editor, { _workspace: workspace, functionView: view,
      selectedBlockSubject: new Subject(), selectedBlockIdsSubject: new Subject(),
      assertWorkspaceEditAvailable() {}, hideChaff() {} });
    Blockly.getFocusManager().focusNode(line);
    editor.setFunctionView(second.id); await settle();
    expect(state.scopeId).toBe(second.id);
    expect(Blockly.getSelected()).toBeNull();
    workspace.centerOnBlock(line.id, true); await settle();
    expect(state.scopeId).toBe(first.id);
    expect(isBlocklyFunctionViewBlockVisible(line)).toBeTrue();
    expect(Blockly.getSelected()).toBeNull();
  });

  it('keeps newly pasted and disconnected blocks visible as scratch blocks', async () => {
    view.setScope(first.id);
    const scratch = make('function_view_line', 'scratch'); await settle();
    expect(isBlocklyFunctionViewBlockVisible(scratch)).toBeTrue();
    line.unplug(); await settle();
    expect(isBlocklyFunctionViewBlockVisible(line)).toBeTrue();
    view.setScope(second.id);
    expect(isBlocklyFunctionViewBlockVisible(scratch)).toBeFalse();
    view.setScope('@other'); expect(isBlocklyFunctionViewBlockVisible(scratch)).toBeTrue();
  });

  it('prevents invisible drag targets while allowing programmatic connections to the same models', async () => {
    const hidden = make('function_view_line', 'hidden');
    second.getInput('BODY')!.connection!.connect(hidden.previousConnection!); await settle();
    view.setScope(first.id);
    expect(workspace.connectionChecker.doDragChecks(line.nextConnection!, hidden.previousConnection!, 100)).toBeFalse();
    hidden.unplug(); line.nextConnection!.connect(hidden.previousConnection!); await settle();
    expect(line.getNextBlock()).toBe(hidden); expect(isBlocklyFunctionViewBlockVisible(hidden)).toBeTrue();
  });

  it('does not rescan hidden trees on layout moves/field edits or walk their ancestry for every drag candidate', async () => {
    const hidden = make('function_view_line', 'hidden');
    second.getInput('BODY')!.connection!.connect(hidden.previousConnection!); await settle();
    view.setScope(first.id);
    const children = spyOn(second, 'getChildren').and.callThrough();
    const root = spyOn(hidden, 'getRootBlock').and.callThrough();
    const count = state.totalCount;
    first.moveBy(20, 30); line.setFieldValue('edited', 'TEXT'); await settle();
    expect(children).not.toHaveBeenCalled(); expect(state.totalCount).toBe(count);
    hidden.previousConnection!.moveTo(line.nextConnection!.x, line.nextConnection!.y);
    for (let i = 0; i < 60; i++) expect(workspace.connectionChecker.doDragChecks(line.nextConnection!, hidden.previousConnection!, 100)).toBeFalse();
    expect(root).not.toHaveBeenCalled();
    hidden.unplug(); line.nextConnection!.connect(hidden.previousConnection!); await settle();
    expect(isBlocklyFunctionViewBlockVisible(hidden)).toBeTrue();
  });

  it('uses only visible content for scroll/zoom bounds and restores full bounds', () => {
    const original = workspace.getBlocksBoundingBox(); view.setScope(first.id);
    expect(workspace.getBlocksBoundingBox().right).toBeLessThan(1000);
    view.setScope(''); expect(workspace.getBlocksBoundingBox()).toEqual(original);
  });

  it('updates renamed options and recovers safely if the selected function is deleted', async () => {
    view.setScope(second.id); second.setFieldValue('renamed', 'NAME'); await settle();
    expect(state.options.find(option => option.id === second.id)!.label).toBe('renamed()');
    second.dispose(false); await settle();
    expect(state.scopeId).toBe(''); expect(isBlocklyFunctionViewBlockVisible(first)).toBeTrue();
    expect(() => view.setScope('missing')).not.toThrow();
  });

  it('exports the complete SVG and restores the view even when an exporter fails', () => {
    view.setScope(first.id);
    const svg = view.withAllVisible(() => exportWorkspaceToSvg(workspace));
    expect(svg).toContain('other');
    const exported = new DOMParser().parseFromString(svg!, 'image/svg+xml');
    expect(exported.querySelector('[data-id="second"]')?.getAttribute('style') ?? '').not.toContain('display: none');
    expect(Number(exported.documentElement.getAttribute('width'))).toBeGreaterThan(1000);
    expect(isBlocklyFunctionViewBlockVisible(second)).toBeFalse();
    expect(() => view.withAllVisible(() => { throw new Error('failed'); })).toThrow();
    expect(second.getSvgRoot().style.display).toBe('none');
  });

  it('resets scratch blocks on a suppressed bulk load and preserves a surviving scope id', async () => {
    view.setScope(first.id); const scratch = make('function_view_line', 'scratch'); await settle();
    view.loaded();
    expect(state.scopeId).toBe(first.id); expect(isBlocklyFunctionViewBlockVisible(scratch)).toBeFalse();
    Blockly.Events.disable();
    try { workspace.clear(); } finally { Blockly.Events.enable(); }
    view.loaded(); expect(state.scopeId).toBe(''); expect(state.totalCount).toBe(0);
  });

  it('filters pinned child comment bubbles without changing serialized text, pinning or geometry', async () => {
    line.setCommentText('persistent child comment');
    const icon = line.getIcon(Blockly.icons.CommentIcon.TYPE)!;
    await icon.setBubbleVisible(true); await settle();
    const before = Blockly.serialization.workspaces.save(workspace);
    const svg = (icon as any).textInputBubble.getSvgRoot() as SVGElement;
    view.setScope(second.id);
    expect(svg.style.display).toBe('none');
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
    view.setScope(first.id);
    expect(svg.style.display).toBe('');
    expect(icon.bubbleIsVisible()).toBeTrue();
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
  });

  it('preserves pinned child comment state when reloading a saved project', async () => {
    line.setCommentText('persistent child comment');
    await line.getIcon(Blockly.icons.CommentIcon.TYPE)!.setBubbleVisible(true); await settle();
    const before = Blockly.serialization.workspaces.save(workspace);
    withNativeStateLoading(Blockly, workspace, before, () => loadBlocklyWorkspace(workspace, before));
    // Project admission waits a frame: native updateEditable/loadState finish
    // pinning and coordinates asynchronously after the initial render batch.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    view.loaded(); view.setScope(second.id);
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
    const icon = workspace.getBlockById(line.id)!.getIcon(Blockly.icons.CommentIcon.TYPE)!;
    expect((icon as any).textInputBubble.getSvgRoot().style.display).toBe('none');
    view.setScope(first.id);
    expect(icon.bubbleIsVisible()).toBeTrue();
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
  });
});
