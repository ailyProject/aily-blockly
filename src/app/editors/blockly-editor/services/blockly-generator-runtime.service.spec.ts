import * as Blockly from 'blockly';
import * as en from 'blockly/msg/en';
import * as zhHans from 'blockly/msg/zh-hans';
import { BlocklyGeneratorRuntimeService } from './blockly-generator-runtime.service';

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
});
