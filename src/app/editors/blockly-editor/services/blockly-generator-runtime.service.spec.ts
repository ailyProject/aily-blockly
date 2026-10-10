import * as Blockly from 'blockly';
import * as en from 'blockly/msg/en';
import * as zhHans from 'blockly/msg/zh-hans';
import { BlocklyGeneratorRuntimeService } from './blockly-generator-runtime.service';
import { BlocklyDeclarativeBlockCatalog } from './blockly-declarative-block-catalog';
import { describeAbsBlockCapability } from '../../../integrations/blockly/abs/abs-block-capabilities';
import { withNativeStateLoading } from './blockly-native-state-loading';
import { loadAbsWorkspaceState } from '../../../integrations/blockly/abs/abs-workspace-state';

describe('BlocklyGeneratorRuntimeService', () => {
  let service: BlocklyGeneratorRuntimeService;
  let originalMessages: PropertyDescriptorMap;

  beforeEach(() => {
    originalMessages = Object.getOwnPropertyDescriptors(Blockly.Msg);
    service = new BlocklyGeneratorRuntimeService();
  });

  afterEach(() => {
    service.destroy();
    const originalKeys = new Set(Object.keys(originalMessages));
    for (const key of Object.keys(Blockly.Msg)) {
      if (!originalKeys.has(key)) {
        delete Blockly.Msg[key];
      }
    }
    Object.defineProperties(Blockly.Msg, originalMessages);
  });

  function activateRuntime(): void {
    service.activate({
      mode: 'arduino',
      getWorkspace: () => null,
    });
  }

  it('loads the published variable lookup alongside native dynamic function and variable categories', () => {
    const container = document.createElement('div'); document.body.appendChild(container);
    let workspace: Blockly.WorkspaceSvg | null = null;
    service.activate({ mode: 'arduino', getWorkspace: () => workspace });
    const source = `
      Blockly.Blocks.variable_define = { init() { this.appendDummyInput().appendField('declare'); } };
      window.findLegacyVariableCategory = () => Blockly.getMainWorkspace().getToolbox().getToolboxItems().find(item =>
        item.name_ === "Variables" || (item.getContents && item.getContents().some(c => c.type === "variable_define"))
      ).getName();
    `;
    service.loadGenerator('/project/node_modules/@aily-project/lib-core-variables/generator.js', source);
    try {
      workspace = Blockly.inject(container, { toolbox: { kind: 'categoryToolbox', contents: [
        { kind: 'category', name: '函数', custom: 'PROCEDURE' },
        { kind: 'category', name: '原生变量', custom: 'VARIABLE' },
        { kind: 'category', name: '变量', contents: [{ kind: 'block', type: 'variable_define' }] },
      ] } });
      expect(service.invokeGlobal('findLegacyVariableCategory')).toBe('变量');
      const categories = workspace.getToolbox()!.getToolboxItems() as Blockly.ToolboxCategory[];
      expect(categories[0].getContents()).toBe('PROCEDURE');
      expect(categories[1].getContents()).toBe('VARIABLE');
      expect(source).not.toContain('Array.isArray');
      expect(service.captureNativeReplay().steps.some(step => step.kind === 'script' && step.source.includes('Array.isArray'))).toBeTrue();
    } finally { workspace?.dispose(); container.remove(); }
  });

  for (const chunk of [false, true]) it('settles project-owned dropdown tasks across an entire load; chunk=' + chunk, async () => {
    const container = document.createElement('div'); document.body.appendChild(container);
    const workspace = Blockly.inject(container, { toolbox: null });
    const previousBlockly = window['Blockly']; window['Blockly'] = Blockly;
    service.activate({ mode: 'arduino', getWorkspace: () => workspace as Blockly.WorkspaceSvg });
    service.loadGenerator('dynamic-devices/generator.js', `
      Blockly.Blocks.runtime_config = { init() { this.appendDummyInput().appendField(new Blockly.FieldTextInput('Device'), 'NAME'); } };
      Blockly.Blocks.runtime_use = { init() {
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([['Default','default']]), 'DEVICE');
        setTimeout(() => {
          const configs = Blockly.getMainWorkspace().getBlocksByType('runtime_config', false);
          this.getField('DEVICE').menuGenerator_ = [['Default','default'], ...configs.map(b => [b.getFieldValue('NAME'),b.getFieldValue('NAME')])];
        }, 1000);
      } };
    `);
    const blocks = [{ type: 'runtime_use', id: 'consumer', fields: { DEVICE: 'Sensor' } },
      ...Array.from({ length: 70 }, (_, index) => ({ type: 'runtime_config', id: 'config-' + index, fields: { NAME: index === 69 ? 'Sensor' : 'Device' + index } }))];
    const state = { blocks: { blocks } };
    try {
      if (chunk) await loadAbsWorkspaceState(state, workspace as Blockly.WorkspaceSvg, { chunk }, () => {});
      else withNativeStateLoading(Blockly, workspace, state, () => Blockly.serialization.workspaces.load(state, workspace));
      expect(workspace.getBlockById('consumer')!.getFieldValue('DEVICE')).toBe('Sensor');
      expect(workspace.getAllBlocks(false).length).toBe(71);
      expect((service as any).session.resources.timeouts.size).toBe(0);
    } finally { workspace.dispose(); container.remove(); window['Blockly'] = previousBlockly; }
  });

  it('notifies library-owned loading listeners without invoking host save/generation listeners', () => {
    const workspace = new Blockly.Workspace(), hostListener = jasmine.createSpy('hostListener');
    workspace.addChangeListener(hostListener);
    service.activate({ mode: 'arduino', getWorkspace: () => workspace as Blockly.WorkspaceSvg });
    service.loadGenerator('dependent-listener/generator.js', `
      Blockly.Blocks.runtime_listener_use = { init() {
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([['Default','default']]), 'DEVICE');
        this.workspace.addChangeListener(event => {
          if (event.type === Blockly.Events.FINISHED_LOADING) {
            const canceled = setTimeout(() => { throw new Error('Canceled callback ran'); }, 0);
            clearTimeout(canceled);
            setTimeout(() => { this.getField('DEVICE').menuGenerator_ = [['Sensor','Sensor']]; }, 50);
          }
        });
      } };
    `);
    const state = { blocks: { blocks: [{ type: 'runtime_listener_use', id: 'consumer', fields: { DEVICE: 'Sensor' } }] } };
    Blockly.Events.disable();
    try {
      withNativeStateLoading(Blockly, workspace, state, () => Blockly.serialization.workspaces.load(state, workspace));
      expect(workspace.getBlockById('consumer')!.getFieldValue('DEVICE')).toBe('Sensor');
      expect(hostListener).not.toHaveBeenCalled();
      expect((service as any).session.resources.timeouts.size).toBe(0);
    } finally { workspace.dispose(); Blockly.Events.enable(); }
  });

  it('does not drain ordinary host timers when all saved fields are already available', async () => {
    const workspace = new Blockly.Workspace();
    service.activate({ mode: 'arduino', getWorkspace: () => workspace as Blockly.WorkspaceSvg });
    service.loadGenerator('ordinary-timer/generator.js', `
      window.timerRuns = 0;
      window.readTimerRuns = () => window.timerRuns;
      Blockly.Blocks.runtime_timer = { init() {
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([['Default','default']]), 'DEVICE');
        setTimeout(() => { window.timerRuns++; }, 10);
      } };
    `);
    const state = { blocks: { blocks: [{ type: 'runtime_timer', fields: { DEVICE: 'default' } }] } };
    try {
      withNativeStateLoading(Blockly, workspace, state, () => Blockly.serialization.workspaces.load(state, workspace));
      expect(service.invokeGlobal('readTimerRuns')).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(service.invokeGlobal('readTimerRuns')).toBe(1);
    } finally { workspace.dispose(); }
  });

  it('encodes legacy text before Project Data wrapping without adding wrappers on unrelated library loads', () => {
    activateRuntime();
    service.loadGenerator('legacy-text/generator.js', `Arduino.forBlock.text = block => ['"' + block.getFieldValue('TEXT') + '"', 0];`);
    const generator: any = service.getActiveGenerator()!, handler = generator.forBlock['text'];
    const block = { getFieldValue: () => '{"city":"成都"}', type: 'text', getField: () => undefined };
    expect(handler(block as any, generator)).toEqual(['"{\\"city\\":\\"成都\\"}"', 0]);
    service.loadGenerator('unrelated/generator.js', `Arduino.forBlock.other = () => '';`);
    expect(generator.forBlock['text']).toBe(handler);
    service.loadGenerator('replacement/generator.js', `Arduino.forBlock.text = block => [Arduino.quote_(block.getFieldValue('TEXT')), 0];`);
    expect(generator.forBlock['text'](block as any, generator)).toEqual(['"{\\"city\\":\\"成都\\"}"', 0]);
  });

  it('preserves the published AI-VOX raw header input without weakening ordinary text escaping', () => {
    activateRuntime();
    service.loadGenerator('legacy-text/generator.js', `Arduino.forBlock.text = block => ['"' + block.getFieldValue('TEXT') + '"', 0];`);
    const generator: any = service.getActiveGenerator()!;
    const rawHeaders = '{{"Authorization", "Bearer test-token"}}';
    const headerBlock: any = {
      type: 'text',
      getFieldValue: () => rawHeaders,
      getField: () => undefined,
      outputConnection: {},
    };
    let parentBlock: any;
    const parentConnection: any = { getSourceBlock: () => parentBlock };
    parentBlock = {
      type: 'aivox_config_websocket',
      inputList: [{ name: 'ai_vox_websocket_param', connection: parentConnection }],
    };
    headerBlock.outputConnection.targetConnection = parentConnection;

    const legacyCode = generator.forBlock['text'](headerBlock, generator)[0];
    expect(legacyCode.substring(1, legacyCode.length - 1)).toBe(rawHeaders);

    const ordinaryBlock = { type: 'text', getFieldValue: () => rawHeaders, getField: () => undefined };
    expect(generator.forBlock['text'](ordinaryBlock as any, generator)[0])
      .toBe('"{{\\"Authorization\\", \\"Bearer test-token\\"}}"');
  });

  it('captures declarations registered by generator scripts in the same project runtime, without probing instances', () => {
    const catalog = new BlocklyDeclarativeBlockCatalog();
    service.activate({ mode: 'arduino', boardConfig: { label: 'configured' }, getWorkspace: () => null,
      onBlockDefinition: (source, definition) => catalog.record(source, definition) });
    const probe = spyOn(Blockly.Workspace.prototype, 'newBlock').and.callThrough();
    service.loadGenerator('any-library/generator.js', `Blockly.defineBlocksWithJsonArray([{type:'runtime_declared_shape',
      message0:'%1',args0:[{type:'field_input',name:'NAME',text:boardConfig.label}],output:'String'}]);`);
    const snapshot = catalog.capture(Blockly.Blocks);
    expect(snapshot.get('runtime_declared_shape')!['args0'][0].text).toBe('configured');
    expect(describeAbsBlockCapability(snapshot, 'runtime_declared_shape').level).toBe('create');
    expect(probe).not.toHaveBeenCalled();
    service.destroy(); expect(() => snapshot.assertCurrent()).toThrow();
  });

  it('passes declared MCU to libraries and candidate replay without retaining it across board changes', () => {
    service.activate({ mode: 'arduino', boardConfig: { type: 'vendor:sdk:alias', mcu: 'esp32s3' }, getWorkspace: () => null });
    service.loadGenerator('read-board/generator.js', 'window.readBoardMcu = () => boardConfig.mcu;');
    expect(service.invokeGlobal('readBoardMcu')).toBe('esp32s3');
    expect(service.captureNativeReplay().steps.filter(step => step.kind === 'context').at(-1)?.['boardConfig']['mcu']).toBe('esp32s3');
    service.updateBoardConfig({ type: 'other:sdk:legacy' });
    expect(service.invokeGlobal('readBoardMcu')).toBeUndefined();
    expect(service.captureNativeReplay().steps.filter(step => step.kind === 'context').at(-1)?.['boardConfig']['mcu']).toBeUndefined();
  });

  it('preserves the current host locale across a runtime rebuild', () => {
    Blockly.setLocale(en as any);
    activateRuntime();

    Blockly.setLocale(zhHans as any);
    service.refreshBlocklyMessageSnapshot();
    service.rebuild();

    expect(Blockly.Msg['DUPLICATE_BLOCK']).toBe(zhHans.DUPLICATE_BLOCK);
    expect(Blockly.Msg['COLLAPSE_BLOCK']).toBe(zhHans.COLLAPSE_BLOCK);
    expect(Blockly.Msg['DELETE_X_BLOCKS']).toBe(zhHans.DELETE_X_BLOCKS);
  });

  it('does not adopt project-library message keys into the host checkpoint', () => {
    Blockly.setLocale(zhHans as any);
    activateRuntime();

    Blockly.Msg['PROJECT_LIBRARY_ONLY'] = 'project value';
    service.refreshBlocklyMessageSnapshot();
    service.rebuild();

    expect(Blockly.Msg['PROJECT_LIBRARY_ONLY']).toBeUndefined();
  });

  it('does not let late generator-load cleanup destroy a replacement runtime', () => {
    activateRuntime(); const previous = service.getActiveGenerator();
    const current = service.rebuild();
    service.destroy(previous);
    expect(service.getActiveGenerator()).toBe(current);
    service.destroy(current);
    expect(service.getActiveGenerator()).toBeNull();
  });

  it('can clean up the owned session even after a script failure deactivates it', () => {
    activateRuntime(); const owner = service.getActiveGenerator();
    const internal = service as any, session = internal.session;
    internal.markFailed(session);
    expect(service.getActiveGenerator()).toBeNull();
    service.destroy(owner);
    expect(internal.session).toBeNull(); expect(session.iframe.isConnected).toBeFalse();
  });
});
