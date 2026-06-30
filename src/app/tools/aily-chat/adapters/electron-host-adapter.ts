/**
 * Electron 宿主适配器
 *
 * 将 Electron 环境中的 window['xxx'] API 和 Angular 服务映射为 IAilyHostAPI 接口。
 * 在 aily-chat 组件初始化时调用 createElectronHostAdapter() 创建实例。
 *
 * 使用方式：
 *   const host = createElectronHostAdapter({ projectService, configService, ... });
 *   AilyHost.init(host);
 */

import {
  IAilyHostAPI,
  IFileSystem,
  IPathUtils,
  ITerminal,
  IDialog,
  IPlatform,
  IProjectProvider,
  IAuthProvider,
  IConfigProvider,
  IBuildProvider,
  INotificationProvider,
  IEnvProvider,
  IShellUtils,
  IEditorProvider,
  IConnectionGraphProvider,
  IMcpProvider,
} from '../core/host-api';

/**
 * Electron 适配器所需的 Angular 服务引用。
 * 这些只在创建时传入一次，adapter 内部不 import 任何 Angular 服务。
 */
export interface ElectronAdapterDeps {
  projectService: any;
  configService: any;
  authService: any;
  builderService: any;
  platformService: any;
  noticeService?: any;
  blocklyService?: any;
  connectionGraphService?: any;
  cmdService?: any;
  crossPlatformCmdService?: any;
  absAutoSyncService?: any;
  arduinoLintService?: any;
  electronService?: any;
  uiService?: any;
  onboardingService?: any;
}

/**
 * 创建基于 Electron window[] API 的 IAilyHostAPI 实现。
 */
export function createElectronHostAdapter(deps: ElectronAdapterDeps): IAilyHostAPI {
  const getElectronAPI = () => (window as any)['electronAPI'] ?? {};
  const getWindowBridge = (key: string) => getElectronAPI()[key] ?? (window as any)[key];
  const getFs = () => getWindowBridge('fs');
  const getPath = () => getWindowBridge('path');
  const getTerminal = () => getWindowBridge('terminal');
  const getCmd = () => getWindowBridge('cmd');
  const getDialog = () => getWindowBridge('dialog');
  const getPlatform = () => getWindowBridge('platform');
  const getOther = () => (window as any)['other'] ?? getElectronAPI().shell;
  const getEnv = () => getWindowBridge('env');
  const getMcp = () => getWindowBridge('mcp');
  const getOs = () => getWindowBridge('os');
  const getLog = () => getWindowBridge('log');
  const getClipboard = () => getElectronAPI().clipboard ?? (window as any)['clipboard'];
  const textDocumentContentProviders = new Map<string, {
    provideTextDocumentContent(uri: string): Promise<string | undefined> | string | undefined;
  }>();
  const getDep = <K extends keyof ElectronAdapterDeps>(key: K): ElectronAdapterDeps[K] => deps[key];
  let cachedHostConfigApiEndpoint: string | null | undefined;

  const normalizeStringValue = (value: unknown): string => typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : '';

  const normalizeComparablePath = (value: unknown): string => normalizeStringValue(value)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

  const resolveActiveProjectPath = (rawProjectService: any): string => {
    const currentProjectPath = normalizeStringValue(rawProjectService?.currentProjectPath);
    const projectRootPath = normalizeStringValue(rawProjectService?.projectRootPath);
    if (!currentProjectPath) {
      return '';
    }
    if (projectRootPath && normalizeComparablePath(currentProjectPath) === normalizeComparablePath(projectRootPath)) {
      return '';
    }
    return currentProjectPath;
  };

  const resolveProjectPath = (rawProjectService: any): string =>
    resolveActiveProjectPath(rawProjectService);

  const resolveProjectRootPath = (rawProjectService: any): string =>
    normalizeStringValue(rawProjectService?.projectRootPath)
    || resolveProjectPath(rawProjectService);

  const resolveProjectBoardFromPackageData = (packageData: any): string | undefined => {
    const explicitBoard = normalizeStringValue(packageData?.board);
    if (explicitBoard) {
      return explicitBoard;
    }

    const dependencies = packageData?.dependencies;
    if (!dependencies || typeof dependencies !== 'object') {
      return undefined;
    }

    const boardDependency = Object.keys(dependencies)
      .find(dependencyName => dependencyName.startsWith('@aily-project/board-'));
    return boardDependency
      ? boardDependency.slice('@aily-project/'.length)
      : undefined;
  };

  const resolveProjectBoard = (rawProjectService: any): string | undefined => {
    if (!resolveActiveProjectPath(rawProjectService)) {
      return undefined;
    }
    return resolveProjectBoardFromPackageData(rawProjectService?.currentPackageData)
      || normalizeStringValue(rawProjectService?.currentBoardConfig?.name)
      || normalizeStringValue(rawProjectService?.currentBoard)
      || undefined;
  };

  const resolveProjectName = (rawProjectService: any): string | undefined => {
    if (!resolveActiveProjectPath(rawProjectService)) {
      return undefined;
    }
    return normalizeStringValue(rawProjectService?.currentPackageData?.name)
      || normalizeStringValue(rawProjectService?.projectName)
      || undefined;
  };

  const readHostConfigApiEndpoint = (): string | null => {
    if (cachedHostConfigApiEndpoint !== undefined) {
      return cachedHostConfigApiEndpoint;
    }

    cachedHostConfigApiEndpoint = null;
    try {
      const pathApi = getPath();
      const fsApi = getFs();
      if (!pathApi || !fsApi || typeof fsApi.readFileSync !== 'function') {
        return cachedHostConfigApiEndpoint;
      }

      const electronPath = typeof pathApi.getElectronPath === 'function' ? pathApi.getElectronPath() : '';
      const appDataPath = typeof pathApi.getAppDataPath === 'function' ? pathApi.getAppDataPath() : '';
      const defaultConfigPath = electronPath && typeof pathApi.join === 'function'
        ? pathApi.join(electronPath, 'config', 'config.json')
        : '';
      const userConfigPath = appDataPath && typeof pathApi.join === 'function'
        ? pathApi.join(appDataPath, 'config.json')
        : '';
      const defaultConfig = readJsonFileSync(fsApi, defaultConfigPath);
      const userConfig = userConfigPath && fsExistsSync(fsApi, userConfigPath)
        ? readJsonFileSync(fsApi, userConfigPath)
        : null;
      const mergedConfig = mergeHostConfig(defaultConfig, userConfig);
      cachedHostConfigApiEndpoint = resolveHostConfigApiEndpoint(mergedConfig);
      return cachedHostConfigApiEndpoint;
    } catch {
      cachedHostConfigApiEndpoint = null;
      return cachedHostConfigApiEndpoint;
    }
  };

  // ----- fs -----
  const fs: IFileSystem = {
    readFileSync: (path, encoding?) => getFs().readFileSync(path, encoding ?? 'utf8'),
    readFileAsBase64: (path) => getFs().readFileAsBase64?.(path),
    writeFileSync: (path, data) => getFs().writeFileSync(path, data),
    appendFileSync: (path, data) => getFs().appendFileSync?.(path, data),
    existsSync: (path) => getFs()?.existsSync?.(path) ?? false,
    mkdirSync: (path, options?) => getFs().mkdirSync(path, options),
    unlinkSync: (path) => getFs().unlinkSync(path),
    rmdirSync: (path, options?) => getFs().rmdirSync(path, options),
    renameSync: (oldPath, newPath) => getFs().renameSync?.(oldPath, newPath),
    copySync: (src, dest) => getFs().copySync?.(src, dest),
    statSync: (path) => {
      const raw = getFs().statSync(path);
      return {
        size: raw.size,
        mtime: new Date(raw.mtime),
        birthtime: raw.birthtime ? new Date(raw.birthtime) : undefined,
        isDirectory: () => raw._isDirectory,
        isFile: () => raw._isFile,
      };
    },
    isDirectory: (path) => getFs().isDirectory(path),
    readdirSync: (path) => getFs().readdirSync(path),
    readDirSync: (path) => {
      const entries = getFs().readDirSync?.(path);
      if (!entries) return undefined;
      return entries.map((e: any) => ({
        name: e.name,
        isDirectory: () => e._isDirectory,
        isFile: () => e._isFile,
      }));
    },
    realpathSync: (path) => getFs().realpathSync?.(path),
    // ---- 异步方法（IPC 到主进程） ----
    readFile: (path, encoding?) => getFs().readFile(path, encoding ?? 'utf8'),
    writeFile: (path, data, encoding?) => getFs().writeFile(path, data, encoding),
    exists: (path) => getFs().exists(path),
    stat: async (path) => {
      const raw = await getFs().stat(path);
      return {
        size: raw.size,
        mtime: new Date(raw.mtime),
        birthtime: raw.birthtime ? new Date(raw.birthtime) : undefined,
        isDirectory: () => raw._isDirectory,
        isFile: () => raw._isFile,
      };
    },
    readdir: (path) => getFs().readdir(path),
    readDir: async (path) => {
      const entries = await getFs().readDir(path);
      return entries.map((e: any) => ({
        name: e.name,
        isDirectory: () => e._isDirectory,
        isFile: () => e._isFile,
      }));
    },
    mkdir: (path, options?) => getFs().mkdir(path, options),
    unlink: (path) => getFs().unlink(path),
    watch: (watchPath, listener, options) => {
      const handle = getFs().watch?.(watchPath, listener, options);
      if (!handle) {
        return undefined;
      }

      return {
        close: () => handle.close?.(),
        dispose: () => handle.dispose?.() ?? handle.close?.(),
        unsubscribe: () => handle.unsubscribe?.() ?? handle.close?.(),
      };
    },
  };

  // ----- path -----
  const path: IPathUtils = {
    join: (...paths) => getPath()?.join?.(...paths) ?? paths.filter(Boolean).join('/'),
    resolve: (...paths) => getPath()?.resolve?.(...paths) ?? paths.filter(Boolean).join('/'),
    dirname: (p) => getPath()?.dirname?.(p) ?? String(p).replace(/[\\/][^\\/]*$/, ''),
    basename: (p, ext?) => getPath()?.basename?.(p, ext) ?? String(p).split(/[\\/]/).pop() ?? '',
    extname: (p) => getPath()?.extname?.(p) ?? '',
    relative: (from, to) => getPath()?.relative?.(from, to) ?? to,
    isAbsolute: (p) => getPath()?.isAbsolute?.(p) ?? /^[A-Za-z]:[\\/]|^\//.test(String(p)),
    normalize: (p) => getPath()?.normalize?.(p) ?? p,
    getAppDataPath: () => getPath()?.getAppDataPath?.() ?? '',
    getUserDocuments: () => getPath()?.getUserDocuments?.() ?? '',
    getUserHome: () => getPath()?.getUserHome?.() ?? '',
    getAilyBuilderPath: () => getPath()?.getAilyBuilderPath?.(),
    getAilyBuilderBuildPath: () => getPath()?.getAilyBuilderBuildPath?.(),
    getAilyChildPath: () => getPath()?.getAilyChildPath?.(),
    getElectronPath: () => getPath()?.getElectronPath?.(),
    isExists: (p) => getPath()?.isExists?.(p) ?? false,
    isDir: (p) => getPath()?.isDir?.(p) ?? false,
  };

  // ----- terminal (合并 window['terminal'] + window['cmd']) -----
  const terminal: ITerminal = {
    getShell: () => getTerminal()?.getShell(),
    init: (data) => getTerminal()?.init(data),
    onPidData: (pid, cb) => getTerminal()?.onPidData?.(pid, cb),
    onPidExit: (pid, cb) => getTerminal()?.onPidExit?.(pid, cb),
    sendInput: (data) => getTerminal()?.sendInput(data),
    spawnCommand: (data) => getTerminal()?.spawnCommand?.(data),
    sendInputAsync: (data) => getTerminal()?.sendInputAsync(data),
    close: (data) => getTerminal()?.close(data),
    resize: (data) => getTerminal()?.resize(data),
    interrupt: (pid) => getTerminal()?.interrupt(pid),
    killProcess: (pid, name) => getTerminal()?.killProcess(pid, name),
    startStream: (pid) => getTerminal()?.startStream(pid),
    stopStream: (pid, sid) => getTerminal()?.stopStream(pid, sid),
    onStreamData: (sid, cb) => getTerminal()?.onStreamData(sid, cb),
    executeWithStream: (pid, cmd) => getTerminal()?.executeWithStream(pid, cmd),
    // window['cmd'] 映射
    run: (options) => getCmd()?.run(options),
    kill: (streamId) => getCmd()?.kill(streamId),
    killByName: (name) => getCmd()?.killByName(name),
    input: (streamId, input) => getCmd()?.input(streamId, input),
    onData: (streamId, cb) => getCmd()?.onData(streamId, cb),
    execBackground: (command, options?) => getCmd()?.execBackground(command, options),
    killBackgroundProcess: (pid) => getCmd()?.killBackgroundProcess(pid),
  };

  // ----- dialog -----
  const dialog: IDialog = {
    selectFiles: (options?) => getDialog()?.selectFiles(options),
  };

  // ----- platform -----
  const platform: IPlatform = {
    get type() { return getPlatform()?.type ?? 'linux'; },
    get pathSeparator() { return getPlatform()?.pt ?? '/'; },
    get isWindows() { return getPlatform()?.isWindows ?? false; },
    get isMacOS() { return getPlatform()?.isMacOS ?? false; },
    get isLinux() { return getPlatform()?.isLinux ?? true; },
    get lang() { return getPlatform()?.lang ?? 'zh-CN'; },
    get za7() { return getPlatform()?.isWindows ? '7za.exe' : '7zz'; },
    homedir: () => getOs()?.homedir?.() ?? getPath()?.getUserHome?.() ?? '',
    tmpdir: () => getOs()?.tmpdir?.() ?? '',
  };

  // ----- project (lazy Angular ProjectService -> IProjectProvider) -----
  const project: IProjectProvider = new Proxy({} as IProjectProvider, {
    get(_target, prop: string | symbol) {
      const rawProjectService = getDep('projectService');
      if (!rawProjectService) {
        return undefined;
      }

      if (prop === 'currentProjectPath') {
        return resolveProjectPath(rawProjectService);
      }
      if (prop === 'projectRootPath') {
        return resolveProjectRootPath(rawProjectService);
      }
      if (prop === 'currentBoard') {
        return resolveProjectBoard(rawProjectService);
      }
      if (prop === 'projectName') {
        return resolveProjectName(rawProjectService);
      }
      if (prop === 'getProjectPath') {
        return () => resolveProjectPath(rawProjectService);
      }
      if (prop === 'getBoard') {
        return () => resolveProjectBoard(rawProjectService);
      }
      if (prop === 'getProjectInfo') {
        return async () => {
          const activeProjectPath = resolveProjectPath(rawProjectService);
          if (typeof rawProjectService.getProjectInfo === 'function') {
            const info = await rawProjectService.getProjectInfo();
            if (info && typeof info === 'object') {
              const infoRecord = info as Record<string, unknown>;
              if (!activeProjectPath && infoRecord['projectOpened'] !== true) {
                return {
                  ...infoRecord,
                  projectOpened: false,
                };
              }
              return {
                ...infoRecord,
                path: normalizeStringValue(infoRecord['path']) || activeProjectPath,
                board: infoRecord['board'] ?? resolveProjectBoard(rawProjectService),
                name: infoRecord['name'] ?? resolveProjectName(rawProjectService),
              };
            }
            return info;
          }
          return {
            projectOpened: Boolean(activeProjectPath),
            path: activeProjectPath,
            rootPath: resolveProjectRootPath(rawProjectService),
            board: resolveProjectBoard(rawProjectService),
            name: resolveProjectName(rawProjectService),
          };
        };
      }
      if (prop === 'getPackageJsonSync') {
        return () => {
          try { return rawProjectService.currentPackageData ?? undefined; }
          catch { return undefined; }
        };
      }

      const value = rawProjectService[prop as keyof typeof rawProjectService];
      return typeof value === 'function' ? value.bind(rawProjectService) : value;
    },
    set(_target, prop: string | symbol, value) {
      const rawProjectService = getDep('projectService');
      if (!rawProjectService) {
        return false;
      }

      rawProjectService[prop as keyof typeof rawProjectService] = value;
      return true;
    },
    has(_target, prop: string | symbol) {
      const rawProjectService = getDep('projectService');
      if (!rawProjectService) {
        return false;
      }
      if ([
        'currentProjectPath',
        'projectRootPath',
        'currentBoard',
        'projectName',
        'getProjectPath',
        'getProjectInfo',
        'getBoard',
        'getPackageJsonSync',
      ].includes(String(prop))) {
        return true;
      }
      return prop in rawProjectService;
    },
  });

  // ----- auth -----
  // ----- auth (映射 getToken2 → getToken) -----
  const auth: IAuthProvider = {
    get isLoggedIn() { return getDep('authService')?.isLoggedIn ?? false; },
    get isLoggedIn$() { return getDep('authService')?.isLoggedIn$; },
    get authChanged$() { return getDep('authService')?.authChanged$; },
    get token() { return getDep('authService')?.token ?? ''; },
    get userInfo() { return getDep('authService')?.userInfo; },
    get userInfo$() { return getDep('authService')?.userInfo$; },
    get authSnapshot$() { return getDep('authService')?.authSnapshot$; },
    getAuthHeaders: () => getDep('authService')?.getAuthHeaders?.() ?? {},
    initializeAuth: () => getDep('authService')?.initializeAuth?.() ?? Promise.resolve(),
    getToken: () => getDep('authService')?.getToken2?.() ?? Promise.resolve(''),
    getSnapshot: () => getDep('authService')?.getAuthSnapshot?.() ?? null,
    refreshMe: () => getDep('authService')?.refreshMe?.() ?? Promise.resolve(null),
    promptLogin: () => getDep('authService')?.promptLogin?.() ?? Promise.resolve(false),
  };

  // ----- config (透传 data/save) -----
  const config: IConfigProvider = {
    get apiEndpoint() {
      const envEndpoint = (typeof process !== 'undefined' ? process.env?.['AILY_API_SERVER'] : undefined)
        || (typeof window !== 'undefined' ? (window as any)?.process?.env?.['AILY_API_SERVER'] : undefined);
      if (typeof envEndpoint === 'string' && envEndpoint.trim()) {
        return envEndpoint.trim();
      }

      return readHostConfigApiEndpoint() || 'https://api.aily.pro';
    },
    get locale() { return getDep('configService')?.data?.lang ?? 'zh-CN'; },
    get: (key: string) => getDep('configService')?.data?.[key],
    set: (key: string, value: any) => {
      const configService = getDep('configService');
      if (configService?.data) configService.data[key] = value;
    },
    get data() { return getDep('configService')?.data; },
    save: () => getDep('configService')?.save?.(),
    getBoardsList: () => getDep('configService')?.getBoardsList?.(),
    getLibrariesList: () => getDep('configService')?.getLibrariesList?.(),
    getHardwareCategories: () => getDep('configService')?.getHardwareCategories?.(),
    loadHardwareIndexForAI: () => getDep('configService')?.loadHardwareIndexForAI?.(),
    scheduleHardwareIndexRefreshForAI: (reason: string, options?: { force?: boolean }) => getDep('configService')?.scheduleHardwareIndexRefreshForAI?.(reason, options),
    get boardIndex() { return (getDep('configService') as any)?.boardIndex; },
    get boardList() { return (getDep('configService') as any)?.boardList; },
    get boardDict() { return (getDep('configService') as any)?.boardDict; },
    get libraryIndex() { return (getDep('configService') as any)?.libraryIndex; },
    get libraryList() { return (getDep('configService') as any)?.libraryList; },
    get libraryDict() { return (getDep('configService') as any)?.libraryDict; },
  };

  // ----- builder -----
  const builder: IBuildProvider = {
    build: async (projectPath: string) => {
      if (!projectPath) {
        return { success: false, output: 'No active project is available for build.' };
      }
      const builderService = getDep('builderService');
      if (!builderService || typeof builderService.build !== 'function') {
        return { success: false, output: 'Build system is not available.' };
      }

      try {
        const result = await builderService.build(projectPath);
        return {
          success: result?.state !== 'error' && result?.state !== 'warn',
          output: result?.text ?? result?.output ?? JSON.stringify(result ?? null),
        };
      } catch (error: any) {
        return {
          success: false,
          output: error?.text || error?.message || String(error),
        };
      }
    },
    upload: async (projectPath: string, port: string) => {
      const builderService = getDep('builderService');
      const upload = builderService?.upload;
      if (typeof upload !== 'function') {
        return { success: false, output: 'Upload system is not available.' };
      }

      try {
        const result = await upload.call(builderService, projectPath, port);
        return {
          success: result?.state !== 'error' && result?.state !== 'warn',
          output: result?.text ?? result?.output ?? JSON.stringify(result ?? null),
        };
      } catch (error: any) {
        return {
          success: false,
          output: error?.text || error?.message || String(error),
        };
      }
    },
  };

  // ----- notification -----
  const notification: INotificationProvider = {
    success: (msg) => getDep('noticeService')?.success?.(msg),
    error: (msg) => getDep('noticeService')?.error?.(msg),
    warning: (msg) => getDep('noticeService')?.warning?.(msg),
    info: (msg) => getDep('noticeService')?.info?.(msg),
  };

  // ----- env -----
  const env: IEnvProvider = {
    get: (key) => getEnv()?.get(key),
    set: (data) => getEnv()?.set(data),
  };

  // ----- shell -----
  const shell: IShellUtils = {
    openByExplorer: (p) => getOther()?.openByExplorer?.(p) ?? getOther()?.showItemInFolder?.(p),
    openByBrowser: (url) => getOther()?.openByBrowser?.(url),
    moveToTrash: (filePath) => getOther()?.moveToTrash?.(filePath),
  };

  const log = {
    info: (message: string) => getLog()?.info?.(message),
    warn: (message: string) => getLog()?.warn?.(message),
    error: (message: string, error?: unknown) => getLog()?.error?.(message, error),
  };

  // ----- editor (optional, lazy) -----
  const connectionGraph: IConnectionGraphProvider = {
    generateConnectionGraph: (args) => getDep('connectionGraphService')?.generateConnectionGraph?.(args),
    getPinmapSummary: (args) => getDep('connectionGraphService')?.getPinmapSummary?.(args),
    validateConnectionGraph: (args) => getDep('connectionGraphService')?.validateConnectionGraph?.(args),
    getSensorPinmapCatalog: (args) => getDep('connectionGraphService')?.getSensorPinmapCatalog?.(args),
    generatePinmap: (args) => getDep('connectionGraphService')?.generatePinmap?.(args),
    savePinmap: (args) => getDep('connectionGraphService')?.savePinmap?.(args),
    getCurrentSchematic: (args) => getDep('connectionGraphService')?.getCurrentSchematic?.(args),
    applySchematic: (args) => getDep('connectionGraphService')?.applySchematic?.(args),
  };

  const editor: IEditorProvider = {
    registerTextDocumentContentProvider: (scheme, provider) => {
      const normalizedScheme = normalizeTextDocumentProviderScheme(scheme);
      if (!normalizedScheme || !provider || typeof provider.provideTextDocumentContent !== 'function') {
        return { dispose() {} };
      }

      textDocumentContentProviders.set(normalizedScheme, provider);
      return {
        dispose() {
          if (textDocumentContentProviders.get(normalizedScheme) === provider) {
            textDocumentContentProviders.delete(normalizedScheme);
          }
        },
      };
    },
    showTextDocument: (targetPath, options) => {
      const projectPath = options?.projectPath?.trim()
        || getDep('projectService')?.currentProjectPath
        || getDep('projectService')?.projectRootPath;
      const uiService = getDep('uiService');
      if (!uiService?.openCodeEditorFile || !projectPath || !targetPath?.trim()) {
        return false;
      }

      return uiService.openCodeEditorFile(projectPath, targetPath, options?.selection);
    },
    readTextDocument: async (uri) => {
      const registeredProvider = resolveRegisteredTextDocumentContentProvider(textDocumentContentProviders, uri);
      if (registeredProvider) {
        const content = await Promise.resolve(registeredProvider.provideTextDocumentContent(uri));
        if (typeof content === 'string') {
          return content;
        }
      }

      const readTextDocument = getDep('uiService')?.readTextDocument
        ?? getDep('electronService')?.readTextDocument
        ?? (window as any)['editor']?.readTextDocument;
      if (typeof readTextDocument !== 'function') {
        return undefined;
      }

      return await Promise.resolve(readTextDocument(uri));
    },
    getWorkspaceXml: () => getDep('blocklyService')?.getWorkspaceXml?.(),
    loadWorkspace: (xml) => getDep('blocklyService')?.loadWorkspace?.(xml),
    getGeneratedCode: () => getDep('blocklyService')?.getGeneratedCode?.(),
    reloadAbiJson: () => getDep('blocklyService')?.reloadAbiJson?.(),
    getBlockDefinitions: () => getDep('blocklyService')?.getBlockDefinitions?.(),
    get connectionGraph() {
      return getDep('connectionGraphService') ? connectionGraph : undefined;
    },
  };

  // ----- mcp (可选) -----
  const mcp: IMcpProvider = {
    connect: (name, command, args) => getMcp()?.connect(name, command, args),
    getTools: (name) => getMcp()?.getTools(name),
    useTool: (toolName, args) => getMcp()?.useTool(toolName, args),
  };

  return {
    fs, path, terminal, dialog, platform,
    project, auth, config, builder, notification,
    env, shell,
    clipboard: {
      writeText: (text: string) => getClipboard()?.writeText(text),
      readText: () => getClipboard()?.readText?.() ?? '',
    },
    log, editor, mcp,
    // 宿主特有服务透传
    get blockly() { return getDep('blocklyService'); },
    get connectionGraph() { return getDep('connectionGraphService'); },
    get cmd() { return getDep('cmdService'); },
    get crossPlatformCmd() { return getDep('crossPlatformCmdService'); },
    get notice() { return getDep('noticeService'); },
    get electron() { return getDep('electronService'); },
    get absSync() { return getDep('absAutoSyncService'); },
    get arduinoLint() { return getDep('arduinoLintService'); },
    get ui() { return getDep('uiService'); },
    get onboarding() { return getDep('onboardingService'); },
  };
}

function readJsonFileSync(fsApi: any, filePath: string): Record<string, any> | null {
  if (!filePath || typeof fsApi?.readFileSync !== 'function') {
    return null;
  }

  const raw = fsApi.readFileSync(filePath, 'utf8');
  if (typeof raw !== 'string') {
    return null;
  }

  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function fsExistsSync(fsApi: any, filePath: string): boolean {
  if (!filePath) {
    return false;
  }

  if (typeof fsApi?.existsSync === 'function') {
    return fsApi.existsSync(filePath) === true;
  }

  return true;
}

function mergeHostConfig(
  defaultConfig: Record<string, any> | null,
  userConfig: Record<string, any> | null,
): Record<string, any> | null {
  if (!defaultConfig && !userConfig) {
    return null;
  }

  return {
    ...(defaultConfig ?? {}),
    ...(userConfig ?? {}),
    regions: {
      ...((defaultConfig?.['regions'] && typeof defaultConfig['regions'] === 'object') ? defaultConfig['regions'] : {}),
      ...((userConfig?.['regions'] && typeof userConfig['regions'] === 'object') ? userConfig['regions'] : {}),
    },
  };
}

function resolveHostConfigApiEndpoint(config: Record<string, any> | null): string | null {
  const regions = config?.['regions'];
  if (!regions || typeof regions !== 'object') {
    return null;
  }

  const buildFlavor = normalizeBuildFlavor(config?.['build_flavor']);
  const officialRegion = typeof config?.['official_region'] === 'string' && config['official_region'].trim()
    ? config['official_region'].trim()
    : buildFlavor === 'global' ? 'eu' : 'cn';
  const configuredRegion = typeof config?.['region'] === 'string' && config['region'].trim()
    ? config['region'].trim()
    : officialRegion;
  const currentRegion = shouldFallbackToOfficialRegion(configuredRegion, officialRegion, regions)
    ? officialRegion
    : configuredRegion;
  const regionConfig = regions[currentRegion] ?? regions[officialRegion] ?? regions['cn'] ?? regions['eu'];
  const apiServer = typeof regionConfig?.['api_server'] === 'string'
    ? regionConfig['api_server'].trim()
    : '';
  return apiServer || null;
}

function normalizeBuildFlavor(flavor: unknown): string {
  return flavor === 'global' ? 'global' : 'cn';
}

function isOfficialRegion(regionKey: string, regions: Record<string, any>): boolean {
  const regionConfig = regions?.[regionKey];
  if (!regionConfig) {
    return false;
  }

  if (typeof regionConfig['official'] === 'boolean') {
    return regionConfig['official'];
  }

  return regionKey === 'cn' || regionKey === 'eu';
}

function shouldFallbackToOfficialRegion(
  regionKey: string,
  officialRegion: string,
  regions: Record<string, any>,
): boolean {
  if (!regionKey || !officialRegion || !regions?.[regionKey]) {
    return false;
  }

  return isOfficialRegion(regionKey, regions) && regionKey !== officialRegion;
}

function normalizeTextDocumentProviderScheme(scheme: string): string {
  return typeof scheme === 'string' ? scheme.trim().toLowerCase() : '';
}

function getUriScheme(uri: string): string {
  const match = typeof uri === 'string'
    ? uri.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
    : null;
  return match?.[1]?.toLowerCase() ?? '';
}

function resolveRegisteredTextDocumentContentProvider(
  providers: ReadonlyMap<string, {
    provideTextDocumentContent(uri: string): Promise<string | undefined> | string | undefined;
  }>,
  uri: string,
): {
  provideTextDocumentContent(uri: string): Promise<string | undefined> | string | undefined;
} | undefined {
  const scheme = getUriScheme(uri);
  if (!scheme) {
    return undefined;
  }

  return providers.get(scheme);
}
