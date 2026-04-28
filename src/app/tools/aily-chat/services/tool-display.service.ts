/**
 * 工具显示文本生成服务
 *
 * 从 AilyChatComponent 提取的纯函数集合，用于：
 * - 生成工具调用的开始/完成显示文本
 * - 格式化命令、搜索模式、文件名、URL 等
 */

import { ToolRegistry } from '../core/tool-registry';
import { AilyHost } from '../core/host';

/**
 * 生成工具调用开始时的显示文本
 */
export function generateToolStartText(toolName: string, args?: any): string {
  if (!args) return `正在执行工具: ${toolName}`;

  const cleanToolName = toolName.startsWith('mcp_') ? toolName.substring(4) : toolName;

  if (ToolRegistry.has(cleanToolName)) {
    return ToolRegistry.getStartText(toolName, args);
  }

  switch (cleanToolName) {
    case 'create_single_block':
      return `创建块: ${args.type || 'unknown'}`;
    case 'connect_blocks_simple':
      return `连接块: ${args.action || 'unknown'}`;
    case 'set_block_field':
      return `设置字段: ${args.fieldName || 'unknown'}`;
    case 'set_block_input':
      return `设置输入: ${args.inputName || 'unknown'}`;
    case 'get_workspace_blocks':
      return "获取工作区块列表...";
    case 'flat_create_blocks': {
      let flatBlockCount = 0;
      if (args?.blocks) {
        if (typeof args.blocks === 'string') {
          try { flatBlockCount = JSON.parse(args.blocks).length; } catch { flatBlockCount = 0; }
        } else if (Array.isArray(args.blocks)) {
          flatBlockCount = args.blocks.length;
        }
      }
      return `扁平化创建块: ${flatBlockCount}个块...`;
    }
    case 'variable_manager_tool': {
      const operation = args.operation;
      const operationText = operation === 'create' ? '创建' :
        operation === 'delete' ? '删除' :
          operation === 'rename' ? '重命名' : '列出';
      return `${operationText}变量...`;
    }
    case 'getBlockConnectionCompatibilityTool':
      return "分析块连接兼容性...";
    default:
      return `执行工具: ${cleanToolName}`;
  }
}

/**
 * 生成工具调用完成时的显示文本
 */
export function generateToolResultText(toolName: string, args?: any, result?: any): string {
  const cleanToolName = toolName.startsWith('mcp_') ? toolName.substring(4) : toolName;

  if (ToolRegistry.has(cleanToolName)) {
    return ToolRegistry.getResultText(toolName, args, result);
  }

  if (result?.is_error) {
    return `${toolName} 执行失败`;
  }

  switch (cleanToolName) {
    case 'create_single_block':
      return `块创建成功: ${args?.type || 'unknown'}`;
    case 'connect_blocks_simple':
      return `块连接成功: ${args?.action || 'unknown'}`;
    case 'set_block_field':
      return `字段设置成功: ${args?.fieldName || 'unknown'}`;
    case 'set_block_input':
      return `输入设置成功: ${args?.inputName || 'unknown'}`;
    case 'get_workspace_blocks':
      return `获取块列表成功`;
    case 'flat_create_blocks': {
      let blocksCreated = result?.data?.stats?.blocksCreated || 0;
      if (blocksCreated === 0 && args?.blocks) {
        if (typeof args.blocks === 'string') {
          try { blocksCreated = JSON.parse(args.blocks).length; } catch { blocksCreated = 0; }
        } else if (Array.isArray(args.blocks)) {
          blocksCreated = args.blocks.length;
        }
      }
      const connsCreated = result?.data?.stats?.connectionsEstablished || 0;
      return `扁平化创建成功: ${blocksCreated}个块, ${connsCreated}个连接`;
    }
    case 'variable_manager_tool': {
      const operation = args?.operation || 'unknown';
      const variableName = args?.variableName ? ` ${args.variableName}` : '';
      return `变量操作成功: ${operation}${variableName}`;
    }
    case 'getBlockConnectionCompatibilityTool':
      return `块连接兼容性分析完成`;
    default:
      return `${cleanToolName} 执行成功`;
  }
}

/**
 * 格式化命令显示
 */
export function formatCommandDisplay(command: string, maxPathSegments: number = 2): string {
  if (!command) return 'unknown';

  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return 'unknown';

  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  const specialCommands: Record<string, string> = {
    'cd': '切换到', 'mkdir': '创建目录', 'rmdir': '删除目录',
    'rm': '删除', 'del': '删除', 'remove': '删除',
    'cp': '复制', 'copy': '复制',
    'mv': '移动', 'move': '移动', 'rename': '重命名',
    'ls': '列出', 'dir': '列出', 'tree': '目录树',
    'cat': '查看', 'type': '查看', 'head': '查看', 'tail': '查看', 'less': '查看', 'more': '查看',
    'touch': '创建文件', 'echo': '输出', 'printf': '输出',
    'chmod': '修改权限', 'chown': '修改所有者',
    'grep': '搜索', 'find': '查找', 'locate': '定位',
    'tar': '压缩/解压', 'zip': '压缩', 'unzip': '解压', 'gzip': '压缩', 'gunzip': '解压',
    'curl': '请求', 'wget': '下载',
    'pip': 'pip', 'npm': 'npm', 'yarn': 'yarn', 'pnpm': 'pnpm', 'node': 'node', 'python': 'python',
    'git': 'git', 'svn': 'svn',
    'make': '构建', 'cmake': '配置构建', 'gcc': '编译', 'g++': '编译', 'clang': '编译',
    'sudo': '管理员执行', 'su': '切换用户',
    'ssh': '远程连接', 'scp': '远程复制', 'rsync': '同步',
    'ps': '进程列表', 'kill': '终止进程', 'top': '系统监控', 'htop': '系统监控',
    'df': '磁盘空间', 'du': '目录大小', 'free': '内存信息',
    'pwd': '当前目录', 'whoami': '当前用户', 'hostname': '主机名',
    'ping': '网络测试', 'ifconfig': '网络配置', 'ipconfig': '网络配置', 'netstat': '网络状态',
    'apt': 'apt', 'apt-get': 'apt-get', 'yum': 'yum', 'brew': 'brew', 'choco': 'choco',
    'systemctl': '服务管理', 'service': '服务管理',
    'docker': 'docker', 'kubectl': 'kubectl',
  };

  const filteredArgs = args.filter(a => !a.startsWith('-'));

  if (cmd === 'cd' && filteredArgs.length > 0) {
    const targetPath = filteredArgs.join(' ').replace(/["']/g, '');
    const normalizedPath = targetPath.replace(/\\/g, '/');
    const pathParts = normalizedPath.split('/').filter(Boolean);

    if (pathParts.length > maxPathSegments) {
      return `切换到: .../${pathParts.slice(-maxPathSegments).join('/')}`;
    } else if (pathParts.length > 0) {
      return `切换到: ${pathParts.join('/')}`;
    }
    return 'cd';
  }

  if (specialCommands[cmd]) {
    if (filteredArgs.length > 0) {
      const target = filteredArgs[filteredArgs.length - 1].replace(/["']/g, '');
      const name = target.split(/[\\/]/).pop() || target;
      return `${specialCommands[cmd]}: ${name}`;
    }
    return specialCommands[cmd];
  }

  if (filteredArgs.length > 0) {
    return `${cmd} ${filteredArgs[0]}`;
  }
  return cmd;
}

/**
 * 格式化搜索模式显示
 */
export function formatSearchPattern(pattern: string, maxLength: number = 30): string {
  if (!pattern) return '未知模式';

  try {
    const parts = pattern.split('|');
    const keywords = parts.map(part => {
      return part
        .replace(/\\b/g, '')
        .replace(/\^|\$/g, '')
        .replace(/\\[dDwWsS]/g, '')
        .replace(/[\[\]\(\)\{\}\*\+\?\.]/g, '')
        .trim();
    }).filter(k => k.length > 0);

    if (keywords.length === 0) {
      return pattern.length > maxLength ? pattern.substring(0, maxLength) + '...' : pattern;
    }

    const formatted = keywords.join(' | ');

    if (formatted.length > maxLength) {
      let result = '';
      for (let i = 0; i < keywords.length; i++) {
        const next = result ? result + ' | ' + keywords[i] : keywords[i];
        if (next.length > maxLength - 3) {
          return result + '...';
        }
        result = next;
      }
      return result + '...';
    }

    return formatted;
  } catch {
    return pattern.length > maxLength ? pattern.substring(0, maxLength) + '...' : pattern;
  }
}

/** 获取路径中的最后一个文件夹名 */
export function getLastFolderName(path: string): string {
  if (!path) return '';
  const normalizedPath = path.replace(/\\/g, '/');
  const trimmedPath = normalizedPath.endsWith('/') ? normalizedPath.slice(0, -1) : normalizedPath;
  const parts = trimmedPath.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/** 获取路径中的文件名 */
export function getFileName(path: string): string {
  if (!path) return '';
  const normalizedPath = path.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/** 获取URL的显示名称 */
export function getUrlDisplayName(url: string): string {
  if (!url) return '';

  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;

    if (!pathname || pathname === '/') {
      return urlObj.hostname;
    }

    const pathParts = pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
      let lastPart = pathParts[pathParts.length - 1];
      try { lastPart = decodeURIComponent(lastPart); } catch { }

      if (lastPart.includes('.')) {
        return lastPart;
      }

      if (pathParts.length >= 2) {
        let secondLastPart = pathParts[pathParts.length - 2];
        try { secondLastPart = decodeURIComponent(secondLastPart); } catch { }
        return `${secondLastPart}/${lastPart}`;
      }

      return lastPart;
    }

    return urlObj.hostname;
  } catch {
    const parts = url.split('/').filter(Boolean);
    if (parts.length > 0) {
      let lastPart = parts[parts.length - 1];
      try { lastPart = decodeURIComponent(lastPart); } catch { }
      return lastPart;
    }
    return url;
  }
}

/**
 * 从给定路径获取对应 Aily 库的 nickname
 */
export async function getLibraryNickname(path: string): Promise<string> {
  if (!path) return '';

  try {
    const normalizedPath = path.replace(/\\/g, '/');
    const ailyProjectIndex = normalizedPath.indexOf('/@aily-project/');
    if (ailyProjectIndex === -1) return '';

    const afterAilyProject = normalizedPath.substring(ailyProjectIndex + '/@aily-project/'.length);
    const pathParts = afterAilyProject.split('/');
    if (pathParts.length === 0) return '';

    const libraryName = pathParts[0];
    const packageJsonPath = normalizedPath.substring(0, ailyProjectIndex) +
      '/@aily-project/' + libraryName + '/package.json';

    if (AilyHost.get().fs && AilyHost.get().fs.existsSync(packageJsonPath)) {
      const fileContent = AilyHost.get().fs.readFileSync(packageJsonPath, 'utf-8');
      const packageData = JSON.parse(fileContent);
      return packageData.nickname || '';
    }

    return '';
  } catch (error) {
    console.warn('获取库 nickname 失败:', error);
    return '';
  }
}
