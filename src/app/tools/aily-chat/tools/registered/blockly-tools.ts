/**
 * 已注册工具 - Blockly 块操作类
 */

import { IAilyTool, ToolContext, ToolUseResult } from '../../core/tool-types';
import { ToolRegistry } from '../../core/tool-registry';
import {
  smartBlockTool as smartBlockHandler,
  connectBlocksTool as connectBlocksHandler,
  createCodeStructureTool as createCodeStructureHandler,
  configureBlockTool as configureBlockHandler,
  deleteBlockTool as deleteBlockHandler,
  getWorkspaceOverviewTool as getWorkspaceOverviewHandler,
  queryBlockDefinitionTool as queryBlockDefinitionHandler,
  analyzeLibraryBlocksTool as analyzeLibraryBlocksHandler,
  verifyBlockExistenceTool as verifyBlockExistenceHandler,
} from '../editBlockTool';
import { TOOLS as LEGACY_TOOLS } from '../tools';

function findLegacySchema(name: string): any {
  return (LEGACY_TOOLS as any[]).find(t => t.name === name);
}

// ============================
// smart_block_tool
// ============================

class SmartBlockTool implements IAilyTool {
  readonly name = 'smart_block_tool';
  readonly schema = findLegacySchema('smart_block_tool') || {
    name: 'smart_block_tool',
    description: '智能创建Blockly块',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return smartBlockHandler(args);
  }

  getStartText(args: any): string {
    return `创建Blockly块: ${args?.type || 'unknown'}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '智能块操作失败';
    return `智能块操作成功: ${args?.type || 'unknown'}`;
  }
}

// ============================
// connect_blocks_tool
// ============================

class ConnectBlocksTool implements IAilyTool {
  readonly name = 'connect_blocks_tool';
  readonly schema = findLegacySchema('connect_blocks_tool') || {
    name: 'connect_blocks_tool',
    description: '连接Blockly块',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return connectBlocksHandler(args);
  }

  getStartText(): string {
    return '连接Blockly块...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '块连接失败';
    return `块连接成功: ${args?.connectionType || 'unknown'}连接`;
  }
}

// ============================
// create_code_structure_tool
// ============================

class CreateCodeStructureTool implements IAilyTool {
  readonly name = 'create_code_structure_tool';
  readonly schema = findLegacySchema('create_code_structure_tool') || {
    name: 'create_code_structure_tool',
    description: '创建代码结构',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return createCodeStructureHandler(args);
  }

  getStartText(args: any): string {
    return `创建代码结构: ${args?.structure || 'unknown'}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '代码结构创建失败';
    return `代码结构创建成功: ${args?.structure || 'unknown'}`;
  }
}

// ============================
// configure_block_tool
// ============================

class ConfigureBlockTool implements IAilyTool {
  readonly name = 'configure_block_tool';
  readonly schema = findLegacySchema('configure_block_tool') || {
    name: 'configure_block_tool',
    description: '配置Blockly块',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return configureBlockHandler(args);
  }

  getStartText(): string {
    return '配置Blockly块...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '块配置失败';
    return `块配置成功: ID ${args?.blockId || 'unknown'}`;
  }
}

// ============================
// delete_block_tool
// ============================

class DeleteBlockTool implements IAilyTool {
  readonly name = 'delete_block_tool';
  readonly schema = findLegacySchema('delete_block_tool') || {
    name: 'delete_block_tool',
    description: '删除Blockly块',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return deleteBlockHandler(args);
  }

  getStartText(): string {
    return '删除Blockly块...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '块删除失败';
    return '块删除成功';
  }
}

// ============================
// get_workspace_overview_tool
// ============================

class GetWorkspaceOverviewTool implements IAilyTool {
  readonly name = 'get_workspace_overview_tool';
  readonly schema = findLegacySchema('get_workspace_overview_tool');
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return getWorkspaceOverviewHandler(args);
  }

  getStartText(): string {
    return '分析工作区全览...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '工作区分析失败';
    return '工作区分析完成';
  }
}

// ============================
// queryBlockDefinitionTool
// ============================

class QueryBlockDefinitionTool implements IAilyTool {
  readonly name = 'queryBlockDefinitionTool';
  readonly schema = findLegacySchema('queryBlockDefinitionTool') || {
    name: 'queryBlockDefinitionTool',
    description: '查询块定义信息',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return queryBlockDefinitionHandler(ctx.host.project, args);
  }

  getStartText(): string {
    return '查询块定义信息...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '块定义查询失败';
    return '块定义查询完成';
  }
}

// ============================
// analyze_library_blocks
// ============================

class AnalyzeLibraryBlocksTool implements IAilyTool {
  readonly name = 'analyze_library_blocks';
  readonly schema = findLegacySchema('analyze_library_blocks');
  readonly environment = 'gui' as const;
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    // Pre-process libraryNames: string → array
    if (typeof args.libraryNames === 'string') {
      try {
        if (args.libraryNames.startsWith('[')) {
          args.libraryNames = JSON.parse(args.libraryNames);
        } else {
          args.libraryNames = args.libraryNames.split(',').map((s: string) => s.trim()).filter(Boolean);
        }
      } catch {
        if (args.libraryNames) {
          args.libraryNames = [args.libraryNames];
        }
      }
    }
    return analyzeLibraryBlocksHandler(ctx.host?.project, args);
  }

  getStartText(args: any): string {
    let names = '未知库';
    try {
      let parsed: string[] = [];
      if (typeof args?.libraryNames === 'string') {
        parsed = args.libraryNames.startsWith('[')
          ? JSON.parse(args.libraryNames)
          : args.libraryNames.split(',').map((s: string) => s.trim()).filter(Boolean);
      } else if (Array.isArray(args?.libraryNames)) {
        parsed = args.libraryNames;
      }
      if (parsed.length > 0) names = parsed.join(', ');
    } catch { /* fallback */ }
    return `正在分析库: ${names}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return `库分析失败: ${result?.content || '未知错误'}`;
    const metadata = result?.metadata;
    if (metadata) {
      return `库分析完成: 分析了 ${metadata.librariesAnalyzed || 0} 个库，找到 ${metadata.totalBlocks || 0} 个块定义`;
    }
    return '库分析完成';
  }
}

// ============================
// verify_block_existence
// ============================

class VerifyBlockExistenceTool implements IAilyTool {
  readonly name = 'verify_block_existence';
  readonly displayMode = 'appendMessage' as const;
  readonly schema = findLegacySchema('verify_block_existence') || {
    name: 'verify_block_existence',
    description: '验证块存在性',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    // Pre-process blockTypes: string → array via JSON.parse
    if (typeof args.blockTypes === 'string') {
      try {
        args.blockTypes = JSON.parse(args.blockTypes);
      } catch {
        // keep as-is, handler may handle string
      }
    }
    return verifyBlockExistenceHandler(ctx.host?.project, args);
  }

  getStartText(args: any): string {
    let display = '未知块';
    try {
      const blockTypes = typeof args?.blockTypes === 'string'
        ? JSON.parse(args.blockTypes)
        : args?.blockTypes;
      if (Array.isArray(blockTypes)) {
        display = blockTypes.join(', ');
      }
    } catch { /* fallback */ }
    return `正在验证块: ${display}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return `块验证失败: ${result?.content || '未知错误'}`;
    const metadata = result?.metadata;
    if (metadata) {
      const existingCount = metadata.existingBlocks?.length || 0;
      const missingCount = metadata.missingBlocks?.length || 0;
      return `块验证完成: ${existingCount}个块存在，${missingCount}个块缺失`;
    }
    return '块验证完成';
  }
}

// ============================
// 注册
// ============================

ToolRegistry.register(new SmartBlockTool());
ToolRegistry.register(new ConnectBlocksTool());
ToolRegistry.register(new CreateCodeStructureTool());
ToolRegistry.register(new ConfigureBlockTool());
ToolRegistry.register(new DeleteBlockTool());
ToolRegistry.register(new GetWorkspaceOverviewTool());
ToolRegistry.register(new QueryBlockDefinitionTool());
ToolRegistry.register(new AnalyzeLibraryBlocksTool());
ToolRegistry.register(new VerifyBlockExistenceTool());
