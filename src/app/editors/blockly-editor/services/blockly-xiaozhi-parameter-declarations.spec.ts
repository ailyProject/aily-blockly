import { adaptXiaozhiParameterDeclarations } from './blockly-xiaozhi-parameter-declarations';

function declaration(name: string, type: string, enabled = true, parent: any = null): any {
  return { type: 'esp32ai_mcp_control_param', getFieldValue: (key: string) => key === 'VAR' ? name : type,
    isEnabled: () => enabled, getSurroundParent: () => parent };
}

// Model the published generator's order: an event reads the registry before
// its parameter declaration registers the type. The adapter must not warm up
// code generation or retain the previous workspace's types.
function runtime() {
  const realm: any = { mcpControlParams: [] };
  realm.registerMcpControlParam = (name: string, type: string) => {
    const existing = realm.mcpControlParams.find((item: any) => item.name === name);
    if (existing) existing.type = type; else realm.mcpControlParams.push({ name, type });
  };
  const generator: any = { init: jasmine.createSpy('init'), forBlock: {
    aivox_mcp_control_param: jasmine.createSpy('declaration generator'),
    esp32ai_mcp_control_param: jasmine.createSpy('ESP32 declaration generator'),
    aivox_control_message_event_fuction: jasmine.createSpy('event generator'),
  } };
  adaptXiaozhiParameterDeclarations(generator, realm);
  const generate = (blocks: any[]) => {
    generator.init({ getAllBlocks: () => blocks });
    generator.forBlock.aivox_control_message_event_fuction();
    const type = realm.mcpControlParams.find((item: any) => item.name === 'volume')?.type || 'Boolean';
    for (const block of blocks) {
      generator.forBlock[block.type]();
      if (block.isEnabled()) realm.registerMcpControlParam(block.getFieldValue('VAR'), block.getFieldValue('TYPE'));
    }
    return type;
  };
  return { generator, realm, generate };
}

describe('published Xiaozhi parameter generation', () => {
  it('uses Number on the first pass even when its declaration is generated later', () => {
    const { generator, generate } = runtime();
    expect(generate([declaration('volume', 'Number')])).toBe('Number');
    expect(generate([declaration('volume', 'Number')])).toBe('Number');
    expect(generator.forBlock.aivox_control_message_event_fuction).toHaveBeenCalledTimes(2);
    expect(generator.forBlock.esp32ai_mcp_control_param).toHaveBeenCalledTimes(2);
  });

  it('prepares both published parameter block names', () => {
    const { generator, generate } = runtime();
    const legacy = { ...declaration('volume', 'Number'), type: 'aivox_mcp_control_param' };
    expect(generate([legacy])).toBe('Number');
    expect(generator.forBlock.aivox_mcp_control_param).toHaveBeenCalledTimes(1);
  });

  it('uses changed types immediately and forgets removed or renamed declarations', () => {
    const { generate } = runtime();
    expect(generate([declaration('volume', 'Number')])).toBe('Number');
    expect(generate([declaration('volume', 'String')])).toBe('String');
    expect(generate([declaration('renamed', 'Number')])).toBe('Boolean');
    expect(generate([])).toBe('Boolean');
  });

  it('does not prepare disabled declarations or declarations inside disabled parents', () => {
    const { generator, realm } = runtime();
    realm.mcpControlParams.push({ name: 'volume', type: 'Number' });
    generator.init({ getAllBlocks: () => [declaration('volume', 'Number', false),
      declaration('other', 'String', true, { isEnabled: () => false, getSurroundParent: () => null })] });
    expect(realm.mcpControlParams).toEqual([]);
  });

  it('rejects conflicting declarations instead of choosing a type by block order', () => {
    const { generate } = runtime();
    expect(() => generate([declaration('volume', 'Number'), declaration('volume', 'String')])).toThrowError(/conflicting type/);
  });

  it('does not wrap unrelated generators and installs only once', () => {
    const plain = { init: jasmine.createSpy('plain'), forBlock: {} }, original = plain.init;
    adaptXiaozhiParameterDeclarations(plain, {});
    expect(plain.init).toBe(original);
    const { generator, realm } = runtime(), wrapped = generator.init;
    adaptXiaozhiParameterDeclarations(generator, realm);
    expect(generator.init).toBe(wrapped);
  });
});
