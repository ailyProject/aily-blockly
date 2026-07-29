import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';

import { getChildToolConfig, getChildToolConfigs, type ChildToolConfig } from '../configs/tool.config';
import { ChildAppHostRegistryService, type ChildAppHostAction } from './child-app-host-registry.service';
import { UiAutomationRegistryService } from './ui-automation-registry.service';
import { UiService } from './ui.service';

export type ChildAppOpenMode = 'embedded' | 'window';
export type ChildAppControlAction =
  | 'restart'
  | 'maximize'
  | 'unmaximize'
  | 'minimize'
  | 'restore'
  | 'focus'
  | 'detach'
  | 'embed'
  | 'close';

export type ChildAppWindowLayout =
  | 'auto'
  | 'cascade'
  | 'grid'
  | 'horizontal'
  | 'vertical'
  | 'rows'
  | 'columns'
  | 'main_stack';

interface ChildToolSessionState {
  toolId?: string;
  refCount?: number;
  running?: boolean;
  pid?: number;
  durationMs?: number;
  hostInfo?: {
    url?: string;
    port?: number;
    pid?: number;
  } | null;
}

interface ChildAppWindowState {
  open?: boolean;
  visible?: boolean;
  focused?: boolean;
  minimized?: boolean;
  maximized?: boolean;
  fullScreen?: boolean;
  bounds?: Record<string, number> | null;
  display?: Record<string, unknown> | null;
}

interface ChildAppWindowEnvironment {
  success?: boolean;
  mainWindow?: ChildAppWindowState | null;
  displays?: Array<Record<string, unknown>>;
  windows?: Array<ChildAppWindowState & { path?: string }>;
}

@Injectable({ providedIn: 'root' })
export class MainUiAutomationService {
  constructor(
    private readonly menuRegistry: UiAutomationRegistryService,
    private readonly childHostRegistry: ChildAppHostRegistryService,
    private readonly uiService: UiService,
    private readonly translate: TranslateService,
  ) {
    this.childHostRegistry.ensureInitialized();
  }

  listMainMenu(params: Record<string, unknown> = {}): Record<string, unknown> {
    return this.menuRegistry.listMenu('header', {
      includeHidden: params['includeHidden'] === true,
    });
  }

  async executeMainMenu(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const itemId = this.stringParam(params, 'itemId');
    if (!itemId) {
      return { ok: false, message: '缺少菜单项 itemId；请先调用 main_menu_list 获取可执行 ID。' };
    }
    return this.menuRegistry.executeMenu('header', itemId, { confirm: params['confirm'] === true });
  }

  async listChildApps(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const query = this.stringParam(params, 'query').toLowerCase();
    const includeUnavailable = params['includeUnavailable'] === true;
    const limit = this.integerParam(params, 'limit', 50, 1, 100);
    const offset = this.integerParam(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const configs = Object.values(getChildToolConfigs());
    const sessions = await this.readChildToolSessions();

    const allItems = (await Promise.all(configs.map(config => this.describeChildApp(config, sessions))))
      .filter(item => item['enabled'] !== false)
      .filter(item => includeUnavailable || item['available'] !== false)
      .filter(item => {
        if (!query) return true;
        return [item['id'], item['title'], item['description']]
          .some(value => String(value || '').toLowerCase().includes(query));
      });
    const items = allItems.slice(offset, offset + limit);
    const hasMore = offset + items.length < allItems.length;

    return {
      ok: true,
      total: allItems.length,
      total_count: allItems.length,
      count: items.length,
      offset,
      limit,
      hasMore,
      has_more: hasMore,
      ...(hasMore ? { nextOffset: offset + items.length, next_offset: offset + items.length } : {}),
      items,
    };
  }

  async getChildApp(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const toolId = this.stringParam(params, 'toolId');
    const config = getChildToolConfig(toolId);
    if (!toolId || !config) {
      return {
        ok: false,
        message: toolId
          ? `未找到子应用: ${toolId}。请先调用 child_app_list 获取有效 ID。`
          : '缺少子应用 toolId。请先调用 child_app_list 获取有效 ID。',
      };
    }
    return { ok: true, app: await this.describeChildApp(config, await this.readChildToolSessions()) };
  }

  async openChildApp(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const toolId = this.stringParam(params, 'toolId');
    const mode = (this.stringParam(params, 'mode') || 'embedded') as ChildAppOpenMode;
    const config = getChildToolConfig(toolId);
    if (!toolId || !config) {
      return { ok: false, message: `未找到子应用: ${toolId || '(空)'}` };
    }
    if (mode !== 'embedded' && mode !== 'window') {
      return { ok: false, message: `不支持的打开模式: ${mode}；可用 embedded 或 window。` };
    }

    const hasPlacement = ['x', 'y', 'width', 'height', 'displayId'].some(key => params[key] !== undefined);
    const placement = {
      ...(this.optionalNumber(params, 'x') !== undefined ? { x: this.optionalNumber(params, 'x') } : {}),
      ...(this.optionalNumber(params, 'y') !== undefined ? { y: this.optionalNumber(params, 'y') } : {}),
      ...(this.optionalNumber(params, 'width') !== undefined ? { width: this.optionalNumber(params, 'width') } : {}),
      ...(this.optionalNumber(params, 'height') !== undefined ? { height: this.optionalNumber(params, 'height') } : {}),
      ...(params['displayId'] !== undefined ? { displayId: params['displayId'] as string | number } : {}),
      relativeToDisplay: params['relativeToDisplay'] !== false,
      clampToWorkArea: params['clampToWorkArea'] !== false,
      applyInitialBounds: hasPlacement,
    };
    if (mode === 'embedded' && hasPlacement) {
      return { ok: false, message: '位置和尺寸参数只适用于 mode="window" 的独立子应用窗口。' };
    }
    if (mode === 'window' && params['displayId'] !== undefined) {
      const environment = await this.readWindowEnvironment();
      const displayExists = (environment.displays || [])
        .some(display => String(display['id']) === String(params['displayId']));
      if (!displayExists) {
        return {
          ok: false,
          message: `未找到显示器: ${String(params['displayId'])}；请先调用 child_app_window_list 获取实时显示器 ID。`,
          displays: environment.displays || [],
        };
      }
    }

    const routePath = this.routePath(config);
    const windowState = await this.readWindowState(routePath);
    if (mode === 'embedded') {
      if (windowState.open) {
        const moved = await this.sendHostCommand(routePath, toolId, 'embed');
        if (moved['ok'] !== true) return moved;
      }
      const visible = this.uiService.openToolEmbedded(toolId);
      if (!visible) {
        return {
          ok: false,
          operation: 'child_app_open',
          toolId,
          requestedMode: mode,
          message: `子应用未进入内嵌可见状态: ${toolId}`,
        };
      }
    } else if (this.uiService.openToolList.includes(toolId)) {
      const detached = await this.childHostRegistry.control(toolId, 'detach', placement);
      if (detached['ok'] !== true) return detached;
    } else {
      this.uiService.openToolWindow(toolId, { title: this.titleOf(config), ...placement });
    }

    return {
      ok: true,
      operation: 'child_app_open',
      toolId,
      requestedMode: mode,
      visible: mode === 'embedded' ? this.uiService.topTool === toolId : true,
      ...(mode === 'embedded' ? { topTool: this.uiService.topTool } : {}),
      ...(mode === 'window' ? { initialPlacement: placement } : {}),
      message: mode === 'embedded' ? `已打开内嵌子应用: ${toolId}` : `已打开独立子应用窗口: ${toolId}`,
    };
  }

  async controlChildApp(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const toolId = this.stringParam(params, 'toolId');
    const action = this.stringParam(params, 'action') as ChildAppControlAction;
    const config = getChildToolConfig(toolId);
    if (!toolId || !config) {
      return { ok: false, message: `未找到子应用: ${toolId || '(空)'}` };
    }

    const supported: ChildAppControlAction[] = [
      'restart', 'maximize', 'unmaximize', 'minimize', 'restore', 'focus', 'detach', 'embed', 'close',
    ];
    if (!supported.includes(action)) {
      return { ok: false, message: `不支持的子应用动作: ${action || '(空)'}`, supportedActions: supported };
    }

    const routePath = this.routePath(config);
    const embedded = this.uiService.openToolList.includes(toolId);
    const windowState = await this.readWindowState(routePath);

    if (action === 'detach') {
      if (embedded) return this.childHostRegistry.control(toolId, 'detach');
      if (windowState.open) return this.controlWindow(routePath, 'focus', toolId);
      return this.openChildApp({ toolId, mode: 'window' });
    }

    if (action === 'embed') {
      if (windowState.open) return this.sendHostCommand(routePath, toolId, 'embed');
      if (embedded) return { ok: true, toolId, action, message: '子应用已经处于内嵌模式。' };
      return this.openChildApp({ toolId, mode: 'embedded' });
    }

    if (action === 'restart' || action === 'close') {
      const hostAction = action as ChildAppHostAction;
      if (embedded && this.childHostRegistry.has(toolId)) {
        return this.childHostRegistry.control(toolId, hostAction);
      }
      if (windowState.open) {
        return this.sendHostCommand(routePath, toolId, hostAction);
      }
      return {
        ok: false,
        message: `子应用 ${toolId} 当前没有打开的界面；请先 child_app_open。`,
      };
    }

    if (!windowState.open) {
      return {
        ok: false,
        message: `动作 ${action} 只适用于独立子应用窗口；请先执行 detach 或以 mode="window" 打开。`,
      };
    }
    return this.controlWindow(routePath, action, toolId);
  }

  async listChildAppWindows(): Promise<Record<string, unknown>> {
    const environment = await this.readWindowEnvironment();
    const configs = Object.values(getChildToolConfigs());
    const configByPath = new Map(configs.map(config => [this.routePath(config), config]));
    const windows = (environment.windows || []).flatMap(windowState => {
      const config = configByPath.get(String(windowState.path || ''));
      return config ? [{
        toolId: config.id,
        title: this.titleOf(config),
        path: this.routePath(config),
        ...windowState,
      }] : [];
    });
    return {
      ok: environment.success !== false,
      displayCount: environment.displays?.length || 0,
      windowCount: windows.length,
      mainWindow: environment.mainWindow || null,
      displays: environment.displays || [],
      windows,
      layouts: ['auto', 'cascade', 'grid', 'horizontal', 'vertical', 'rows', 'columns', 'main_stack'],
    };
  }

  async setChildAppWindowBounds(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const toolId = this.stringParam(params, 'toolId');
    const config = getChildToolConfig(toolId);
    if (!toolId || !config) {
      return { ok: false, message: `未找到子应用: ${toolId || '(空)'}；请先调用 child_app_window_list。` };
    }
    const routePath = this.routePath(config);
    const windowState = await this.readWindowState(routePath);
    if (!windowState.open) {
      return { ok: false, message: `子应用 ${toolId} 没有独立窗口；请先用 child_app_open(mode="window") 或 detach。` };
    }

    try {
      const result = await (window as any)['subWindow']?.setBounds?.(routePath, {
        bounds: {
          ...(this.optionalNumber(params, 'x') !== undefined ? { x: this.optionalNumber(params, 'x') } : {}),
          ...(this.optionalNumber(params, 'y') !== undefined ? { y: this.optionalNumber(params, 'y') } : {}),
          ...(this.optionalNumber(params, 'width') !== undefined ? { width: this.optionalNumber(params, 'width') } : {}),
          ...(this.optionalNumber(params, 'height') !== undefined ? { height: this.optionalNumber(params, 'height') } : {}),
        },
        ...(params['displayId'] !== undefined ? { displayId: params['displayId'] } : {}),
        relativeToDisplay: params['relativeToDisplay'] !== false,
        clampToWorkArea: params['clampToWorkArea'] !== false,
        focus: params['focus'] === true,
      });
      return result?.success
        ? { ok: true, toolId, operation: 'child_app_window_set_bounds', window: result.state, requested: result.requested }
        : {
            ok: false,
            toolId,
            message: result?.error || '设置子窗口位置或尺寸失败。',
            ...(result?.availableDisplays ? { availableDisplays: result.availableDisplays } : {}),
          };
    } catch (error) {
      return { ok: false, toolId, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async arrangeChildAppWindows(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const configById = new Map(Object.values(getChildToolConfigs()).map(config => [config.id, config]));
    const requestedToolIds = Array.isArray(params['toolIds'])
      ? [...new Set(params['toolIds'].map(value => String(value || '').trim()).filter(Boolean))]
      : [];
    const invalidToolIds = requestedToolIds.filter(toolId => !configById.has(toolId));
    if (invalidToolIds.length > 0) {
      return {
        ok: false,
        message: `存在无效子应用 ID: ${invalidToolIds.join(', ')}；请先调用 child_app_window_list。`,
        invalidToolIds,
      };
    }

    const environment = await this.readWindowEnvironment();
    const openPaths = new Set((environment.windows || []).map(item => String(item.path || '')));
    const toolIds = requestedToolIds.length > 0
      ? requestedToolIds
      : [...configById.values()].filter(config => openPaths.has(this.routePath(config))).map(config => config.id);
    if (toolIds.length === 0) {
      return { ok: false, message: '当前没有独立子应用窗口；请先以 window 模式打开或 detach。' };
    }
    const closedToolIds = toolIds.filter(toolId => !openPaths.has(this.routePath(configById.get(toolId)!)));
    if (closedToolIds.length > 0) {
      return {
        ok: false,
        message: `以下子应用没有独立窗口: ${closedToolIds.join(', ')}；请先打开或 detach。`,
        closedToolIds,
      };
    }

    const layout = (this.stringParam(params, 'layout') || 'auto') as ChildAppWindowLayout;
    try {
      const result = await (window as any)['subWindow']?.arrange?.({
        paths: toolIds.map(toolId => this.routePath(configById.get(toolId)!)),
        layout,
        displayMode: this.stringParam(params, 'displayMode') || 'current',
        ...(Array.isArray(params['displayIds']) ? { displayIds: params['displayIds'] } : {}),
        ...(this.optionalNumber(params, 'gap') !== undefined ? { gap: this.optionalNumber(params, 'gap') } : {}),
        ...(this.optionalNumber(params, 'cascadeOffset') !== undefined
          ? { cascadeOffset: this.optionalNumber(params, 'cascadeOffset') }
          : {}),
        ...(this.optionalNumber(params, 'rows') !== undefined ? { rows: this.optionalNumber(params, 'rows') } : {}),
        ...(this.optionalNumber(params, 'columns') !== undefined ? { columns: this.optionalNumber(params, 'columns') } : {}),
        ...(this.optionalNumber(params, 'mainRatio') !== undefined ? { mainRatio: this.optionalNumber(params, 'mainRatio') } : {}),
        focus: params['focus'] !== false,
      });
      if (!result?.success) {
        return {
          ok: false,
          message: result?.message || result?.error || '排列子窗口失败。',
          ...(result?.availableDisplays ? { availableDisplays: result.availableDisplays } : {}),
        };
      }
      const toolIdByPath = new Map(toolIds.map(toolId => [this.routePath(configById.get(toolId)!), toolId]));
      return {
        ok: true,
        operation: 'child_app_window_arrange',
        requestedLayout: result.requestedLayout,
        displayMode: result.displayMode,
        displays: result.displays,
        windows: Array.isArray(result.windows)
          ? result.windows.map((item: Record<string, unknown>) => ({
              toolId: toolIdByPath.get(String(item['path'] || '')) || null,
              ...item,
            }))
          : [],
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async describeChildApp(
    config: ChildToolConfig,
    sessions: readonly ChildToolSessionState[],
  ): Promise<Record<string, unknown>> {
    const routePath = this.routePath(config);
    const windowState = await this.readWindowState(routePath);
    const embedded = this.uiService.openToolList.includes(config.id);
    const session = sessions.find(candidate => candidate.toolId === config.id);
    let hostStatus = embedded ? this.childHostRegistry.getStatus(config.id) : null;
    if (!hostStatus && windowState.open) {
      const statusResult = await this.sendHostCommand(routePath, config.id, 'status');
      hostStatus = statusResult['ok'] === true ? statusResult : null;
    }
    const mode = embedded && windowState.open
      ? 'embedded_and_window'
      : embedded
        ? 'embedded'
        : windowState.open
          ? 'window'
          : session?.running
            ? 'background'
            : 'closed';

    return {
      id: config.id,
      title: this.titleOf(config),
      titleKey: config.titleKey,
      description: this.descriptionOf(config),
      icon: config.app?.icon || 'fa-light fa-puzzle-piece',
      version: config.version || null,
      available: config.app?.available !== false,
      enabled: config.app?.enabled !== false,
      routePath,
      mode,
      ui: {
        embedded,
        active: embedded && this.uiService.topTool === config.id,
        window: windowState,
        host: hostStatus,
      },
      runtime: {
        running: session?.running === true,
        pid: session?.pid ?? session?.hostInfo?.pid ?? null,
        port: session?.hostInfo?.port ?? null,
        refCount: session?.refCount ?? 0,
        durationMs: session?.durationMs ?? 0,
        url: this.sanitizeLocalUrl(session?.hostInfo?.url),
      },
      supportedActions: [
        'open_embedded', 'open_window', 'restart', 'detach', 'embed', 'focus',
        'maximize', 'unmaximize', 'minimize', 'restore', 'move', 'resize', 'close',
      ],
    };
  }

  private async readChildToolSessions(): Promise<ChildToolSessionState[]> {
    try {
      const sessions = await (window as any)['childToolSession']?.list?.();
      return Array.isArray(sessions) ? sessions as ChildToolSessionState[] : [];
    } catch {
      return [];
    }
  }

  private async readWindowState(routePath: string): Promise<ChildAppWindowState> {
    try {
      const state = await (window as any)['subWindow']?.getState?.(routePath);
      return state && typeof state === 'object' ? state as ChildAppWindowState : { open: false };
    } catch {
      return { open: false };
    }
  }

  private async readWindowEnvironment(): Promise<ChildAppWindowEnvironment> {
    try {
      const state = await (window as any)['subWindow']?.list?.();
      return state && typeof state === 'object'
        ? state as ChildAppWindowEnvironment
        : { success: false, displays: [], windows: [] };
    } catch {
      return { success: false, displays: [], windows: [] };
    }
  }

  private async controlWindow(
    routePath: string,
    action: Exclude<ChildAppControlAction, 'restart' | 'detach' | 'embed'>,
    toolId: string,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await (window as any)['subWindow']?.control?.(routePath, action);
      if (result?.success) {
        return { ok: true, toolId, action, window: result.state || null };
      }
      return { ok: false, message: result?.error || `独立窗口动作失败: ${action}`, toolId, action };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), toolId, action };
    }
  }

  private async sendHostCommand(
    routePath: string,
    toolId: string,
    action: ChildAppHostAction,
  ): Promise<Record<string, unknown>> {
    try {
      const result = await (window as any)['subWindow']?.command?.(routePath, { toolId, action });
      return result && typeof result === 'object'
        ? result as Record<string, unknown>
        : { ok: false, message: `子应用宿主未返回有效结果: ${toolId}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), toolId, action };
    }
  }

  private routePath(config: ChildToolConfig): string {
    return config.routePath || `/child-tool/${config.id}`;
  }

  private titleOf(config: ChildToolConfig): string {
    return this.translate.instant(config.app?.name || config.titleKey);
  }

  private descriptionOf(config: ChildToolConfig): string {
    const key = config.app?.description || `${config.namespace}.DESCRIPTION`;
    return this.translate.instant(key);
  }

  private sanitizeLocalUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    try {
      const parsed = new URL(value);
      for (const key of [...parsed.searchParams.keys()]) {
        if (/token|secret|key/i.test(key)) parsed.searchParams.set(key, '<redacted>');
      }
      return parsed.toString();
    } catch {
      return value.replace(/([?&](?:token|secret|key)=)[^&]+/gi, '$1<redacted>');
    }
  }

  private stringParam(params: Record<string, unknown>, key: string): string {
    return typeof params[key] === 'string' ? String(params[key]).trim() : '';
  }

  private integerParam(
    params: Record<string, unknown>,
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(params[key]);
    return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  private optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
    const value = Number(params[key]);
    return Number.isFinite(value) ? value : undefined;
  }
}
