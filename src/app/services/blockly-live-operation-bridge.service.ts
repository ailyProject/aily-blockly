import { Injectable, NgZone } from '@angular/core';
import * as Blockly from 'blockly';
import packageJson from '../../../package.json';

import { _ProjectService } from '../editors/blockly-editor/services/project.service';
import { BlocklyService } from '../editors/blockly-editor/services/blockly.service';
import { ConfigService } from './config.service';
import { ElectronService } from './electron.service';
import { ProjectService } from './project.service';
import { BuilderService } from './builder.service';
import { ThemeService } from './theme.service';
import { MainUiAutomationService } from './main-ui-automation.service';
import { AbsAutoSyncService } from '../tools/aily-chat/services/abs-auto-sync.service';
import {
  connectBlocksSimpleTool,
  createSingleBlockTool,
  setBlockFieldTool,
  type ConnectBlocksSimpleArgs,
  type CreateSingleBlockArgs,
} from '../tools/aily-chat/tools/atomicBlockTools';
import { searchBoardsLibrariesTool } from '../tools/aily-chat/tools/searchBoardsLibrariesTool';
import { buildProjectTool } from '../tools/aily-chat/tools/buildProjectTool';
import { runSyncAbsFileConcreteHandler } from '../tools/aily-chat/tools/syncAbsFileTool';
import { deleteBlockTool } from '../tools/aily-chat/tools/editBlockTool';
import type { EditorOperationEvent, EditorOperationEventSink } from '../tools/aily-chat/tools/editorOperationEvents';
import type { ToolUseResult } from '../tools/aily-chat/core/tool-types';

type LivePlacement =
  | { kind: 'input'; name: string; asShadow?: boolean }
  | { kind: 'statement'; name: string }
  | { kind: 'next' };

type BlocklyLiveOperationPayload = {
  requestId?: string;
  path?: string;
  operation?: string;
  params?: Record<string, any>;
};

@Injectable({ providedIn: 'root' })
export class BlocklyLiveOperationBridgeService {
  private initialized = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly editorProjectService: _ProjectService,
    private readonly blocklyService: BlocklyService,
    private readonly electronService: ElectronService,
    private readonly builderService: BuilderService,
    private readonly themeService: ThemeService,
    private readonly absAutoSyncService: AbsAutoSyncService,
    private readonly mainUiAutomationService: MainUiAutomationService,
    private readonly ngZone: NgZone,
  ) {}

  ensureInitialized(): void {
    if (this.initialized || typeof window === 'undefined') {
      return;
    }

    const electronApi = (window as any)['electronAPI'];
    const ipcRenderer = window['ipcRenderer'] || electronApi?.ipcRenderer;
    if (!ipcRenderer?.on || !ipcRenderer?.send) {
      return;
    }

    ipcRenderer.on('cli-bridge:blockly-live-operation', (_event: unknown, payload: BlocklyLiveOperationPayload) => {
      void this.handleIpcPayload(ipcRenderer, payload);
    });
    this.initialized = true;
  }

  private async handleIpcPayload(ipcRenderer: any, payload: BlocklyLiveOperationPayload): Promise<void> {
    const requestId = payload?.requestId;
    const respond = (result: Record<string, any>) => {
      ipcRenderer.send('cli-bridge:blockly-live-operation:response', {
        requestId,
        ...result,
      });
    };

    if (!requestId) {
      respond({ ok: false, message: '缺少 requestId' });
      return;
    }

    try {
      const result = await this.ngZone.run(() => this.execute(payload));
      respond(result);
    } catch (error) {
      respond({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async execute(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    if (payload.operation === 'app_info') {
      return this.executeAppInfo();
    }
    if (payload.operation === 'search_boards_libraries') {
      return this.executeSearchBoardsLibraries(payload.params || {});
    }
    if (payload.operation === 'project_create') {
      return this.executeProjectCreate(payload.params || {});
    }
    if (payload.operation === 'main_menu_list') {
      return this.mainUiAutomationService.listMainMenu(payload.params || {});
    }
    if (payload.operation === 'main_menu_execute') {
      return this.mainUiAutomationService.executeMainMenu(payload.params || {});
    }
    if (payload.operation === 'child_app_list') {
      return this.mainUiAutomationService.listChildApps(payload.params || {});
    }
    if (payload.operation === 'child_app_get') {
      return this.mainUiAutomationService.getChildApp(payload.params || {});
    }
    if (payload.operation === 'child_app_open') {
      return this.mainUiAutomationService.openChildApp(payload.params || {});
    }
    if (payload.operation === 'child_app_control') {
      return this.mainUiAutomationService.controlChildApp(payload.params || {});
    }
    if (payload.operation === 'child_app_window_list') {
      return this.mainUiAutomationService.listChildAppWindows();
    }
    if (payload.operation === 'child_app_window_set_bounds') {
      return this.mainUiAutomationService.setChildAppWindowBounds(payload.params || {});
    }
    if (payload.operation === 'child_app_window_arrange') {
      return this.mainUiAutomationService.arrangeChildAppWindows(payload.params || {});
    }

    const requestedProject = this.normalizePath(payload.path);
    const currentProject = this.normalizePath(this.projectService.currentProjectPath);
    if (!currentProject) {
      return { ok: false, message: '当前主程序未打开 Blockly 项目' };
    }
    if (requestedProject && requestedProject !== currentProject) {
      return {
        ok: false,
        message: `当前打开项目不匹配: ${this.projectService.currentProjectPath}`,
        currentProject: this.projectService.currentProjectPath,
      };
    }

    let toolResult: ToolUseResult;
    switch (payload.operation) {
      case 'abi_add':
        toolResult = await this.executeAbiAdd(payload.params || {});
        break;
      case 'abi_delete':
        toolResult = await this.executeAbiDelete(payload.params || {});
        break;
      case 'abi_connect':
        toolResult = await this.executeAbiConnect(payload.params || {});
        break;
      case 'abi_set_field':
        toolResult = await this.executeAbiSetField(payload.params || {});
        break;
      case 'abs_apply':
        return this.executeAbsApply(payload.params || {});
      case 'project_build':
        return this.executeProjectBuild(payload.params || {});
      case 'blocks_tidy':
        return this.executeBlocksTidy();
      case 'project_save':
        return this.executeProjectSave();
      case 'project_reload':
        return this.executeProjectReload();
      default:
        return { ok: false, message: `不支持的 live Blockly 操作: ${payload.operation || ''}` };
    }

    if (toolResult.is_error) {
      return {
        ok: false,
        message: this.extractToolContent(toolResult),
        toolResult,
      };
    }

    await this.editorProjectService.save(this.projectService.currentProjectPath, false);
    return {
      ok: true,
      operation: payload.operation,
      project: this.projectService.currentProjectPath,
      message: this.extractToolContent(toolResult),
      metadata: toolResult.metadata,
      toolResult,
    };
  }

  private async executeAppInfo(): Promise<Record<string, any>> {
    const config = this.configService.data || {};
    const buildFlavor = config.build_flavor === 'global' ? 'global' : 'cn';
    const uiTheme = this.themeService.theme();
    const [builderStatus, linterStatus] = await Promise.all([
      this.readAilyToolStatus('aily-builder', window['builder']),
      this.readAilyToolStatus('aily-linter', window['linter']),
    ]);

    return {
      ok: true,
      operation: 'app_info',
      app: {
        name: packageJson.productName || packageJson.name,
        version: packageJson.version,
        buildFlavor,
        edition: buildFlavor === 'global' ? 'international' : 'domestic',
        editionLabel: buildFlavor === 'global' ? '国际版' : '国内版',
      },
      tools: {
        'aily-builder': builderStatus,
        'aily-linter': linterStatus,
      },
      settings: {
        uiTheme,
        developmentMode: this.configService.getDevelopmentModePreference(),
        coderEnabled: this.configService.isCoderEnabled(),
        blocklyTheme: this.themeService.getBlocklyThemeId(),
        blocklyRenderer: config.blockly?.renderer || 'thrasos',
        blocklyMinimap: config.blockly?.minimap ?? null,
        language: config.lang || config.selectedLanguage || null,
        region: config.region || null,
        officialRegion: config.official_region || null,
        resourceSource: config.resource_source || 'auto',
        projectFolder: config.project_path || null,
      },
      runtime: {
        platform: window['platform']?.type || null,
        versions: (window['electronAPI'] as any)?.versions?.() || null,
      },
    };
  }

  private async readAilyToolStatus(name: string, api: any): Promise<Record<string, any>> {
    if (!api?.status) {
      return {
        name,
        installed: false,
        version: null,
        installing: false,
        error: '状态接口不可用',
      };
    }

    try {
      const status = await api.status();
      return {
        name,
        installed: status?.installed === true,
        version: status?.installedVersion || null,
        installing: status?.installing === true,
        error: status?.error || null,
      };
    } catch (error) {
      return {
        name,
        installed: false,
        version: null,
        installing: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async executeAbiAdd(params: Record<string, any>): Promise<ToolUseResult> {
    const placement = this.normalizePlacement(params['placement']);
    const createArgs: CreateSingleBlockArgs = {
      type: String(params['type'] || ''),
      id: typeof params['id'] === 'string' ? params['id'] : undefined,
      fields: this.objectOrUndefined(params['fields']),
      extraState: this.objectOrUndefined(params['extraState']),
      position: this.positionFrom(params),
      connect: params['parentId'] && placement ? this.connectFromPlacement(String(params['parentId']), placement) : undefined,
    };
    return createSingleBlockTool(createArgs);
  }

  private async executeAbiDelete(params: Record<string, any>): Promise<ToolUseResult> {
    const id = String(params['id'] || '').trim();
    if (!id) {
      return { is_error: true, content: '缺少要删除的块 ID' };
    }
    const workspace = this.blocklyService.workspace
      ?? (Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null);
    if (!workspace?.getBlockById(id)) {
      return { is_error: true, content: `未找到块: ${id}` };
    }

    const result = await deleteBlockTool({ blockId: id });
    if (!result.is_error && workspace.getBlockById(id)) {
      return {
        ...result,
        is_error: true,
        content: `删除操作返回成功，但块仍存在于工作区: ${id}`,
      };
    }
    return result;
  }

  private async executeAbiConnect(params: Record<string, any>): Promise<ToolUseResult> {
    const placement = this.normalizePlacement(params['placement']);
    if (!placement) {
      return { is_error: true, content: '需指定 input / statement / next 之一' };
    }
    const placementConnect = this.connectFromPlacement(String(params['parentId'] || ''), placement);
    const connectArgs: ConnectBlocksSimpleArgs = {
      block: String(params['childId'] || ''),
      target: String(params['parentId'] || ''),
      action: placementConnect.action,
      input: placementConnect.input,
      moveWithChain: placementConnect.moveWithChain,
    };
    return connectBlocksSimpleTool(connectArgs);
  }

  private async executeAbiSetField(params: Record<string, any>): Promise<ToolUseResult> {
    return setBlockFieldTool({
      blockId: String(params['id'] || ''),
      fieldName: String(params['name'] || ''),
      value: params['value'],
    });
  }

  private async executeAbsApply(params: Record<string, any>): Promise<Record<string, any>> {
    const abs = typeof params['abs'] === 'string' ? params['abs'] : '';
    if (!abs.trim()) {
      return { ok: false, message: '缺少 ABS 内容' };
    }

    this.absAutoSyncService.initialize(this.projectService.currentProjectPath);
    const progressSink = this.createLiveOperationProgressSink('abs_apply');
    const syncResult = await runSyncAbsFileConcreteHandler(
      {
        operation: 'import',
        pendingAbsContent: abs,
      },
      this.projectService,
      this.electronService,
      this.absAutoSyncService,
      {
        sessionId: 'mcp-blockly-live-operation',
        toolCallId: 'mcp-abs-apply',
        progressSink,
        runOutsideAngular: operation => this.ngZone.runOutsideAngular(operation),
      },
    );

    return {
      ok: syncResult.is_error !== true,
      operation: 'abs_apply',
      project: this.projectService.currentProjectPath,
      message: this.extractSyncAbsContent(syncResult),
      metadata: syncResult.metadata,
      toolResult: syncResult,
    };
  }

  private createLiveOperationProgressSink(operation: string): EditorOperationEventSink {
    return {
      reportEditorOperationEvent: (event: EditorOperationEvent) => {
        this.emitLiveOperationProgress(operation, event);
      },
    };
  }

  private emitLiveOperationProgress(operation: string, event: EditorOperationEvent): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.dispatchEvent(new CustomEvent('aily:blockly-live-operation-progress', {
        detail: {
          operation,
          project: this.projectService.currentProjectPath,
          event,
        },
      }));
    } catch (error) {
      console.warn('[BlocklyLiveOperationBridge] progress dispatch failed:', error);
    }
  }

  private async executeProjectCreate(params: Record<string, any>): Promise<Record<string, any>> {
    const requestedName = String(params['name'] || '').trim();
    const requestedParentPath = String(params['path'] || '').trim();
    const rawBoardName = String(params['boardName'] || params['board'] || '').trim();
    const boardName = this.normalizeAilyBoardPackageName(rawBoardName);
    const boardVersion = String(params['boardVersion'] || params['version'] || 'latest').trim() || 'latest';
    const boardNickname = String(params['boardNickname'] || params['nickname'] || boardName).trim() || boardName;

    if (!rawBoardName) return { ok: false, message: '缺少开发板包名 boardName' };

    const newProjectData = await this.projectService.createDefaultNewProjectData(
      {
        name: boardName,
        nickname: boardNickname,
        version: boardVersion,
      },
      {
        name: requestedName,
        path: requestedParentPath,
        prefix: typeof params['prefix'] === 'string' ? params['prefix'] : 'project_',
        devmode: typeof params['devmode'] === 'string' ? params['devmode'] : undefined,
      },
    );
    const projectPath = window['path']?.join
      ? window['path'].join(newProjectData.path, newProjectData.name.replace(/\s/g, '_'))
      : `${newProjectData.path.replace(/[\\/]+$/, '')}/${newProjectData.name.replace(/\s/g, '_')}`;

    const ok = await this.projectService.projectNew(
      newProjectData,
      { activationReason: 'chat-tool-create' },
    );

    return {
      ok,
      operation: 'project_create',
      project: ok ? projectPath : null,
      message: ok ? `项目已创建并打开: ${projectPath}` : '项目创建失败',
      name: newProjectData.name,
      path: newProjectData.path,
      board: {
        name: boardName,
        nickname: boardNickname,
        version: boardVersion,
        requestedName: rawBoardName,
      },
    };
  }

  private async executeProjectBuild(params: Record<string, any>): Promise<Record<string, any>> {
    const toolResult = await buildProjectTool(
      this.builderService,
      {
        preprocess_only: params['preprocess_only'] === true,
        clear_cache: params['clear_cache'] === true,
      },
      this.projectService.currentProjectPath,
    );
    return {
      ok: toolResult.is_error !== true,
      operation: 'project_build',
      project: this.projectService.currentProjectPath,
      message: this.extractToolContent(toolResult),
      metadata: toolResult.metadata,
      toolResult,
    };
  }

  private async executeBlocksTidy(): Promise<Record<string, any>> {
    const workspace = this.blocklyService.workspace ?? (Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null);
    if (!workspace) {
      return { ok: false, message: 'Blockly 工作区未就绪，无法整理块' };
    }
    const topBlocks = workspace.getTopBlocks(false);
    if (topBlocks.length <= 1) {
      return {
        ok: true,
        operation: 'blocks_tidy',
        project: this.projectService.currentProjectPath,
        message: '顶层块数量不足，无需整理',
        topBlockCount: topBlocks.length,
      };
    }

    Blockly.Events.setGroup(true);
    try {
      workspace.cleanUp();
    } finally {
      Blockly.Events.setGroup(false);
    }

    const saveResult = await this.projectService.save(this.projectService.currentProjectPath);
    if (!saveResult.success) {
      return {
        ok: false,
        operation: 'blocks_tidy',
        message: `块已整理，但保存项目失败: ${saveResult.error || '未知错误'}`,
        topBlockCount: topBlocks.length,
      };
    }

    return {
      ok: true,
      operation: 'blocks_tidy',
      project: this.projectService.currentProjectPath,
      message: `已整理 ${topBlocks.length} 个顶层 Blockly 块并保存项目`,
      topBlockCount: topBlocks.length,
    };
  }

  private async executeProjectSave(): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return { ok: false, message: '当前未打开 Blockly 项目' };
    }
    const saveResult = await this.projectService.save(projectPath);
    if (!saveResult.success) {
      return {
        ok: false,
        operation: 'project_save',
        message: saveResult.error || '项目保存失败',
        project: projectPath,
      };
    }
    return {
      ok: true,
      operation: 'project_save',
      project: projectPath,
      message: '项目已保存',
    };
  }

  private async executeProjectReload(): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return { ok: false, message: '当前未打开 Blockly 项目' };
    }
    await this.projectService.projectOpen();
    return {
      ok: true,
      operation: 'project_reload',
      project: projectPath,
      message: '项目已从磁盘重新加载',
    };
  }

  private async executeSearchBoardsLibraries(params: Record<string, any>): Promise<Record<string, any>> {
    await this.configService.loadHardwareIndexForAI?.();
    const toolResult = await searchBoardsLibrariesTool.handler(
      {
        query: params['query'],
        type: params['type'],
        filters: params['filters'],
        maxResults: params['maxResults'],
      },
      this.configService,
    );
    const metadata = (toolResult as { metadata?: unknown }).metadata;
    return {
      ok: toolResult.is_error !== true,
      operation: 'search_boards_libraries',
      message: this.extractToolContent(toolResult as ToolUseResult),
      metadata,
      toolResult,
    };
  }

  private connectFromPlacement(target: string, placement: LivePlacement): CreateSingleBlockArgs['connect'] {
    if (placement.kind === 'next') {
      return { action: 'chain_after', target, moveWithChain: false };
    }
    if (placement.kind === 'statement') {
      return { action: 'put_into', target, input: placement.name, moveWithChain: false };
    }
    return { action: 'set_as_input', target, input: placement.name, moveWithChain: false };
  }

  private normalizePlacement(value: any): LivePlacement | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    if (value.kind === 'next') {
      return { kind: 'next' };
    }
    if (value.kind === 'statement' && typeof value.name === 'string') {
      return { kind: 'statement', name: value.name };
    }
    if (value.kind === 'input' && typeof value.name === 'string') {
      return { kind: 'input', name: value.name, asShadow: !!value.asShadow };
    }
    return undefined;
  }

  private positionFrom(params: Record<string, any>): { x: number; y: number } | undefined {
    const hasX = typeof params['x'] === 'number';
    const hasY = typeof params['y'] === 'number';
    if (!hasX && !hasY) {
      return undefined;
    }
    return { x: hasX ? params['x'] : 30, y: hasY ? params['y'] : 30 };
  }

  private objectOrUndefined(value: any): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  }

  private extractToolContent(result: ToolUseResult): string {
    return typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
  }

  private extractSyncAbsContent(result: { content?: unknown }): string {
    return typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
  }

  private normalizePath(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      return '';
    }
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  private normalizeAilyBoardPackageName(boardName: string): string {
    const normalized = String(boardName || '').trim();
    if (!normalized) {
      return normalized;
    }
    if (normalized.startsWith('@aily-project/')) {
      return normalized;
    }
    if (normalized.startsWith('board-')) {
      return `@aily-project/${normalized}`;
    }
    return `@aily-project/board-${normalized}`;
  }
}
