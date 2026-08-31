import { IMenuItem } from "./menu.config";

export interface AppItem extends IMenuItem {
  id: string;
  description?: string;
  enabled?: boolean;
  extension?: boolean;
  core?: string[];
  lock?: boolean;
  subapp?: {
    catalogId: string;
    packageName: string;
    availableVersion: string;
    installedVersion?: string | null;
    installed: boolean;
    updateAvailable: boolean;
    installPath?: string;
  };
}

export interface ChildToolAppConfig extends Partial<AppItem> {
  available?: boolean;
  defaultToolbar?: boolean;
}

export interface ChildToolUiSurfaceConfig {
  entry: string;
  minWidth?: number;
  minHeight?: number;
  preferredHeight?: number;
  interactive?: boolean;
}

export interface ChildToolUiConfig {
  surfaces: Record<string, ChildToolUiSurfaceConfig>;
}

export interface ChildToolRuntimeResourceLifecycleConfig {
  resources: string[];
  suspendMethod: string;
  resumeMethod: string;
  timeoutMs?: number;
}

export interface ChildToolRuntimeConfig {
  apiServer?: 'optional' | 'required';
  processMessagePort?: {
    transport: 'node-ipc-v1';
    maxMessageBytes?: number;
  };
  resourceLifecycle?: ChildToolRuntimeResourceLifecycleConfig;
}

export interface ChildToolAgentRpcConfig {
  method?: string;
  actionParam?: string;
  methods?: Record<string, string>;
}

export interface ChildToolAgentPresentationConfig {
  mode: 'embedded' | 'window' | 'dock';
  surface?: string;
  autoOpen?: 'never' | 'first-active' | 'always' | 'on-error';
  when?: {
    param: string;
    values: Array<string | number | boolean>;
  };
}

export interface ChildToolAgentLifecycleRequestConfig {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ChildToolAgentLifecycleConfig {
  sessionRelease?: ChildToolAgentLifecycleRequestConfig;
}

export interface ChildToolAgentDefinition {
  name: string;
  description: string;
  rpc: ChildToolAgentRpcConfig;
  presentation?: ChildToolAgentPresentationConfig;
  permission?: 'read' | 'change';
  requiresSession?: boolean;
  supportsCancellation?: boolean;
  timeoutMs?: number;
  maxTimeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  inputSchema: Record<string, unknown>;
}

export interface ChildToolAgentConfig {
  protocolVersion: number;
  transport: string;
  skills: string[];
  manifestPath: string;
  lifecycle?: ChildToolAgentLifecycleConfig;
  tools: ChildToolAgentDefinition[];
}

export interface ChildToolConfig {
  id: string;
  catalogId?: string;
  titleKey: string;
  namespace: string;
  version?: string;
  app?: ChildToolAppConfig;
  childDir?: string;
  packageName?: string;
  packagePath?: string;
  entry?: string;
  uiIndex?: string;
  routePath?: string;
  startupTimeoutMs?: number;
  runtime?: ChildToolRuntimeConfig;
  env?: Record<string, string>;
  ui?: ChildToolUiConfig;
  agent?: ChildToolAgentConfig;
}

export let CHILD_TOOL_CONFIGS: Record<string, ChildToolConfig> = {};
const CHILD_TOOL_CONFIG_CHANGE_LISTENERS = new Set<() => void>();

export function getChildToolConfigs(_forceReload = false): Record<string, ChildToolConfig> {
  // 子应用配置由 SubappManagerService 从远端目录和用户级 npm 安装状态注入。
  // 不再扫描随主程序分发的 child/tools，避免误启动开发期临时产物。
  return CHILD_TOOL_CONFIGS;
}

export function replaceChildToolConfigs(configs: ChildToolConfig[]): void {
  const previousSignature = JSON.stringify(CHILD_TOOL_CONFIGS);
  CHILD_TOOL_CONFIGS = configs.reduce((result, config) => {
    if (config?.id) result[config.id] = { ...config, app: config.app ? { ...config.app } : undefined };
    return result;
  }, {} as Record<string, ChildToolConfig>);
  if (JSON.stringify(CHILD_TOOL_CONFIGS) !== previousSignature) {
    for (const listener of CHILD_TOOL_CONFIG_CHANGE_LISTENERS) {
      try {
        listener();
      } catch (error) {
        console.warn('[ChildToolConfig] change listener failed', error);
      }
    }
  }
}

export function onChildToolConfigsChanged(listener: () => void): () => void {
  CHILD_TOOL_CONFIG_CHANGE_LISTENERS.add(listener);
  return () => CHILD_TOOL_CONFIG_CHANGE_LISTENERS.delete(listener);
}

export function getChildToolConfigLoadError(): Error | null {
  return null;
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
  }
];

// 所有可用的 App id。App Store 和 toolbar 只会使用这里列出的 App。
// 子应用（含 aily-simulator）由 SubappManagerService 从远端 subapp-index.json 注入，不在此硬编码。
export const AVAILABLE_APP_IDS: string[] = [
  'code-viewer',
  'serial-monitor',
  'cloud-space',
  'user-center',
];

// 软件初始状态 toolbar 显示的 App id。用户调整后会保存到本地配置。
export const DEFAULT_TOOLBAR_APP_IDS: string[] = [
  'code-viewer',
  'serial-monitor',
  'cloud-space',
  'user-center'
];
