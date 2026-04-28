/**
 * 已注册工具 - ABS / ABI / 工具类
 */

import { IAilyTool, ToolContext, ToolUseResult } from '../../core/tool-types';
import { ToolRegistry } from '../../core/tool-registry';
import { syncAbsFileHandler } from '../syncAbsFileTool';
import { absVersionControlHandler } from '../absVersionControlTool';
import { editAbiFileTool as editAbiFileHandler } from '../editAbiFileTool';
import { reloadAbiJsonTool as reloadAbiJsonHandler, ReloadAbiJsonToolService } from '../reloadAbiJsonTool';
import { TOOLS as LEGACY_TOOLS } from '../tools';
import * as asyncFs from '../../core/async-fs';

function findLegacySchema(name: string): any {
  return (LEGACY_TOOLS as any[]).find(t => t.name === name);
}

// ============================
// sync_abs_file
// ============================

class SyncAbsFileTool implements IAilyTool {
  readonly name = 'sync_abs_file';
  readonly schema = findLegacySchema('sync_abs_file');
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    // electronService compat wrapper: 使用异步 IPC 方法避免阻塞渲染线程
    const fsCompat = {
      exists: (p: string) => asyncFs.exists(p),
      readFile: (p: string) => asyncFs.readFile(p, 'utf-8'),
      writeFile: (p: string, data: string) => asyncFs.writeFile(p, data),
    };
    return syncAbsFileHandler(args, ctx.host.project, fsCompat, ctx.host.absSync);
  }

  getStartText(args: any): string {
    // Only show UI for 'import' operation
    if (args?.operation === 'import') return '加载 图形化代码...';
    return ''; // empty → executeRegisteredTool skips startToolCall
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '项目文件 同步失败';
    if (args?.operation === 'import') return '加载 图形化代码 完成';
    return ''; // export/status → no completeToolCall display
  }
}

// ============================
// abs_version_control
// ============================

// class AbsVersionControlTool implements IAilyTool {
//   readonly name = 'abs_version_control';
//   readonly schema = findLegacySchema('abs_version_control');
//   readonly environment = 'gui' as const;

//   async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
//     if (!ctx.host?.absSync) return { is_error: true, content: 'ABS 同步服务不可用' };
//     return absVersionControlHandler(args, ctx.host.absSync);
//   }

//   getStartText(args: any): string {
//     const action = args?.action || 'unknown';
//     const texts: Record<string, string> = {
//       snapshot: '创建 ABS 快照...',
//       list: '列出历史快照...',
//       restore: '恢复 ABS 快照...',
//       diff: '对比 ABS 快照...',
//     };
//     return texts[action] || `ABS 版本控制: ${action}`;
//   }

//   getResultText(args: any, result?: ToolUseResult): string {
//     if (result?.is_error) return 'ABS 版本控制操作失败';
//     return 'ABS 版本控制操作成功';
//   }
// }

// ============================
// get_abs_syntax
// ============================

// class GetAbsSyntaxTool implements IAilyTool {
//   readonly name = 'get_abs_syntax';
//   readonly schema = findLegacySchema('get_abs_syntax');
//   readonly displayMode = 'appendMessage' as const;

//   async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
//     return getAbsSyntaxHandler();
//   }

//   getStartText(): string {
//     return '获取 ABS 语法规范...';
//   }

//   getResultText(args: any, result?: ToolUseResult): string {
//     if (result?.is_error) return 'ABS 语法规范获取失败';
//     return 'ABS 语法规范获取成功';
//   }
// }

// ============================
// edit_abi_file
// ============================

class EditAbiFileTool implements IAilyTool {
  readonly name = 'edit_abi_file';
  readonly schema = {
    name: 'edit_abi_file',
    description: '编辑ABI文件',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    // Resolve current project path
    const currentProjectPath = ctx.host?.project?.currentProjectPath !== ctx.host?.project?.projectRootPath
      ? ctx.host?.project?.currentProjectPath
      : '';
    if (!currentProjectPath) {
      return { content: '当前未打开项目', is_error: true };
    }

    // Construct params with path + optional fields
    const editParams: any = { path: currentProjectPath, content: args.content };
    if (args.insertLine !== undefined) editParams.insertLine = args.insertLine;
    if (args.replaceStartLine !== undefined) editParams.replaceStartLine = args.replaceStartLine;
    if (args.replaceEndLine !== undefined) editParams.replaceEndLine = args.replaceEndLine;
    if (args.replaceMode !== undefined) editParams.replaceMode = args.replaceMode;
    if (args.encoding !== undefined) editParams.encoding = args.encoding;
    if (args.createIfNotExists !== undefined) editParams.createIfNotExists = args.createIfNotExists;

    const editResult = await editAbiFileHandler(editParams);
    if (editResult.is_error) {
      return editResult;
    }

    // Auto-reload after successful edit
    if (!ctx.host?.blockly || !ctx.host?.project) {
      return { content: editResult.content + '\nℹ️ Blockly 服务不可用，跳过自动重载', is_error: false };
    }
    const reloadService = new ReloadAbiJsonToolService(ctx.host.blockly as any, ctx.host.project as any);
    const reloadResult = await reloadService.executeReloadAbiJson(args);
    return { content: reloadResult.content, is_error: reloadResult.is_error };
  }

  getStartText(args: any): string {
    if (args?.replaceStartLine !== undefined) {
      if (args.replaceEndLine !== undefined && args.replaceEndLine !== args.replaceStartLine) {
        return `替换ABI文件第 ${args.replaceStartLine}-${args.replaceEndLine} 行内容...`;
      }
      return `替换ABI文件第 ${args.replaceStartLine} 行内容...`;
    } else if (args?.insertLine !== undefined) {
      return `ABI文件第 ${args.insertLine} 行插入内容...`;
    } else if (args?.replaceMode === false) {
      return '向ABI文件末尾追加内容...';
    }
    return '编辑ABI文件...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return 'ABI文件编辑失败';
    if (args?.insertLine !== undefined) {
      return `ABI文件第 ${args.insertLine} 行插入内容成功`;
    } else if (args?.replaceStartLine !== undefined) {
      if (args?.replaceEndLine !== undefined && args.replaceEndLine !== args.replaceStartLine) {
        return `ABI文件第 ${args.replaceStartLine}-${args.replaceEndLine} 行替换成功`;
      }
      return `ABI文件第 ${args.replaceStartLine} 行替换成功`;
    } else if (args?.replaceMode === false) {
      return 'ABI文件内容追加成功';
    }
    return 'ABI文件编辑成功';
  }
}

// ============================
// reload_abi_json
// ============================

class ReloadAbiJsonTool implements IAilyTool {
  readonly name = 'reload_abi_json';
  readonly schema = {
    name: 'reload_abi_json',
    description: '重新加载Blockly工作区数据',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent']
  };
  readonly environment = 'gui' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.blockly || !ctx.host?.project) {
      return { is_error: true, content: 'Blockly 服务不可用，无法重新加载 ABI 数据' };
    }
    const service = new ReloadAbiJsonToolService(ctx.host.blockly as any, ctx.host.project as any);
    const result = await service.executeReloadAbiJson(args);
    return {
      content: result.content,
      is_error: result.is_error,
    };
  }

  getStartText(): string {
    return '重新加载Blockly工作区数据...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return 'ABI数据重新加载异常';
    return 'ABI数据重新加载成功';
  }
}

// ============================
// 注册
// ============================

ToolRegistry.register(new SyncAbsFileTool());
// ToolRegistry.register(new AbsVersionControlTool());
// ToolRegistry.register(new GetAbsSyntaxTool());
ToolRegistry.register(new EditAbiFileTool());
ToolRegistry.register(new ReloadAbiJsonTool());
