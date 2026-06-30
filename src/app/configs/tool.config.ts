import { IMenuItem } from "./menu.config";

export interface AppItem extends IMenuItem {
  id: string;
  description?: string;
  enabled?: boolean;
  core?: string[];
  lock?: boolean;
}

export interface ChildToolAppConfig extends Partial<AppItem> {
  available?: boolean;
  defaultToolbar?: boolean;
}

export interface ChildToolConfig {
  id: string;
  titleKey: string;
  namespace: string;
  app?: ChildToolAppConfig;
  childDir?: string;
  entry?: string;
  uiIndex?: string;
  routePath?: string;
  startupTimeoutMs?: number;
  env?: Record<string, string>;
}

interface ChildToolI18nMeta {
  namespace: string;
  keys: Set<string>;
}

const CHILD_TOOL_ICON_BY_DIR: Record<string, string> = {
  'ble-debugger': 'fa-light fa-bluetooth',
  'ffs-manager': 'fa-light fa-database',
  'industrial-bus-debugger': 'fa-light fa-microchip',
  'mqtt-debugger': 'fa-light fa-tower-broadcast',
  'network-debugger': 'fa-light fa-network-wired',
  'serial-debugger': 'fa-light fa-monitor-waveform'
};

const CHILD_TOOL_ID_BY_DIR: Record<string, string> = {
  'ffs-manager': 'ffs-manager-child'
};

const CHILD_TOOL_STARTUP_TIMEOUT_MS_BY_DIR: Record<string, number> = {
  'ffs-manager': 10000
};

let childToolConfigsLoaded = false;
let childToolConfigLoadError: Error | null = null;

export let CHILD_TOOL_CONFIGS: Record<string, ChildToolConfig> = {};

export function getChildToolConfigs(forceReload = false): Record<string, ChildToolConfig> {
  if (!childToolConfigsLoaded || forceReload) {
    try {
      CHILD_TOOL_CONFIGS = loadChildToolConfigs();
      childToolConfigLoadError = null;
    } catch (error) {
      childToolConfigLoadError = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
      CHILD_TOOL_CONFIGS = {};
      console.error('[child-tools] Failed to scan child tools:', childToolConfigLoadError);
    }
    childToolConfigsLoaded = true;
  }

  return CHILD_TOOL_CONFIGS;
}

export function getChildToolConfigLoadError(): Error | null {
  return childToolConfigLoadError;
}

export function getChildToolConfig(toolId: string): ChildToolConfig | null {
  return getChildToolConfigs()[toolId] || null;
}

export function isChildTool(toolId: string): boolean {
  return !!getChildToolConfig(toolId);
}

export function getChildToolAppItems(): AppItem[] {
  return Object.values(getChildToolConfigs())
    .filter(config => config.app?.available !== false)
    .map(config => createChildToolAppItem(config));
}

export function getChildToolAvailableAppIds(): string[] {
  return getChildToolAppItems().map(app => app.id);
}

export function getChildToolDefaultToolbarAppIds(): string[] {
  return Object.values(getChildToolConfigs())
    .filter(config => config.app?.available !== false && config.app?.defaultToolbar === true)
    .map(config => config.app?.id || config.id);
}

function loadChildToolConfigs(): Record<string, ChildToolConfig> {
  const fsApi = typeof window !== 'undefined' ? window['fs'] : null;
  const pathApi = typeof window !== 'undefined' ? window['path'] : null;
  const childPath = pathApi?.getAilyChildPath?.();

  if (!childPath || !pathApi?.join || !fsApi?.existsSync || !fsApi?.readdirSync || !fsApi?.readFileSync) {
    return {};
  }

  const toolsPath = pathApi.join(childPath, 'tools');
  if (!fsApi.existsSync(toolsPath)) {
    throw new Error(`Child tools directory was not found: ${toolsPath}`);
  }

  const toolDirs = fsApi.readdirSync(toolsPath)
    .filter((name: unknown): name is string => typeof name === 'string' && !!name.trim())
    .filter((name: string) => isDirectory(fsApi, pathApi.join(toolsPath, name)))
    .sort((left: string, right: string) => left.localeCompare(right));

  return toolDirs.reduce((configs: Record<string, ChildToolConfig>, dirName: string) => {
    const config = createChildToolConfigFromDirectory(fsApi, pathApi, toolsPath, dirName);
    if (config) {
      configs[config.id] = config;
    }
    return configs;
  }, {});
}

function createChildToolConfigFromDirectory(
  fsApi: any,
  pathApi: any,
  toolsPath: string,
  dirName: string
): ChildToolConfig | null {
  const toolPath = pathApi.join(toolsPath, dirName);
  const packagePath = pathApi.join(toolPath, 'package.json');
  if (!fsApi.existsSync(packagePath)) {
    return null;
  }

  let packageJson: any = {};
  try {
    packageJson = JSON.parse(fsApi.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    console.warn(`[child-tools] Failed to read ${packagePath}:`, error);
    return null;
  }

  const entry = typeof packageJson?.main === 'string' && packageJson.main.trim()
    ? packageJson.main.trim()
    : 'index.js';
  const uiIndex = pathApi.join('ui', 'index.html');
  const scriptPath = pathApi.join(toolPath, entry);
  const uiPath = pathApi.join(toolPath, uiIndex);

  if (!fsApi.existsSync(scriptPath) || !fsApi.existsSync(uiPath)) {
    return null;
  }

  const i18nMeta = readChildToolI18nMeta(fsApi, pathApi, toolPath);
  const namespace = i18nMeta?.namespace || createNamespaceFromDirName(dirName);
  const titleKey = createChildToolTitleKey(namespace, i18nMeta);
  const descriptionKey = createChildToolDescriptionKey(namespace, i18nMeta);
  const id = CHILD_TOOL_ID_BY_DIR[dirName] || dirName;
  const startupTimeoutMs = CHILD_TOOL_STARTUP_TIMEOUT_MS_BY_DIR[dirName];

  return {
    id,
    titleKey,
    namespace,
    app: {
      name: titleKey,
      description: descriptionKey,
      icon: CHILD_TOOL_ICON_BY_DIR[dirName] || 'fa-light fa-puzzle-piece',
      enabled: true
    },
    childDir: pathApi.join('tools', dirName),
    entry,
    uiIndex,
    routePath: `/child-tool/${id}`,
    ...(startupTimeoutMs ? { startupTimeoutMs } : {})
  };
}

function readChildToolI18nMeta(fsApi: any, pathApi: any, toolPath: string): ChildToolI18nMeta | null {
  const i18nPath = pathApi.join(toolPath, 'i18n', 'en.json');
  if (!fsApi.existsSync(i18nPath)) {
    return null;
  }

  try {
    const data = JSON.parse(fsApi.readFileSync(i18nPath, 'utf8'));
    const namespace = Object.keys(data || {}).find(key => data[key] && typeof data[key] === 'object');
    if (!namespace) {
      return null;
    }

    return {
      namespace,
      keys: new Set(Object.keys(data[namespace] || {}))
    };
  } catch (error) {
    console.warn(`[child-tools] Failed to read i18n metadata from ${i18nPath}:`, error);
    return null;
  }
}

function createNamespaceFromDirName(dirName: string): string {
  return dirName.replace(/-/g, '_').toUpperCase();
}

function createChildToolTitleKey(namespace: string, i18nMeta: ChildToolI18nMeta | null): string {
  return i18nMeta?.keys.has('CHILD_TITLE') ? `${namespace}.CHILD_TITLE` : `${namespace}.TITLE`;
}

function createChildToolDescriptionKey(namespace: string, i18nMeta: ChildToolI18nMeta | null): string {
  return i18nMeta?.keys.has('CHILD_DESCRIPTION') ? `${namespace}.CHILD_DESCRIPTION` : `${namespace}.DESCRIPTION`;
}

function isDirectory(fsApi: any, path: string): boolean {
  try {
    if (typeof fsApi.isDirectory === 'function') {
      return !!fsApi.isDirectory(path);
    }

    const stat = fsApi.statSync?.(path);
    if (stat && typeof stat.isDirectory === 'function') {
      return stat.isDirectory();
    }
    return !!stat?._isDirectory;
  } catch {
    return false;
  }
}

function createChildToolAppItem(config: ChildToolConfig): AppItem {
  const app = config.app || {};
  const appId = app.id || config.id;

  return {
    ...app,
    id: appId,
    name: app.name || config.titleKey,
    description: app.description || `${config.namespace}.DESCRIPTION`,
    action: app.action || 'tool-open',
    data: app.data || { type: 'tool', data: config.id },
    icon: app.icon || 'fa-light fa-puzzle-piece',
    enabled: app.enabled !== false
  };
}

// 默认的 App 注册表，展示位置由 AppStoreService 管理
export const APP_LIST: AppItem[] = [
  {
    id: 'code-viewer',
    name: 'MENU.CODE',
    description: 'APP_STORE.CODE_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'code-viewer' },
    icon: 'fa-light fa-rectangle-code',
    router: ['/main/blockly-editor'],
    enabled: true
  },
  {
    id: 'lib-manager',
    name: 'MENU.LIB_MANAGER',
    description: 'APP_STORE.LIB_MANAGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'lib-manager' },
    icon: 'fa-light fa-books',
    router: ['/main/code-editor', '/main/code-editor-pro'],
    enabled: true
  },
  {
    id: 'serial-monitor',
    name: 'MENU.TOOL_SERIAL',
    description: 'APP_STORE.SERIAL_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'serial-monitor' },
    icon: 'fa-light fa-monitor-waveform',
    enabled: true,
    lock: true
  },
  {
    id: 'ffs-manager',
    name: 'MENU.FFS_MANAGER',
    description: 'APP_STORE.FFS_MANAGER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'ffs-manager' },
    icon: 'fa-light fa-database',
    enabled: true
  },
  {
    id: 'aily-chat',
    name: 'MENU.AI',
    description: 'APP_STORE.AI_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'aily-chat' },
    icon: 'fa-light fa-star-christmas',
    more: 'AI',
    enabled: true,
    lock: true
  },
  {
    id: 'model-store',
    name: 'MENU.MODEL_STORE',
    description: 'APP_STORE.MODEL_STORE_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'model-store' },
    icon: 'fa-light fa-microchip-ai',
    enabled: true
  },
  {
    id: 'cloud-space',
    name: 'MENU.USER_SPACE',
    description: 'APP_STORE.CLOUD_SPACE_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'cloud-space' },
    icon: 'fa-light fa-album-collection',
    enabled: true
  },
  {
    id: 'user-center',
    name: 'MENU.USER_AUTH',
    description: 'APP_STORE.USER_CENTER_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'user-center' },
    icon: 'fa-light fa-user',
    enabled: true,
    lock: true
  },
  {
    id: 'simulator',
    name: 'MENU.SIMULATOR',
    description: 'APP_STORE.SIMULATOR_DESC',
    action: 'tool-open',
    data: { type: 'tool', data: 'simulator' },
    icon: 'fa-light fa-atom',
    router: ['/main/blockly-editor'],
    dev: true,
    enabled: false
  }
];

// 所有可用的 App id。App Store 和 toolbar 只会使用这里列出的 App。
export const AVAILABLE_APP_IDS: string[] = [
  'code-viewer',
  'serial-monitor',
  'ffs-manager',
  'aily-chat',
  'model-store',
  'cloud-space',
  'user-center',
];

// 软件初始状态 toolbar 显示的 App id。用户调整后会保存到本地配置。
export const DEFAULT_TOOLBAR_APP_IDS: string[] = [
  'code-viewer',
  'serial-monitor',
  'aily-chat',
  'cloud-space',
  'user-center'
];
