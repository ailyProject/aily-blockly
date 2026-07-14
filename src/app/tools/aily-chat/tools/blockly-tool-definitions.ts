import { MAIN_AGENT_TYPE } from '../core/agent-identifiers';

export const BLOCKLY_TOOL_DEFINITIONS = [
  {
    name: 'syncAbs',
    description: `ABS 文件同步工具。它是修改 Blockly 工作区的唯一 chat/agent 入口：先导出 project.abs，使用文件编辑工具修改 ABS，再导入回 Blockly 工作区。

操作类型：
- export: 将当前 Blockly 工作区导出为 project.abs。
- import: 从 project.abs 导入并替换当前工作区。
- status: 查看 ABS 文件状态和预览。

推荐工作流：
1. syncAbs action="export"
2. read_file project.abs
3. edit_file project.abs
4. syncAbs action="import"`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['export', 'import', 'status'],
          description: '操作类型：export=导出到 ABS 文件，import=从 ABS 文件导入，status=查看状态',
        },
        includeHeader: {
          type: 'boolean',
          description: '导出时是否包含文件头注释（默认 true）',
          default: true,
        },
      },
      required: ['action'],
    },
    agents: [MAIN_AGENT_TYPE],
  },
  {
    name: 'lint',
    description: '检查当前 Blockly 生成代码的语法错误、警告和提示。修改 ABS 并导入后，用它验证生成代码是否仍然可用。',
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['fast', 'accurate', 'auto'],
          default: 'fast',
          description: '检查模式：fast=快速静态检查（默认），accurate=编译器精确检查，auto=先快速检查并在需要时使用编译器检查',
        },
      },
      required: [],
    },
    agents: [MAIN_AGENT_TYPE],
  },
  {
    name: 'analyzeLibrary',
    description: '按库 ID 分析可用块定义。mode="auto" 优先返回 readme_ai.md 参考；没有 readme 或需要强制分析时使用 analysis。',
    input_schema: {
      type: 'object',
      properties: {
        libraryId: {
          type: 'string',
          description: '库 package ID，例如 "lib-servo"',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'readme_ref', 'analysis'],
          default: 'auto',
          description: 'auto 优先 readme；readme_ref 只返回 readme；analysis 强制块分析',
        },
      },
      required: ['libraryId'],
    },
    agents: [MAIN_AGENT_TYPE],
  },
];
