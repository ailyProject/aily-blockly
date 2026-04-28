/**
 * 已注册工具 - 项目与系统操作类
 */

import { IAilyTool, ToolContext, ToolUseResult } from '../../core/tool-types';
import { ToolRegistry } from '../../core/tool-registry';
import { newProjectTool as newProjectHandler } from '../createProjectTool';
import { executeCommandTool as executeCommandHandler } from '../executeCommandTool';
import { getContextTool as getContextHandler } from '../getContextTool';
import { getProjectInfoTool as getProjectInfoHandler } from '../getProjectInfoTool';
import { buildProjectTool as buildProjectHandler } from '../buildProjectTool';
import { reloadProjectTool as reloadProjectHandler } from '../reloadProjectTool';
import { switchBoardTool as switchBoardHandler } from '../switchBoardTool';
import { getBoardConfigTool as getBoardConfigHandler, setBoardConfigTool as setBoardConfigHandler } from '../boardConfigTool';
import { askApprovalTool as askApprovalHandler } from '../askApprovalTool';
import { askUserTool as askUserHandler } from '../askUserTool';
import { searchBoardsLibrariesTool } from '../searchBoardsLibrariesTool';
import { getHardwareCategoriesTool } from '../getHardwareCategoriesTools';
import { getBoardParametersTool } from '../getBoardParametersTool';
import { fetchTool as fetchHandler } from '../fetchTool';
import { webSearchTool as webSearchHandler } from '../webSearchTool';
import { cloneRepositoryTool as cloneRepoHandler } from '../cloneRepositoryTool';
import { todoWriteTool as todoWriteHandler, injectTodoReminder } from '../todoWriteTool';
import { memoryTool as memoryHandler } from '../memoryTool';
import { getErrorsTool as getErrorsHandler, setLastBuildErrors } from '../getErrorsTool';
import {
  startBackgroundCommandTool as startBgCmdHandler,
  getTerminalOutputTool as getTermOutputHandler,
} from '../terminalSessionTool';
import { TOOLS as LEGACY_TOOLS } from '../tools';

function findLegacySchema(name: string): any {
  return (LEGACY_TOOLS as any[]).find(t => t.name === name);
}

// ============================
// create_project
// ============================

class CreateProjectTool implements IAilyTool {
  readonly name = 'create_project';
  readonly schema = findLegacySchema('create_project');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用，无法创建项目' };
    if (!ctx.host?.config) return { is_error: true, content: '配置服务不可用，无法获取开发板信息' };
    const result = await newProjectHandler(ctx.host.project.projectRootPath || '', args, ctx.host.project as any, ctx.host.config as any);
    if (!result.is_error) {
      // Signal to post-switch logic that Blockly rules injection is needed
      result.metadata = { ...result.metadata, newProject: true };
    }
    return result;
  }

  getStartText() { return '正在创建项目...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '项目创建异常,即将重试';
    return '项目创建成功';
  }
}

// ============================
// execute_command
// ============================

class ExecuteCommandTool implements IAilyTool {
  readonly name = 'execute_command';
  readonly schema = findLegacySchema('execute_command');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    const host = ctx.host!;
    if (!host.cmd) return { is_error: true, content: '命令执行服务不可用' };
    if (!args.cwd && host.project) {
      args.cwd = host.project.currentProjectPath || host.project.projectRootPath;
    }

    const projectPath = args.cwd || host.project?.currentProjectPath;
    const command = args.command || '';
    const isNpmInstall = command.includes('npm i') || command.includes('npm install');
    const isNpmUninstall = command.includes('npm uninstall');
    let unloadResults: string[] = [];

    // Pre-execution: npm uninstall → check blocks in use → unload libraries
    if (isNpmUninstall && host.blockly && host.platform) {
      const npmRegex = /@aily-project\/[a-zA-Z0-9-_]+/g;
      const matches = command.match(npmRegex);

      if (matches && matches.length > 0) {
        const uniqueLibs = [...new Set(matches)];
        const separator = host.platform.pathSeparator;
        const libsInUse: string[] = [];

        for (const libPackageName of uniqueLibs as string[]) {
          try {
            const libBlockPath = projectPath + `${separator}node_modules${separator}` + libPackageName + `${separator}block.json`;
            if (host.fs.existsSync(libBlockPath)) {
              const blocksData = JSON.parse(host.fs.readFileSync(libBlockPath, 'utf-8'));
              const abiJson = JSON.stringify(host.blockly.getProjectDocument());
              for (const element of blocksData) {
                if (abiJson.includes(element.type)) {
                  libsInUse.push(libPackageName);
                  break;
                }
              }
            }
          } catch (e) {
            console.warn('检查库使用情况失败:', libPackageName, e);
          }
        }

        if (libsInUse.length > 0) {
          return {
            content: `无法卸载以下库，因为项目代码正在使用它们：${libsInUse.join(', ')}。请先删除相关代码块后再尝试卸载。`,
            is_error: true
          };
        }

        for (const libPackageName of uniqueLibs) {
          try {
            await host.blockly.unloadLibrary(libPackageName, projectPath);
            unloadResults.push(`${libPackageName} 卸载成功`);
          } catch (e: any) {
            console.warn('卸载库失败:', libPackageName, e);
            unloadResults.push(`${libPackageName} 卸载失败: ${e.message || e}`);
          }
        }
      }
    }

    // Execute the command
    const toolResult: ToolUseResult = await executeCommandHandler(host.cmd, args, ctx.securityContext);

    // Post-execution: append uninstall results
    if (isNpmUninstall && unloadResults.length > 0) {
      toolResult.content = (toolResult.content || '') + `\n\n库卸载结果:\n${unloadResults.join('\n')}`;
    }

    // Post-execution: npm install → load libraries
    if (!toolResult.is_error && isNpmInstall && host.blockly && host.platform) {
      const installSeparator = host.platform.pathSeparator;
      const libsToLoad: string[] = [];

      // 1. Match @aily-project/xxx scoped packages
      const npmRegex = /@aily-project\/[a-zA-Z0-9-_]+/g;
      const scopedMatches = command.match(npmRegex);
      if (scopedMatches) libsToLoad.push(...scopedMatches);

      // 2. Match local path installs
      const npmInstallArgMatch = command.match(/npm\s+(?:install|i|ci)\b(.*?)(?:&&|$)/);
      const npmInstallArgs = npmInstallArgMatch ? npmInstallArgMatch[1] : '';
      const tokens = npmInstallArgs.trim().split(/\s+/).map((t: string) => t.replace(/^["']|["']$/g, ''));
      const skipTokens = new Set(['--save', '--save-dev', '-D', '-S', '-g', '--global', '--legacy-peer-deps', '--force']);
      for (const token of tokens) {
        if (!token || skipTokens.has(token) || token.startsWith('-')) continue;
        const isLocalPath = token.startsWith('./') || token.startsWith('../') ||
          token.startsWith('/') || /^[A-Za-z]:[/\\]/.test(token) ||
          token.startsWith('.\\') || token.startsWith('..\\');
        if (isLocalPath) {
          try {
            let fullPath = token;
            if (!(/^[A-Za-z]:[/\\]/.test(token) || token.startsWith('/'))) {
              fullPath = projectPath + installSeparator + token.replace(/[/\\]/g, installSeparator);
            }
            const pkgJsonPath = fullPath.replace(/[/\\]+$/, '') + installSeparator + 'package.json';
            const pkgJson = JSON.parse(host.fs.readFileSync(pkgJsonPath, 'utf-8'));
            if (pkgJson?.name) libsToLoad.push(pkgJson.name);
          } catch (e) {
            console.warn('读取本地包 package.json 失败:', token, e);
          }
        }
      }

      const uniqueLibs = [...new Set(libsToLoad)];
      const loadResults: string[] = [];
      for (const libPackageName of uniqueLibs) {
        try {
          await host.blockly.loadLibrary(libPackageName, projectPath);
          loadResults.push(`${libPackageName} 加载成功`);
        } catch (e: any) {
          console.warn('加载库失败:', libPackageName, e);
          loadResults.push(`${libPackageName} 加载失败: ${e.message || e}`);
        }
      }
      // if (loadResults.length > 0) {
      //   toolResult.content = (toolResult.content || '') + `\n\n库加载结果:\n${loadResults.join('\n')}`;
      // }
    }

    // Handle npm install failure: mark as non-retryable (via warning = false, is_error = true stays)
    if (toolResult.is_error && isNpmInstall) {
      // npm install failures should not trigger retry - keep is_error but don't set warning
      toolResult.metadata = { ...toolResult.metadata, npmInstallFailure: true };
    } else if (toolResult.is_error) {
      // Regular command failures should trigger retry
      toolResult.warning = true;
      toolResult.is_error = false;
    }

    return toolResult;
  }

  getStartText(args: any): string {
    const parts = (args?.command || '').trim().split(/\s+/);
    const cmd = parts[0] || 'unknown';
    const cmdArg = parts[1] || '';
    if (cmd.toLowerCase() === 'npm') return `执行: ${cmd} ${cmdArg}`;
    const display = cmdArg.length > 20 ? '...' + cmdArg.slice(-20) : cmdArg;
    return `执行: ${cmd} ${display}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const parts = (args?.command || '').trim().split(/\s+/);
    const cmd = parts[0] || 'unknown';
    const cmdDisplay = cmd.toLowerCase() === 'npm' && parts[1] ? `${cmd} ${parts[1]}` : cmd;

    if (result?.metadata?.npmInstallFailure) {
      return 'npm install命令执行失败，请检查网络或依赖配置';
    }
    if (result?.is_error || result?.warning) {
      return `命令 ${cmdDisplay} 执行异常, 即将重试`;
    }
    return `命令 ${cmdDisplay} 执行成功`;
  }
}

// ============================
// get_context
// ============================

class GetContextTool implements IAilyTool {
  readonly name = 'get_context';
  readonly schema = findLegacySchema('get_context');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return getContextHandler(ctx.host.project as any, args);
  }

  getStartText() { return '获取 上下文信息...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '获取 上下文信息 异常, 即将重试' : '获取 上下文信息 成功';
  }
}

// ============================
// get_project_info
// ============================

class GetProjectInfoTool implements IAilyTool {
  readonly name = 'get_project_info';
  readonly schema = findLegacySchema('get_project_info');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return getProjectInfoHandler(ctx.host.project as any, args);
  }

  getStartText() { return '获取 项目信息...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '获取 项目信息 异常, 即将重试' : '获取 项目信息 成功';
  }
}

// ============================
// build_project
// ============================

class BuildProjectTool implements IAilyTool {
  readonly name = 'build_project';
  readonly schema = findLegacySchema('build_project');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.builder) return { is_error: true, content: '编译服务不可用' };
    const projectPath = ctx.host.project?.currentProjectPath || '';
    return buildProjectHandler(ctx.host.builder as any, args, projectPath);
  }

  getStartText() { return '正在编译项目...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '编译失败' : '编译成功';
  }
}

// ============================
// reload_project
// ============================

class ReloadProjectTool implements IAilyTool {
  readonly name = 'reload_project';
  readonly schema = findLegacySchema('reload_project');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用' };
    return reloadProjectHandler(ctx.host.project as any, args);
  }

  getStartText() { return '重新加载项目...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '项目重新加载失败' : '项目重新加载成功';
  }
}

// ============================
// switch_board
// ============================

class SwitchBoardTool implements IAilyTool {
  readonly name = 'switch_board';
  readonly schema = findLegacySchema('switch_board');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用，无法切换开发板' };
    const result = await switchBoardHandler(ctx.host.project as any, args);
    if (!result.is_error && result.metadata?.boardChanged) {
      // 通知后续逻辑需要重新注入 Blockly 规则
      result.metadata = { ...result.metadata, newProject: true };
    }
    return result;
  }

  getStartText(args: any): string {
    const board = args?.board_name || '未知开发板';
    const shortName = board.replace('@aily-project/board-', '');
    return `正在切换开发板: ${shortName}...`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const board = args?.board_name || '未知开发板';
    const shortName = board.replace('@aily-project/board-', '');
    return result?.is_error ? `切换开发板 ${shortName} 失败` : `开发板已切换为 ${shortName}`;
  }
}

// ============================
// get_board_config
// ============================

class GetBoardConfigTool implements IAilyTool {
  readonly name = 'get_board_config';
  readonly schema = findLegacySchema('get_board_config');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用，无法获取开发板配置' };
    return getBoardConfigHandler(ctx.host.project as any, args);
  }

  getStartText() { return '获取开发板配置...'; }
  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '获取开发板配置失败' : '获取开发板配置成功';
  }
}

// ============================
// set_board_config
// ============================

class SetBoardConfigTool implements IAilyTool {
  readonly name = 'set_board_config';
  readonly schema = findLegacySchema('set_board_config');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用，无法设置开发板配置' };
    return setBoardConfigHandler(ctx.host.project as any, ctx.host.builder as any, args);
  }

  getStartText(args: any): string {
    const key = args?.config_key || '';
    const value = args?.config_value || '';
    return `设置 ${key} = ${value}...`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const key = args?.config_key || '';
    return result?.is_error ? `设置 ${key} 失败` : `${key} 设置成功`;
  }
}

// ============================
// ask_approval
// ============================

class AskApprovalTool implements IAilyTool {
  readonly name = 'ask_approval';
  readonly displayMode = 'silent' as const;
  readonly schema = {
    name: 'ask_approval',
    description: '请求用户确认操作',
    input_schema: { type: 'object', properties: {}, required: [] },
    agents: ['mainAgent']
  };

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    return askApprovalHandler(args);
  }
}

// ============================
// ask_user（参考 Copilot vscode_askQuestions）
// ============================

class AskUserTool implements IAilyTool {
  readonly name = 'ask_user';
  readonly schema = findLegacySchema('ask_user');
  readonly displayMode = 'silent' as const;

  async invoke(args: any, _ctx: ToolContext): Promise<ToolUseResult> {
    return askUserHandler(args);
  }

  getStartText(args: any): string {
    const q = args?.question || '向用户提问';
    return q.length > 30 ? q.substring(0, 30) + '...' : q;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.metadata?.skipped) return '用户跳过了问题';
    if (result?.is_error) return '提问失败';
    return '已获取用户回答';
  }
}

// ============================
// search_boards_libraries
// ============================

class SearchBoardsLibrariesTool implements IAilyTool {
  readonly name = 'search_boards_libraries';
  readonly schema = findLegacySchema('search_boards_libraries');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.config) return { is_error: true, content: '配置服务不可用，无法搜索硬件' };
    return searchBoardsLibrariesTool.handler(args, ctx.host.config as any);
  }

  getStartText(args: any): string {
    const searchType = args?.type || 'boards';
    const searchTypeDisplay = searchType === 'boards' ? '开发板' : searchType === 'libraries' ? '库' : '开发板和库';

    let searchDisplayText = '';
    // Parse filters (may be JSON string or object)
    let parsedFilters: any = null;
    if (args?.filters) {
      if (typeof args.filters === 'string') {
        try {
          const trimmed = args.filters.trim();
          if (trimmed && trimmed !== '{}') {
            parsedFilters = JSON.parse(trimmed);
          }
        } catch { /* ignore */ }
      } else if (typeof args.filters === 'object') {
        parsedFilters = args.filters;
      }
    }

    // Prioritize filters.keywords display
    if (parsedFilters?.keywords) {
      const keywords = Array.isArray(parsedFilters.keywords)
        ? parsedFilters.keywords
        : String(parsedFilters.keywords).split(/\s+/);
      if (keywords.length > 0) {
        searchDisplayText = keywords.slice(0, 3).join(', ');
        if (keywords.length > 3) {
          searchDisplayText += ` 等${keywords.length}个关键词`;
        }
      }
    }

    // Show other filter keys (excluding keywords)
    if (parsedFilters) {
      const otherFilterKeys = Object.keys(parsedFilters).filter(k => k !== 'keywords');
      if (otherFilterKeys.length > 0) {
        const filterDisplay = otherFilterKeys.slice(0, 3).map(k => {
          const val = parsedFilters[k];
          if (Array.isArray(val)) return `${k}:[${val.slice(0, 2).join(',')}${val.length > 2 ? '...' : ''}]`;
          return `${k}:${val}`;
        }).join(', ');
        searchDisplayText += searchDisplayText ? ` + ${filterDisplay}` : filterDisplay;
      }
    }

    if (!searchDisplayText) searchDisplayText = '未知查询';
    return `正在搜索${searchTypeDisplay}: ${searchDisplayText}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const searchType = args?.type || 'boards';
    const searchTypeDisplay = searchType === 'boards' ? '开发板' : searchType === 'libraries' ? '库' : '开发板和库';
    if (result?.is_error) return `搜索 ${searchTypeDisplay} 失败: ${result?.content || '未知错误'}`;
    const totalMatches = result?.metadata?.totalMatches || 0;
    // Build search summary for display
    let searchDisplayText = this.getStartText(args).replace(/^正在搜索[^:]*:\s*/, '');
    const searchSummary = searchDisplayText.length > 20 ? searchDisplayText.substring(0, 20) + '...' : searchDisplayText;
    return `搜索 ${searchTypeDisplay} 「${searchSummary}」完成，找到 ${totalMatches} 个匹配项`;
  }
}

// ============================
// get_hardware_categories
// ============================

class GetHardwareCategoriesTool implements IAilyTool {
  readonly name = 'get_hardware_categories';
  readonly schema = findLegacySchema('get_hardware_categories');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.config) return { is_error: true, content: '配置服务不可用，无法获取硬件分类' };
    return getHardwareCategoriesTool.handler(args, ctx.host.config as any);
  }

  getStartText(args: any): string {
    const type = args?.type === 'boards' ? '开发板' : '库';
    return `正在获取${type}分类...`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const type = args?.type === 'boards' ? '开发板' : '库';
    if (result?.is_error) return `获取 ${type} 分类失败`;
    const count = result?.metadata?.categories?.length || 0;
    return `获取 ${type} 分类完成，共 ${count} 个分类`;
  }
}

// ============================
// get_board_parameters
// ============================

class GetBoardParametersTool implements IAilyTool {
  readonly name = 'get_board_parameters';
  readonly schema = findLegacySchema('get_board_parameters');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.project) return { is_error: true, content: '项目服务不可用，无法获取开发板参数' };
    return getBoardParametersTool.handler(ctx.host.project as any, args);
  }

  getStartText(args: any): string {
    const params = Array.isArray(args?.parameters) ? args.parameters.join(', ') : (args?.parameters || '所有参数');
    return `正在获取当前开发板参数 (${params})`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return `获取开发板参数失败`;
    const boardName = result?.metadata?.boardName || '未知';
    return `获取开发板 "${boardName}" 参数成功`;
  }
}

// ============================
// fetch
// ============================

class FetchTool implements IAilyTool {
  readonly name = 'fetch';
  readonly schema = findLegacySchema('fetch');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.fetch) return { is_error: true, content: '网络请求服务不可用' };
    return fetchHandler(ctx.host.fetch, args);
  }

  getStartText(args: any): string {
    const url = args?.url || 'unknown';
    return `进行网络请求: ${url}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '网络请求异常，即将重试';
    return `网络请求 ${args?.url || ''} 成功`;
  }
}

// ============================
// clone_repository
// ============================

class CloneRepositoryTool implements IAilyTool {
  readonly name = 'clone_repository';
  readonly schema = findLegacySchema('clone_repository');

  async invoke(args: any, _ctx: ToolContext): Promise<ToolUseResult> {
    return cloneRepoHandler(args);
  }

  getStartText(args: any): string {
    const url = args?.url || '';
    const parts = url.replace(/\.git\/?$/, '').split('/');
    const repoName = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : url;
    return `克隆仓库: ${repoName}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '仓库克隆失败';
    const fileCount = result?.metadata?.fileCount || 0;
    return `仓库克隆完成，${fileCount} 个文件`;
  }
}

// ============================
// web_search
// ============================

class WebSearchTool implements IAilyTool {
  readonly name = 'web_search';
  readonly schema = findLegacySchema('web_search');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!ctx.host?.webSearch) return { is_error: true, content: '网页搜索服务不可用' };
    return webSearchHandler(ctx.host.webSearch, args);
  }

  getStartText(args: any): string {
    return `搜索: ${args?.query || ''}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '搜索失败，即将重试';
    const count = result?.metadata?.resultCount || 0;
    return `搜索完成，找到 ${count} 条结果`;
  }
}

// ============================
// todo_write_tool
// ============================

class TodoWriteTool implements IAilyTool {
  readonly name = 'todo_write_tool';
  readonly schema = findLegacySchema('todo_write_tool');
  readonly displayMode = 'silent' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    const todoArgs = { ...args, sessionId: ctx.sessionId };
    return todoWriteHandler(todoArgs);
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return 'TODO操作异常,即将重试';
    const op = args?.operation || 'unknown';
    const itemTitle = args?.content || args?.title || '项目';
    const texts: Record<string, string> = {
      add: `TODO项目添加成功: ${itemTitle}`,
      batch_add: 'TODO项目批量添加成功',
      list: 'TODO列表获取成功',
      update: 'TODO项目更新成功',
      toggle: 'TODO项目状态切换成功',
      delete: 'TODO项目删除成功',
      clear: 'TODO列表清空成功',
      query: 'TODO查询完成',
      stats: 'TODO统计完成',
    };
    return texts[op] || 'TODO操作完成';
  }
}

// ============================
// 注册
// ============================

ToolRegistry.register(new CreateProjectTool());
ToolRegistry.register(new ExecuteCommandTool());
ToolRegistry.register(new GetContextTool());
ToolRegistry.register(new GetProjectInfoTool());
ToolRegistry.register(new BuildProjectTool());
ToolRegistry.register(new ReloadProjectTool());
ToolRegistry.register(new SwitchBoardTool());
ToolRegistry.register(new GetBoardConfigTool());
ToolRegistry.register(new SetBoardConfigTool());
ToolRegistry.register(new AskApprovalTool());
ToolRegistry.register(new AskUserTool());
ToolRegistry.register(new SearchBoardsLibrariesTool());
ToolRegistry.register(new GetHardwareCategoriesTool());
ToolRegistry.register(new GetBoardParametersTool());
ToolRegistry.register(new FetchTool());
ToolRegistry.register(new CloneRepositoryTool());
ToolRegistry.register(new WebSearchTool());
ToolRegistry.register(new TodoWriteTool());

// ============================
// memory — 记忆工具
// ============================

class MemoryTool implements IAilyTool {
  readonly name = 'memory';
  readonly schema = findLegacySchema('memory');
  readonly displayMode = 'silent' as const;

  async invoke(args: any, _ctx: ToolContext): Promise<ToolUseResult> {
    return memoryHandler(args);
  }

  getStartText(args: any): string {
    const scope = args?.scope === 'global' ? '全局' : '项目';
    const cmd = args?.command || 'read';
    return `${scope}记忆: ${cmd}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    const scope = args?.scope === 'global' ? '全局' : '项目';
    if (result?.is_error) return `${scope}记忆操作失败`;
    return `${scope}记忆操作成功`;
  }
}

ToolRegistry.register(new MemoryTool());

// ============================
// get_errors — 错误诊断工具
// ============================

class GetErrorsTool implements IAilyTool {
  readonly name = 'get_errors';
  readonly schema = findLegacySchema('get_errors');
  readonly displayMode = 'appendMessage' as const;

  async invoke(args: any, _ctx: ToolContext): Promise<ToolUseResult> {
    return getErrorsHandler(args);
  }

  getStartText(args: any): string {
    const path = args?.path;
    return path ? `检查错误: ${path.split(/[\\/]/).pop()}` : '检查项目错误...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '错误检查失败';
    const count = result?.metadata?.errorCount || 0;
    return count > 0 ? `发现 ${count} 个问题` : '未发现错误';
  }
}

ToolRegistry.register(new GetErrorsTool());

// ============================
// start_background_command — 后台命令执行
// ============================

class StartBackgroundCommandTool implements IAilyTool {
  readonly name = 'start_background_command';
  readonly schema = findLegacySchema('start_background_command');

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    if (!args.cwd && ctx.host?.project) {
      args.cwd = ctx.host.project.currentProjectPath || ctx.host.project.projectRootPath;
    }
    return startBgCmdHandler(args);
  }

  getStartText(args: any): string {
    const cmd = (args?.command || '').split(/\s+/).slice(0, 3).join(' ');
    return `后台启动: ${cmd}`;
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '后台命令启动失败';
    return `后台命令已启动 (${result?.metadata?.sessionId || ''})`;
  }
}

// ============================
// get_terminal_output — 获取后台命令输出
// ============================

class GetTerminalOutputTool implements IAilyTool {
  readonly name = 'get_terminal_output';
  readonly schema = findLegacySchema('get_terminal_output');
  readonly displayMode = 'silent' as const;

  async invoke(args: any, _ctx: ToolContext): Promise<ToolUseResult> {
    return getTermOutputHandler(args);
  }

  getResultText(args: any, result?: ToolUseResult): string {
    if (result?.is_error) return '获取终端输出失败';
    const status = result?.metadata?.status || 'unknown';
    return `终端输出获取成功 (${status})`;
  }
}

ToolRegistry.register(new StartBackgroundCommandTool());
ToolRegistry.register(new GetTerminalOutputTool());

// ============================
// save_arch — 框架图保存工具
// ============================

class SaveArchTool implements IAilyTool {
  readonly name = 'save_arch';
  readonly schema = findLegacySchema('save_arch');
  readonly displayMode = 'silent' as const;

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    const host = ctx.host;
    if (!host?.fs || !host?.path) {
      return { is_error: true, content: '文件系统服务不可用' };
    }

    const code: string = (args?.code || '').trim();
    if (!code) {
      return { is_error: true, content: '参数 code 不能为空' };
    }

    const content = `\`\`\`mermaid\n${code}\n\`\`\`\n`;

    const projectPath = host.project?.currentProjectPath || host.project?.projectRootPath;
    const rootPath = host.project?.projectRootPath;
    const isOrphan = !projectPath || (rootPath && projectPath === rootPath);

    try {
      if (projectPath && !isOrphan) {
        const archPath = host.path.join(projectPath, 'arch.md');
        const dir = host.path.dirname(archPath);
        if (!host.fs.existsSync(dir)) {
          host.fs.mkdirSync(dir, { recursive: true });
        }
        host.fs.writeFileSync(archPath, content);
        return { is_error: false, content: `框架图已保存到 ${archPath}（已在对话中渲染，无需再次输出）`, metadata: { chatContent: `\n\n${content}\n` } };
      } else if (isOrphan && rootPath && ctx.sessionId) {
        const chatHistoryDir = host.path.join(rootPath, '.chat_history');
        if (!host.fs.existsSync(chatHistoryDir)) {
          host.fs.mkdirSync(chatHistoryDir, { recursive: true });
        }
        const archPath = host.path.join(chatHistoryDir, `${ctx.sessionId}_arch.md`);
        host.fs.writeFileSync(archPath, content);
        return { is_error: false, content: `框架图已保存到 ${archPath}（已在对话中渲染，无需再次输出）`, metadata: { chatContent: `\n\n${content}\n` } };
      } else {
        return { is_error: true, content: '无法确定保存路径：当前未打开项目且无会话 ID' };
      }
    } catch (err: any) {
      return { is_error: true, content: `保存框架图失败: ${err.message || err}` };
    }
  }

  getStartText(): string {
    return '保存框架图到 arch.md...';
  }

  getResultText(args: any, result?: ToolUseResult): string {
    return result?.is_error ? '框架图保存失败' : '框架图保存成功';
  }
}

ToolRegistry.register(new SaveArchTool());
