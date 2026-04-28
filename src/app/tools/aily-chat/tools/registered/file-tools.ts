/**
 * 已注册工具 - 文件操作类
 *
 * 将已有的工具函数封装为 IAilyTool 接口，
 * 通过 ToolRegistry.register() 注册到注册中心。
 */

import { IAilyTool, ToolContext, ToolUseResult } from '../../core/tool-types';
import { ToolRegistry } from '../../core/tool-registry';
import { readFileTool as readFileHandler } from '../readFileTool';
import { createFileTool as createFileHandler } from '../createFileTool';
import { createFolderTool as createFolderHandler } from '../createFolderTool';
import { editFileTool as editFileHandler } from '../editFileTool';
import { deleteFileTool as deleteFileHandler } from '../deleteFileTool';
import { deleteFolderTool as deleteFolderHandler } from '../deleteFolderTool';
import { checkExistsTool as checkExistsHandler } from '../checkExistsTool';
import { listDirectoryTool as listDirectoryHandler } from '../listDirectoryTool';
import { getDirectoryTreeTool as getDirectoryTreeHandler } from '../getDirectoryTreeTool';
import { grepTool as grepHandler } from '../grepTool';
import { AilyHost } from '../../core/host';
import globHandler from '../globTool';
import { replaceStringInFileTool as replaceStringHandler, multiReplaceStringInFileTool as multiReplaceHandler } from '../replaceStringTool';
import { TOOLS as LEGACY_TOOLS } from '../tools';

// ============================
// 辅助函数
// ============================

function getFileName(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

function getLastFolderName(path: string): string {
  if (!path) return '';
  const normalized = path.replace(/\\/g, '/');
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = trimmed.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

function findLegacySchema(name: string): any {
  return (LEGACY_TOOLS as any[]).find(t => t.name === name);
}

// ============================
// read_file
// ============================

class ReadFileTool implements IAilyTool {
  readonly name = 'read_file';
  readonly schema = findLegacySchema('read_file');

  /**
   * Resolve library nickname from path (synchronous, uses AilyHost.get().fs).
   * Returns the package.json nickname or the lib-xxx directory name.
   */
  private resolveLibInfo(path: string): { isLib: boolean; libNickName: string } {
    if (!path) return { isLib: false, libNickName: '' };

    const normalized = path.replace(/\\/g, '/');
    // 检测路径是否在 @aily-project/lib-* 库目录下
    const libMatch = normalized.match(/@aily-project\/(lib-[^/]+)/);
    if (!libMatch) return { isLib: false, libNickName: '' };

    const libName = libMatch[1];

    // Try to read nickname from package.json
    let nickname = '';
    try {
      const ailyIdx = normalized.indexOf('/@aily-project/');
      const pkgPath = normalized.substring(0, ailyIdx) + '/@aily-project/' + libName + '/package.json';
      if (typeof window !== 'undefined' && AilyHost.get().fs?.existsSync?.(pkgPath)) {
        const pkg = JSON.parse(AilyHost.get().fs.readFileSync(pkgPath, 'utf-8'));
        nickname = pkg.nickname || '';
      }
    } catch { /* ignore */ }

    return { isLib: true, libNickName: nickname || libName };
  }

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    const result = await readFileHandler(args, ctx.securityContext);
    // Attach library info to metadata for getResultText
    const libInfo = this.resolveLibInfo(args?.path);
    if (libInfo.isLib) {
      result.metadata = { ...result.metadata, libNickName: libInfo.libNickName, isLib: true };
    }
    return result;
  }

  getStartText(args: any): string {
    const libInfo = this.resolveLibInfo(args?.path);
    if (libInfo.isLib && libInfo.libNickName) {
      return `了解 ${libInfo.libNickName} 使用方法`;
    }
    const fileName = getFileName(args?.path);
    return `读取: ${fileName}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const fileName = getFileName(args?.path);
    const libNickName = result?.metadata?.libNickName;
    const isLib = result?.metadata?.isLib;

    if (result?.is_error) {
      if (fileName === 'project.abs') return '读取 项目文件 异常, 即将重试';
      if (libNickName) return `了解 ${libNickName} 使用方法异常, 即将重试`;
      return '读取 文件 异常, 即将重试';
    }

    if (fileName === 'project.abs') return '读取 项目文件 成功';
    if (libNickName || isLib) return `了解 ${libNickName || fileName} 使用方法成功`;
    return `读取 ${fileName} 文件成功`;
  }
}

// ============================
// create_file
// ============================

class CreateFileTool implements IAilyTool {
  readonly name = 'create_file';
  readonly schema = findLegacySchema('create_file');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (args?.path) ctx.editCheckpoint?.recordEdit(args.path, 'create');
    const result = await createFileHandler(args, ctx.securityContext);
    ctx.editCheckpoint?.publishCurrentSummary();
    return result;
  }

  getStartText(args: any): string {
    let fileName = getFileName(args?.path);
    if (fileName === 'project.abs') fileName = '项目文件';
    return `创建: ${fileName}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    let fileName = getFileName(args?.path);
    if (fileName === 'project.abs') fileName = '项目文件';
    if (result?.is_error) return `创建 ${fileName} 文件异常, 即将重试`;
    return `创建 ${fileName} 文件成功`;
  }
}

// ============================
// create_folder
// ============================

class CreateFolderTool implements IAilyTool {
  readonly name = 'create_folder';
  readonly schema = findLegacySchema('create_folder');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return createFolderHandler(args);
  }

  getStartText(args: any): string {
    return `创建: ${getLastFolderName(args?.path)}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const name = getLastFolderName(args?.path);
    if (result?.is_error) return `创建 ${name} 文件夹异常, 即将重试`;
    return `创建 ${name} 文件夹成功`;
  }
}

// ============================
// edit_file
// ============================

class EditFileTool implements IAilyTool {
  readonly name = 'edit_file';
  readonly schema = findLegacySchema('edit_file');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (args?.path) ctx.editCheckpoint?.recordEdit(args.path, 'modify');
    const result = await editFileHandler(args);
    ctx.editCheckpoint?.publishCurrentSummary();
    return result;
  }

  getStartText(args: any): string {
    let fileName = getFileName(args?.path);
    if (fileName === 'project.abs') fileName = '项目文件';
    return `编辑: ${fileName}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    let fileName = getFileName(args?.path);
    if (fileName === 'project.abs') fileName = '项目文件';
    if (result?.is_error) return `编辑 ${fileName} 文件异常, 即将重试`;
    return `编辑 ${fileName} 文件成功`;
  }
}

// ============================
// delete_file
// ============================

class DeleteFileTool implements IAilyTool {
  readonly name = 'delete_file';
  readonly schema = findLegacySchema('delete_file');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (args?.path) ctx.editCheckpoint?.recordEdit(args.path, 'delete');
    const result = await deleteFileHandler(args, ctx.securityContext);
    ctx.editCheckpoint?.publishCurrentSummary();
    return result;
  }

  getStartText(args: any): string {
    return `删除: ${getFileName(args?.path)}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const name = getFileName(args?.path);
    if (result?.is_error) return `删除 ${name} 文件异常, 即将重试`;
    return `删除 ${name} 文件成功`;
  }
}

// ============================
// delete_folder
// ============================

class DeleteFolderTool implements IAilyTool {
  readonly name = 'delete_folder';
  readonly schema = findLegacySchema('delete_folder');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return deleteFolderHandler(args, ctx.securityContext);
  }

  getStartText(args: any): string {
    return `删除: ${getLastFolderName(args?.path)}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const name = getLastFolderName(args?.path);
    if (result?.is_error) return `删除 ${name} 文件夹异常, 即将重试`;
    return `删除 ${name} 文件夹成功`;
  }
}

// ============================
// check_exists (不在 TOOLS 数组中但 component 有 case)
// ============================

class CheckExistsTool implements IAilyTool {
  readonly name = 'check_exists';
  readonly schema = {
    name: 'check_exists',
    description: '检查指定路径的文件或文件夹是否存在，返回详细信息。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要检查的路径' },
        type: { type: 'string', enum: ['file', 'folder', 'any'], default: 'any' }
      },
      required: ['path']
    },
    agents: ['mainAgent']
  };

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return checkExistsHandler(args);
  }

  getStartText(args: any): string {
    const fileName = getFileName(args?.path);
    const folderName = getLastFolderName(args?.path);
    return fileName ? `检查文件是否存在: ${fileName}` : `检查文件夹是否存在: ${folderName}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const fileName = getFileName(args?.path);
    const folderName = getLastFolderName(args?.path);
    if (result?.is_error) return fileName ? `检查文件 ${fileName} 是否存在失败` : `检查文件夹 ${folderName} 是否存在失败`;
    return fileName ? `文件 ${fileName} 存在` : `文件夹 ${folderName} 存在`;
  }
}

// ============================
// list_directory
// ============================

class ListDirectoryTool implements IAilyTool {
  readonly name = 'list_directory';
  readonly schema = {
    name: 'list_directory',
    description: '列出指定目录的内容，包括文件和文件夹信息。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列出内容的目录路径' }
      },
      required: ['path']
    },
    agents: ['mainAgent', 'schematicAgent']
  };

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return listDirectoryHandler(args);
  }

  getStartText(args: any): string {
    return `获取${getLastFolderName(args?.path)}目录内容`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const name = getLastFolderName(args?.path);
    if (result?.is_error) return `获取 ${name} 目录内容异常, 即将重试`;
    return `获取 ${name} 目录内容成功`;
  }
}

// ============================
// get_directory_tree
// ============================

class GetDirectoryTreeTool implements IAilyTool {
  readonly name = 'get_directory_tree';
  readonly schema = {
    name: 'get_directory_tree',
    description: '获取指定目录的树状结构，可控制遍历深度。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要获取树状结构的目录路径' },
        maxDepth: { type: 'number', default: 3 },
        includeFiles: { type: 'boolean', default: true }
      },
      required: ['path']
    },
    agents: ['mainAgent', 'schematicAgent']
  };

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return getDirectoryTreeHandler(args);
  }

  getStartText(args: any): string {
    return `获取目录树: ${getLastFolderName(args?.path)}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const name = getLastFolderName(args?.path);
    if (result?.is_error) return `获取目录树 ${name} 失败: ${result?.content || '未知错误'}`;
    return `获取目录树 ${name} 成功`;
  }
}

// ============================
// grep_tool
// ============================

class GrepTool implements IAilyTool {
  readonly name = 'grep_tool';
  readonly schema = findLegacySchema('grep_tool');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return grepHandler(args);
  }

  getStartText(args: any): string {
    const pattern = (args?.pattern || '').substring(0, 30);
    const pathDisplay = args?.path ? getLastFolderName(args.path) : '当前项目';
    return `正在搜索内容: ${pattern} (${pathDisplay})`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const pattern = (args?.pattern || '').substring(0, 20);
    if (result?.is_error) return `搜索「${pattern}」失败: ${result?.content || '未知错误'}`;
    const numMatches = result?.metadata?.numMatches;
    const numFiles = result?.metadata?.numFiles;
    if (numMatches !== undefined) {
      return numMatches === 0
        ? `搜索「${pattern}」完成，未找到匹配内容`
        : `搜索「${pattern}」完成，找到 ${numMatches} 个匹配记录`;
    }
    if (numFiles !== undefined) return `搜索「${pattern}」完成，找到 ${numFiles} 个匹配文件`;
    return `搜索「${pattern}」完成`;
  }
}

// ============================
// glob_tool
// ============================

class GlobTool implements IAilyTool {
  readonly name = 'glob_tool';
  readonly schema = findLegacySchema('glob_tool');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return globHandler(args);
  }

  getStartText(args: any): string {
    const pattern = (args?.pattern || '未知模式').substring(0, 30);
    const pathDisplay = args?.path ? getLastFolderName(args.path) : '当前目录';
    return `正在查找文件: ${pattern} (${pathDisplay})`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return `文件搜索失败: ${result?.content || '未知错误'}`;
    const numFiles = result?.metadata?.numFiles;
    if (numFiles === 0) return '搜索完成，未找到匹配的文件';
    let text = `搜索完成，找到 ${numFiles} 个文件`;
    if (result?.metadata?.truncated) text += ' (结果已截断)';
    return text;
  }
}

// ============================
// replace_string_in_file
// ============================

class ReplaceStringInFileTool implements IAilyTool {
  readonly name = 'replace_string_in_file';
  readonly schema = findLegacySchema('replace_string_in_file');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (args?.path) ctx.editCheckpoint?.recordEdit(args.path, 'modify');
    const result = await replaceStringHandler(args);
    ctx.editCheckpoint?.publishCurrentSummary();
    return result;
  }

  getStartText(args: any): string {
    let fileName = getFileName(args?.path);
    if (fileName === 'project.abs') fileName = '项目文件';
    return `替换: ${fileName}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    let fileName = getFileName(args?.path);
    if (fileName === 'project.abs') fileName = '项目文件';
    if (result?.is_error) return `替换 ${fileName} 异常, 即将重试`;
    return `替换 ${fileName} 成功`;
  }
}

// ============================
// multi_replace_string_in_file
// ============================

class MultiReplaceStringInFileTool implements IAilyTool {
  readonly name = 'multi_replace_string_in_file';
  readonly schema = findLegacySchema('multi_replace_string_in_file');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    // 记录每个文件的编辑前状态
    if (Array.isArray(args?.replacements)) {
      const recorded = new Set<string>();
      for (const r of args.replacements) {
        if (r.path && !recorded.has(r.path)) {
          ctx.editCheckpoint?.recordEdit(r.path, 'modify');
          recorded.add(r.path);
        }
      }
    }
    const result = await multiReplaceHandler(args);
    ctx.editCheckpoint?.publishCurrentSummary();
    return result;
  }

  getStartText(args: any): string {
    const count = Array.isArray(args?.replacements) ? args.replacements.length : 0;
    return `批量替换: ${count} 处修改`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const count = Array.isArray(args?.replacements) ? args.replacements.length : 0;
    if (result?.is_error) return `批量替换异常, 即将重试`;
    return `批量替换 ${count} 处修改成功`;
  }
}

// ============================
// 注册所有文件操作类工具
// ============================

ToolRegistry.register(new ReadFileTool());
ToolRegistry.register(new CreateFileTool());
ToolRegistry.register(new CreateFolderTool());
ToolRegistry.register(new EditFileTool());
ToolRegistry.register(new ReplaceStringInFileTool());
ToolRegistry.register(new MultiReplaceStringInFileTool());
ToolRegistry.register(new DeleteFileTool());
ToolRegistry.register(new DeleteFolderTool());
ToolRegistry.register(new CheckExistsTool());
ToolRegistry.register(new ListDirectoryTool());
ToolRegistry.register(new GetDirectoryTreeTool());
ToolRegistry.register(new GrepTool());
ToolRegistry.register(new GlobTool());
