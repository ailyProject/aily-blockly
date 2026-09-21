import * as Blockly from 'blockly';
import * as en from 'blockly/msg/en';
import * as zhHans from 'blockly/msg/zh-hans';
import { BlocklyGeneratorRuntimeService } from './blockly-generator-runtime.service';
import { BlocklyDeclarativeBlockCatalog } from './blockly-declarative-block-catalog';
import { describeAbsBlockCapability } from '../../../integrations/blockly/abs/abs-block-capabilities';

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
