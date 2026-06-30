/**
 * Blockly 编辑工具简单测试脚本
 * 在浏览器环境中手动测试工具功能
 */

import { 
  smartBlockTool, 
  createCodeStructureTool, 
  variableManagerTool,
  blocklyEditTools
} from './editBlockTool';

// 测试结果收集器
interface TestResult {
  name: string;
  success: boolean;
  message: string;
  error?: string;
}

class BlocklyEditToolTester {
  private results: TestResult[] = [];

  // 添加测试结果
  private addResult(name: string, success: boolean, message: string, error?: string) {
    this.results.push({ name, success, message, error });
    
    const status = success ? '✅' : '❌';
    const output = `${status} ${name}: ${message}`;
    
    if (error) {
      console.error(output, error);
    } else {
      console.log(output);
    }
  }

  // 测试1: 基础块创建
  async testBasicBlockCreation() {
    try {
      const result = await smartBlockTool({
        type: 'serial_println',
        fields: { SERIAL: 'Serial' },
        inputs: {
          VAR: {
            block: {
              type: 'text',
              fields: { TEXT: 'Hello Blockly Test!' }
            }
          }
        }
      });

      if (result.is_error) {
        this.addResult('基础块创建', false, result.content);
      } else {
        this.addResult('基础块创建', true, `成功创建块 ID: ${result.metadata?.blockId}`);
      }
    } catch (error) {
      this.addResult('基础块创建', false, '测试异常', String(error));
    }
  }

  // 测试2: Arduino程序结构创建
  async testArduinoProgramCreation() {
    try {
      const result = await createCodeStructureTool({
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
                block: {
                  type: 'text',
                  fields: { TEXT: 'Arduino Setup Complete!' }
                }
              }
            }
          }
        ]
      });

      if (result.is_error) {
        this.addResult('Arduino程序创建', false, result.content);
      } else {
        this.addResult('Arduino程序创建', true, `成功创建 ${result.metadata?.createdBlocks?.length || 0} 个块`);
      }
    } catch (error) {
      this.addResult('Arduino程序创建', false, '测试异常', String(error));
    }
  }

  // 测试3: 变量管理
  async testVariableManagement() {
    try {
      // 创建变量
      const createResult = await variableManagerTool({
        action: 'create',
        variable: {
          name: 'testVariable',
          type: 'int',
          scope: 'global',
          initialValue: 42
        }
      });

      if (createResult.is_error) {
        this.addResult('变量管理', false, createResult.content);
        return;
      }

      // 列出变量
      const listResult = await variableManagerTool({
        action: 'list'
      });

      if (listResult.is_error) {
        this.addResult('变量管理', false, listResult.content);
      } else {
        const varCount = listResult.metadata?.variables?.length || 0;
        this.addResult('变量管理', true, `成功创建变量，当前有 ${varCount} 个变量`);
      }
    } catch (error) {
      this.addResult('变量管理', false, '测试异常', String(error));
    }
  }

  // 测试4: 条件结构创建
  async testConditionCreation() {
    try {
      const result = await createCodeStructureTool({
        structure: 'condition',
        blocks: [
          {
            type: 'logic_boolean',
            fields: { BOOL: 'TRUE' }
          },
          {
            type: 'serial_println',
            fields: { SERIAL: 'Serial' },
            inputs: {
              VAR: {
                block: {
                  type: 'text',
                  fields: { TEXT: 'Condition is true!' }
                }
              }
            }
          }
        ]
      });

      if (result.is_error) {
        this.addResult('条件结构创建', false, result.content);
      } else {
        this.addResult('条件结构创建', true, `成功创建条件结构，包含 ${result.metadata?.createdBlocks?.length || 0} 个块`);
      }
    } catch (error) {
      this.addResult('条件结构创建', false, '测试异常', String(error));
    }
  }

  // 测试5: 工作区环境检查
  async testWorkspaceAvailability() {
    try {
      // 检查 Blockly 是否可用
      if (typeof window === 'undefined' || !window['Blockly']) {
        this.addResult('工作区环境', false, 'Blockly 全局对象不可用');
        return;
      }

      // 检查工作区是否存在
      const workspace = window['Blockly'].getMainWorkspace?.();
      if (!workspace) {
        this.addResult('工作区环境', false, '未找到主工作区');
        return;
      }

      if (workspace.disposed) {
        this.addResult('工作区环境', false, '工作区已被销毁');
        return;
      }

      this.addResult('工作区环境', true, `工作区可用，ID: ${workspace.id || 'unknown'}`);
    } catch (error) {
      this.addResult('工作区环境', false, '环境检查异常', String(error));
    }
  }

  // 运行所有测试
  async runAllTests() {
    console.log('🚀 开始运行 Blockly 编辑工具测试...\n');

    this.results = [];

    await this.testWorkspaceAvailability();
    await this.testBasicBlockCreation();
    await this.testArduinoProgramCreation();
    await this.testVariableManagement();
    await this.testConditionCreation();

    this.printSummary();
  }

  // 打印测试摘要
  private printSummary() {
    const successCount = this.results.filter(r => r.success).length;
    const totalCount = this.results.length;
    
    console.log('\n' + '='.repeat(50));
    console.log('📊 测试摘要');
    console.log('='.repeat(50));
    console.log(`总测试数: ${totalCount}`);
    console.log(`成功数: ${successCount}`);
    console.log(`失败数: ${totalCount - successCount}`);
    console.log(`成功率: ${((successCount / totalCount) * 100).toFixed(1)}%`);
    
    if (successCount === totalCount) {
      console.log('🎉 所有测试通过！');
    } else {
      console.log('⚠️  部分测试失败，请检查失败的测试项');
    }
  }

  // 获取测试结果
  getResults(): TestResult[] {
    return [...this.results];
  }
}

// 导出测试器和快捷函数
export const blocklyTester = new BlocklyEditToolTester();

// 快捷测试函数
export async function runQuickTest() {
  await blocklyTester.runAllTests();
  return blocklyTester.getResults();
}

// 单独测试函数
export async function testBasicBlockCreation() {
  const tester = new BlocklyEditToolTester();
  await tester.testBasicBlockCreation();
  return tester.getResults();
}

export async function testArduinoProgramCreation() {
  const tester = new BlocklyEditToolTester();
  await tester.testArduinoProgramCreation();
  return tester.getResults();
}

export async function testVariableManagement() {
  const tester = new BlocklyEditToolTester();
  await tester.testVariableManagement();
  return tester.getResults();
}

// 浏览器控制台使用说明
if (typeof window !== 'undefined') {
  console.log(`
🧪 Blockly 编辑工具测试已加载！

使用方法：
1. 完整测试：runQuickTest()
2. 单项测试：
   - testBasicBlockCreation()
   - testArduinoProgramCreation() 
   - testVariableManagement()

示例：
  runQuickTest().then(results => console.log('测试完成', results));
  `);

  // 将测试函数添加到全局作用域，方便控制台调用
  (window as any).runQuickTest = runQuickTest;
  (window as any).testBasicBlockCreation = testBasicBlockCreation;
  (window as any).testArduinoProgramCreation = testArduinoProgramCreation;
  (window as any).testVariableManagement = testVariableManagement;
  (window as any).blocklyEditTools = blocklyEditTools;
}

export default BlocklyEditToolTester;
