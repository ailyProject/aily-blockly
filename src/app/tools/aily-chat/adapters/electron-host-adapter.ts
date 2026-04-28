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
  fetchToolService?: any;
  webSearchToolService?: any;
  electronService?: any;
  uiService?: any;
  onboardingService?: any;
}

/**
 * 创建基于 Electron window[] API 的 IAilyHostAPI 实现。
 */
export function createElectronHostAdapter(deps: ElectronAdapterDeps): IAilyHostAPI {
  // 缓存 window 引用，避免每次访问都查找
  const wFs = (window as any)['fs'];
  const wPath = (window as any)['path'];
  const wTerminal = (window as any)['terminal'];
  const wCmd = (window as any)['cmd'];
  const wDialog = (window as any)['dialog'];
  const wPlatform = (window as any)['platform'];
  const wOther = (window as any)['other'];
  const wEnv = (window as any)['env'];
  const wMcp = (window as any)['mcp'];
  const wOs = (window as any)['os'];

  // ----- fs -----
  const fs: IFileSystem = {
    readFileSync: (path, encoding?) => wFs.readFileSync(path, encoding ?? 'utf8'),
    readFileAsBase64: (path) => wFs.readFileAsBase64?.(path),
    writeFileSync: (path, data) => wFs.writeFileSync(path, data),
    appendFileSync: (path, data) => wFs.appendFileSync?.(path, data),
    existsSync: (path) => wFs.existsSync(path),
    mkdirSync: (path, options?) => wFs.mkdirSync(path, options),
    unlinkSync: (path) => wFs.unlinkSync(path),
    rmdirSync: (path, options?) => wFs.rmdirSync(path, options),
    renameSync: (oldPath, newPath) => wFs.renameSync?.(oldPath, newPath),
    copySync: (src, dest) => wFs.copySync?.(src, dest),
    statSync: (path) => {
      const raw = wFs.statSync(path);
      return {
        size: raw.size,
        mtime: new Date(raw.mtime),
        birthtime: raw.birthtime ? new Date(raw.birthtime) : undefined,
        isDirectory: () => raw._isDirectory,
        isFile: () => raw._isFile,
      };
    },
    isDirectory: (path) => wFs.isDirectory(path),
    readdirSync: (path) => wFs.readdirSync(path),
    readDirSync: (path) => {
      const entries = wFs.readDirSync?.(path);
      if (!entries) return undefined;
      return entries.map((e: any) => ({
        name: e.name,
        isDirectory: () => e._isDirectory,
        isFile: () => e._isFile,
      }));
    },
    realpathSync: (path) => wFs.realpathSync?.(path),
    // ---- 异步方法（IPC 到主进程） ----
    readFile: (path, encoding?) => wFs.readFile(path, encoding ?? 'utf8'),
    writeFile: (path, data, encoding?) => wFs.writeFile(path, data, encoding),
    exists: (path) => wFs.exists(path),
    stat: async (path) => {
      const raw = await wFs.stat(path);
      return {
        size: raw.size,
        mtime: new Date(raw.mtime),
        birthtime: raw.birthtime ? new Date(raw.birthtime) : undefined,
        isDirectory: () => raw._isDirectory,
        isFile: () => raw._isFile,
      };
    },
    readdir: (path) => wFs.readdir(path),
    readDir: async (path) => {
      const entries = await wFs.readDir(path);
      return entries.map((e: any) => ({
        name: e.name,
        isDirectory: () => e._isDirectory,
        isFile: () => e._isFile,
      }));
    },
    mkdir: (path, options?) => wFs.mkdir(path, options),
    unlink: (path) => wFs.unlink(path),
  };

  // ----- path -----
  const path: IPathUtils = {
    join: (...paths) => wPath.join(...paths),
    resolve: (...paths) => wPath.resolve(...paths),
    dirname: (p) => wPath.dirname(p),
    basename: (p, ext?) => wPath.basename(p, ext),
    extname: (p) => wPath.extname(p),
    relative: (from, to) => wPath.relative(from, to),
    isAbsolute: (p) => wPath.isAbsolute(p),
    normalize: (p) => wPath.normalize?.(p),
    getAppDataPath: () => wPath.getAppDataPath(),
    getUserDocuments: () => wPath.getUserDocuments(),
    getUserHome: () => wPath.getUserHome(),
    getAilyBuilderPath: () => wPath.getAilyBuilderPath?.(),
    getAilyBuilderBuildPath: () => wPath.getAilyBuilderBuildPath?.(),
    getAilyChildPath: () => wPath.getAilyChildPath?.(),
    getElectronPath: () => wPath.getElectronPath?.(),
    isExists: (p) => wPath.isExists?.(p),
    isDir: (p) => wPath.isDir?.(p),
  };

  // ----- terminal (合并 window['terminal'] + window['cmd']) -----
  const terminal: ITerminal = {
    getShell: () => wTerminal?.getShell(),
    init: (data) => wTerminal?.init(data),
    sendInput: (data) => wTerminal?.sendInput(data),
    sendInputAsync: (data) => wTerminal?.sendInputAsync(data),
    close: (data) => wTerminal?.close(data),
    resize: (data) => wTerminal?.resize(data),
    interrupt: (pid) => wTerminal?.interrupt(pid),
    killProcess: (pid, name) => wTerminal?.killProcess(pid, name),
    startStream: (pid) => wTerminal?.startStream(pid),
    stopStream: (pid, sid) => wTerminal?.stopStream(pid, sid),
    onStreamData: (sid, cb) => wTerminal?.onStreamData(sid, cb),
    executeWithStream: (pid, cmd) => wTerminal?.executeWithStream(pid, cmd),
    // window['cmd'] 映射
    run: (options) => wCmd?.run(options),
    kill: (streamId) => wCmd?.kill(streamId),
    killByName: (name) => wCmd?.killByName(name),
    input: (streamId, input) => wCmd?.input(streamId, input),
    onData: (streamId, cb) => wCmd?.onData(streamId, cb),
    execBackground: (command, options?) => wCmd?.execBackground(command, options),
    killBackgroundProcess: (pid) => wCmd?.killBackgroundProcess(pid),
  };

  // ----- dialog -----
  const dialog: IDialog = {
    selectFiles: (options?) => wDialog?.selectFiles(options),
  };

  // ----- platform -----
  const platform: IPlatform = {
    type: wPlatform?.type ?? 'linux',
    pathSeparator: wPlatform?.pt ?? '/',
    isWindows: wPlatform?.isWindows ?? false,
    isMacOS: wPlatform?.isMacOS ?? false,
    isLinux: wPlatform?.isLinux ?? true,
    lang: wPlatform?.lang ?? 'zh-CN',
    za7: wPlatform?.isWindows ? '7za.exe' : '7zz',
    homedir: () => wOs?.homedir?.() ?? wPath?.getUserHome?.() ?? '',
    tmpdir: () => wOs?.tmpdir?.() ?? '',
  };

  // ----- project (直接透传 Angular 服务，保留完整 API 供 handler 使用) -----
  const project: IProjectProvider = deps.projectService ?? {} as IProjectProvider;

  // ----- auth -----
  // ----- auth (映射 getToken2 → getToken) -----
  const auth: IAuthProvider = {
    get isLoggedIn() { return deps.authService?.isLoggedIn ?? false; },
    get token() { return deps.authService?.token ?? ''; },
    get userInfo() { return deps.authService?.userInfo; },
    getAuthHeaders: () => deps.authService?.getAuthHeaders?.() ?? {},
    getToken: () => deps.authService?.getToken2?.() ?? Promise.resolve(''),
    promptLogin: () => deps.authService?.promptLogin?.() ?? Promise.resolve(false),
  };

  // ----- config (透传 data/save) -----
  const config: IConfigProvider = {
    get apiEndpoint() {
      // wEnv.get() returns a Promise (IPC), cannot use directly in sync getter.
      // Use configService's synchronous API, fall back to process.env, then default.
      return deps.configService?.getCurrentApiServer?.()
        || (typeof process !== 'undefined' ? process.env?.['AILY_API_SERVER'] : undefined)
        || 'https://api.aily.pro';
    },
    get locale() { return deps.configService?.data?.lang ?? 'zh-CN'; },
    get: (key: string) => deps.configService?.data?.[key],
    set: (key: string, value: any) => { if (deps.configService?.data) deps.configService.data[key] = value; },
    get data() { return deps.configService?.data; },
    save: () => deps.configService?.save?.(),
    getBoardsList: () => deps.configService?.getBoardsList?.(),
    getLibrariesList: () => deps.configService?.getLibrariesList?.(),
    getHardwareCategories: () => deps.configService?.getHardwareCategories?.(),
    loadHardwareIndexForAI: () => deps.configService?.loadHardwareIndexForAI?.(),
    get boardIndex() { return (deps.configService as any)?.boardIndex; },
    get boardList() { return (deps.configService as any)?.boardList; },
    get boardDict() { return (deps.configService as any)?.boardDict; },
    get libraryIndex() { return (deps.configService as any)?.libraryIndex; },
    get libraryList() { return (deps.configService as any)?.libraryList; },
    get libraryDict() { return (deps.configService as any)?.libraryDict; },
  };

  // ----- builder -----
  const builder: IBuildProvider = deps.builderService ?? {} as IBuildProvider;

  // ----- notification -----
  const notification: INotificationProvider = {
    success: (msg) => deps.noticeService?.success?.(msg),
    error: (msg) => deps.noticeService?.error?.(msg),
    warning: (msg) => deps.noticeService?.warning?.(msg),
    info: (msg) => deps.noticeService?.info?.(msg),
  };

  // ----- env -----
  const env: IEnvProvider = {
    get: (key) => wEnv?.get(key),
    set: (data) => wEnv?.set(data),
  };

  // ----- shell -----
  const shell: IShellUtils = {
    openByExplorer: (p) => wOther?.openByExplorer(p),
    openByBrowser: (url) => wOther?.openByBrowser(url),
    moveToTrash: (filePath) => wOther?.moveToTrash(filePath),
  };

  // ----- editor (可选) -----
  let editor: IEditorProvider | undefined;
  if (deps.blocklyService) {
    editor = {
      getWorkspaceXml: () => deps.blocklyService?.getWorkspaceXml?.(),
      loadWorkspace: (xml) => deps.blocklyService?.loadWorkspace?.(xml),
      getGeneratedCode: () => deps.blocklyService?.getGeneratedCode?.(),
      reloadAbiJson: () => deps.blocklyService?.reloadAbiJson?.(),
      getBlockDefinitions: () => deps.blocklyService?.getBlockDefinitions?.(),
      connectionGraph: deps.connectionGraphService ? {
        generateConnectionGraph: (args) => deps.connectionGraphService?.generateConnectionGraph?.(args),
        getPinmapSummary: (args) => deps.connectionGraphService?.getPinmapSummary?.(args),
        validateConnectionGraph: (args) => deps.connectionGraphService?.validateConnectionGraph?.(args),
        getSensorPinmapCatalog: (args) => deps.connectionGraphService?.getSensorPinmapCatalog?.(args),
        generatePinmap: (args) => deps.connectionGraphService?.generatePinmap?.(args),
        savePinmap: (args) => deps.connectionGraphService?.savePinmap?.(args),
        getCurrentSchematic: (args) => deps.connectionGraphService?.getCurrentSchematic?.(args),
        applySchematic: (args) => deps.connectionGraphService?.applySchematic?.(args),
      } : undefined,
    };
  }

  // ----- mcp (可选) -----
  const mcp: IMcpProvider | undefined = wMcp ? {
    connect: (name, command, args) => wMcp.connect(name, command, args),
    getTools: (name) => wMcp.getTools(name),
    useTool: (toolName, args) => wMcp.useTool(toolName, args),
  } : undefined;

  return {
    fs, path, terminal, dialog, platform,
    project, auth, config, builder, notification,
    env, shell, editor, mcp,
    // 宿主特有服务透传
    blockly: deps.blocklyService,
    connectionGraph: deps.connectionGraphService,
    cmd: deps.cmdService,
    crossPlatformCmd: deps.crossPlatformCmdService,
    notice: deps.noticeService,
    electron: deps.electronService,
    absSync: deps.absAutoSyncService,
    fetch: deps.fetchToolService,
    webSearch: deps.webSearchToolService,
    ui: deps.uiService,
    authFull: deps.authService,
    onboarding: deps.onboardingService,
  };
}
