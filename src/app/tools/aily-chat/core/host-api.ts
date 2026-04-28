/**
 * Aily Chat Plugin — 宿主环境接口定义
 *
 * IAilyHostAPI 是 aily-chat 插件与宿主 IDE 之间的唯一契约。
 * 宿主（Blockly IDE / Code IDE / CLI）实现此接口，插件通过此接口访问外部能力。
 *
 * 设计原则：
 *   - aily-chat 内部代码禁止直接使用 window['xxx'] 或 import 父项目服务
 *   - 所有外部依赖通过 IAilyHostAPI 子接口暴露
 *   - 可选子接口（如 editor、mcp）通过 `?` 标记，非 Blockly 宿主可不实现
 */

// ============================================================
// 顶层宿主接口
// ============================================================

export interface IAilyHostAPI {
  /** 文件系统操作 */
  readonly fs: IFileSystem;
  /** 路径工具 */
  readonly path: IPathUtils;
  /** 终端/命令执行 */
  readonly terminal: ITerminal;
  /** 对话框/文件选择 */
  readonly dialog: IDialog;
  /** 平台信息 */
  readonly platform: IPlatform;
  /** 项目信息 */
  readonly project: IProjectProvider;
  /** 鉴权 */
  readonly auth: IAuthProvider;
  /** 配置 */
  readonly config: IConfigProvider;
  /** 构建 */
  readonly builder: IBuildProvider;
  /** 通知/消息 */
  readonly notification: INotificationProvider;
  /** 环境变量 */
  readonly env: IEnvProvider;
  /** 杂项系统操作 */
  readonly shell: IShellUtils;

  /** 编辑器能力（可选 — Blockly IDE 专属功能通过此扩展点注入） */
  readonly editor?: IEditorProvider;
  /** MCP 进程管理（可选 — 需要 Electron 环境） */
  readonly mcp?: IMcpProvider;

  // ---- 宿主特有服务（直接透传，用于复杂 handler 调用） ----
  /** Blockly 编辑器服务（可选 — 完整 BlocklyService 透传） */
  readonly blockly?: any;
  /** 连线图服务（可选 — 完整 ConnectionGraphService 透传） */
  readonly connectionGraph?: any;
  /** 命令执行服务（可选 — 完整 CmdService 透传） */
  readonly cmd?: any;
  /** ABS 自动同步服务（可选） */
  readonly absSync?: any;
  /** HTTP 请求服务（可选） */
  readonly fetch?: any;
  /** 网页搜索服务（可选） */
  readonly webSearch?: any;
  /** 跨平台命令服务（可选 — createDirectory / linkItem 等） */
  readonly crossPlatformCmd?: any;
  /** 通知服务透传（可选 — update / clear 等完整 NoticeService 透传） */
  readonly notice?: any;
  /** Electron 服务透传（可选 — isWindowFocused / notify 等） */
  readonly electron?: any;
  /** UI 服务透传（可选 — updateFooterState / closeTool 等） */
  readonly ui?: any;
  /** 鉴权服务透传（可选 — Observable 订阅用，initializeAuth / isLoggedIn$ / userInfo$ 等） */
  readonly authFull?: any;
  /** 新手引导服务透传（可选 — start 等） */
  readonly onboarding?: any;
}

// ============================================================
// 文件系统
// ============================================================

export interface IFileStat {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtime: Date;
  birthtime?: Date;
}

export interface IDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface IFileSystem {
  readFileSync(path: string, encoding?: string): string;
  readFileAsBase64?(path: string): string;
  writeFileSync(path: string, data: string, encoding?: string): void;
  appendFileSync?(path: string, data: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
  rmdirSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  renameSync?(oldPath: string, newPath: string): void;
  copySync?(src: string, dest: string): void;
  statSync(path: string): IFileStat;
  isDirectory(path: string): boolean;
  readdirSync(path: string): string[];
  /** 带文件类型信息的目录读取 */
  readDirSync?(path: string): IDirent[];
  realpathSync?(path: string): string;

  // ---- 异步方法（可选，优先使用以避免阻塞 UI） ----
  readFile?(path: string, encoding?: string): Promise<string>;
  writeFile?(path: string, data: string, encoding?: string): Promise<void>;
  exists?(path: string): Promise<boolean>;
  stat?(path: string): Promise<IFileStat>;
  readdir?(path: string): Promise<string[]>;
  /** 异步带文件类型信息的目录读取 */
  readDir?(path: string): Promise<IDirent[]>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<void>;
  unlink?(path: string): Promise<void>;
}

// ============================================================
// 路径工具
// ============================================================

export interface IPathUtils {
  // 标准 path 方法
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  dirname(path: string): string;
  basename(path: string, ext?: string): string;
  extname(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  normalize?(path: string): string;

  // Electron 环境特有的路径获取
  getAppDataPath(): string;
  getUserDocuments(): string;
  getUserHome(): string;
  getAilyBuilderPath?(): string;
  getAilyBuilderBuildPath?(): string;
  getAilyChildPath?(): string;
  getElectronPath?(): string;

  /** 路径是否存在（window['path'].isExists 的映射） */
  isExists?(path: string): boolean;
  /** 是否为目录（window['path'].isDir 的映射） */
  isDir?(path: string): boolean;
}

// ============================================================
// 终端
// ============================================================

export interface ITerminal {
  /** 获取当前 shell 类型 */
  getShell(): Promise<string>;

  // === 高级命令执行（CmdService 的能力） ===
  /** 同 window['cmd'].run — 交互式命令执行 */
  run?(options: any): Promise<any>;
  /** 中断命令执行 */
  kill?(streamId: string): Promise<any>;
  /** 按进程名终止 */
  killByName?(processName: string): Promise<any>;
  /** 向正在运行的命令发送输入 */
  input?(streamId: string, input: string): Promise<any>;
  /** 监听命令输出 */
  onData?(streamId: string, callback: (data: any) => void): () => void;

  // === PTY 终端（window['terminal'] 的能力） ===
  /** 创建终端实例 */
  init?(data: any): Promise<any>;
  /** 发送输入到 PTY */
  sendInput?(data: any): void;
  sendInputAsync?(data: any): Promise<any>;
  /** 关闭终端 */
  close?(data: any): void;
  /** 调整终端大小 */
  resize?(data: any): void;
  /** 中断进程 (Ctrl+C) */
  interrupt?(pid: number): Promise<any>;
  /** 强制终止进程 */
  killProcess?(pid: number, processName: string): Promise<any>;

  // === 流式命令执行 ===
  startStream?(pid: number): Promise<any>;
  stopStream?(pid: number, streamId: string): Promise<any>;
  onStreamData?(streamId: string, callback: (lines: any, complete: boolean) => void): () => void;
  executeWithStream?(pid: number, command: string): Promise<any>;

  // === 后台静默执行 ===
  execBackground?(command: string, options?: any): { processInfo: { pid: number; kill(): void }; promise: Promise<any> };
  killBackgroundProcess?(pid: number): Promise<{ success: boolean }>;
}

// ============================================================
// 对话框
// ============================================================

export interface IDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface IDialog {
  /** 选择文件 */
  selectFiles(options?: any): Promise<IDialogResult>;
}

// ============================================================
// 平台信息
// ============================================================

export interface IPlatform {
  /** 系统类型: 'win32' | 'darwin' | 'linux' */
  readonly type: string;
  /** 路径分隔符: '\\' 或 '/' */
  readonly pathSeparator: string;
  readonly isWindows: boolean;
  readonly isMacOS: boolean;
  readonly isLinux: boolean;
  /** 系统语言 */
  readonly lang: string;

  /** 用户主目录 */
  homedir(): string;
  /** 系统临时目录 */
  tmpdir(): string;
  /** 7z 可执行文件名（Windows: '7za.exe', 其他: '7zz'） */
  readonly za7?: string;
}

// ============================================================
// 项目信息
// ============================================================

export interface IProjectProvider {
  /** 当前项目路径 */
  readonly currentProjectPath: string;
  /** 项目根路径 */
  readonly projectRootPath: string;
  /** 当前开发板标识 */
  readonly currentBoard?: string;
  /** 项目名称 */
  readonly projectName?: string;

  /** 获取项目详情 */
  getProjectInfo?(): any;
  /** 重新加载项目 */
  reloadProject?(): Promise<void>;
  /** 创建新项目 */
  createProject?(name: string, board: string, path: string): Promise<any>;
  /** 获取 package.json 内容 */
  getPackageJson?(): Promise<any>;
  /** 获取 board.json 内容 */
  getBoardJson?(): Promise<any>;
  /** 获取当前开发板模块标识（如 @aily-project/board-xxx） */
  getBoardModule?(): Promise<string>;
  /** 获取 board 的 package.json 内容 */
  getBoardPackageJson?(): Promise<any>;
  /** 当前项目路径变化通知（Observable，宿主环境提供） */
  readonly currentProjectPath$?: any;
}

// ============================================================
// 鉴权
// ============================================================

export interface IAuthProvider {
  readonly isLoggedIn: boolean;
  readonly token: string;
  readonly userInfo?: any;
  getAuthHeaders(): Record<string, string>;
  /** 异步获取鉴权 token（刷新后的最新 token） */
  getToken?(): Promise<string>;
  /** 触发登录流程（可选，GUI 环境实现） */
  promptLogin?(): Promise<boolean>;
}

// ============================================================
// 配置
// ============================================================

export interface IConfigProvider {
  /** API 端点 */
  readonly apiEndpoint: string;
  /** 当前语言 */
  readonly locale: string;

  get(key: string): any;
  set?(key: string, value: any): void;

  /** 配置数据对象（直接读写，宿主自行持久化策略） */
  readonly data?: any;
  /** 持久化配置更改 */
  save?(): void;

  /** 获取板卡列表 */
  getBoardsList?(): any[];
  /** 获取库列表 */
  getLibrariesList?(): any[];
  /** 获取硬件分类 */
  getHardwareCategories?(): any[];
  /** 加载硬件索引数据（用于 AI 工具的开发板/库搜索） */
  loadHardwareIndexForAI?(): Promise<any>;

  /** 板卡索引数据（新版） */
  readonly boardIndex?: any[];
  /** 板卡列表数据（旧版） */
  readonly boardList?: any[];
  /** 板卡字典（按 name 索引） */
  readonly boardDict?: Record<string, any>;
  /** 库索引数据（新版） */
  readonly libraryIndex?: any[];
  /** 库列表数据（旧版） */
  readonly libraryList?: any[];
  /** 库字典（按 name 索引） */
  readonly libraryDict?: Record<string, any>;
}

// ============================================================
// 构建
// ============================================================

export interface IBuildProvider {
  build(projectPath: string): Promise<{ success: boolean; output: string }>;
  upload?(projectPath: string, port: string): Promise<{ success: boolean; output: string }>;
}

// ============================================================
// 通知
// ============================================================

export interface INotificationProvider {
  success(message: string): void;
  error(message: string): void;
  warning(message: string): void;
  info(message: string): void;
}

// ============================================================
// 环境变量
// ============================================================

export interface IEnvProvider {
  /** 获取环境变量 */
  get(key: string): string | undefined;
  /** 设置环境变量（可选） */
  set?(data: Record<string, string>): Promise<void>;
}

// ============================================================
// 杂项系统操作
// ============================================================

export interface IShellUtils {
  /** 在系统文件浏览器中打开路径 */
  openByExplorer?(path: string): void;
  /** 在默认浏览器中打开 URL */
  openByBrowser?(url: string): void;
  /** 移入回收站 */
  moveToTrash?(filePath: string): Promise<any>;
}

// ============================================================
// 编辑器能力（扩展点 — 可选）
// ============================================================

/**
 * 编辑器扩展点。
 * - Blockly IDE: 实现 getWorkspaceXml, reloadAbiJson, getBlockDefinitions 等
 * - Code IDE: 实现 getCurrentFileContent, getCurrentFilePath 等
 * - CLI: 不实现 (editor 为 undefined)
 */
export interface IEditorProvider {
  // Blockly 专属
  getWorkspaceXml?(): string;
  loadWorkspace?(xml: string): void;
  getGeneratedCode?(): string;
  reloadAbiJson?(): void;
  getBlockDefinitions?(): any[];

  // Code 编辑器专属
  getCurrentFileContent?(): string;
  getCurrentFilePath?(): string;

  // 连线图/原理图（Blockly 专属扩展）
  connectionGraph?: IConnectionGraphProvider;
}

export interface IConnectionGraphProvider {
  generateConnectionGraph?(args: any): Promise<any>;
  getPinmapSummary?(args: any): Promise<any>;
  validateConnectionGraph?(args: any): Promise<any>;
  getSensorPinmapCatalog?(args: any): Promise<any>;
  generatePinmap?(args: any): Promise<any>;
  savePinmap?(args: any): Promise<any>;
  getCurrentSchematic?(args: any): Promise<any>;
  applySchematic?(args: any): Promise<any>;
}

// ============================================================
// MCP (Model Context Protocol) — 可选
// ============================================================

export interface IMcpToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface IMcpProvider {
  connect(name: string, command: string, args: string[]): Promise<{ success: boolean; error?: string }>;
  getTools(name: string): Promise<{ success: boolean; tools?: IMcpToolDef[]; error?: string }>;
  useTool(toolName: string, args: Record<string, unknown>): Promise<{
    success: boolean;
    result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    error?: string;
  }>;
}
