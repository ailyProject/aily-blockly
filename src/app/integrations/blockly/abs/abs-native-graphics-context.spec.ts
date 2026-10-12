import * as Blockly from 'blockly';
import { captureNativeGraphicsContext } from '../../../editors/blockly-editor/services/blockly-native-graphics-context';
import { BlocklyGeneratorRuntimeService } from '../../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import '../../../editors/blockly-editor/components/blockly/blockly-native-registrations';
import { AilyIcon, AILY_ICON_TYPE } from '../../../editors/blockly-editor/components/blockly/renderer/aily-icon/acon';

describe('native graphics replay context', () => {
  let host: HTMLDivElement, workspace: Blockly.WorkspaceSvg, runtime: BlocklyGeneratorRuntimeService;
  let previousIcons: unknown;
  const createWorkspace = (renderer: string) => Blockly.inject(host, { renderer, rtl: true, oneBasedIndex: false,
    rendererOverrides: { MIN_BLOCK_HEIGHT: 31 },
    theme: Blockly.Theme.defineTheme('native_context_test', { name: 'native_context_test',
      base: Blockly.Themes.Classic, fontStyle: { family: 'monospace', weight: 'normal', size: 16 }, startHats: true }) });
  beforeEach(() => {
    previousIcons = (window as any).__ailyBlockDefinitionsMap;
    (window as any).__ailyBlockDefinitionsMap = new Map([['graphics_context_probe', { type: 'i', src: 'fa-solid fa-code', width: 24, height: 20 }]]);
    host = document.createElement('div'); host.style.cssText = 'width:1024px;height:768px;'; document.body.appendChild(host);
    workspace = createWorkspace('thrasos');
    runtime = new BlocklyGeneratorRuntimeService();
  });
  afterEach(() => {
    runtime.destroy(); workspace.dispose(); host.remove(); delete Blockly.Blocks['graphics_context_probe'];
    (window as any).__ailyBlockDefinitionsMap = previousIcons;
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });

  it('captures detached data, not live Theme or renderer instances; headless callers keep defaults', () => {
    const snapshot = captureNativeGraphicsContext(workspace)!;
    expect(snapshot.renderer).toBe('thrasos'); expect(snapshot.rtl).toBeTrue();
    expect(snapshot.oneBasedIndex).toBeFalse(); expect(snapshot.theme.fontStyle.size).toBe(16);
    expect(snapshot.viewportRendering).toBeFalse();
    expect(snapshot.theme).not.toBe(workspace.getTheme() as any);
    snapshot.theme.fontStyle.size = 99; snapshot.rendererOverrides!['MIN_BLOCK_HEIGHT'] = 88;
    (snapshot.blockIcons[0][1] as any).width = 99;
    expect((window as any).__ailyBlockDefinitionsMap.get('graphics_context_probe').width).toBe(24);
    expect(workspace.getTheme().fontStyle.size).toBe(16);
    expect(workspace.options.rendererOverrides!['MIN_BLOCK_HEIGHT']).toBe(31);
    const headless = new Blockly.Workspace();
    try { expect(captureNativeGraphicsContext(headless)).toBeUndefined(); expect(captureNativeGraphicsContext(null)).toBeUndefined(); }
    finally { headless.dispose(); }
  });

  it('invalidates replay after in-place visual configuration changes or workspace replacement', () => {
    let current = workspace;
    runtime.activate({ mode: 'arduino', getWorkspace: () => current });
    const altered = runtime.captureNativeReplay(); altered.graphics!.theme.fontStyle.size = 99;
    expect(() => altered.assertCurrent()).toThrowError(/graphics changed/);
    expect(workspace.getTheme().fontStyle.size).toBe(16);
    for (const [change, restore] of [
      [() => { workspace.getTheme().fontStyle.size = 17; }, () => { workspace.getTheme().fontStyle.size = 16; }],
      [() => { workspace.options.rendererOverrides!['MIN_BLOCK_HEIGHT'] = 32; }, () => { workspace.options.rendererOverrides!['MIN_BLOCK_HEIGHT'] = 31; }],
      [() => { workspace.options.oneBasedIndex = true; }, () => { workspace.options.oneBasedIndex = false; }],
      [() => { workspace.setViewportRendering(true); }, () => { workspace.setViewportRendering(false); }],
      [() => { (window as any).__ailyBlockDefinitionsMap.get('graphics_context_probe').width = 32; },
        () => { (window as any).__ailyBlockDefinitionsMap.get('graphics_context_probe').width = 24; }],
      [() => { current = null!; }, () => { current = workspace; }],
    ]) {
      const replay = runtime.captureNativeReplay(); change();
      expect(() => replay.assertCurrent()).toThrowError(/graphics changed/);
      restore(); expect(() => runtime.captureNativeReplay().assertCurrent()).not.toThrow();
    }
  });

  it('keeps the complete candidate state and initializes offscreen views with viewport rendering', async () => {
    workspace.setViewportRendering(true);
    const graphics = captureNativeGraphicsContext(workspace)!;
    const steps = [{ kind: 'context' as const, mode: 'arduino' as const }, { kind: 'script' as const, label: 'offscreen-views', source: `
      Blockly.Blocks.offscreen_probe = { init() {
        if (!this.workspace.getViewportRenderer()) throw Error('candidate did not use host viewport rendering');
        this.appendDummyInput().appendField('probe');
        this.workspace.getViewportRenderer().deferView(this, () => {
          this.setTooltip('initialized');
          this.viewInitialized = true;
        });
      } };
      Arduino.forBlock.offscreen_probe = block => {
        if (!block.viewInitialized) throw Error('offscreen view was skipped');
        return 'probe();\\n';
      };
    ` }];
    const state = { blocks: { blocks: [{ id: 'hidden', type: 'offscreen_probe', x: 0, y: 50000 }] } };
    const result = await evaluateNativeCandidate({ graphics, steps, blocks: [],
      verify: { state, contracts: { fields: { hidden: {} } } } }, { assertCurrent() {} });
    expect(result.state['blocks'].blocks).toEqual(state.blocks.blocks);
  });

  for (const renderer of ['thrasos', 'aily-thrasos', 'aily-zelos']) it(`replays ${renderer}, theme, icons, index mode and RTL before library initialization`, async () => {
    workspace.dispose(); workspace = createWorkspace(renderer);
    Blockly.Blocks['graphics_context_probe'] = { init() { this.appendDummyInput().appendField('geometry probe'); } };
    const block = workspace.newBlock('graphics_context_probe'); block.initSvg(); block.render();
    const dimensions = block.getHeightWidth();
    const iconCount = block.getIcons().length;
    expect(iconCount).toBe(renderer.startsWith('aily-') ? 1 : 0);
    const graphics = captureNativeGraphicsContext(workspace)!;
    const result = await evaluateNativeCandidate({ graphics, blocks: [{ id: 'probe', type: 'graphics_context_probe', fields: [] }], steps: [{
      kind: 'script', label: 'graphics-context', source: `
        Blockly.Blocks.graphics_context_probe = {
          init() {
            const w = this.workspace;
            if (w.options.renderer !== '${renderer}' || !w.RTL || w.options.oneBasedIndex || w.getTheme().fontStyle.size !== 16)
              throw Error('graphics replay used different host options');
            this.appendDummyInput().appendField('geometry probe');
            setTimeout(() => {
              this.render();
              if (this.getIcons().length !== ${iconCount}) throw Error('graphics replay lost host icon');
              const size = this.getHeightWidth();
              if (size.width !== ${dimensions.width} || size.height !== ${dimensions.height})
                throw Error('graphics replay produced different dimensions: ' + JSON.stringify(size));
            }, 0);
          }
        };
      `,
    }] }, { assertCurrent() {} });
    expect(result.state['blocks'].blocks[0].type).toBe('graphics_context_probe');
    expect(graphics.theme.fontStyle.size).toBe(16);
  });

  for (const renderer of ['aily-thrasos', 'aily-zelos']) it(`${renderer} retains unchanged icon DOM but applies actual icon edits`, () => {
    workspace.dispose(); workspace = createWorkspace(renderer);
    Blockly.Blocks['graphics_context_probe'] = { init() { this.appendDummyInput().appendField('geometry probe'); } };
    const block = workspace.newBlock('graphics_context_probe'); block.initSvg(); block.render();
    const icon = block.getIcon(AILY_ICON_TYPE) as AilyIcon;
    const content = block.getSvgRoot().querySelector('foreignObject');
    expect(content).not.toBeNull();
    const create = spyOn<any>(icon, 'createIconContent').and.callThrough();
    for (let i = 0; i < 3; i++) block.render();
    icon.setState({ ...icon.getState() }); icon.setState(icon.getState().src);
    expect(create).not.toHaveBeenCalled();
    expect(block.getSvgRoot().querySelector('foreignObject')).toBe(content);
    const state = (window as any).__ailyBlockDefinitionsMap.get('graphics_context_probe');
    Object.assign(state, { width: 36, src: 'fa-solid fa-star', color: 'red' });
    block.render();
    expect(block.getIcon(AILY_ICON_TYPE)).toBe(icon);
    expect(create).toHaveBeenCalledTimes(1);
    const changed = block.getSvgRoot().querySelector('foreignObject');
    expect(changed).not.toBe(content); expect(changed!.getAttribute('width')).toBe('36');
    expect(changed!.getAttribute('color')).toBe('red');
    expect(changed!.querySelector('i')!.className).toBe('fa-solid fa-star');
    expect(icon.getSize().width).toBe(36);
    icon.setState({ color: '' }); expect(icon.getState().color).toBe('white');
    const final = block.getSvgRoot().querySelector('foreignObject');
    icon.setState({ color: undefined });
    expect(block.getSvgRoot().querySelector('foreignObject')).toBe(final);
  });
});
