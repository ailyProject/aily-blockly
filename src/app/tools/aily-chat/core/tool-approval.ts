/**
 * Aily Tool Approval System — 工具执行许可机制
 *
 * 参考 VS Code Copilot 的 claudeToolPermission 设计：
 * - 工具通过 requiresApproval 声明是否需要用户确认
 * - 在工具实际执行前，弹出确认 UI 等待用户批准或拒绝
 * - 支持 getApprovalMessage() 自定义确认描述
 *
 * 与旧 ask_approval 工具的区别：
 * - 旧方案：ask_approval 是一个独立工具，LLM 可以选择不调用它
 * - 新方案：审批逻辑在 ToolRegistry.execute() 层强制拦截，无法绕过
 */

// ============================
// 类型定义
// ============================

/** 审批请求信息，传递给 UI 层 */
export interface ToolApprovalRequest {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 确认标题 */
  title: string;
  /** 确认描述（说明工具将做什么） */
  message: string;
  /** 工具参数（供 UI 展示详情） */
  args?: any;
}

/** 审批结果 */
export interface ToolApprovalResult {
  approved: boolean;
  /** 用户拒绝时的原因（可选） */
  reason?: string;
  /** 许可范围：once=仅本次, session=本会话后续自动允许同名工具, session-safe=自动允许所有非破坏性操作 */
  scope?: 'once' | 'session' | 'session-safe';
}

/** UI 层注册的审批回调 */
export type ToolApprovalCallback = (request: ToolApprovalRequest) => Promise<ToolApprovalResult>;

// ============================
// 全局回调注册（与 askUserTool 同模式）
// ============================

let _approvalCallback: ToolApprovalCallback | null = null;

/**
 * 注册工具审批回调。由 UI 层（ChatEngineService）初始化时调用。
 * 回调负责在聊天界面展示审批 UI，等待用户确认后返回结果。
 */
export function registerToolApprovalCallback(cb: ToolApprovalCallback): void {
  _approvalCallback = cb;
}

/**
 * 取消注册审批回调（组件销毁时调用）
 */
export function unregisterToolApprovalCallback(): void {
  _approvalCallback = null;
}

// ============================
// 需要审批的工具集合
// ============================

/**
 * 需要用户确认才能执行的工具名称集合。
 *
 * 分类：
 * - 命令行执行：execute_command, start_background_command
 * - 项目创建/修改：create_project, build_project, switch_board, set_board_config
 * - 文件删除：delete_file, delete_folder
 * - 安装/克隆：clone_repository
 * - 原理图应用：apply_schematic, save_pinmap
 */
const TOOLS_REQUIRING_APPROVAL = new Set<string>([
  // 命令行
  'execute_command',
  'start_background_command',
  // 项目级操作
  'create_project',
  'build_project',
  'switch_board',
  'set_board_config',
  // 删除操作
  'delete_file',
  'delete_folder',
  // 外部资源
  'clone_repository',
  // 原理图变更
//   'apply_schematic',
//   'save_pinmap',
	// 子代理工具
	'run_subagent',
]);

// ============================
// 会话级自动许可缓存
// ============================

/** 本会话中已被用户授予「后续自动允许」的工具名称集合 */
const _sessionApprovedTools = new Set<string>();

/** 本会话中是否启用了「自动允许所有非破坏性操作」模式 */
let _sessionSafeMode = false;

// ============================
// 只读命令检测
// ============================

/**
 * 只读/查询类命令的首词白名单。
 * 这些命令只进行读取或查询，不会修改文件系统或安装软件。
 */
const READ_ONLY_COMMANDS = new Set<string>([
  // 文件/目录查看
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'less', 'more',
  'find', 'fd', 'locate', 'tree',
  // 文本搜索
  'grep', 'rg', 'ag', 'ack', 'findstr', 'select-string',
  // 系统信息
  'echo', 'pwd', 'cd', 'which', 'where', 'whoami', 'hostname',
  'uname', 'env', 'printenv', 'set', 'date', 'uptime', 'df', 'du',
  'wc', 'sort', 'uniq', 'diff', 'cmp', 'file', 'stat', 'readlink',
  // 网络查询
  'ping', 'nslookup', 'dig', 'host', 'curl', 'wget',
  // 版本/帮助
  'man', 'help', 'info',
  // PowerShell 只读 cmdlet（小写匹配）
  'get-childitem', 'get-content', 'get-item', 'get-location',
  'get-process', 'get-service', 'get-command', 'get-help',
  'get-member', 'get-variable', 'get-alias', 'get-history',
  'get-date', 'get-host', 'get-culture', 'get-module',
  'get-executionpolicy', 'get-itemproperty', 'test-path',
  'test-connection', 'resolve-path', 'measure-object',
  'select-object', 'where-object', 'format-table', 'format-list',
  'out-string', 'write-output', 'write-host',
]);

/**
 * 带版本/帮助后缀的命令模式。
 * 匹配 `xxx --version`, `xxx -v`, `xxx --help`, `xxx -h`
 */
const VERSION_HELP_PATTERN = /^\S+\s+(-v|--version|-h|--help|version)\s*$/i;

/**
 * 带只读子命令的 Git 命令
 */
const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'tag', 'remote',
  'stash list', 'describe', 'shortlog', 'rev-parse', 'ls-files',
  'ls-tree', 'cat-file', 'config --list', 'config --get',
]);

/**
 * 带只读子命令的 npm/yarn/pnpm 命令
 */
const PKG_READ_ONLY_SUBCOMMANDS = new Set([
  'list', 'ls', 'info', 'view', 'show', 'search', 'outdated',
  'audit', 'why', 'config list', 'config get', 'bin', 'prefix',
  'root', 'help', 'version',
]);

/**
 * 带只读子命令的 pip/python 命令
 */
const PIP_READ_ONLY_SUBCOMMANDS = new Set([
  'list', 'show', 'freeze', 'check', 'search', 'config list',
  'config get', 'help', 'debug',
]);

/**
 * 判断命令是否为只读/查询类命令。
 * 只读命令不会修改系统状态，可以安全地自动放行。
 */
export function isReadOnlyCommand(command: string): boolean {
  if (!command?.trim()) return false;

  const trimmed = command.trim();

  // 版本/帮助查询一律放行
  if (VERSION_HELP_PATTERN.test(trimmed)) return true;

  // 提取首个命令词（处理路径前缀和引号）
  // 处理形如 "C:\path\to\cmd.exe" arg 或 /usr/bin/cmd arg 的情况
  const firstToken = trimmed
    .replace(/^["']([^"']+)["']\s*/, '$1 ')  // 去除引号包裹
    .split(/\s+/)[0]                          // 取第一个词
    .replace(/^.*[/\\]/, '')                  // 去除路径前缀
    .replace(/\.exe$/i, '')                   // 去除 .exe 后缀
    .toLowerCase();

  // 直接匹配只读命令白名单
  if (READ_ONLY_COMMANDS.has(firstToken)) return true;

  // Git 子命令检测
  if (firstToken === 'git') {
    const rest = trimmed.substring(trimmed.indexOf('git') + 3).trim().toLowerCase();
    for (const sub of GIT_READ_ONLY_SUBCOMMANDS) {
      if (rest.startsWith(sub)) return true;
    }
    return false;
  }

  // npm/yarn/pnpm 子命令检测
  if (['npm', 'yarn', 'pnpm', 'npx'].includes(firstToken)) {
    const rest = trimmed.substring(trimmed.indexOf(firstToken) + firstToken.length).trim().toLowerCase();
    for (const sub of PKG_READ_ONLY_SUBCOMMANDS) {
      if (rest.startsWith(sub)) return true;
    }
    return false;
  }

  // pip/pip3/python 子命令检测
  if (['pip', 'pip3'].includes(firstToken)) {
    const rest = trimmed.substring(trimmed.indexOf(firstToken) + firstToken.length).trim().toLowerCase();
    for (const sub of PIP_READ_ONLY_SUBCOMMANDS) {
      if (rest.startsWith(sub)) return true;
    }
    return false;
  }
  if (['python', 'python3', 'node'].includes(firstToken)) {
    // python -c "..." 和 node -e "..." 不算只读
    const rest = trimmed.substring(trimmed.indexOf(firstToken) + firstToken.length).trim();
    if (/^(-V|--version|-h|--help)\s*$/.test(rest)) return true;
    return false;
  }

  return false;
}

// ============================
// 破坏性操作检测
// ============================

/** 永远需要审批的工具（即使在 session-safe 模式下） */
const ALWAYS_REQUIRE_APPROVAL = new Set<string>([
  'delete_file',
  'delete_folder',
]);

/**
 * 破坏性命令关键词。
 * 当命令包含这些模式时，即使在 session-safe 模式下也不能自动放行。
 */
const DESTRUCTIVE_CMD_PATTERNS = [
  /\brm\s/i, /\brm$/i,
  /\brmdir\b/i,
  /\bdel\s/i, /\bdel$/i,
  /\bRemove-Item\b/i,
  /\bRemove-/i,
  /\bformat\s/i,
  /\bdrop\s/i,
  /\btruncate\s/i,
  /\b--force\b/i, /\b-rf\b/i, /\b-fr\b/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[fd])/i,
  /\bgit\s+branch\s+-[dD]/i,
] as const;

/**
 * 判断命令行命令是否为破坏性操作。
 */
export function isDestructiveCommand(command: string): boolean {
  if (!command?.trim()) return false;
  return DESTRUCTIVE_CMD_PATTERNS.some(p => p.test(command));
}

/**
 * 判断工具+参数组合是否为破坏性操作。
 * 破坏性操作在 session-safe 模式下也不会被自动放行。
 */
export function isDestructiveOperation(toolName: string, args?: any): boolean {
  if (ALWAYS_REQUIRE_APPROVAL.has(toolName)) return true;
  if ((toolName === 'execute_command' || toolName === 'start_background_command') && args?.command) {
    return isDestructiveCommand(args.command);
  }
  return false;
}

/**
 * 判断工具是否需要审批。
 * 检查顺序：
 * 1. 工具不在审批列表中 → 不需要
 * 2. 命令行工具的只读命令 → 不需要（自动放行）
 * 3. 工具已获得会话级授权 → 不需要
 * 4. 会话安全模式已开启 且 操作非破坏性 → 不需要
 * 5. 其他 → 需要审批
 */
export function toolRequiresApproval(toolName: string, args?: any): boolean {
  if (!TOOLS_REQUIRING_APPROVAL.has(toolName)) return false;

  // 命令行工具：只读命令自动放行
  if ((toolName === 'execute_command' || toolName === 'start_background_command') && args?.command) {
    if (isReadOnlyCommand(args.command)) return false;
  }

  // 会话级授权（针对特定工具）
  if (_sessionApprovedTools.has(toolName)) return false;

  // 会话安全模式：非破坏性操作自动放行
  if (_sessionSafeMode && !isDestructiveOperation(toolName, args)) return false;

  return true;
}

/**
 * 将工具加入本会话自动许可列表（用户选择「后续自动允许」时调用）
 */
export function approveToolForSession(toolName: string): void {
  _sessionApprovedTools.add(toolName);
}

/**
 * 启用会话安全模式（自动允许所有非破坏性操作）
 */
export function enableSessionSafeMode(): void {
  _sessionSafeMode = true;
}

/**
 * 清空会话级自动许可缓存（新建会话时调用）
 */
export function clearSessionApprovals(): void {
  _sessionApprovedTools.clear();
  _sessionSafeMode = false;
}

/**
 * 动态添加需要审批的工具（供外部配置扩展）
 */
export function addToolRequiringApproval(toolName: string): void {
  TOOLS_REQUIRING_APPROVAL.add(toolName);
}

/**
 * 动态移除工具的审批要求
 */
export function removeToolApprovalRequirement(toolName: string): void {
  TOOLS_REQUIRING_APPROVAL.delete(toolName);
}

// ============================
// 审批描述生成
// ============================

/**
 * 为工具调用生成人类可读的审批描述。
 * 各工具根据参数生成不同的描述信息。
 */
export function generateApprovalMessage(toolName: string, args: any): { title: string; message: string } {
  switch (toolName) {
    case 'execute_command':
      return {
        title: '执行命令',
        message: `即将执行命令：\n${args?.command || '(未知命令)'}${args?.cwd ? '\n工作目录：' + args.cwd : ''}`
      };
    case 'start_background_command':
      return {
        title: '启动后台命令',
        message: `即将在后台启动命令：\n${args?.command || '(未知命令)'}`
      };
    case 'create_project':
      return {
        title: '创建项目',
        message: `即将创建新项目：${args?.name || args?.projectName || '(未命名)'}${args?.board ? '\n开发板：' + args.board : ''}`
      };
    case 'build_project':
      return {
        title: '编译项目',
        message: '即将编译当前项目，这可能需要一些时间。'
      };
    case 'switch_board':
      return {
        title: '切换开发板',
        message: `即将切换开发板为：${args?.board || args?.boardId || args?.board_name || '(未知)'}`
      };
    case 'set_board_config':
      return {
        title: '修改开发板配置',
        message: `即将修改开发板配置：${args?.key || '(未知配置项)'} = ${args?.value ?? '(未知值)'}`
      };
    case 'delete_file':
      return {
        title: '删除文件',
        message: `即将删除文件：${args?.path || args?.filePath || '(未知路径)'}`
      };
    case 'delete_folder':
      return {
        title: '删除文件夹',
        message: `即将删除文件夹及其所有内容：${args?.path || args?.folderPath || '(未知路径)'}`
      };
    case 'clone_repository':
      return {
        title: '克隆仓库',
        message: `即将克隆 Git 仓库：${args?.url || args?.repoUrl || '(未知地址)'}`
      };
    // case 'apply_schematic':
    //   return {
    //     title: '应用原理图',
    //     message: '即将将生成的原理图应用到当前项目，这会修改硬件连接配置。'
    //   };
    // case 'save_pinmap':
    //   return {
    //     title: '保存引脚映射',
    //     message: '即将保存引脚映射配置到项目文件。'
    //   };
    case 'run_subagent':
      return {
        title: `调用子代理: ${args?.agent || '(未知)'}`,
        message: `即将调用子代理 ${args?.agent || '(未知)'} 执行任务：\n${args?.task || '(未指定任务)'}`
      };
    default:
      return {
        title: `执行 ${toolName}`,
        message: `即将执行工具 ${toolName}，请确认是否继续。`
      };
  }
}

// ============================
// 审批执行入口
// ============================

/**
 * 请求用户审批。
 * 如果没有注册回调（如 CLI 模式），则回退到 window.confirm。
 *
 * @returns true = 用户批准，false = 用户拒绝
 */
export async function requestToolApproval(
  toolCallId: string,
  toolName: string,
  args: any
): Promise<ToolApprovalResult> {
  const { title, message } = generateApprovalMessage(toolName, args);

  if (_approvalCallback) {
    return _approvalCallback({ toolCallId, toolName, title, message, args });
  }

  // 回退：使用 window.confirm（Electron GUI 环境）
  try {
    const confirmed = window.confirm(`${title}\n\n${message}`);
    return { approved: confirmed, reason: confirmed ? undefined : '用户取消' };
  } catch {
    // 非浏览器环境（CLI / Node），默认允许
    return { approved: true };
  }
}
