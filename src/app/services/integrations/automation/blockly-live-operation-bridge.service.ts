import { Inject, Injectable, NgZone } from '@angular/core';
import * as Blockly from 'blockly';
import packageJson from '../../../../../package.json';

import { ConfigService, ThemeService } from '@core/preferences/public-api';
import { ElectronService } from '@core/platform/public-api';
import {
  executeCoderProjectCreateOperation,
  getProjectCreationModeError,
  ProjectService,
} from '@domain/project/public-api';
import { BuilderService } from '@domain/build/public-api';
import { MainUiAutomationService } from './main-ui-automation.service';
import { SubappAgentBridgeService } from '@integration/subapps/public-api';
import { isAilyLibraryPackageName } from '@shared/public-api';
import {
  selectSerialPort,
  SerialService,
  type PortItem,
  UploaderService,
} from '@domain/device/public-api';
import { AbsAutoSyncService } from '../../../integrations/blockly/abs/abs-auto-sync.service';
import {
  connectBlocks,
  createBlock,
  deleteBlock,
  setBlockField,
  type ConnectBlockInput,
  type CreateBlockInput,
} from '../../../integrations/blockly/blockly-host-operations';
import { searchBoardsLibrariesTool } from '../../../integrations/blockly/board-library-search';
import { runProjectBuild } from '../../../integrations/blockly/project-build-operation';
import type { EditorOperationEvent } from '../../../integrations/blockly/editor-operation-event';
import type { HostToolResult } from '../../../integrations/blockly/host-tool-result';
import {
  BLOCKLY_LIVE_EDITOR_PORT,
  type BlocklyLiveEditorPort,
} from './ports/blockly-live-editor.port';

type LivePlacement =
  | { kind: 'input'; name: string; asShadow?: boolean }
  | { kind: 'statement'; name: string }
  | { kind: 'next' };

type BlocklyLiveOperationPayload = {
  requestId?: string;
  rendererGeneration?: number;
  path?: string;
  operation?: string;
  params?: Record<string, any>;
};

@Injectable({ providedIn: 'root' })
export class BlocklyLiveOperationBridgeService {
  private initialized = false;
  private aiWritingDepth = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    @Inject(BLOCKLY_LIVE_EDITOR_PORT)
    private readonly blocklyEditor: BlocklyLiveEditorPort,
    private readonly electronService: ElectronService,
    private readonly builderService: BuilderService,
    private readonly themeService: ThemeService,
    private readonly absAutoSyncService: AbsAutoSyncService,
    private readonly mainUiAutomationService: MainUiAutomationService,
    private readonly subappAgentBridgeService: SubappAgentBridgeService,
    private readonly serialService: SerialService,
    private readonly uploaderService: UploaderService,
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
        ...result,
        requestId,
        rendererGeneration: payload?.rendererGeneration,
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
    if (payload.operation === 'project_open') {
      return this.executeProjectOpen(payload.path || '');
    }
    if (payload.operation === 'project_close') {
      return this.executeProjectClose();
    }
    if (payload.operation === 'project_load_status') {
      return {
        ok: true,
        operation: 'project_load_status',
        ...this.projectService.getBlocklyProjectLoadStatus(payload.path || undefined),
      };
    }
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
    if (payload.operation === 'subapp_agent_call') {
      const params = payload.params || {};
      const agentContext = params['context'] && typeof params['context'] === 'object'
        ? params['context'] as Record<string, unknown>
        : {};
      return this.subappAgentBridgeService.execute(params, undefined, {
        sessionId: String(params['sessionId'] || '').trim(),
        toolCallId: String(params['requestId'] || '').trim(),
        workspaceRoot: String(agentContext['workspaceRoot'] || '').trim(),
        developmentMode: agentContext['developmentMode'] === 'coder' ? 'coder' : 'blockly',
      });
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

    if (payload.operation !== 'project_reload') {
      const loadStatus = this.projectService.getBlocklyProjectLoadStatus(
        this.projectService.currentProjectPath,
      );
      const isBlocklyProject = this.electronService.exists(
        this.electronService.pathJoin(this.projectService.currentProjectPath, 'project.abi'),
      );
      const editorReady = isBlocklyProject
        ? loadStatus.ready
        : loadStatus.state === 'loaded' && !loadStatus.error;
      if (!isBlocklyProject && this.isBlocklyWorkspaceOperation(payload.operation)) {
        return {
          ok: false,
          operation: payload.operation,
          project: this.projectService.currentProjectPath,
          reason: 'coder_operation_mismatch',
          message: `Coder 工程不支持 Blockly 工作区操作: ${payload.operation}`,
          loadStatus,
        };
      }
      if (!editorReady) {
        return {
          ok: false,
          operation: payload.operation,
          project: this.projectService.currentProjectPath,
          reason: loadStatus.error ? 'project_load_failed' : 'project_not_ready',
          message: loadStatus.error
            ? `项目加载失败，已阻止后续操作：${loadStatus.error}`
            : `项目尚未加载完成，已阻止后续操作（state=${loadStatus.state}）`,
          loadStatus,
          guidance: isBlocklyProject
            ? '请先关闭项目，在离线状态修复 project.abs/project.abi 或依赖，再重新打开；只有 loadStatus.ready=true 后才能继续。'
            : '请等待 Coder 工程完成加载；若持续失败，请重新打开工程并检查 package.json 与源码入口。',
        };
      }
    }

    let toolResult: HostToolResult;
    switch (payload.operation) {
      case 'abi_add':
        toolResult = await this.runBlockWritingOperation(() => this.executeAbiAdd(payload.params || {}));
        break;
      case 'abi_delete':
        toolResult = await this.runBlockWritingOperation(() => this.executeAbiDelete(payload.params || {}));
        break;
      case 'abi_connect':
        toolResult = await this.runBlockWritingOperation(() => this.executeAbiConnect(payload.params || {}));
        break;
      case 'abi_set_field':
        toolResult = await this.runBlockWritingOperation(() => this.executeAbiSetField(payload.params || {}));
        break;
      case 'abs_apply':
        return this.runBlockWritingOperation(() => this.executeAbsApply(payload.params || {}));
      case 'block_metadata_snapshot':
        return this.executeBlockMetadataSnapshot();
      case 'library_runtime_sync':
        return this.runBlockWritingOperation(() => this.executeLibraryRuntimeSync(payload.params || {}));
      case 'project_abi_check':
        return this.executeProjectAbiCheck();
      case 'project_build':
        return this.executeProjectBuild(payload.params || {});
      case 'serial_ports_list':
        return this.executeSerialPortsList(payload.params || {});
      case 'project_upload':
        return this.executeProjectUpload(payload.params || {});
      case 'blocks_tidy':
        return this.runBlockWritingOperation(() => this.executeBlocksTidy());
      case 'project_save':
        return this.runBlockWritingOperation(() => this.executeProjectSave());
      case 'project_reload':
        return this.runBlockWritingOperation(() => this.executeProjectReload());
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

    await this.blocklyEditor.saveProject(this.projectService.currentProjectPath, false);
    return {
      ok: true,
      operation: payload.operation,
      project: this.projectService.currentProjectPath,
      message: this.extractToolContent(toolResult),
      metadata: toolResult.metadata,
      toolResult,
    };
  }

  /**
   * 新版 Agent 的 Blockly 写入工具执行期间置 `aiWriting = true`：
   * 仅在实际改积木的 live 操作期间点亮遮罩。带终止按钮的
   * 「AI正在操作」通知由发起本次会话的 Aily Chat surface 负责。
   */
  private async runBlockWritingOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.beginBlockWriting();
    try {
      return await operation();
    } finally {
      this.endBlockWriting();
    }
  }

  private isBlocklyWorkspaceOperation(operation?: string): boolean {
    return new Set([
      'abi_add',
      'abi_delete',
      'abi_connect',
      'abi_set_field',
      'abs_apply',
      'block_metadata_snapshot',
      'library_runtime_sync',
      'blocks_tidy',
      'project_save',
    ]).has(String(operation || ''));
  }

  private beginBlockWriting(): void {
    this.aiWritingDepth += 1;
    if (this.aiWritingDepth !== 1) {
      return;
    }
    this.blocklyEditor.setAiWritingActive('live-blockly-operation', true);
  }

  private endBlockWriting(): void {
    this.aiWritingDepth = Math.max(0, this.aiWritingDepth - 1);
    if (this.aiWritingDepth > 0) {
      return;
    }
    this.blocklyEditor.setAiWritingActive('live-blockly-operation', false);
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
        name: this.configService.getApplicationName(),
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

  private async executeAbiAdd(params: Record<string, any>): Promise<HostToolResult> {
    const placement = this.normalizePlacement(params['placement']);
    const workspace = this.getWorkspace();
    if (!workspace) return { is_error: true, content: 'Blockly 工作区未就绪' };
    const createArgs: CreateBlockInput = {
      type: String(params['type'] || ''),
      id: typeof params['id'] === 'string' ? params['id'] : undefined,
      fields: this.objectOrUndefined(params['fields']),
      extraState: this.objectOrUndefined(params['extraState']),
      position: this.positionFrom(params),
      connect: params['parentId'] && placement ? this.connectFromPlacement(String(params['parentId']), placement) : undefined,
    };
    return createBlock(workspace, createArgs);
  }

  private async executeAbiDelete(params: Record<string, any>): Promise<HostToolResult> {
    const id = String(params['id'] || '').trim();
    if (!id) {
      return { is_error: true, content: '缺少要删除的块 ID' };
    }
    const workspace = this.blocklyEditor.getWorkspace()
      ?? (Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null);
    if (!workspace?.getBlockById(id)) {
      return { is_error: true, content: `未找到块: ${id}` };
    }

    const result = deleteBlock(workspace, id);
    if (!result.is_error && workspace.getBlockById(id)) {
      return {
        ...result,
        is_error: true,
        content: `删除操作返回成功，但块仍存在于工作区: ${id}`,
      };
    }
    return result;
  }

  private async executeAbiConnect(params: Record<string, any>): Promise<HostToolResult> {
    const placement = this.normalizePlacement(params['placement']);
    if (!placement) {
      return { is_error: true, content: '需指定 input / statement / next 之一' };
    }
    const placementConnect = this.connectFromPlacement(String(params['parentId'] || ''), placement);
    const workspace = this.getWorkspace();
    if (!workspace) return { is_error: true, content: 'Blockly 工作区未就绪' };
    const connectArgs: ConnectBlockInput = {
      block: String(params['childId'] || ''),
      target: String(params['parentId'] || ''),
      action: placementConnect.action,
      input: placementConnect.input,
      moveWithChain: placementConnect.moveWithChain,
    };
    return connectBlocks(workspace, connectArgs);
  }

  private async executeAbiSetField(params: Record<string, any>): Promise<HostToolResult> {
    const workspace = this.getWorkspace();
    if (!workspace) return { is_error: true, content: 'Blockly 工作区未就绪' };
    return setBlockField(
      workspace,
      String(params['id'] || ''),
      String(params['name'] || ''),
      params['value'],
    );
  }

  private async executeAbsApply(params: Record<string, any>): Promise<Record<string, any>> {
    const abs = typeof params['abs'] === 'string' ? params['abs'] : '';
    if (!abs.trim()) {
      return { ok: false, message: '缺少 ABS 内容' };
    }

    this.absAutoSyncService.initialize(this.projectService.currentProjectPath);
    const operationId = `abs-apply:${Date.now().toString(36)}`;
    this.emitLiveOperationProgress('abs_apply', {
      type: 'editor_operation_progress',
      operationId,
      operationKind: 'blockly.abs.apply',
      phase: 'started',
      label: 'Apply ABS to Blockly workspace',
      timestamp: Date.now(),
    });
    const syncResult = await this.ngZone.runOutsideAngular(
      () => this.absAutoSyncService.importContent(abs),
    );

    if (!syncResult.success) {
      const message = [...(syncResult.errors ?? []), ...(syncResult.warnings ?? [])].join('\n')
        || 'ABS 导入失败';
      this.emitLiveOperationProgress('abs_apply', {
        type: 'editor_operation_progress',
        operationId,
        operationKind: 'blockly.abs.apply',
        phase: 'failed',
        label: 'Apply ABS to Blockly workspace',
        detail: message,
        timestamp: Date.now(),
      });
      return {
        ok: false,
        operation: 'abs_apply',
        project: this.projectService.currentProjectPath,
        message,
      };
    }

    const saveResult = await this.projectService.save(this.projectService.currentProjectPath);
    const ok = saveResult.success === true;
    const message = ok ? 'ABS 已导入 Blockly 工作区并保存项目' : `ABS 已导入，但保存失败: ${saveResult.error || '未知错误'}`;
    this.emitLiveOperationProgress('abs_apply', {
      type: 'editor_operation_progress',
      operationId,
      operationKind: 'blockly.abs.apply',
      phase: ok ? 'completed' : 'failed',
      label: 'Apply ABS to Blockly workspace',
      detail: message,
      timestamp: Date.now(),
    });

    return {
      ok,
      operation: 'abs_apply',
      project: this.projectService.currentProjectPath,
      message,
    };
  }

  private executeBlockMetadataSnapshot(): Record<string, any> {
    const snapshot = this.blocklyEditor.getRuntimeBlockMetadataSnapshot();
    return {
      ok: true,
      operation: 'block_metadata_snapshot',
      project: this.projectService.currentProjectPath,
      blocks: snapshot.blocks,
      failures: snapshot.failures,
    };
  }

  private async executeLibraryRuntimeSync(params: Record<string, any>): Promise<Record<string, any>> {
    const requestedPackages: unknown = params['packages'];
    if (
      !Array.isArray(requestedPackages)
      || requestedPackages.length === 0
      || !requestedPackages.every((name) => typeof name === 'string' && isAilyLibraryPackageName(name))
    ) {
      return { ok: false, operation: 'library_runtime_sync', ready: false, message: '请提供有效的库包名数组 packages' };
    }

    const packages = [...new Set<string>(requestedPackages)];
    const projectPath = this.projectService.currentProjectPath;
    await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);

    const loadStatus = this.projectService.getBlocklyProjectLoadStatus(projectPath);
    const runtime = this.blocklyEditor.getLibraryRuntimeSnapshot();
    const missingLibraries = packages.filter((name) => !runtime.loadedLibraries.includes(name));
    const missingToolboxLibraries = packages.filter((name) => !runtime.toolboxLibraries.includes(name));
    const failedLibraries = packages.filter((name) => runtime.failedLibraries.includes(name));
    const ready = loadStatus.ready
      && runtime.active
      && missingLibraries.length === 0
      && missingToolboxLibraries.length === 0
      && failedLibraries.length === 0;

    return {
      ok: ready,
      operation: 'library_runtime_sync',
      project: projectPath,
      ready,
      packages,
      loadStatus,
      runtime,
      missingLibraries,
      missingToolboxLibraries,
      failedLibraries,
      ...(!ready ? {
        reason: 'library_runtime_not_ready',
        message: '库文件已同步，但宿主尚未完成目标库和工具箱的加载，请检查库加载错误。',
      } : {}),
    };
  }

  private async executeProjectAbiCheck(): Promise<Record<string, any>> {
    const snapshot = await this.blocklyEditor.getProjectRevisionSnapshot();
    return {
      ok: true,
      operation: 'project_abi_check',
      project: this.projectService.currentProjectPath,
      ...snapshot,
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
    await this.configService.init();
    const mode = this.configService.getPreferredChatAgentRuntimeMode();
    const modeError = getProjectCreationModeError(mode, params);
    if (modeError) {
      return { ok: false, operation: 'project_create', reason: 'project_mode_mismatch', developmentMode: mode, message: modeError };
    }
    if (mode === 'coder') {
      return this.executeCoderProjectCreate(params);
    }

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
      developmentMode: mode,
      projectType: mode,
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

  private async executeCoderProjectCreate(params: Record<string, any>): Promise<Record<string, any>> {
    return executeCoderProjectCreateOperation(params, {
      normalizeBoardName: (value) => this.normalizeAilyBoardPackageName(value),
      getBoards: () => this.configService.getBoardListForSelector(),
      loadBoards: () => this.configService.loadBoardList(),
      defaultParentPath: () => this.projectService.getDefaultProjectParentPath(),
      generateUniqueName: (parentPath, prefix) =>
        this.projectService.generateUniqueProjectName(parentPath, prefix),
      createProject: async (data) => {
        const projectPath = window['path'].join(data.path, data.name.replace(/\s/g, '_'));
        const ok = await this.projectService.projectNew(data, {
          deferActivation: true,
          templateDirectory: 'template_arduino',
          activationReason: 'chat-tool-create',
        });
        return { ok, projectPath: ok ? projectPath : undefined };
      },
      openProject: (projectPath) => this.projectService.projectOpen(projectPath, {
        reason: 'chat-tool-create',
      }),
      recordBoardUsage: (boardName) => this.configService.recordBoardUsage(boardName),
    });
  }

  private async executeProjectBuild(params: Record<string, any>): Promise<Record<string, any>> {
    await this.projectService.ensureBlocklyLibraryRuntimeReady(this.projectService.currentProjectPath);
    const toolResult = await runProjectBuild(
      this.builderService,
      {
        preprocessOnly: params['preprocess_only'] === true,
        clearCache: params['clear_cache'] === true,
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

  private serializeSerialPort(port: PortItem, currentPort = this.serialService.currentPort): Record<string, any> {
    return {
      name: String(port.name || ''),
      text: String(port.text || ''),
      type: port.type || 'serial',
      current: String(port.name || '') === String(currentPort || ''),
      ...(port.vendorId ? { vendorId: port.vendorId } : {}),
      ...(port.productId ? { productId: port.productId } : {}),
      ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
      ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
      ...(port.pnpId ? { pnpId: port.pnpId } : {}),
    };
  }

  private async getSerialPortSelection(requestedPort?: string) {
    const ports = await this.serialService.getSerialPorts();
    const selection = selectSerialPort(ports, {
      requestedPort,
      currentPort: this.serialService.currentPort,
      boardConfig: this.projectService.currentBoardConfig,
    });
    return { ports, selection };
  }

  private async executeSerialPortsList(params: Record<string, any>): Promise<Record<string, any>> {
    const requestedPort = typeof params['port'] === 'string' ? params['port'].trim() : undefined;
    try {
      const { ports, selection } = await this.getSerialPortSelection(requestedPort);
      return {
        ok: true,
        operation: 'serial_ports_list',
        project: this.projectService.currentProjectPath,
        board: {
          name: this.projectService.currentBoardConfig?.['name'] || '',
          core: this.projectService.currentBoardConfig?.['core'] || '',
        },
        currentPort: this.serialService.currentPort || null,
        ports: ports.map(port => this.serializeSerialPort(port)),
        recommendation: {
          port: selection.selected?.name || null,
          reason: selection.reason,
          confidence: selection.confidence,
          message: selection.message,
        },
        candidates: selection.candidates.map(candidate => ({
          port: candidate.port.name,
          score: candidate.score,
          reasons: candidate.reasons,
        })),
        message: ports.length > 0 ? `检测到 ${ports.length} 个串口。${selection.message}` : selection.message,
      };
    } catch (error) {
      return {
        ok: false,
        operation: 'serial_ports_list',
        project: this.projectService.currentProjectPath,
        message: `获取串口列表失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async executeProjectUpload(params: Record<string, any>): Promise<Record<string, any>> {
    await this.projectService.ensureBlocklyLibraryRuntimeReady(this.projectService.currentProjectPath);
    const requestedPort = typeof params['port'] === 'string' ? params['port'].trim() : undefined;
    try {
      const { ports, selection } = await this.getSerialPortSelection(requestedPort);
      if (!selection.selected?.name) {
        return {
          ok: false,
          operation: 'project_upload',
          project: this.projectService.currentProjectPath,
          code: selection.reason === 'ambiguous' ? 'serial_port_ambiguous' : 'serial_port_not_found',
          message: selection.message,
          ports: ports.map(port => this.serializeSerialPort(port)),
          candidates: selection.candidates.map(candidate => ({
            port: candidate.port.name,
            score: candidate.score,
            reasons: candidate.reasons,
          })),
        };
      }

      const selectedPort = await this.serialService.selectSerialPort(selection.selected.name);
      const uploadResult = await this.uploaderService.upload();
      return {
        ok: true,
        operation: 'project_upload',
        project: this.projectService.currentProjectPath,
        selectedPort: this.serializeSerialPort(selectedPort),
        selection: {
          reason: selection.reason,
          confidence: selection.confidence,
          message: selection.message,
        },
        message: uploadResult?.text || `固件已烧录到 ${selectedPort.name}`,
        uploadResult,
      };
    } catch (error: any) {
      return {
        ok: false,
        operation: 'project_upload',
        project: this.projectService.currentProjectPath,
        selectedPort: this.serialService.currentPort || null,
        message: error?.text || error?.message || String(error),
        uploadResult: error?.result,
      };
    }
  }

  private async executeBlocksTidy(): Promise<Record<string, any>> {
    await this.projectService.ensureBlocklyLibraryRuntimeReady(this.projectService.currentProjectPath);
    const workspace = this.blocklyEditor.getWorkspace() ?? (Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null);
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
    await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);
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

  private async executeProjectOpen(projectPath: string): Promise<Record<string, any>> {
    const requestedProject = String(projectPath || '').trim();
    if (!requestedProject) {
      return { ok: false, operation: 'project_open', message: '缺少项目路径' };
    }
    if (!this.electronService.exists(requestedProject)) {
      return { ok: false, operation: 'project_open', message: `项目目录不存在: ${requestedProject}` };
    }

    const sameProject = this.normalizePath(requestedProject)
      === this.normalizePath(this.projectService.currentProjectPath);
    try {
      const opened = await this.projectService.projectOpen(requestedProject, {
        reason: sameProject ? 'chat-tool-reload' : 'chat-tool-open',
      });
      const loadStatus = this.projectService.getBlocklyProjectLoadStatus(requestedProject);
      const editorReady = this.electronService.exists(
        this.electronService.pathJoin(requestedProject, 'project.abi'),
      ) ? loadStatus.ready : loadStatus.state === 'loaded';
      if (!opened || !editorReady) {
        return {
          ok: false,
          operation: 'project_open',
          project: requestedProject,
          reason: loadStatus.error ? 'project_load_failed' : 'project_open_rejected',
          message: loadStatus.error || `项目未完成加载（state=${loadStatus.state}）`,
          loadStatus,
        };
      }
      return {
        ok: true,
        operation: 'project_open',
        project: requestedProject,
        message: '项目已打开并完成加载',
        loadStatus,
      };
    } catch (error) {
      const loadStatus = this.projectService.getBlocklyProjectLoadStatus(requestedProject);
      return {
        ok: false,
        operation: 'project_open',
        project: requestedProject,
        reason: 'project_load_failed',
        message: error instanceof Error ? error.message : String(error),
        loadStatus,
        guidance: '请先关闭项目，在离线状态修复 project.abs/project.abi 或依赖，再重新打开；不要在失败的半初始化工作区继续保存或导入。',
      };
    }
  }

  private async executeProjectClose(): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return { ok: true, operation: 'project_close', project: null, message: '当前没有打开的项目' };
    }

    const loadStatus = this.projectService.getBlocklyProjectLoadStatus(projectPath);
    if (loadStatus.ready) {
      const saved = await this.projectService.save(projectPath);
      if (!saved.success) {
        return {
          ok: false,
          operation: 'project_close',
          project: projectPath,
          reason: 'project_save_failed',
          message: `关闭项目前保存失败：${saved.error || '未知错误'}`,
          loadStatus,
        };
      }
    }

    const closed = await this.projectService.close({ allowDuringChatTool: true });
    return {
      ok: closed === true,
      operation: 'project_close',
      project: null,
      message: closed === true ? '项目已关闭，可安全进行离线修复' : '项目关闭被拒绝',
      previousLoadStatus: loadStatus,
    };
  }

  private async executeProjectReload(): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return { ok: false, message: '当前未打开 Blockly 项目' };
    }
    try {
      const opened = await this.projectService.projectOpen(projectPath, { reason: 'chat-tool-reload' });
      const loadStatus = this.projectService.getBlocklyProjectLoadStatus(projectPath);
      const editorReady = this.electronService.exists(
        this.electronService.pathJoin(projectPath, 'project.abi'),
      ) ? loadStatus.ready : loadStatus.state === 'loaded';
      if (!opened || !editorReady) {
        return {
          ok: false,
          operation: 'project_reload',
          project: projectPath,
          reason: loadStatus.error ? 'project_load_failed' : 'project_reload_rejected',
          message: loadStatus.error || `项目从磁盘重新加载失败（state=${loadStatus.state}）`,
          loadStatus,
        };
      }
      return {
        ok: true,
        operation: 'project_reload',
        project: projectPath,
        message: '项目已从磁盘重新加载',
        loadStatus,
      };
    } catch (error) {
      const loadStatus = this.projectService.getBlocklyProjectLoadStatus(projectPath);
      return {
        ok: false,
        operation: 'project_reload',
        project: projectPath,
        reason: 'project_load_failed',
        message: error instanceof Error ? error.message : String(error),
        loadStatus,
        guidance: '请关闭项目后离线修复，再重新打开；不要在失败的半初始化工作区继续保存或重复导入。',
      };
    }
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
      message: this.extractToolContent(toolResult),
      metadata,
      toolResult,
    };
  }

  private connectFromPlacement(
    target: string,
    placement: LivePlacement,
  ): Omit<ConnectBlockInput, 'block'> {
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

  private extractToolContent(result: HostToolResult): string {
    return typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '');
  }

  private getWorkspace(): Blockly.WorkspaceSvg | null {
    return this.blocklyEditor.getWorkspace()
      ?? (Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null);
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
