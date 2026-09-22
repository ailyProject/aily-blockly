import { convertAbiToAbs, convertAbsToAbi } from './abi-abs-converter';
import { loadBlockDefinitionsFromPath, setGlobalBlockMetas } from './block-definition.service';

describe('ABS field regressions (production converter)', () => {
  beforeEach(() => {
    const definitions = [{
      type: 'test_mode',
      args0: [
        { type: 'field_dropdown', name: 'MODE', options: [['Interrupt', 'true'], ['Queue', 'false']] },
        { type: 'field_input', name: 'textValue' },
        { type: 'field_unknown_custom', name: 'DATA' },
      ],
    }];
    setGlobalBlockMetas(loadBlockDefinitionsFromPath('/project', {
      path: { join: (...parts: string[]) => parts.join('/') },
      fs: {
        existsSync: () => true,
        readdirSync: () => ['lib-test'],
        readFileSync: () => JSON.stringify(definitions),
      },
    }));
  });

  afterEach(() => setGlobalBlockMetas(new Map()));

  it('normalizes a boolean only against the actual dropdown values', () => {
    const result = convertAbsToAbi('test_mode(MODE=false)');
    expect(result.success).toBeTrue();
    expect(result.abiJson.blocks.blocks[0].fields.MODE).toBe('false');
  });

  it('keeps a dropdown string and leading-zero text through two round trips', () => {
    let abi = { blocks: { blocks: [{ type: 'test_mode', fields: { MODE: 'false', textValue: '001' } }] } };
    for (let i = 0; i < 2; i++) {
      const result = convertAbsToAbi(convertAbiToAbs(abi));
      expect(result.success).toBeTrue();
      abi = result.abiJson;
      expect(abi.blocks.blocks[0].fields).toEqual({ MODE: 'false', textValue: '001' });
    }
  });

  it('reports an invalid dropdown instead of allowing Blockly to default it', () => {
    expect(convertAbsToAbi('test_mode(MODE="invalid")').success).toBeFalse();
  });

  it('does not uppercase named fields', () => {
    const result = convertAbsToAbi('test_mode(textValue="false")');
    expect(result.abiJson.blocks.blocks[0].fields).toEqual({ textValue: 'false' });
  });
  it('names dynamic fields absent from static argsOrder instead of inventing EXTRA_N', () => {
    const abi = { blocks: { blocks: [{ type: 'test_mode', fields: {
      MODE: 'false', textValue: '001', DATA: { frames: [] }, pinLabel: 'LED_BUILTIN', dynamicState: { values: [1, false] },
    } }] } };
    const abs = convertAbiToAbs(abi);
    expect(abs).toContain('pinLabel="LED_BUILTIN"');
    const result = convertAbsToAbi(abs);
    expect(result.success).toBeTrue();
    expect(result.abiJson.blocks.blocks[0].fields).toEqual(abi.blocks.blocks[0].fields);
  });

  it('does not mistake arbitrary objects containing name for Blockly variables', () => {
    const value = { name: 'image', frames: [1, 2], enabled: false };
    const result = convertAbsToAbi(`test_mode(DATA=${JSON.stringify(value)})`);
    expect(result.success).toBeTrue();
    expect(result.abiJson.variables).toEqual([]);
    expect(result.abiJson.blocks.blocks[0].fields.DATA).toEqual(value);
  });

  it('still accepts saved legacy @json fields before the coordinated format cutover', () => {
    const data = { value: [1, false] };
    const result = convertAbsToAbi(`test_mode(DATA=${JSON.stringify('@json:' + JSON.stringify(data))})`);
    expect(result.success).toBeTrue();
    expect(result.abiJson.blocks.blocks[0].fields.DATA).toEqual(data);
  });

  for (const extraState of [false, null, [], [false, 'x::ID'], { ids: ['x::PARAM'], text: ' @extra:inside' }]) {
    it(`preserves the complete extraState contract: ${JSON.stringify(extraState)}`, () => {
      const abi = { blocks: { blocks: [{ type: 'test_mode', id: 'a', extraState }] } };
      const result = convertAbsToAbi(convertAbiToAbs(abi, { includeBlockIds: true }));
      expect(result.success).toBeTrue();
      expect(result.abiJson.blocks.blocks[0].extraState).toEqual(extraState);
    });
  }

  it('preserves escaped strings ending in a backslash and later arguments', () => {
    const abi = { blocks: { blocks: [{ type: 'test_mode', fields: { MODE: 'false', textValue: 'path\\', DATA: { unicode: '😀', text: '\\u0041' } } }] } };
    const result = convertAbsToAbi(convertAbiToAbs(abi));
    expect(result.success).toBeTrue();
    expect(result.abiJson.blocks.blocks[0].fields).toEqual(abi.blocks.blocks[0].fields);
  });
});
