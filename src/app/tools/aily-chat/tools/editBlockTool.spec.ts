/**
 * Blockly 编辑工具测试
 * 测试 editBlockTool 的各项功能
 */

import { 
  smartBlockTool, 
  connectBlocksTool, 
  createCodeStructureTool, 
  configureBlockTool, 
  variableManagerTool, 
  findBlockTool 
} from './editBlockTool';

// Mock Blockly 环境
const mockBlockly = {
  Events: {
    getRecordUndo: () => true,
    setRecordUndo: (value: boolean) => {},
    getGroup: () => null,
    setGroup: (group: any) => {},
    disable: () => {},
    enable: () => {},
    isEnabled: () => true
  },
  Blocks: {
    serial_begin: {},
    serial_println: {},
    arduino_setup: {},
    arduino_loop: {},
    math_number: {},
    text: {},
    variables_get: {},
    variable_define: {},
    controls_if: {},
    controls_whileUntil: {},
    logic_boolean: {}
  },
  getMainWorkspace: () => mockWorkspace,
  Workspace: {
    getAll: () => [mockWorkspace]
  }
};

// Mock Workspace
const mockWorkspace = {
  id: 'test-workspace',
  disposed: false,
  svgGroup_: true,
  newBlock: (type: string) => new MockBlock(type),
  getBlockById: (id: string) => mockBlocks.get(id) || null,
  getAllBlocks: () => Array.from(mockBlocks.values()),
  getMetrics: () => ({
    viewLeft: 0,
    viewTop: 0,
    viewWidth: 800,
    viewHeight: 600
  }),
  getParentSvg: () => ({ parentNode: document.body }),
  setSelected: (block: any) => { selectedBlock = block; },
  getSelected: () => selectedBlock,
  createVariable: (name: string, type: string) => new MockVariable(name, type),
  getAllVariables: () => Array.from(mockVariables.values()),
  renameVariableById: (id: string, newName: string) => {
    const variable = Array.from(mockVariables.values()).find(v => v.getId() === id);
    if (variable) {
      variable.name = newName;
    }
  },
  deleteVariableById: (id: string) => {
    const variable = Array.from(mockVariables.values()).find(v => v.getId() === id);
    if (variable) {
      mockVariables.delete(variable.name);
    }
  }
};

// Mock Block
class MockBlock {
  public id: string;
  public type: string;
  public disposed = false;
  public workspace = mockWorkspace;
  private fields = new Map<string, MockField>();
  private inputs = new Map<string, MockInput>();
  public nextConnection: MockConnection | null = null;
  public previousConnection: MockConnection | null = null;
  public outputConnection: MockConnection | null = null;

  constructor(type: string) {
    this.id = 'block_' + Math.random().toString(36).substr(2, 9);
    this.type = type;
    
    // 根据块类型设置连接
    if (['serial_begin', 'serial_println', 'variable_define'].includes(type)) {
      this.previousConnection = new MockConnection(this, 'previous');
      this.nextConnection = new MockConnection(this, 'next');
    }
    
    if (['math_number', 'text', 'variables_get', 'logic_boolean'].includes(type)) {
      this.outputConnection = new MockConnection(this, 'output');
    }
    
    // 设置默认字段
    this.setupDefaultFields();
    
    // 设置默认输入
    this.setupDefaultInputs();
    
    // 注册到全局块集合
    mockBlocks.set(this.id, this);
  }

  private setupDefaultFields() {
    switch (this.type) {
      case 'serial_begin':
        this.fields.set('SERIAL', new MockField('Serial'));
        this.fields.set('SPEED', new MockField('115200'));
        break;
      case 'serial_println':
        this.fields.set('SERIAL', new MockField('Serial'));
        break;
      case 'math_number':
        this.fields.set('NUM', new MockField(0));
        break;
      case 'text':
        this.fields.set('TEXT', new MockField(''));
        break;
      case 'logic_boolean':
        this.fields.set('BOOL', new MockField('TRUE'));
        break;
      case 'variables_get':
      case 'variable_define':
        this.fields.set('VAR', new MockField(''));
        break;
    }
  }

  private setupDefaultInputs() {
    switch (this.type) {
      case 'serial_println':
        this.inputs.set('VAR', new MockInput('VAR', 'value'));
        break;
      case 'arduino_setup':
        this.inputs.set('ARDUINO_SETUP', new MockInput('ARDUINO_SETUP', 'statement'));
        break;
      case 'arduino_loop':
        this.inputs.set('ARDUINO_LOOP', new MockInput('ARDUINO_LOOP', 'statement'));
        break;
      case 'controls_if':
        this.inputs.set('IF0', new MockInput('IF0', 'value'));
        this.inputs.set('DO0', new MockInput('DO0', 'statement'));
        break;
      case 'controls_whileUntil':
        this.inputs.set('BOOL', new MockInput('BOOL', 'value'));
        this.inputs.set('DO', new MockInput('DO', 'statement'));
        break;
      case 'variable_define':
        this.inputs.set('VALUE', new MockInput('VALUE', 'value'));
        break;
    }
  }

  initSvg() {
    // Mock SVG initialization
  }

  render() {
    // Mock render
  }

  moveBy(dx: number, dy: number) {
    // Mock movement
  }

  moveTo(x: number, y: number) {
    // Mock movement
  }

  getField(name: string) {
    return this.fields.get(name) || null;
  }

  getInput(name: string) {
    return this.inputs.get(name) || null;
  }

  setDeletable(deletable: boolean) {
    // Mock setDeletable
  }

  getSvgRoot() {
    return {
      style: {}
    };
  }

  getRelativeToSurfaceXY() {
    return { x: Math.random() * 400, y: Math.random() * 300 };
  }

  getNextBlock() {
    return this.nextConnection?.targetConnection?.sourceBlock_ || null;
  }
}

// Mock Field
class MockField {
  constructor(private value: any) {}

  getValue() {
    return this.value;
  }

  setValue(value: any) {
    this.value = value;
  }

  getText() {
    return String(this.value);
  }

  setText(text: string) {
    this.value = text;
  }
}

// Mock Input
class MockInput {
  public connection: MockConnection;

  constructor(public name: string, public type: 'value' | 'statement') {
    this.connection = new MockConnection(null, type === 'value' ? 'input_value' : 'input_statement');
  }
}

// Mock Connection
class MockConnection {
  public targetConnection: MockConnection | null = null;
  public sourceBlock_: MockBlock | null = null;

  constructor(sourceBlock: MockBlock | null, public type: string) {
    this.sourceBlock_ = sourceBlock;
  }

  connect(otherConnection: MockConnection) {
    this.targetConnection = otherConnection;
    otherConnection.targetConnection = this;
  }

  disconnect() {
    if (this.targetConnection) {
      this.targetConnection.targetConnection = null;
      this.targetConnection = null;
    }
  }

  setShadowDom(shadowBlock: any) {
    // Mock shadow DOM setting
  }
}

// Mock Variable
class MockVariable {
  private id: string;

  constructor(public name: string, public type: string) {
    this.id = 'var_' + Math.random().toString(36).substr(2, 9);
    mockVariables.set(name, this);
  }

  getId() {
    return this.id;
  }
}

// Global state
const mockBlocks = new Map<string, MockBlock>();
const mockVariables = new Map<string, MockVariable>();
let selectedBlock: MockBlock | null = null;

// Setup global mocks
(global as any).window = {
  Blockly: mockBlockly
};

// 测试套件
describe('Blockly Edit Tools', () => {
  beforeEach(() => {
    // 清理状态
    mockBlocks.clear();
    mockVariables.clear();
    selectedBlock = null;
  });

  describe('smartBlockTool', () => {
    it('应该能创建一个简单的块', async () => {
      const result = await smartBlockTool({
        type: 'serial_begin',
        fields: {
          SERIAL: 'Serial',
          SPEED: '9600'
        }
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.blockType).toBe('serial_begin');
      expect(result.metadata?.blockId).toBeDefined();
    });

    it('应该能创建带输入的块', async () => {
      const result = await smartBlockTool({
        type: 'serial_println',
        fields: {
          SERIAL: 'Serial'
        },
        inputs: {
          VAR: {
            block: {
              type: 'text',
              fields: { TEXT: 'Hello World' }
            }
          }
        }
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.blockType).toBe('serial_println');
    });

    it('应该处理不存在的块类型', async () => {
      const result = await smartBlockTool({
        type: 'non_existent_block'
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('不存在或未注册');
    });
  });

  describe('createCodeStructureTool', () => {
    it('应该能创建序列结构', async () => {
      const result = await createCodeStructureTool({
        structure: 'sequence',
        blocks: [
          {
            type: 'serial_begin',
            fields: { SERIAL: 'Serial', SPEED: '115200' }
          },
          {
            type: 'serial_println',
            fields: { SERIAL: 'Serial' },
            inputs: {
              VAR: {
                block: { type: 'text', fields: { TEXT: 'Ready!' } }
              }
            }
          }
        ]
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.structureType).toBe('sequence');
      expect(result.metadata?.createdBlocks?.length).toBe(4); // 2个主块 + 2个子块
    });

    it('应该能创建Setup结构', async () => {
      const result = await createCodeStructureTool({
        structure: 'setup',
        blocks: [
          {
            type: 'serial_begin',
            fields: { SERIAL: 'Serial', SPEED: '115200' }
          }
        ]
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.structureType).toBe('setup');
      expect(result.metadata?.rootBlockId).toBeDefined();
    });

    it('应该能创建条件结构', async () => {
      const result = await createCodeStructureTool({
        structure: 'condition',
        blocks: [
          { type: 'logic_boolean' },
          { type: 'serial_println', fields: { SERIAL: 'Serial' } }
        ]
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.structureType).toBe('condition');
    });

    it('应该能创建循环结构', async () => {
      const result = await createCodeStructureTool({
        structure: 'loop',
        blocks: [
          { type: 'logic_boolean' },
          { type: 'serial_println', fields: { SERIAL: 'Serial' } }
        ]
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.structureType).toBe('loop');
    });
  });

  describe('connectBlocksTool', () => {
    it('应该能连接两个现有块', async () => {
      // 先创建两个块
      const block1Result = await smartBlockTool({
        type: 'serial_begin',
        fields: { SERIAL: 'Serial', SPEED: '9600' }
      });

      const block2Result = await smartBlockTool({
        type: 'serial_println',
        fields: { SERIAL: 'Serial' }
      });

      // 连接它们
      const connectResult = await connectBlocksTool({
        sourceBlock: block1Result.metadata!.blockId,
        targetBlock: block2Result.metadata!.blockId,
        connectionType: 'next'
      });

      expect(connectResult.is_error).toBe(false);
      expect(connectResult.metadata?.sourceBlockId).toBe(block1Result.metadata!.blockId);
      expect(connectResult.metadata?.targetBlockId).toBe(block2Result.metadata!.blockId);
    });

    it('应该能创建并连接新块', async () => {
      const result = await connectBlocksTool({
        sourceBlock: {
          type: 'serial_begin',
          fields: { SERIAL: 'Serial', SPEED: '9600' }
        },
        targetBlock: {
          type: 'serial_println',
          fields: { SERIAL: 'Serial' }
        },
        connectionType: 'next'
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.connectionType).toBe('next');
    });
  });

  describe('configureBlockTool', () => {
    it('应该能配置现有块的字段', async () => {
      // 先创建一个块
      const createResult = await smartBlockTool({
        type: 'serial_begin',
        fields: { SERIAL: 'Serial', SPEED: '9600' }
      });

      // 配置该块
      const configResult = await configureBlockTool({
        blockId: createResult.metadata!.blockId,
        fields: {
          SPEED: '115200'
        }
      });

      expect(configResult.is_error).toBe(false);
      expect(configResult.metadata?.fieldsUpdated).toContain('SPEED');
    });

    it('应该能按类型查找并配置块', async () => {
      // 先创建一个块
      await smartBlockTool({
        type: 'serial_begin',
        fields: { SERIAL: 'Serial', SPEED: '9600' }
      });

      // 按类型配置
      const configResult = await configureBlockTool({
        blockType: 'serial_begin',
        fields: {
          SPEED: '115200'
        }
      });

      expect(configResult.is_error).toBe(false);
    });
  });

  describe('variableManagerTool', () => {
    it('应该能创建变量', async () => {
      const result = await variableManagerTool({
        action: 'create',
        variable: {
          name: 'testVar',
          type: 'int',
          scope: 'global',
          initialValue: 42
        }
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.variableName).toBe('testVar');
      expect(result.metadata?.variableId).toBeDefined();
    });

    it('应该能列出变量', async () => {
      // 先创建几个变量
      await variableManagerTool({
        action: 'create',
        variable: { name: 'var1', type: 'int', scope: 'global' }
      });

      await variableManagerTool({
        action: 'create',
        variable: { name: 'var2', type: 'string', scope: 'global' }
      });

      // 列出变量
      const result = await variableManagerTool({
        action: 'list'
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.variables?.length).toBe(2);
    });

    it('应该能重命名变量', async () => {
      // 先创建一个变量
      await variableManagerTool({
        action: 'create',
        variable: { name: 'oldName', type: 'int', scope: 'global' }
      });

      // 重命名
      const result = await variableManagerTool({
        action: 'rename',
        oldName: 'oldName',
        newName: 'newName'
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.variableName).toBe('newName');
    });

    it('应该能删除变量', async () => {
      // 先创建一个变量
      await variableManagerTool({
        action: 'create',
        variable: { name: 'toDelete', type: 'int', scope: 'global' }
      });

      // 删除
      const result = await variableManagerTool({
        action: 'delete',
        variable: { name: 'toDelete', type: 'int', scope: 'global' }
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.variableName).toBe('toDelete');
    });
  });

  describe('findBlockTool', () => {
    it('应该能按类型查找块', async () => {
      // 创建一些块
      await smartBlockTool({ type: 'serial_begin' });
      await smartBlockTool({ type: 'serial_println' });
      await smartBlockTool({ type: 'serial_begin' });

      // 查找
      const result = await findBlockTool({
        criteria: { type: 'serial_begin' }
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.foundBlocks?.length).toBe(2);
      expect(result.metadata?.foundBlocks?.[0].type).toBe('serial_begin');
    });

    it('应该能选中找到的块', async () => {
      // 创建一个块
      await smartBlockTool({ type: 'serial_begin' });

      // 查找并选中
      const result = await findBlockTool({
        criteria: { type: 'serial_begin' },
        action: 'select'
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.selectedBlockId).toBeDefined();
    });

    it('找不到块时应该返回空结果', async () => {
      const result = await findBlockTool({
        criteria: { type: 'non_existent_type' }
      });

      expect(result.is_error).toBe(false);
      expect(result.metadata?.foundBlocks?.length).toBe(0);
    });
  });

  describe('错误处理', () => {
    it('应该处理无效的块类型', async () => {
      const result = await smartBlockTool({
        type: 'invalid_block_type'
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('不存在或未注册');
    });

    it('应该处理缺少必需参数', async () => {
      const result = await smartBlockTool({
        type: ''
      });

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('必需的');
    });

    it('应该处理连接不兼容的块', async () => {
      const result = await connectBlocksTool({
        sourceBlock: 'non_existent_block',
        targetBlock: 'another_non_existent_block',
        connectionType: 'next'
      });

      expect(result.is_error).toBe(true);
    });
  });

  describe('集成测试', () => {
    it('应该能创建完整的Arduino程序', async () => {
      // 创建Setup结构
      const setupResult = await createCodeStructureTool({
        structure: 'setup',
        blocks: [
          {
            type: 'serial_begin',
            fields: { SERIAL: 'Serial', SPEED: '115200' }
          },
          {
            type: 'serial_println',
            fields: { SERIAL: 'Serial' },
            inputs: {
              VAR: {
                block: { type: 'text', fields: { TEXT: 'Setup Complete!' } }
              }
            }
          }
        ]
      });

      expect(setupResult.is_error).toBe(false);

      // 创建Loop结构
      const loopResult = await smartBlockTool({
        type: 'arduino_loop',
        inputs: {
          ARDUINO_LOOP: {
            block: {
              type: 'serial_println',
              fields: { SERIAL: 'Serial' },
              inputs: {
                VAR: {
                  block: { type: 'text', fields: { TEXT: 'Loop running...' } }
                }
              }
            }
          }
        }
      });

      expect(loopResult.is_error).toBe(false);

      // 验证创建的块数量
      expect(mockBlocks.size).toBeGreaterThan(4);
    });

    it('应该能创建带变量的程序', async () => {
      // 创建变量
      const varResult = await variableManagerTool({
        action: 'create',
        variable: {
          name: 'counter',
          type: 'int',
          scope: 'global',
          initialValue: 0
        }
      });

      expect(varResult.is_error).toBe(false);

      // 使用变量
      const blockResult = await smartBlockTool({
        type: 'serial_println',
        fields: { SERIAL: 'Serial' },
        inputs: {
          VAR: {
            block: {
              type: 'variables_get',
              fields: { VAR: { name: 'counter' } }
            }
          }
        }
      });

      expect(blockResult.is_error).toBe(false);
    });
  });
});
