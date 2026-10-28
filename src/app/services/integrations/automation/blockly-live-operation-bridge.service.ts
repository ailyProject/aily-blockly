import { CoderProjectRuntimeService } from '../../../integrations/coder/coder-project-runtime.service';
import { Inject, Injectable, NgZone } from '@angular/core';
import * as Blockly from 'blockly';

import { ConfigService, ThemeService } from '@core/preferences/public-api';
import { ElectronService } from '@core/platform/public-api';
import {
  executeCoderProjectCreateOperation,
  getProjectApplicationName,
  getProjectCreationModeError,
  ProjectService,
} from '@domain/project/public-api';
import { BuilderService } from '@domain/build/public-api';
import { MainUiAutomationService } from './main-ui-automation.service';
import { AiOperationRegistryService } from './ai-operation-registry.service';
import { SubappAgentBridgeService } from '@integration/subapps/public-api';
import { isAilyLibraryPackageName, isAilyScopedPackageName } from '@shared/public-api';
import {
  selectSerialPort,
  SerialService,
  type PortItem,
  UploaderService,
} from '@domain/device/public-api';
import { AbsGenerationToolsService } from '../../../integrations/blockly/abs/abs-generation-tools.service';
import { sameAbsProjectDirectory } from '../../../integrations/blockly/abs/abs-project-path';
import { checkAbsDocumentation } from '../../../integrations/blockly/abs/abs-documentation';
import { ABS_LIVE_PROTOCOL, absPrecommitFailure, rejectAbsLiveRequest, rejectAbsRuntime } from '../../../integrations/blockly/abs/abs-live-protocol';
import { searchBoardsLibrariesTool } from '../../../integrations/blockly/board-library-search';
import { runProjectBuild } from '../../../integrations/blockly/project-build-operation';
import { ProjectBuildReceipts, readProjectBuildRequest } from './project-build-receipts';
import { forkClosedProject, forkProject } from './project-fork-operation';
import { ProjectForkReceipts, readProjectForkRequest } from './project-fork-receipts';
import { inspectFailedProjectLoad } from './project-load-recovery';
import { projectViewRecoveryFailure } from './project-view-recovery';
import { importProjectMedia } from '../../../integrations/blockly/project-media-import';
import { getBoardConfig, setBoardConfig } from '../../../integrations/blockly/board-config-operation';
import { switchProjectBoard } from '../../../integrations/blockly/board-switch-operation';
import type { EditorOperationEvent } from '../../../integrations/blockly/editor-operation-event';
import type { HostToolResult } from '../../../integrations/blockly/host-tool-result';
import {
  BLOCKLY_LIVE_EDITOR_PORT,
  type BlocklyLiveEditorPort,
} from './ports/blockly-live-editor.port';

type BlocklyLiveOperationPayload = {
  requestId?: string;
  rendererGeneration?: number;
  path?: string;
  operation?: string;
  params?: Record<string, any>;
};

const PROJECT_MUTATIONS = new Set([
  'abs_apply', 'abs_projection', 'abs_validate', 'abs_recovery',
  'library_runtime_sync', 'set_board_config', 'project_save', 'blocks_tidy',
  'project_build', 'project_upload',
  'project_media_import',
]);

@Injectable({ providedIn: 'root' })
export class BlocklyLiveOperationBridgeService {
  private initialized = false;
  private aiWritingDepth = 0;
  private absApplyInProgress = false;
  private boardSwitchInProgress = false;
  private mutationSequence = 0;
  private buildReceipts?: ProjectBuildReceipts;
  private forkReceipts?: ProjectForkReceipts;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    @Inject(BLOCKLY_LIVE_EDITOR_PORT)
    private readonly blocklyEditor: BlocklyLiveEditorPort,
    private readonly electronService: ElectronService,
    private readonly builderService: BuilderService,
    private readonly themeService: ThemeService,
    private readonly absGenerationTools: AbsGenerationToolsService,
    private readonly mainUiAutomationService: MainUiAutomationService,
    private readonly aiOperations: AiOperationRegistryService,
    private readonly subappAgentBridgeService: SubappAgentBridgeService,
    private readonly serialService: SerialService,
    private readonly uploaderService: UploaderService,
    private readonly ngZone: NgZone,
    private readonly coderRuntime: CoderProjectRuntimeService,
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
        code: (error as any)?.code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async execute(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    if (payload.operation === 'project_repair_bootstrap') return this.projectService.openIndependentRepairTarget();
    if (payload.operation === 'project_repair_shutdown_admission') return {
      ok: this.projectService.canCloseIndependentRepairTarget(payload.path || ''), operation: payload.operation };
    if (payload.operation === 'project_repair_adoption_admission') return {
      ok: this.projectService.canAdoptIndependentRepairTarget(payload.path || ''), operation: payload.operation };
    if (payload.operation === 'project_recovery_open') return this.executeRecoveryOpen(payload);
    if (payload.operation === 'project_fork_status'
      || payload.operation === 'project_fork' && Object.hasOwn(payload.params || {}, 'forkRequest')) {
      const project = payload.params?.['project'] || payload.path || this.projectService.currentProjectPath;
      try {
        const request = readProjectForkRequest(payload.params?.['forkRequest']);
        if (typeof project !== 'string' || !project || !window['path']?.isAbsolute(project)
          || payload.path && this.normalizePath(payload.path) !== this.normalizePath(project))
          throw Object.assign(new Error('A recovery receipt requires its exact absolute source project.'), { code: 'PROJECT_FORK_RECEIPT_INVALID' });
        const native = window['fs']?.projectRecoveryReceipts;
        if (!native) throw Object.assign(new Error('Recovery receipts require the matching native host.'), { code: 'PROJECT_FORK_RECEIPT_UNAVAILABLE' });
        const receipts = this.forkReceipts ??= new ProjectForkReceipts(native, result => this.refreshForkResult(result));
        if (payload.operation === 'project_fork_status') {
          if (Object.keys(payload.params || {}).some(key => !['project', 'forkRequest'].includes(key)))
            throw Object.assign(new Error('Fork observation accepts only project and forkRequest.'), { code: 'PROJECT_FORK_RECEIPT_INVALID' });
          return this.withRepairEnvironment(receipts.status(project, request));
        }
        const params = { ...payload.params };
        delete params['forkRequest']; delete params['project'];
        const signature = JSON.stringify([params['targetPath'] ?? null]);
        return this.withRepairEnvironment(await receipts.start(project, request, signature, () =>
          this.executeAdmittedOperation({ ...payload, path: project, params })));
      } catch (error) {
        return { ok: false, operation: payload.operation, sourceProject: project,
          code: (error as any)?.code || 'PROJECT_FORK_RECEIPT_FAILED',
          observation: { resultKnown: false, operationCancelled: false },
          message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (payload.operation === 'project_build_status'
      || payload.operation === 'project_build' && Object.hasOwn(payload.params || {}, 'buildRequest')) {
      const project = payload.path || this.projectService.currentProjectPath;
      try {
        const request = readProjectBuildRequest(payload.params?.['buildRequest']);
        if (!project) throw Object.assign(new Error('A build receipt requires its project path.'), { code: 'BUILD_RECEIPT_INVALID' });
        const receipts = this.buildReceipts ??= new ProjectBuildReceipts();
        if (payload.operation === 'project_build_status') return await receipts.status(project, request);
        const params = { ...payload.params };
        delete params['buildRequest'];
        const signature = JSON.stringify([params['preprocess_only'] === true, params['clear_cache'] === true]);
        return await receipts.start(project, request, signature, () =>
          this.executeAdmittedOperation({ ...payload, path: project, params }));
      } catch (error) {
        return { ok: false, operation: payload.operation, project, code: (error as any)?.code, buildOutcome: 'not-started',
          message: error instanceof Error ? error.message : String(error) };
      }
    }
    return this.executeAdmittedOperation(payload);
  }

  /** A complete disk fork need not destroy an unserialisable source renderer.
   * Native launch authority is read back from its durable completion receipt,
   * not inferred from a caller's path or this response object. */
  private async withRepairEnvironment(response: Record<string, any>): Promise<Record<string, any>> {
    const receipt = response['forkReceipt'];
    const result = response['operation'] === 'project_fork_status' ? response['result'] : response;
    if (receipt?.state !== 'completed' || result?.projectSaved !== true
      || result.activationBlocked?.reason !== 'partial-canvas-unavailable') return response;
    const native = window['fs']?.projectRepairEnvironment;
    if (!native) return response;
    try {
      const repairEnvironment = await native.ensure(receipt.project, receipt.requestId);
      const updated = { ...result, repairEnvironment,
        ...(repairEnvironment.initialNormalization ? { initialNormalization: repairEnvironment.initialNormalization } : {}) };
      return response['operation'] === 'project_fork_status' ? { ...response, result: updated } : updated;
    } catch (error) {
      const updated = { ...result, repairEnvironmentError: {
        code: (error as any)?.code || 'PROJECT_REPAIR_ENVIRONMENT_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error) } };
      return response['operation'] === 'project_fork_status' ? { ...response, result: updated } : updated;
    }
  }

  private refreshForkResult(result: Record<string, any>): Record<string, any> {
    const target = typeof result['project'] === 'string' ? result['project'] : '';
    const current = target && this.normalizePath(target) === this.normalizePath(this.projectService.currentProjectPath);
    const loadStatus = current ? this.projectService.getBlocklyProjectLoadStatus(target) : undefined;
    const activated = !!current && loadStatus?.ready === true;
    return { ...result, activated, loadStatus,
      projectionPending: activated && result['projectionPending'] === true };
  }

  private async executeRecoveryOpen(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    const params = payload.params || {}, project = params['project'] || payload.path;
    try {
      const request = readProjectForkRequest({ version: params['version'], requestId: params['requestId'] });
      if (Object.keys(params).some(key => !['version', 'requestId', 'project'].includes(key))
        || typeof project !== 'string' || !window['path']?.isAbsolute(project)
        || payload.path && this.normalizePath(payload.path) !== this.normalizePath(project))
        throw Object.assign(new Error('Recovery opening requires its exact saved source and request.'), { code: 'PROJECT_RECOVERY_OPEN_INVALID' });
      const current = this.projectService.currentProjectPath;
      if (current && this.normalizePath(current) === this.normalizePath(project)) return {
        ok: true, operation: 'project_recovery_open', project,
        receipt: { version: 1, requestId: request.requestId, state: 'completed' },
        sourceGuardReleased: false, observedOpen: true,
        loadStatus: this.projectService.getBlocklyProjectLoadStatus(project),
      };
      const native = window['fs']?.projectRecoveryReceipts;
      if (!native) throw Object.assign(new Error('Recovery opening requires the matching native receipt host.'), { code: 'PROJECT_FORK_RECEIPT_UNAVAILABLE' });
      const receipts = this.forkReceipts ??= new ProjectForkReceipts(native, result => this.refreshForkResult(result));
      const result = await receipts.start(project, request, 'closed-recovery-open', () => {
        if (this.absApplyInProgress || this.boardSwitchInProgress) return Promise.resolve({
          ok: false, operation: 'project_fork', sourceProject: project, projectSaved: false,
          code: 'PROJECT_RECOVERY_OPEN_BUSY', message: 'A host mutation still owns its operation; no source was opened or changed.' });
        return forkClosedProject(this.projectService, project);
      });
      return { ok: result['ok'] === true, operation: 'project_recovery_open', project,
        sourceGuardReleased: false, result,
        ...(result['ok'] !== true ? { code: result['code'], message: result['message'],
          ...(['PROJECT_FILE_BUSY', 'PROJECT_RECOVERY_SOURCE_BUSY', 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'].includes(result['code'])
            ? { nextAction: { tool: 'app_info', input: {} },
              guidance: 'Source-copy admission did not establish a safe read scope. Keep the source, candidate and owner records. Observe app_info and the existing operation; retry only after its actual state changes. Do not delete locks, force rebind, loop unchanged requests or ask the user to repair internal files.' } : {}) } : {}),
        receipt: { version: 1, requestId: request.requestId, state: result['forkReceipt']?.state ?? 'unknown' } };
    } catch (error) {
      return { ok: false, operation: 'project_recovery_open', project, sourceGuardReleased: false,
        code: (error as any)?.code || 'PROJECT_RECOVERY_OPEN_FAILED',
        message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeAdmittedOperation(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    const rejection = rejectAbsLiveRequest(payload.operation || '', payload.params || {});
    if (rejection) return { ...rejection, project: this.projectService.currentProjectPath };
    // The coordinator consumes exact journal authority before invoking the
    // domain lifecycle gate. A generic mutation mask would block its own
    // reopen; all other recovery/writing operations retain their admission.
    const journalReopen = payload.operation === 'abs_recovery' && payload.params?.['action'] === 'reopen';
    const recoveryInspection = payload.operation === 'abs_recovery' && payload.params?.['action'] === 'inspect';
    const recoveryPath = payload.path || this.projectService.currentProjectPath;
    const recoveryDependencyReload = payload.operation === 'library_runtime_sync'
      && this.projectService.hasSavedRecoveryTarget?.(recoveryPath)
      && this.projectService.getBlocklyProjectLoadStatus(recoveryPath).ready === false;
    if (journalReopen || recoveryInspection || recoveryDependencyReload || (!PROJECT_MUTATIONS.has(payload.operation || '')
      && !(payload.operation === 'blocks_set_state' && payload.params?.['action'] === 'update'))) return this.executeOperation(payload);
    const projectPath = payload.path || this.projectService.currentProjectPath;
    if (this.projectService.isProjectTransitionInProgress(projectPath)) {
      return { ok: false, operation: payload.operation, project: projectPath, reason: 'project_lifecycle_busy',
        ...(payload.operation === 'project_build' ? { buildOutcome: 'not-started' } : {}),
        message: '项目正在切换、重载或关闭；本次写入尚未开始，请等待该宿主操作完成。' };
    }
    const source = `live-project-mutation:${++this.mutationSequence}`;
    this.aiOperations.setActive(source, true, { projectPath, blocksProjectLifecycle: true });
    try { return await this.executeOperation(payload); }
    finally { this.aiOperations.setActive(source, false); }
  }

  private async executeOperation(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    // Owner control does not access the workspace. Keep heartbeats and cleanup
    // reachable while a project operation holds its gate; the subapp bridge
    // still validates lease ownership. Tool execution remains behind the gate.
    if (payload.operation === 'subapp_agent_owner') {
      return this.subappAgentBridgeService.manageOwnerLease(payload.params || {});
    }
    if (payload.operation === 'subapp_agent_release') {
      return this.subappAgentBridgeService.releaseSession(String(payload.params?.['sessionId'] || '').trim());
    }
    if (payload.operation === 'project_list') return {
      ok: true,
      project: this.projectService.currentProjectPath,
      projects: this.projectService.coderProjects.map(project => project.path),
      coderWorkspace: this.projectService.coderWorkspace,
    };
    if (payload.operation === 'abs_apply_status') {
      return {
        ok: true,
        operation: 'abs_apply_status',
        project: this.projectService.currentProjectPath,
        inProgress: this.absApplyInProgress,
      };
    }
    const inspection = ['project_load_status', 'app_info', 'search_boards_libraries'].includes(payload.operation || '');
    const buildNotStarted = payload.operation === 'project_build' ? { buildOutcome: 'not-started' } : {};
    if (this.boardSwitchInProgress && !inspection) {
      return { ok: false, ...buildNotStarted, reason: 'board_switch_in_progress', message: '开发板正在切换，请等待当前操作完成。' };
    }
    if (this.absApplyInProgress && !inspection) {
      return { ok: false, ...buildNotStarted, reason: 'abs_apply_in_progress', message: 'ABS 正在导入或保存，请等待本次操作结束。' };
    }
    if (payload.operation === 'project_fork') {
      return forkProject(this.projectService, payload.path, payload.params || {});
    }
    if (payload.operation === 'project_open') {
      return this.executeProjectOpen(payload.path || '');
    }
    if (payload.operation === 'project_close') {
      return this.executeProjectClose(payload.path);
    }
    if (payload.operation === 'project_load_status') {
      const path = payload.path || this.projectService.currentProjectPath;
      if (this.projectService.getProjectMode(path) === 'coder') {
        const opened = this.projectService.coderProjects.some(project => this.normalizePath(project.path) === this.normalizePath(path));
        const ready = opened && this.coderRuntime.getSession(path).editorReady;
        return { ok: opened, operation: payload.operation, project: path, state: ready ? 'loaded' : opened ? 'loading' : 'default', ready };
      }
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
    if (payload.operation === 'child_app_recover') {
      return this.mainUiAutomationService.recoverChildApp(payload.params || {});
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
        ownerLeaseId: String(params['ownerLeaseId'] || '').trim(),
        toolCallId: String(params['requestId'] || '').trim(),
        workspaceRoot: String(agentContext['workspaceRoot'] || '').trim(),
        developmentMode: agentContext['developmentMode'] === 'coder' ? 'coder' : 'blockly',
      });
    }
    const coderPath = payload.path || this.projectService.currentProjectPath;
    if (this.projectService.getProjectMode(coderPath) === 'coder'
      && ['project_build', 'project_upload', 'serial_ports_list', 'project_save'].includes(payload.operation)) {
      if (!this.projectService.coderProjects.some(project => this.normalizePath(project.path) === this.normalizePath(coderPath))) {
        return { ok: false, ...buildNotStarted, project: coderPath, message: '请先添加此 Coder 工程' };
      }
      if (payload.operation === 'project_build' && this.coderRuntime.getSession(coderPath).busy) {
        return { ok: false, ...buildNotStarted, project: coderPath, reason: 'project_operation_busy',
          message: '当前 Coder 工程正在编译或上传；本次编译尚未开始。' };
      }
      return this.executeCoderProjectOperation(coderPath, payload.operation, payload.params || {});
    }

    // Cleanup is token-scoped and remains available after a failed reload.
    if (payload.operation === 'abs_recovery' && payload.params?.['action'] === 'history_release') {
      return this.absGenerationTools.execute('abs_recovery', payload.params);
    }
    const requestedProject = payload.path;
    const currentProject = this.projectService.currentProjectPath;
    if (!currentProject) {
      return { ok: false, ...buildNotStarted, message: '当前主程序未打开项目' };
    }
    const matchesProject = !requestedProject || await sameAbsProjectDirectory(requestedProject, currentProject,
      window['fs']?.realpathAsync, window['platform']?.isWindows === true);
    if (!matchesProject || currentProject !== this.projectService.currentProjectPath) {
      return {
        ok: false,
        ...buildNotStarted,
        message: `当前打开项目不匹配: ${this.projectService.currentProjectPath}`,
        currentProject: this.projectService.currentProjectPath,
      };
    }

    if (payload.operation !== 'project_reload') {
      const isBlocklyProject = this.projectService.getProjectMode(this.projectService.currentProjectPath) !== 'coder';
      const loadStatus = this.getProjectRuntimeStatus(this.projectService.currentProjectPath);
      const editorReady = loadStatus.ready;
      if (!isBlocklyProject && this.isBlocklyWorkspaceOperation(payload.operation)) {
        return {
          ok: false,
          ...buildNotStarted,
          operation: payload.operation,
          project: this.projectService.currentProjectPath,
          reason: 'coder_operation_mismatch',
          message: `Coder 工程不支持 Blockly 工作区操作: ${payload.operation}`,
          loadStatus,
        };
      }
      if (!editorReady) {
        if (isBlocklyProject && loadStatus.error && payload.operation === 'project_abi_check') {
          const saved = await this.projectService.inspectSavedRecoveryTarget(this.projectService.currentProjectPath);
          if (saved) return saved;
        }
        if (isBlocklyProject && loadStatus.error && payload.operation === 'library_runtime_sync'
          && this.projectService.hasSavedRecoveryTarget(this.projectService.currentProjectPath)) {
          return this.executeLibraryRuntimeSync(payload.params || {}, true);
        }
        if (isBlocklyProject && loadStatus.error && payload.operation === 'abs_recovery' && payload.params?.['action'] === 'inspect') {
          const source = this.projectService.currentProjectPath;
          return inspectFailedProjectLoad(source, loadStatus, payload.params, () => {
            const latest = this.getProjectRuntimeStatus(source);
            if (this.projectService.currentProjectPath !== source || latest.ready || latest.error !== loadStatus.error) {
              throw Object.assign(new Error('The failed project activation changed during inspection. Read app_info before recovery.'),
                { code: 'PROJECT_RECOVERY_SOURCE_CHANGED' });
            }
            if (this.projectService.isProjectOpening || this.projectService.isProjectTransitionInProgress(source)
              || this.aiOperations.hasBlocking(source)) {
              throw Object.assign(new Error('A project operation still owns the source. Observe its completion before recovery; no ownership was bypassed.'),
                { code: 'PROJECT_RECOVERY_SOURCE_BUSY' });
            }
          }, () => this.projectService.inspectSavedRecoveryTarget?.(source) ?? Promise.resolve(null));
        }
        return {
          ok: false,
          ...buildNotStarted,
          operation: payload.operation,
          project: this.projectService.currentProjectPath,
          reason: loadStatus.error ? 'project_load_failed' : 'project_not_ready',
          message: loadStatus.error
            ? `项目加载失败，已阻止后续操作：${loadStatus.error}`
            : `项目尚未加载完成，已阻止后续操作（state=${loadStatus.state}）`,
          loadStatus,
          guidance: isBlocklyProject
            ? loadStatus.error
              ? '先调用 project_recover(action="inspect") 获取失败加载诊断与磁盘保全恢复动作；不要保存半初始化画布、离线改 ABI/map 或清理锁。'
              : '先通过 app_info 观察当前加载操作；尚未完成加载时不要导入、保存或另起恢复写入。'
            : '请等待 Coder 工程完成加载；若持续失败，请重新打开工程并检查 package.json 与源码入口。',
          ...(isBlocklyProject ? { nextAction: loadStatus.error
            ? { tool: 'project_recover', input: { project: this.projectService.currentProjectPath, action: 'inspect' } }
            : { tool: 'app_info', input: {} } } : {}),
        };
      }
      if (!isBlocklyProject && ['board_switch', 'set_board_config'].includes(payload.operation || '') &&
        this.coderRuntime.getSession(this.projectService.currentProjectPath).busy) {
        return { ok: false, operation: payload.operation, reason: 'project_operation_busy',
          message: '当前 Coder 工程正在编译或上传，配置尚未修改；请等待该操作结束。' };
      }
    }

    switch (payload.operation) {
      case 'blocks_set_state':
        return payload.params?.['action'] === 'inspect'
          ? this.absGenerationTools.blockState(payload.params)
          : this.runAbsOperation(() => this.absGenerationTools.blockState(payload.params || {}));
      case 'project_media_import':
        return importProjectMedia(currentProject, payload.params as any);
      case 'abs_apply':
        return this.runAbsOperation(() => this.executeAbsApply(payload.params || {}));
      case 'abs_projection':
        return this.executeAbsProjection(payload.params || {});
      case 'abs_validate':
        return this.executeAbsCandidateValidation(payload.params || {});
      case 'abs_recovery':
        return { project: this.projectService.currentProjectPath,
          ...await this.absGenerationTools.execute('abs_recovery', payload.params || {}, undefined, undefined,
            (path, assertCurrent) => this.projectService.reopenRecoveredBlocklyProject(path, assertCurrent)) };
      case 'abs_compose':
      case 'abs_precheck':
        return this.absGenerationTools.authoring(payload.operation, payload.params || {});
      case 'abs_capabilities':
        return { ok: true, operation: 'abs_capabilities', project: this.projectService.currentProjectPath,
          capabilities: this.absGenerationTools.capabilities(payload.params || {}) };
      case 'abs_check_documentation':
        return { ok: true, operation: 'abs_check_documentation', project: this.projectService.currentProjectPath,
          documentation: checkAbsDocumentation(payload.params) };
      case 'block_metadata_snapshot':
        return this.executeBlockMetadataSnapshot();
      case 'library_runtime_sync':
        // The native rebuild owns its workspace edit lease. Discovery and
        // dependency waits must leave the existing canvas interactive.
        return this.executeLibraryRuntimeSync(payload.params || {});
      case 'project_abi_check':
        return this.executeProjectAbiCheck();
      case 'project_build':
        return this.executeProjectBuild(payload.params || {});
      case 'get_board_config':
        return getBoardConfig(this.projectService, payload.params?.['section']);
      case 'board_switch':
        return this.executeBoardSwitch(payload.params || {});
      case 'set_board_config':
        return setBoardConfig(this.projectService, this.builderService, this.electronService, payload.params || {},
          this.projectService.getProjectMode(this.projectService.currentProjectPath) === 'coder'
            ? project => this.coderRuntime.build(project, { preprocessOnly: true }) : undefined);
      case 'serial_ports_list':
        return this.executeSerialPortsList(payload.params || {});
      case 'project_upload':
        return this.executeProjectUpload(payload.params || {});
      case 'blocks_tidy':
        return this.runBlockWritingOperation(() => this.executeBlocksTidy());
      case 'project_save':
        return this.runBlockWritingOperation(() => this.executeProjectSave());
      case 'project_reload':
        return this.executeProjectReload();
      default:
        return { ok: false, message: `不支持的 live Blockly 操作: ${payload.operation || ''}` };
    }

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

  private async runAbsOperation<T>(operation: () => Promise<T>): Promise<T> {
    const source = 'live-abs-operation';
    this.absApplyInProgress = true;
    this.aiOperations.setActive(source, true, { projectPath: this.projectService.currentProjectPath });
    try {
      return await this.runBlockWritingOperation(operation);
    } finally {
      this.aiOperations.setActive(source, false);
      this.absApplyInProgress = false;
    }
  }

  private isBlocklyWorkspaceOperation(operation?: string): boolean {
    return new Set([
      'abs_apply',
      'abs_projection',
      'abs_validate',
      'abs_recovery',
      'abs_capabilities',
      'abs_compose',
      'abs_precheck',
      'block_metadata_snapshot',
      'library_runtime_sync',
      'blocks_tidy',
      'blocks_set_state',
      'project_save',
      'project_media_import',
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
      capabilities: { projectBuildReceipts: 1, projectForkReceipts: 1, projectRecoveryOpen: 1 },
      app: {
        name: this.configService.getApplicationName(),
        version: this.electronService.applicationVersion,
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
        absProtocol: ABS_LIVE_PROTOCOL,
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

  private readAbsSource(params: Record<string, any>): string {
    const hasText = typeof params['abs'] === 'string', hasPath = typeof params['absPath'] === 'string';
    if (hasText === hasPath) throw new Error('必须且只能提供 abs 或 absPath。');
    const source = hasPath ? this.electronService.readFile(params['absPath']) : params['abs'];
    if (typeof source !== 'string' || !source.trim()) throw new Error('缺少 ABS 内容');
    return source;
  }

  private async executeAbsProjection(params: Record<string, any>) {
    await this.projectService.ensureBlocklyLibraryRuntimeReady();

    return this.absGenerationTools.execute('abs_projection', params);
  }

  private async executeAbsCandidateValidation(params: Record<string, any>) {
    const source = this.readAbsSource(params);

    await this.projectService.ensureBlocklyLibraryRuntimeReady();

    const libraryRuntimeFingerprint = await this.projectService.getBlocklyLibraryRuntimeFingerprint();

    const unavailable = rejectAbsRuntime('abs_validate', libraryRuntimeFingerprint);
    if (unavailable) return { ...unavailable, project: this.projectService.currentProjectPath };

    const result = await this.absGenerationTools.execute('abs_validate', params, source);

    if (!result.ok) return result;

    const changed = rejectAbsRuntime('abs_validate', await this.projectService.getBlocklyLibraryRuntimeFingerprint(), libraryRuntimeFingerprint!);
    if (changed) return { ...changed, project: this.projectService.currentProjectPath };

    return { ...result, receipt: { ...(result as any).receipt, libraryRuntimeFingerprint } };
  }

  private async executeAbsApply(params: Record<string, any>) {
    let source: string;
    try {
      const fingerprint = await this.projectService.getBlocklyLibraryRuntimeFingerprint();
      const rejection = rejectAbsRuntime('abs_apply', fingerprint, params['validation'].libraryRuntimeFingerprint);
      if (rejection) return { ...rejection, project: this.projectService.currentProjectPath };
      source = this.readAbsSource(params);
    } catch (error) {
      return { ...absPrecommitFailure('abs_apply', error), project: this.projectService.currentProjectPath };
    }
    const operationId = `abs-apply:${Date.now().toString(36)}`;
    const progress = (phase: 'started' | 'progress' | 'completed' | 'failed', detail?: string) => this.emitLiveOperationProgress('abs_apply', {
      type: 'editor_operation_progress', operationId, operationKind: 'blockly.abs.apply',
      phase, label: 'Apply ABS generation', detail, timestamp: Date.now(),
    });
    progress('started');
    const result = await this.ngZone.runOutsideAngular(() => this.absGenerationTools.execute('abs_apply', params, source,
      (blocks, batches) => progress('progress', `已装载 ${blocks} 个块，完成 ${batches} 批`)));
    progress(result.ok ? 'completed' : 'failed', result.ok ? 'ABS 已完成身份合并、完整读回及同代保存' : (result as any).message);
    return result; // The coordinator already saved ABI and prepared outputs. Never save or generate twice.
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

  private async executeLibraryRuntimeSync(params: Record<string, any>, savedRecovery = false): Promise<Record<string, any>> {
    const requestedPackages: unknown = params['packages'];
    if (
      !Array.isArray(requestedPackages)
      || !requestedPackages.every((name) => typeof name === 'string' && isAilyLibraryPackageName(name))
    ) {
      return { ok: false, operation: 'library_runtime_sync', ready: false, message: '请提供有效的库包名数组 packages' };
    }

    const packages = [...new Set<string>(requestedPackages)];
    const removedPackages: unknown = params['removedPackages'] ?? [];
    if (!Array.isArray(removedPackages) || !removedPackages.every(name => typeof name === 'string' && isAilyLibraryPackageName(name))) {
      return { ok: false, operation: 'library_runtime_sync', ready: false, message: 'Invalid removedPackages' };
    }
    const projectPath = this.projectService.currentProjectPath;
    const recovery = savedRecovery ? await this.projectService.reloadSavedRecoveryTarget(projectPath) : undefined;
    if (recovery && !recovery.ok) return { ...recovery, operation: 'library_runtime_sync', packages, removedPackages,
      ready: false, reason: 'library_runtime_not_ready',
      nextAction: { tool: 'project_recover', input: { project: projectPath, action: 'inspect' } },
      message: recovery.message || recovery.loadStatus?.error || 'The independent recovery target has not completed loading; installed files were retained.' };
    if (!recovery) await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);

    const loadStatus = this.projectService.getBlocklyProjectLoadStatus(projectPath);
    const runtime = this.blocklyEditor.getLibraryRuntimeSnapshot();
    const missingLibraries = packages.filter((name) => !runtime.loadedLibraries.includes(name));
    const missingToolboxLibraries = packages.filter((name) => !runtime.toolboxLibraries.includes(name));
    const failedLibraries = packages.filter((name) => runtime.failedLibraries.includes(name));
    const remainingRemovedLibraries = removedPackages.filter(name => runtime.loadedLibraries.includes(name) || runtime.toolboxLibraries.includes(name));
    const ready = loadStatus.ready
      && this.projectService.currentProjectPath === projectPath
      && runtime.active
      && missingLibraries.length === 0
      && missingToolboxLibraries.length === 0
      && failedLibraries.length === 0
      && remainingRemovedLibraries.length === 0;

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
      remainingRemovedLibraries,
      removedPackages,
      ...(recovery ? { recoveryReload: recovery.recoveryReload, recoveryArchive: recovery.recoveryArchive,
        projectionPending: true } : {}),
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
      unsavedLibraryChanges: await this.projectService.hasUnsavedLibraryChanges(),
      project: this.projectService.currentProjectPath,
      ...snapshot,
    };
  }

  private async executeBoardSwitch(params: Record<string, any>): Promise<Record<string, any>> {
    const developmentMode = this.projectService.getProjectMode(this.projectService.currentProjectPath) === 'coder' ? 'coder' : 'blockly';
    if (params['developmentMode'] && params['developmentMode'] !== developmentMode) {
      return { ok: false, changed: false, operation: 'board_switch', reason: 'project_mode_mismatch', developmentMode };
    }
    this.boardSwitchInProgress = true;
    this.aiOperations.setActive('live-board-switch', true, { projectPath: this.projectService.currentProjectPath });
    try {
      const operation = () => switchProjectBoard(params, {
        currentProject: () => this.projectService.currentProjectPath,
        readBoard: () => getBoardConfig(this.projectService, 'pins'),
        resolveBoard: async name => {
          await this.configService.init();
          if (!this.configService.boardDict[name]) await this.configService.loadBoardList();
          const board = this.configService.boardDict[name];
          return board ? { name, version: board.version || 'latest' } : undefined;
        },
        changeBoard: board => this.projectService.changeBoard(board),
        ensureRuntime: async project => {
          if (this.projectService.currentProjectPath !== project) throw new Error('Active project changed');
          // Native changeBoard owns its reload. Once it returns, protect the
          // tool's remaining runtime synchronization/readback without locking
          // the native operation out of its own lifecycle.
          if (this.projectService.isProjectTransitionInProgress(project)) throw new Error('Project lifecycle changed before board runtime synchronization');
          this.aiOperations.setActive('live-board-switch', true, { projectPath: project, blocksProjectLifecycle: true });
          if (developmentMode === 'coder') {
            if (!await this.waitForCoderEditor(project)) throw new Error('Coder editor reload did not become ready');
            if (!await this.coderRuntime.getSession(project).project.syncCurrentBoardConfig()) throw new Error('Coder board configuration did not synchronize');
            return;
          }
          const manifest = await this.projectService.getPackageJson();
          const packages = Object.keys(manifest?.dependencies || {}).filter(isAilyLibraryPackageName);
          const result = await this.executeLibraryRuntimeSync({ packages });
          if (!result['ready']) throw new Error(`Board library/toolbox runtime is not ready: ${JSON.stringify({
            missing: result['missingLibraries'], toolbox: result['missingToolboxLibraries'], failed: result['failedLibraries'],
          })}`);
        },
        isReady: project => this.getProjectRuntimeStatus(project).ready,
      });
      // Board installation can take minutes. Native save/rebuild operations
      // protect their own writes; the download must not own the canvas mask.
      const result = await operation();
      return { ...result, developmentMode };
    } finally {
      this.aiOperations.setActive('live-board-switch', false);
      this.boardSwitchInProgress = false;
    }
  }

  private getProjectRuntimeStatus(project: string): { ready: boolean; state: string; error?: string } {
    if (this.projectService.getProjectMode(project) !== 'coder') return this.projectService.getBlocklyProjectLoadStatus(project);
    const opened = this.projectService.coderProjects.some(item => this.normalizePath(item.path) === this.normalizePath(project));
    const ready = opened && this.coderRuntime.getSession(project).editorReady;
    return { ready, state: ready ? 'loaded' : opened ? 'loading' : 'default' };
  }

  private async waitForCoderEditor(project: string): Promise<boolean> {
    const deadline = Date.now() + 30_000;
    while (this.projectService.currentProjectPath === project && !this.getProjectRuntimeStatus(project).ready && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return this.projectService.currentProjectPath === project && this.getProjectRuntimeStatus(project).ready;
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
    const result = await executeCoderProjectCreateOperation(params, {
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
    return {
      ...result,
      ...(result['ok'] === true && this.projectService.coderWorkspace
        ? { coderWorkspace: this.projectService.coderWorkspace }
        : {}),
    };
  }

  private async executeCoderProjectOperation(path: string, operation: string, params: Record<string, any>): Promise<Record<string, any>> {
    try {
      if (operation === 'serial_ports_list') {
        const { session, ports, selection } = await this.coderRuntime.resolvePort(path, params['port']);
        return { ok: true, operation, project: path, currentPort: session.serial.currentPort,
          board: session.project.currentBoardConfig,
          ports: ports.map(port => this.serializeSerialPort(port, session.serial.currentPort)),
          recommendation: { port: selection.selected?.name || null, reason: selection.reason, confidence: selection.confidence, message: selection.message },
        };
      }
      if (operation === 'project_save') {
        const result = await this.coderRuntime.getSession(path).project.save(path, 15000);
        return { ok: result.success, operation, project: path, ...result };
      }
      const result = operation === 'project_upload'
        ? await this.coderRuntime.upload(path, params['port'])
        : await this.coderRuntime.build(path, { preprocessOnly: params['preprocess_only'] === true, clearCache: params['clear_cache'] === true });
      return { ok: true, operation, project: path, message: result?.text || '', result };
    } catch (error: any) {
      return { ok: false, operation, project: path, buildOutcome: error?.buildOutcome,
        message: error?.text || error?.message || String(error), result: error?.result || error?.buildResult };
    }
  }

  private async executeProjectBuild(params: Record<string, any>): Promise<Record<string, any>> {
    try {
      await this.projectService.ensureBlocklyLibraryRuntimeReady(this.projectService.currentProjectPath);
    } catch (error) {
      return { ok: false, operation: 'project_build', project: this.projectService.currentProjectPath,
        buildOutcome: 'not-started', code: (error as any)?.code,
        message: error instanceof Error ? error.message : String(error) };
    }
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
      buildOutcome: toolResult.metadata?.['buildOutcome'],
      result: toolResult.metadata?.['buildResult'],
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
    const projectPath = this.projectService.currentProjectPath;
    await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);
    const assertProject = () => {
      if (projectPath !== this.projectService.currentProjectPath) throw new Error('整理操作所属项目已改变。');
    };
    assertProject();
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

    await this.blocklyEditor.runWorkspaceOperation(async () => {
      assertProject();
      if (workspace !== this.blocklyEditor.getWorkspace()) throw new Error('整理操作所属工作区已改变。');
      const previousGroup = Blockly.Events.getGroup();
      Blockly.Events.setGroup(true);
      try { workspace.cleanUp(); } finally { Blockly.Events.setGroup(previousGroup); }
    });

    try {
      // The editor port resolves when the real save settles. A UI Action's
      // five-second feedback timeout does not cancel its save or release leases.
      await this.blocklyEditor.saveProject(projectPath);
    } catch (error) {
      return {
        ok: false,
        operation: 'blocks_tidy',
        project: projectPath,
        message: `块已整理，但保存项目失败: ${error instanceof Error ? error.message : String(error)}`,
        ...this.saveFailureFacts(error),
        topBlockCount: topBlocks.length,
      };
    }

    return {
      ok: true,
      operation: 'blocks_tidy',
      project: projectPath,
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
    if (projectPath !== this.projectService.currentProjectPath) throw new Error('保存操作所属项目已改变。');
    try {
      await this.blocklyEditor.saveProject(projectPath);
    } catch (error) {
      return {
        ok: false,
        operation: 'project_save',
        message: error instanceof Error ? error.message : String(error),
        project: projectPath,
        ...this.saveFailureFacts(error),
      };
    }
    return {
      ok: true,
      operation: 'project_save',
      project: projectPath,
      message: '项目已保存',
    };
  }

  private saveFailureFacts(error: unknown): Record<string, unknown> {
    const failure = error as any;
    if (typeof failure?.projectSaved !== 'boolean') return {};
    return { projectSaved: failure.projectSaved, generatedCodePublished: failure.generatedCodePublished === true,
      partial: failure.partial === true, ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
      ...(failure.projectSaved ? { recovery: 'The project is saved. For a stale build owner use project_recover(action="fork") to create an independent recovery project; do not delete unknown ownership records.' } : {}) };
  }

  private async executeProjectOpen(projectPath: string): Promise<Record<string, any>> {
    const requestedProject = String(projectPath || '').trim();
    if (!requestedProject) {
      return { ok: false, operation: 'project_open', message: '缺少项目路径' };
    }
    if (!this.electronService.exists(requestedProject)) {
      return { ok: false, operation: 'project_open', message: `项目目录不存在: ${requestedProject}` };
    }

    // Chat-triggered opens must never surface the manual cross-product dialog or
    // bind an opposite-mode project into this renderer.  Keep this preflight in
    // the bridge even though ProjectService also guards interactive UI opens: it
    // gives older/remote Agents a stable machine-readable rejection before any
    // route, lock, recent-project or activation state can change.
    await this.configService.init();
    const developmentMode = this.configService.getPreferredChatAgentRuntimeMode();
    const projectType = this.projectService.getProjectMode(requestedProject);
    if (!projectType) {
      return {
        ok: false,
        operation: 'project_open',
        project: requestedProject,
        reason: 'project_mode_unknown',
        developmentMode,
        projectType: null,
        stateChanged: false,
        message: '无法识别项目类型，已阻止打开。',
      };
    }
    if (projectType !== developmentMode) {
      return {
        ok: false,
        operation: 'project_open',
        project: requestedProject,
        reason: 'project_mode_mismatch',
        developmentMode,
        projectType,
        stateChanged: false,
        referenceOnly: true,
        message: `当前 ${getProjectApplicationName(developmentMode)} 不能直接打开 ${getProjectApplicationName(projectType)} 工程。`,
        guidance: '如果只需参考对方模式的代码，可以使用只读文件工具，但不能将该目录绑定为当前项目；如需继续编辑，请在对应应用中手动打开。',
      };
    }

    const sameProject = this.normalizePath(requestedProject)
      === this.normalizePath(this.projectService.currentProjectPath);
    try {
      const opened = await this.projectService.projectOpen(requestedProject, {
        reason: sameProject ? 'chat-tool-reload' : 'chat-tool-open',
        interactive: false,
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
        ...(this.projectService.coderWorkspace
          ? { coderWorkspace: this.projectService.coderWorkspace }
          : {}),
      };
    } catch (error) {
      const viewFailure = projectViewRecoveryFailure(error, requestedProject, { mode: developmentMode,
        hasOpenView: !!this.projectService.currentProjectPath || !!this.projectService.coderProjects?.length,
        hasSavedDocument: () => this.electronService.exists(this.electronService.pathJoin(requestedProject, 'project.abi')) });
      if (viewFailure) return viewFailure;
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

  private async executeProjectClose(requestedPath?: string): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return { ok: true, operation: 'project_close', project: null, message: '当前没有打开的项目' };
    }
    if (requestedPath && this.normalizePath(requestedPath) !== this.normalizePath(projectPath)) {
      return { ok: false, operation: 'project_close', project: projectPath, reason: 'project_mismatch',
        message: '目标项目不是当前活动项目，未保存或关闭其他项目。' };
    }

    const loadStatus = this.projectService.getBlocklyProjectLoadStatus(projectPath);
    let closed: boolean;
    try { closed = await this.projectService.close({ save: true }); }
    catch (error) {
      return { ok: false, operation: 'project_close', project: projectPath, reason: 'project_close_failed',
        code: (error as any)?.code, message: error instanceof Error ? error.message : String(error), loadStatus };
    }
    return {
      ok: closed === true,
      operation: 'project_close',
      project: closed === true ? null : projectPath,
      ...(closed === true ? {} : { reason: 'project_close_rejected' }),
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
      if (opened && this.projectService.getProjectMode(projectPath) === 'coder') {
        const ready = await this.waitForCoderEditor(projectPath);
        return { ok: ready, operation: 'project_reload', project: projectPath,
          message: ready ? '项目已从磁盘重新加载' : '项目编辑器重新加载超时',
          loadStatus: { project: projectPath, state: ready ? 'loaded' : 'loading', ready } };
      }
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
        offset: params['offset'],
        detail: params['detail'],
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

  private extractToolContent(result: HostToolResult): string {
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
    if (isAilyScopedPackageName(normalized)) {
      return normalized;
    }
    if (normalized.startsWith('board-')) {
      return `@aily-project/${normalized}`;
    }
    return `@aily-project/board-${normalized}`;
  }

}
