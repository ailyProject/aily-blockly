import { CoderProjectRuntimeService } from '../../../integrations/coder/coder-project-runtime.service';
import type { ProjectSaveRequest } from '@domain/project/public-api';
import { Inject, Injectable, NgZone } from '@angular/core';
import * as Blockly from 'blockly';

import { ConfigService, ThemeService } from '@core/preferences/public-api';
import { ElectronService } from '@core/platform/public-api';
import {
  executeCoderProjectCreateOperation,
  getProjectApplicationName,
  getProjectCreationModeError,
  ProjectService,
  readProjectSaveRequest,
} from '@domain/project/public-api';
import { BuilderService, readPreparedBuildInput, requirePreparedBuildExecution } from '@domain/build/public-api';
import type { BuildLocalFallbackControl } from '../../../utils/cloud-build-progress.utils';
import { MainUiAutomationService } from './main-ui-automation.service';
import { AiOperationRegistryService } from './ai-operation-registry.service';
import { SubappAgentBridgeService } from '@integration/subapps/public-api';
import { isAilyLibraryPackageName, isAilyScopedPackageName, requireProjectProgramPublication,
  type ProjectStorageAttachment } from '@shared/public-api';
import { boardPublicationRequest } from '../../domains/project/project-board-publication-request';
import {
  selectSerialPort,
  SerialService,
  type FirmwareUploadOptions,
  type PortItem,
  UploaderService,
} from '@domain/device/public-api';
import { AbsGenerationToolsService } from '../../../integrations/blockly/abs/abs-generation-tools.service';
import { readAbsBlockStateRequest, type AbsBlockStateUpdateRequest } from '../../../integrations/blockly/abs/abs-block-state';
import { sameAbsProjectDirectory } from '../../../integrations/blockly/abs/abs-project-path';
import { checkAbsDocumentation } from '../../../integrations/blockly/abs/abs-documentation';
import { ABS_LIVE_PROTOCOL, absPrecommitFailure, rejectAbsLiveRequest, rejectAbsRuntime } from '../../../integrations/blockly/abs/abs-live-protocol';
import { absWorkspaceProtocol } from '../../../integrations/blockly/abs/abs-workspace-protocol';
import { searchBoardsLibrariesTool } from '../../../integrations/blockly/board-library-search';
import { runProjectBuild } from '../../../integrations/blockly/project-build-operation';
import { ProjectBuildReceipts, readNativeBuildReceipt, readProjectBuildRequest } from './project-build-receipts';
import { createProjectLifecycleAssertion, type ProjectLifecycleSnapshot } from './project-lifecycle-admission';
import { ProjectCreateReceipts, readProjectCreateRequest, type ProjectCreateGuard } from './project-create-receipts';
import { ProjectNavigationReceipts, readProjectNavigationRequest } from './project-navigation-receipts';
import type { ProjectNavigationTransition } from '../../domains/project/project-navigation-transition';
import { forkProject } from './project-fork-operation';
import { ProjectForkReceipts, readProjectForkRequest } from './project-fork-receipts';
import { inspectFailedProjectLoad, projectLoadFailureGuidance } from './project-load-recovery';
import { openAbsHostStorage } from '../../../integrations/blockly/abs/abs-host-storage';
import { recoverAbsProjectOperation, settleAbsProjectOpen } from '../../../integrations/blockly/abs/abs-project-restart';
import { AbsApplicationJournal } from '../../../integrations/blockly/abs/abs-application-journal';
import { AbsOperationJournal } from '../../../integrations/blockly/abs/abs-operation-journal';
import { absJson } from '../../../integrations/blockly/abs/abs-identity-map';
import { applicationRequestKey, nativeSaveAdmissionIdentity, observedApplicationAdmission, OriginalRequestAdmissions, originalAdmissionOutcome,
  type OriginalRequestAdmissionIdentity } from '../../../integrations/blockly/abs/original-request-admission';
import { nativeSaveIdentity } from '../../../integrations/blockly/abs/abs-native-save-result';
import { blockStatePublicationIdentity, blockStatePublicationReference } from '../../../integrations/blockly/abs/abs-native-save-protocol';
import { observeNativePublication } from '../../../integrations/blockly/abs/abs-native-save-observation';
import { inspectAbsBaselineRecovery, recoverAbsBaseline } from '../../../integrations/blockly/abs/abs-baseline-recovery';
import { restoreAbsProjectCaches } from '../../../integrations/blockly/abs/abs-project-open';
import { projectViewRecoveryFailure } from './project-view-recovery';
import { importProjectMedia } from '../../../integrations/blockly/project-media-import';
import { getBoardConfig, setBoardConfig } from '../../../integrations/blockly/board-config-operation';
import { switchProjectBoard } from '../../../integrations/blockly/board-switch-operation';
import { settleOriginalBoardEnvironment } from '../../../integrations/blockly/environment-settlement';
import type { EditorOperationEvent } from '../../../integrations/blockly/editor-operation-event';
import type { HostToolResult } from '../../../integrations/blockly/host-tool-result';
import {
  BLOCKLY_LIVE_EDITOR_PORT,
  type BlocklyLiveEditorPort,
} from './ports/blockly-live-editor.port';

type BlocklyLiveOperationPayload = {
  requestId?: string;
  rendererGeneration?: number;
  lifecycle?: ProjectLifecycleSnapshot;
  originalAdmissionAttachment?: ProjectStorageAttachment;
  nativeSaveWriter?: { viewRevision: number; intentHash: string };
  path?: string;
  operation?: string;
  params?: Record<string, any>;
};

const PROJECT_MUTATIONS = new Set([
  'abs_apply', 'abs_projection', 'abs_validate', 'abs_recovery', 'abs_workspace_migrate',
  'library_history_navigation', 'library_runtime_sync', 'library_mutation_prepare', 'library_mutation_abort', 'set_board_config', 'project_save', 'blocks_tidy',
  'project_build', 'project_upload',
  'project_media_import',
]);
const buildFallbackControl = Symbol('buildFallbackControl');
type ProjectBuildParameters = Record<string, any> & { [buildFallbackControl]?: BuildLocalFallbackControl };
const projectLockMaintenance = new Set(['retire_empty_project_lock', 'retire_project_file_lock']);
const diskRecoveryObservations = new Set(['history_observe', 'read_draft']);

function observesAbsDisk(payload: BlocklyLiveOperationPayload): boolean {
  return payload.operation === 'abs_recovery' && diskRecoveryObservations.has(payload.params?.['action']);
}

// Backup/observation and environment-only operations are not program writers.
function publishesProjectProgram(payload: BlocklyLiveOperationPayload): boolean {
  const { operation, params = {} } = payload;
  if (operation === 'abs_protocol') return params['action'] === 'prepare_workspace_migration';
  if (['project_save', 'blocks_tidy', 'abs_apply', 'board_switch', 'set_board_config'].includes(operation || '')) return true;
  if (operation === 'abs_projection') return params['publish'] !== false;
  if (operation === 'blocks_set_state') return params['action'] !== 'inspect';
  if (operation === 'abs_recovery' && ['resolve', 'recover_project'].includes(params['action']) && params['observe'] === true) return false;
  return operation === 'abs_recovery' && [
    'history_publish', 'recover', 'abandon', 'reopen', 'refresh', 'repair', 'resolve', 'recover_project',
  ].includes(params['action']);
}

@Injectable({ providedIn: 'root' })
export class BlocklyLiveOperationBridgeService {
  private nativeRecoveryRuntime?: { key: string; fingerprint: string };
  private initialized = false;
  private aiWritingDepth = 0;
  private absApplyInProgress = false;
  private boardSwitchInProgress = false;
  private mutationSequence = 0;
  private buildReceipts?: ProjectBuildReceipts;
  private forkReceipts?: ProjectForkReceipts;
  private createReceipts?: ProjectCreateReceipts;
  private navigationReceipts?: ProjectNavigationReceipts;
  private readonly pendingOriginalAdmissions = new Set<string>();

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
    ipcRenderer.on('cli-bridge:project-navigation-stop', (_event: unknown, value: unknown) => {
      const request = readProjectNavigationRequest(value, path => window['path'].isAbsolute(path));
      if (request?.rendererGeneration === this.electronService.currentRendererGeneration) this.navigationReceipts?.stop(request);
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
      const reportsCanvas = payload.operation === 'abs_apply'
        || payload.operation === 'abs_recovery' && payload.params?.['action'] === 'candidate_capture';
      const originalView = reportsCanvas ? this.canvasScope(payload) : undefined;
      const result = await this.ngZone.run(() => this.execute(payload));
      if (originalView && result['ok'] === true) {
        const observed = this.canvasScope(payload);
        const workingRevision = payload.operation === 'abs_apply'
          ? result['receipt']?.appliedRevision : result['capture']?.working?.revision;
        if (typeof result['project'] === 'string'
          && this.normalizePath(result['project']) === this.normalizePath(originalView.attachment.root)
          && observed && absJson(observed) === absJson(originalView)
          && Number.isSafeInteger(workingRevision) && workingRevision >= 0)
          result['canvasVersion'] = { ...originalView, workingRevision };
      }
      respond(result);
    } catch (error) {
      const original = error;
      const dependency = (original as any)?.dependencyConflict, project = payload?.path;
      const localDependencyConflict = (original as any)?.code === 'LIBRARY_DEPENDENCY_CONFLICT'
        && dependency?.version === 1 && dependency.status === 'available' && dependency.sourceFilesChanged === false
        && typeof project === 'string' && !!project.trim() && typeof dependency.project === 'string'
        && this.normalizePath(project) === this.normalizePath(dependency.project)
        && /^sha256:[a-f0-9]{64}$/.test(dependency.token)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dependency.requestId)
        && Array.isArray(dependency.entries) && dependency.entries.length > 0 && dependency.entries.length <= 256
        && dependency.entries.every((entry: any) => entry && ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'ailyLocalLibrarySources'].includes(entry.field)
          && typeof entry.name === 'string' && entry.name.length > 0
          && ['base', 'staged', 'disk'].every(name => entry[name] === null || typeof entry[name] === 'string'));
      respond({
        ok: false,
        code: (original as any)?.code,
        message: original instanceof Error ? original.message : String(original),
        ...((original as any)?.commandDispatched === false ? { commandDispatched: false, stateChanged: false, candidateApplied: false } : {}),
        ...(localDependencyConflict ? { project, operation: payload.operation,
          nextAction: { tool: 'project_recover', input: { project, action: 'inspect_dependencies' } },
          recovery: 'Inspect the retained dependency entries before reading ABS; projection did not complete. No version was discarded or candidate applied.' } : {}),
      });
    }
  }

  private async execute(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    // Deny legacy copy requests before allocating a receipt or destination.
    // File permission approval cannot authorize an internal recovery clone.
    if (payload.operation === 'project_fork') return forkProject(this.projectService, payload.path, payload.params || {});
    if (payload.operation === 'project_canvas_status') return this.observeCanvasVersion(payload);
    if (payload.operation === 'abs_admission_status') return this.observeApplicationAdmission(payload);
    if (payload.operation === 'abs_recovery' && payload.params?.['action'] === 'observe_state')
      return this.observeStatePublication(payload);
    if (payload.operation === 'project_navigation_workspace_mode') return this.observeClosedWorkspaceMode(payload);
    const blocklyProgram = this.projectService.getProjectMode(payload.path || this.projectService.currentProjectPath) !== 'coder';
    // Bind the original request before the live readiness and mutation gates.
    // Invalid protocol messages cannot acquire an admission record.
    const applyId = payload.operation === 'abs_apply' && payload.params?.['requestId'];
    if (blocklyProgram && window['fs']?.projectSyncStorageVersion === 2
      && typeof applyId === 'string' && payload.params?.['version'] === 2 && /^[A-Za-z0-9-]{16,80}$/.test(applyId)) {
      const rejection = rejectAbsLiveRequest('abs_apply', payload.params);
      if (rejection) return { ...rejection, project: this.projectService.currentProjectPath };
      return this.executeApplyAdmission(payload, applyId);
    }
    const nativeSaveAdmission = blocklyProgram && window['fs']?.projectSyncStorageVersion === 2
      && ['project_save', 'blocks_tidy'].includes(payload.operation || '') && payload.params?.['saveRequest']?.version === 2;
    if (blocklyProgram && !nativeSaveAdmission && publishesProjectProgram(payload)) {
      try { requireProjectProgramPublication(); }
      catch (error) { return { ok: false, operation: payload.operation, commandDispatched: false,
        code: (error as any)?.code, message: error instanceof Error ? error.message : String(error) }; }
    }
    if (blocklyProgram && payload.operation === 'blocks_set_state' && payload.params?.['action'] === 'update') {
      let request: ReturnType<typeof readAbsBlockStateRequest>;
      try {
        request = readAbsBlockStateRequest(payload.params);
      } catch (error) {
        return { ...absPrecommitFailure('blocks_set_state', error), project: payload.path, commandDispatched: false };
      }
      if (request.action === 'update') return this.executeStateAdmission(payload, request);
    }
    if (blocklyProgram && window['fs']?.nativeSaveReceiptVersion === 2 && ['project_save', 'blocks_tidy'].includes(payload.operation || '')
      && !Object.hasOwn(payload.params || {}, 'saveRequest')) return { ok: false, code: 'PROJECT_SAVE_PROTOCOL_UPGRADE_REQUIRED',
        operation: payload.operation, commandDispatched: false, message: 'A native save requires the matching original durable request.' };
    if (payload.operation === 'project_board_environment_settle') return this.executeBoardEnvironmentSettlement(payload, blocklyProgram);
    if (payload.operation === 'project_publication_prepare') return this.prepareOriginalSaveWriter(payload, blocklyProgram);
    if (blocklyProgram && payload.nativeSaveWriter && ['set_board_config', 'board_switch'].includes(payload.operation || ''))
      return this.executePreparedBoardPublication(payload);
    if (payload.operation === 'project_publication_status') {
      const params = payload.params || {}, project = params['project'] ?? payload.path;
      try {
        const request = readProjectSaveRequest(params['saveRequest']);
        if (request.version !== 2 || typeof project !== 'string' || !window['path']?.isAbsolute(project)
          || Object.keys(params).some(key => !['project', 'saveRequest', 'originalTargetPid'].includes(key))
          || payload.path && this.normalizePath(payload.path) !== this.normalizePath(project))
          throw Object.assign(new Error('Invalid original publication observation scope.'), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
        return await this.projectService.observeProjectPublication(project, request, params['originalTargetPid']);
      } catch (error) {
        return { ok: false, operation: payload.operation, project, code: (error as any)?.code ?? 'PROJECT_SAVE_RECEIPT_FAILED',
          observation: { resultKnown: false, operationCancelled: false }, message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (payload.operation === 'project_save_status'
      || ['project_save', 'blocks_tidy'].includes(payload.operation || '') && Object.hasOwn(payload.params || {}, 'saveRequest')) {
      const params = payload.params || {}, project = params['project'] ?? payload.path;
      try {
        const request = readProjectSaveRequest(params['saveRequest']);
        if (Object.keys(params).some(key => !['project', 'saveRequest'].includes(key))
          || payload.operation !== 'project_save_status' && request.input !== undefined
          || typeof project !== 'string' || !project || !window['path']?.isAbsolute(project)
          || payload.path && this.normalizePath(payload.path) !== this.normalizePath(project)
          || payload.operation !== 'project_save_status' && request.operation !== payload.operation)
          throw Object.assign(new Error('A save receipt requires its exact absolute project and original operation.'),
            { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
        // Observation never creates a task, acquires a write lease, or redirects
        // an old request to whichever project happens to be active now.
        if (payload.operation === 'project_save_status') return await this.projectService.getProjectSaveReceipt(project, request);
        const admitted = { ...payload, path: project, params: {} };
        return await this.projectService.startProjectSaveReceipt(project, request, () => {
          if (request.version !== 2) return this.executeAdmittedOperation(admitted);
          if (!nativeSaveAdmission) return this.executeAdmittedOperation(admitted, request);
          return this.executeSaveAdmission(admitted, project, request);
        }, nativeSaveAdmission ? failure => this.executeSaveAdmission(admitted, project, request, failure) : undefined);
      } catch (error) {
        return { ok: false, operation: payload.operation, project, code: (error as any)?.code || 'PROJECT_SAVE_RECEIPT_FAILED',
          observation: { resultKnown: false, operationCancelled: false },
          message: error instanceof Error ? error.message : String(error) };
      }
    }
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
          return receipts.status(project, request);
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
        const receipts = this.buildReceipts ??= new ProjectBuildReceipts(undefined, undefined, (target, requestId) =>
          this.normalizePath(target) === this.normalizePath(this.projectService.currentProjectPath)
            ? readNativeBuildReceipt(target, requestId) : undefined);
        const params: ProjectBuildParameters = { ...payload.params };
        const hasFallback = Object.hasOwn(params, 'local_fallback_from_request_id');
        if (payload.operation === 'project_build_status' && !hasFallback) return await receipts.status(project, request);
        const fromRequestId = hasFallback ? readProjectBuildRequest({ version: 1, requestId: params['local_fallback_from_request_id'] }).requestId : undefined;
        if (hasFallback && (payload.operation !== 'project_build' || params['preprocess_only'] === true
          || params['clear_cache'] === true || request.requestId === fromRequestId)) {
          throw Object.assign(new Error('A local fallback requires a new full compile request with its original cloud receipt.'), { code: 'BUILD_FALLBACK_UNAVAILABLE' });
        }
        delete params['buildRequest'];
        delete params['local_fallback_from_request_id'];
        params['buildLogRequestId'] = request.requestId;
        const signature = JSON.stringify([params['preprocess_only'] === true, params['clear_cache'] === true, fromRequestId]);
        return await receipts.start(project, request, signature, control => {
          if (control.local) params[buildFallbackControl] = control;
          else if (params['preprocess_only'] !== true) {
            const capture = () => window['fs']?.captureProjectAttachment?.(project) as ProjectStorageAttachment | undefined;
            let attachment: ProjectStorageAttachment | undefined;
            try { attachment = capture(); } catch { /* The original build can still run without a fallback receipt. */ }
            if (attachment?.version === 1) params[buildFallbackControl] = {
              recordCloudFailure: (error, assertSourceCurrent) => control.recordCloudFailure?.(error, async () => {
                const checkAttachment = () => {
                  if (JSON.stringify(capture()) !== JSON.stringify(attachment)) {
                    throw Object.assign(new Error('The cloud build project is no longer the same physical project.'), { code: 'BUILD_FALLBACK_UNAVAILABLE' });
                  }
                };
                checkAttachment();
                await assertSourceCurrent();
                checkAttachment();
              }),
            };
          }
          return this.executeAdmittedOperation({ ...payload, path: project, params });
        }, fromRequestId);
      } catch (error) {
        return { ok: false, operation: payload.operation, project, code: (error as any)?.code, buildOutcome: 'not-started',
          message: error instanceof Error ? error.message : String(error) };
      }
    }
    if (payload.operation === 'project_build' && Object.hasOwn(payload.params || {}, 'local_fallback_from_request_id')) {
      return { ok: false, operation: payload.operation, buildOutcome: 'not-started', code: 'BUILD_FALLBACK_UNAVAILABLE',
        message: 'Local fallback requires a new and original build receipt.' };
    }
    return this.executeAdmittedOperation(payload);
  }

  private canvasScope(payload: BlocklyLiveOperationPayload) {
    const project = this.projectService.currentProjectPath, rendererGeneration = payload.rendererGeneration;
    const viewRevision = this.projectService.projectViewRevision;
    if (!project || !payload.path || this.normalizePath(payload.path) !== this.normalizePath(project)
      || typeof rendererGeneration !== 'number' || !Number.isSafeInteger(rendererGeneration) || rendererGeneration < 1
      || rendererGeneration !== this.electronService.currentRendererGeneration
      || !Number.isSafeInteger(viewRevision) || viewRevision < 0) return;
    try {
      const attachment: ProjectStorageAttachment | undefined = window['fs']?.captureProjectAttachment?.(project);
      if (attachment?.version === 1) return { version: 1 as const, attachment, rendererGeneration, viewRevision };
    } catch { /* The physical project is no longer verifiable. */ }
  }

  private observeCanvasVersion(payload: BlocklyLiveOperationPayload): Record<string, any> {
    const params = payload.params ?? {}, probeId = params['probeId'];
    const operation = 'project_canvas_status';
    if (params['version'] !== 1 || typeof probeId !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(probeId)
      || Object.keys(params).some(key => key !== 'version' && key !== 'probeId'))
      return { ok: false, operation, code: 'PROJECT_CANVAS_STATUS_INVALID' };
    const unknown = { ok: false, operation, probeId, code: 'PROJECT_CANVAS_STATUS_UNKNOWN' };
    try {
      const before = this.canvasScope(payload), project = this.projectService.currentProjectPath;
      if (!before || this.projectService.getProjectMode(project) !== 'blockly'
        || !this.projectService.getBlocklyProjectLoadStatus(project).ready
        || this.projectService.isProjectTransitionInProgress(project)) return unknown;
      const workingRevision = this.blocklyEditor.readCanvasWorkingRevision();
      if (typeof workingRevision !== 'number' || !Number.isSafeInteger(workingRevision) || workingRevision < 0
        || absJson(this.canvasScope(payload) ?? null) !== absJson(before)) return unknown;
      return { ok: true, operation, probeId, project, canvasVersion: { ...before, workingRevision } };
    } catch { return unknown; }
  }

  private async admissionGuard(requested: string | undefined): Promise<{ project: string; guard: () => void } | undefined> {
    const project = this.projectService.currentProjectPath;
    if (!project) return;
    const current = this.projectService.captureCurrentProjectGuard();
    if (requested && !await sameAbsProjectDirectory(requested, project, window['fs']?.realpathAsync, window['platform']?.isWindows === true)) return;
    if (!current()) return;
    return { project, guard: () => {
      if (!current()) throw Object.assign(new Error('The original request project changed during admission.'), { code: 'PROJECT_ADMISSION_CONTEXT_STALE' });
    } };
  }

  private async observeClosedWorkspaceMode(payload: BlocklyLiveOperationPayload) {
    const { operation, path: project, lifecycle, rendererGeneration } = payload;
    if (!project || lifecycle?.sourceProject !== null || lifecycle.rendererGeneration !== rendererGeneration
      || this.projectService.currentProjectPath || this.projectService.getProjectMode(project) !== 'blockly') {
      return { ok: false, operation, code: 'PROJECT_LIFECYCLE_TARGET_UNCONFIRMED' };
    }
    const revision = this.projectService.projectViewRevision;
    return absWorkspaceProtocol(project, { version: 1 }, () => {
      if (this.projectService.currentProjectPath || this.projectService.projectViewRevision !== revision) {
        throw Object.assign(new Error('The original closed project view changed.'), { code: 'PROJECT_LIFECYCLE_CONTEXT_CHANGED' });
      }
    });
  }

  /** Read the exact original application independently of the current canvas. */
  private async observeApplicationAdmission(payload: BlocklyLiveOperationPayload) {
    const project = payload.path, { version, requestId, originalTargetPid } = payload.params ?? {};
    const unknown = { ok: false, operation: 'abs_apply', project, publication: { status: 'UNKNOWN' },
      applicationObservation: { version: 1, requestId, observationOnly: true, resultKnown: false, current: false } };
    if (typeof project !== 'string' || !window['path']?.isAbsolute(project) || version !== 2
      || typeof requestId !== 'string' || !/^[A-Za-z0-9-]{16,80}$/.test(requestId)
      || originalTargetPid !== undefined && (!Number.isSafeInteger(originalTargetPid) || originalTargetPid <= 0)
      || Object.keys(payload.params ?? {}).some(key => !['version', 'requestId', 'originalTargetPid'].includes(key))) {
      return { ...unknown, code: 'ABS_ADMISSION_STATUS_INVALID' };
    }
    try {
      const port = await openAbsHostStorage(project, () => {});
      const admissions = new OriginalRequestAdmissions(port, project);
      const record = await admissions.observe({ operation: 'abs_apply', requestId });
      if (record && (originalTargetPid === undefined || record.executor.hostPid === originalTargetPid))
        return observedApplicationAdmission(record, port.executor);
      if (!record && originalTargetPid !== undefined) {
        if (await port.read(await applicationRequestKey(requestId)) !== null) {
          const { result } = await new AbsApplicationJournal(port, project).observe(requestId, () => {}, originalTargetPid);
          if (result.publicationObservation?.executor.hostPid === originalTargetPid
            || result.writerObservation?.executor.hostPid === originalTargetPid) return result;
        }
        const writer = await admissions.observeExitedApplicationWriter(requestId, originalTargetPid);
        if (writer) return { ...unknown, code: 'ABS_APPLY_WRITER_UNAVAILABLE',
          writerObservation: { version: 1, ...writer, observer: { hostPid: port.executor?.hostPid ?? null } } };
      }
    } catch { /* Keep the result unknown without an exact original proof. */ }
    return { ...unknown, code: 'ABS_APPLY_OBSERVATION_UNKNOWN' };
  }

  private async executeBoardEnvironmentSettlement(payload: BlocklyLiveOperationPayload, blocklyProgram: boolean) {
    const params = payload.params || {}, project = payload.path, operation = 'project_board_environment_settle';
    const hostPid = params['originalTargetPid'];
    let requestId: string | undefined;
    try {
      const request = readProjectSaveRequest(params['saveRequest']);
      requestId = request.requestId;
      if (!blocklyProgram || request.version !== 2 || request.operation !== 'project_save' || !request.input
        || !Number.isSafeInteger(hostPid) || hostPid < 1 || typeof project !== 'string' || !window['path']?.isAbsolute(project)
        || Object.keys(params).some(key => !['saveRequest', 'originalTargetPid'].includes(key))) {
        throw Object.assign(new Error('Board settlement requires an exact project and original publication.'),
          { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
      }
      const scope = await this.admissionGuard(project);
      if (!scope) throw Object.assign(new Error('The original board project is no longer open in this host.'),
        { code: 'PROJECT_ADMISSION_CONTEXT_STALE' });
      const host = window['libraryDependencies'];
      if (host?.environmentVersion !== 2 || typeof host.pendingEnvironment !== 'function' || typeof host.settleLinkedEnvironment !== 'function')
        throw Object.assign(new Error('The matching linked dependency publisher is unavailable.'),
          { code: 'LIBRARY_ENVIRONMENT_UNAVAILABLE' });
      const io = await openAbsHostStorage(scope.project, scope.guard);
      const identity = await nativeSaveIdentity(io.attachment?.root ?? scope.project, request);
      const environmentStatus = await settleOriginalBoardEnvironment(io, scope.project, { request: identity, hostPid }, host, scope.guard);
      return { ok: true, operation, project, requestId, environmentStatus };
    } catch (error) {
      return { ok: false, operation, project, requestId, environmentStatus: 'pending',
        code: (error as any)?.code ?? 'LIBRARY_ENVIRONMENT_UNCERTAIN',
        message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeApplyAdmission(payload: BlocklyLiveOperationPayload, requestId: string): Promise<Record<string, any>> {
    const scope = await this.admissionGuard(payload.path);
    const rejected = { ok: false, operation: 'abs_apply', code: 'PROJECT_ADMISSION_CONTEXT_STALE',
      message: 'The original application target is no longer open in this host.' };
    const project = scope?.project ?? payload.path;
    if (!project || (!scope && !payload.originalAdmissionAttachment)) return rejected;
    const key = project + '\0' + requestId;
    const pending = {
      ok: false, operation: 'abs_apply', project, code: 'ABS_APPLY_OBSERVATION_PENDING',
      publication: { status: 'UNKNOWN' }, message: 'Observe the original application; it is still settling.',
    };
    if (this.pendingOriginalAdmissions.has(key)) return pending;
    this.pendingOriginalAdmissions.add(key);
    try {
      const { port, settlementGuard } = await this.openAdmissionStorage(payload, project, scope?.guard);
      const identity = { operation: 'abs_apply' as const, requestId };
      const admissions = new OriginalRequestAdmissions(port, project);
      const priorAdmission = await admissions.observe(identity);
      if (priorAdmission) return observedApplicationAdmission(priorAdmission);
      try { await admissions.assertApplicationWriter(requestId, payload.params?.['validation']?.candidate?.hash, port); }
      catch { return pending; }
      if (await port.read(await applicationRequestKey(requestId)) !== null) {
        return scope ? (await new AbsApplicationJournal(port, project).observe(requestId, scope.guard)).result : pending;
      }
      return await this.settleAdmissionFailure(admissions, identity, settlementGuard, markWriter => {
        if (!scope) return Promise.resolve(rejected);
        scope.guard();
        try { requireProjectProgramPublication(); }
        catch (error) { return Promise.resolve(absPrecommitFailure('abs_apply', error)); }
        return this.executeAdmittedOperation({ ...payload, path: project }, undefined, () => { scope.guard(); markWriter(); });
      });
    } finally {
      this.pendingOriginalAdmissions.delete(key);
    }
  }

  private observeStatePublication(payload: BlocklyLiveOperationPayload) {
    const path = payload.path;
    if (typeof path !== 'string' || !window['path']?.isAbsolute(path)) {
      return { ok: false, operation: 'abs_recovery', code: 'ABS_REQUEST_INVALID', candidateApplied: false };
    }
    return this.absGenerationTools.observeBlockState(path, payload.params ?? {}, () => this.projectService.projectViewRevision);
  }

  private async executeStateAdmission(payload: BlocklyLiveOperationPayload, request: AbsBlockStateUpdateRequest) {
    const scope = await this.admissionGuard(payload.path);
    const path = scope?.project ?? payload.path;
    const refusal = { ok: false, operation: 'blocks_set_state', code: 'PROJECT_ADMISSION_CONTEXT_STALE',
      message: 'The original block state target is no longer open.' };
    if (!path || !scope && !payload.originalAdmissionAttachment) return { ...refusal, commandDispatched: false };
    const { port, settlementGuard } = await this.openAdmissionStorage(payload, path, scope?.guard);
    const project = port.attachment?.root ?? path;
    const nativeRequest = await blockStatePublicationIdentity(project, request);
    const identity = nativeSaveAdmissionIdentity(nativeRequest)!;
    const statePublication = blockStatePublicationReference(request, nativeRequest);
    const key = project + '\0' + nativeRequest.requestId;
    const pending = { ok: false, operation: 'blocks_set_state', project, statePublication,
      code: 'ABS_BLOCK_STATE_PUBLICATION_PENDING', publication: { status: 'UNKNOWN' }, candidateApplied: false };
    if (this.pendingOriginalAdmissions.has(key)) return pending;
    this.pendingOriginalAdmissions.add(key);
    try {
      const admissions = new OriginalRequestAdmissions(port, project);
      const read = () => observeNativePublication(port, project, nativeRequest, { originalTargetPid: port.executor?.hostPid ?? undefined });
      const existing = await read();
      if (existing) return { ...pending, ...existing, ...existing.result, operation: 'blocks_set_state' };
      const result = await this.settleAdmissionFailure(admissions, identity, settlementGuard, async markWriter => {
        if (!scope) return refusal;
        scope.guard();
        const writer = await admissions.reserveSave(nativeRequest, this.projectService.projectViewRevision, scope.guard);
        if (!writer) return pending;
        return this.executeAdmittedOperation({ ...payload, path }, undefined, () => { scope.guard(); markWriter(); });
      });
      if (result['admission']?.status !== 'NOT_STARTED') return result;
      const observed = await read();
      return observed
        ? { ...pending, ...observed, ...observed.result, ...result, statePublication }
        : pending;
    } finally {
      this.pendingOriginalAdmissions.delete(key);
    }
  }

  private async executeSaveAdmission(payload: BlocklyLiveOperationPayload, path: string, request: ProjectSaveRequest,
    refusal?: { code: string; message: string }) {
    const scope = refusal ? undefined : await this.admissionGuard(path);
    const rejected = { ok: false, operation: request.operation, ...(refusal ?? {
      code: 'PROJECT_ADMISSION_CONTEXT_STALE', message: 'The original save target is no longer open in this host.' }) };
    if (!scope && !payload.originalAdmissionAttachment) return rejected;
    const project = scope?.project ?? path;
    const { port, settlementGuard } = await this.openAdmissionStorage(payload, project, scope?.guard);
    const root = port.attachment?.root ?? project;
    const nativeRequest = await nativeSaveIdentity(root, request), identity = nativeSaveAdmissionIdentity(nativeRequest)!;
    const admissions = new OriginalRequestAdmissions(port, root);
    await admissions.assertSaveWriter(nativeRequest, port, payload.nativeSaveWriter);
    if (payload.operation !== request.operation && (await admissions.observe(identity)
      || await new AbsOperationJournal(port, root).findDocumentSave(nativeRequest, settlementGuard))) {
      return this.projectService.observeProjectPublication(root, request, port.executor!.hostPid);
    }
    return this.settleAdmissionFailure(admissions, identity, settlementGuard, markWriter => {
      if (!scope || payload.nativeSaveWriter && payload.nativeSaveWriter.viewRevision !== this.projectService.projectViewRevision)
        return Promise.resolve(rejected);
      scope.guard();
      requireProjectProgramPublication();
      return this.executeAdmittedOperation(payload, request, () => { scope.guard(); markWriter(); });
    });
  }

  private async prepareOriginalSaveWriter(payload: BlocklyLiveOperationPayload, blocklyProgram: boolean) {
    const operation = 'project_publication_prepare';
    const params = payload.params || {}, path = payload.path;
    try {
      const request = readProjectSaveRequest(params['saveRequest']);
      if (!blocklyProgram || request.version !== 2 || !path
        || !window['path']?.isAbsolute(path) || !payload.originalAdmissionAttachment
        || params['project'] !== undefined && this.normalizePath(params['project']) !== this.normalizePath(path)
        || Object.keys(params).some(key => !['project', 'saveRequest'].includes(key)))
        throw Object.assign(new Error('Preparing a save requires the exact original active project and native request.'), { code: 'PROJECT_SAVE_RECEIPT_INVALID' });
      const scope = await this.admissionGuard(path);
      const revision = this.projectService.projectViewRevision;
      const guard = () => {
        if (!scope || this.projectService.projectViewRevision !== revision)
          throw Object.assign(new Error('The original save canvas changed.'), { code: 'PROJECT_ADMISSION_CONTEXT_STALE' });
        scope.guard();
      };
      guard();
      requireProjectProgramPublication();
      const port = await openAbsHostStorage(path, guard);
      if (absJson(port.attachment) !== absJson(payload.originalAdmissionAttachment))
        throw Object.assign(new Error('The original physical save target changed.'), { code: 'PROJECT_ADMISSION_ATTACHMENT_CHANGED' });
      const project = port.attachment?.root ?? path;
      const identity = await nativeSaveIdentity(project, request);
      const saveWriter = await new OriginalRequestAdmissions(port, project).reserveSave(identity, revision, guard);
      if (!saveWriter) return { ok: false, operation, project, code: 'PROJECT_SAVE_REQUEST_CONSUMED', commandDispatched: false };
      return { ok: true, operation, project, saveWriter };
    } catch (error) {
      return { ok: false, operation, code: (error as any)?.code ?? 'PROJECT_SAVE_RECEIPT_FAILED',
        commandDispatched: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executePreparedBoardPublication(payload: BlocklyLiveOperationPayload) {
    const path = payload.path, params = payload.params || {};
    if (!path) return { ok: false, code: 'PROJECT_SAVE_RECEIPT_INVALID', commandDispatched: false };
    const input = payload.operation === 'board_switch'
      ? { kind: 'board-switch' as const, boardName: params['boardName'] }
      : { kind: 'board-config' as const, configKey: params['config_key'], configValue: params['config_value'] };
    const request = boardPublicationRequest(input, readProjectSaveRequest(params['saveRequest']));
    const key = path + '\0' + request.requestId;
    const pending = { ok: false, operation: payload.operation, project: path, code: 'PROJECT_SAVE_OBSERVATION_REQUIRED',
      publication: { status: 'UNKNOWN' } };
    if (this.pendingOriginalAdmissions.has(key)) return pending;
    this.pendingOriginalAdmissions.add(key);
    try {
      return await this.executeSaveAdmission(payload, path, request);
    } finally {
      this.pendingOriginalAdmissions.delete(key);
    }
  }

  private async openAdmissionStorage(payload: BlocklyLiveOperationPayload, project: string, activeGuard: (() => void) | undefined) {
    // The main process supplies the original physical scope before forwarding
    // the command. The native lock still guards that exact storage throughout
    // settlement. Only the writer continues to require the active canvas.
    const attachment = payload.originalAdmissionAttachment;
    const settlementGuard = attachment ? () => undefined : activeGuard;
    if (!settlementGuard) throw new Error('Original admission settlement requires a project guard.');
    const port = await openAbsHostStorage(project, settlementGuard);
    if (attachment && absJson(attachment) !== absJson(port.attachment)) throw Object.assign(
      new Error('The original physical project changed before admission settlement.'),
      { code: 'PROJECT_ADMISSION_ATTACHMENT_CHANGED' });
    return { port, settlementGuard };
  }

  private async settleAdmissionFailure(admissions: OriginalRequestAdmissions, identity: OriginalRequestAdmissionIdentity,
    guard: () => void, run: (markWriter: () => void) => Promise<Record<string, any>>) {
    let writerReached = false, result: Record<string, any>;
    try { result = await run(() => { guard(); writerReached = true; }); }
    catch (error) {
      if (writerReached) throw error;
      result = { ok: false, code: (error as any)?.code, message: error instanceof Error ? error.message : String(error) };
    }
    // The ABS coordinator also reports prechecks inside apply as explicitly
    // not-started. No other post-admission failure can acquire this proof.
    const application = identity.operation === 'abs_apply';
    if (result['ok'] !== false || writerReached && !(application && result['application']?.status === 'NOT_STARTED'
      && result['publication']?.status === 'NOT_COMMITTED')) return result;
    const code = result['code'] ?? result['reason'] ?? 'PROJECT_OPERATION_NOT_STARTED';
    const message = result['message'] ?? 'The original operation was rejected before starting.';
    const retained = await admissions.reject(identity, { code, message }, guard);
    if (!retained) return { ok: false, operation: identity.operation, code: 'PROJECT_ADMISSION_OBSERVATION_REQUIRED',
      message: 'The original operation has an execution record. Observe its result.' };
    return { ...result, ...originalAdmissionOutcome(retained) };
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
    const updated: Record<string, any> = { ...result, activated, loadStatus,
      projectionPending: result['projectionPending'] === true };
    if (activated && updated['code'] === 'PROJECT_RECOVERY_RUNTIME_REQUIRED') {
      delete updated['code']; delete updated['error'];
      updated['warnings'] = Array.isArray(updated['warnings']) ? updated['warnings'].filter((value: unknown) =>
        typeof value !== 'string' || !/Load (?:the )?target runtime|Load its runtime/i.test(value)) : [];
      updated['message'] = 'The current project runtime is loaded. Projection and generated output retain their separately reported state.';
    }
    return updated;
  }

  private sameProjectRecoveryVerification(project: string, requestId: string, inputAbiHash?: string) {
    const ready = this.normalizePath(this.projectService.currentProjectPath) === this.normalizePath(project)
      && this.projectService.getBlocklyProjectLoadStatus(project).ready === true;
    const currentAbiHash = ready ? window['fs']?.projectRecoveryReceipts?.abiHash(project) : undefined;
    return { version: 1, ok: ready && /^sha256:[a-f0-9]{64}$/.test(currentAbiHash ?? ''), requestId,
      project, sameProject: true, activated: ready, ready, candidateApplied: false,
      ...(currentAbiHash ? { currentAbiHash } : {}), ...(inputAbiHash ? { inputAbiHash } : {}) };
  }

  private async executeRecoveryOpen(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    const params = payload.params || {}, project = params['project'] || payload.path;
    try {
      const request = readProjectForkRequest({ version: params['version'], requestId: params['requestId'] });
      if (Object.keys(params).some(key => !['version', 'requestId', 'project', 'observe'].includes(key))
        || params['observe'] !== undefined && typeof params['observe'] !== 'boolean'
        || typeof project !== 'string' || !window['path']?.isAbsolute(project)
        || payload.path && this.normalizePath(payload.path) !== this.normalizePath(project))
        throw Object.assign(new Error('Recovery opening requires its exact saved source and request.'), { code: 'PROJECT_RECOVERY_OPEN_INVALID' });
      const current = this.projectService.currentProjectPath;
      if (!params['observe'] && current && this.normalizePath(current) === this.normalizePath(project)) return {
        ok: this.projectService.getBlocklyProjectLoadStatus(project).ready === true, operation: 'project_recovery_open', project,
        receipt: { version: 1, requestId: request.requestId, state: 'completed' },
        sourceGuardReleased: false, observedOpen: true,
        loadStatus: this.projectService.getBlocklyProjectLoadStatus(project),
        projectRecoveryVerification: this.sameProjectRecoveryVerification(project, request.requestId),
      };
      const native = window['fs']?.projectRecoveryReceipts;
      if (!native) throw Object.assign(new Error('Recovery opening requires the matching native receipt host.'), { code: 'PROJECT_FORK_RECEIPT_UNAVAILABLE' });
      const receipts = this.forkReceipts ??= new ProjectForkReceipts(native, result => this.refreshForkResult(result));
      const observed = params['observe'] === true ? receipts.status(project, request) : undefined;
      const result = observed ? observed['result'] ?? observed : await receipts.start(project, request, 'same-project-recovery-open', () => {
        if (this.absApplyInProgress || this.boardSwitchInProgress) return Promise.resolve({
          ok: false, operation: 'project_fork', sourceProject: project, projectSaved: false,
          code: 'PROJECT_RECOVERY_OPEN_BUSY', message: 'A host mutation still owns its operation; no source was opened or changed.' });
        if (this.projectService.currentProjectPath) return Promise.resolve({
          ok: false, operation: 'project_recovery_open', project, projectSaved: false, activated: false,
          code: 'PROJECT_RECOVERY_OPEN_VIEW_ACTIVE', message: 'The current view is retained; recovery cannot replace it.' });
        return this.projectService.projectOpen(project, { saveBeforeReload: false }).then(opened => {
          const loadStatus = this.projectService.getBlocklyProjectLoadStatus(project);
          return { ok: opened === true && loadStatus.ready === true, operation: 'project_recovery_open',
            project, sourceProject: project, projectSaved: false, activated: opened === true && loadStatus.ready === true,
            candidateApplied: false, sameProject: true, loadStatus,
            ...(!loadStatus.ready ? { code: 'PROJECT_RECOVERY_OPEN_NOT_READY',
              message: loadStatus.error ?? 'The same project is not ready; its source and owner protections were retained.',
              ...projectLoadFailureGuidance(project, loadStatus) } : {}) };
        });
      });
      return { ok: result['ok'] === true, operation: 'project_recovery_open', project,
        sourceGuardReleased: false, result,
        ...(result['sameProject'] === true && result['project'] === project ? {
          projectRecoveryVerification: this.sameProjectRecoveryVerification(project, request.requestId,
            result['forkReceipt']?.sourceAbiHash ?? observed?.['forkReceipt']?.sourceAbiHash) } : {}),
        ...(result['ok'] !== true ? { code: result['code'], message: result['message'],
          ...(result['nextAction'] ? { nextAction: result['nextAction'], guidance: result['guidance'] } : {}),
          ...(['PROJECT_FILE_BUSY', 'PROJECT_RECOVERY_SOURCE_BUSY', 'PROJECT_RECOVERY_SOURCE_UNVERIFIED'].includes(result['code'])
            ? { nextAction: { tool: 'app_info', input: {} },
              guidance: 'Source-copy admission did not establish a safe read scope. Keep the source, candidate and owner records. Observe app_info and the existing operation; retry only after its actual state changes. Do not delete locks, force rebind, loop unchanged requests or ask the user to repair internal files.' } : {}) } : {}),
        receipt: { version: 1, requestId: request.requestId, state: observed?.['forkReceipt']?.state ?? result['forkReceipt']?.state ?? 'unknown' } };
    } catch (error) {
      return { ok: false, operation: 'project_recovery_open', project, sourceGuardReleased: false,
        code: (error as any)?.code || 'PROJECT_RECOVERY_OPEN_FAILED',
        message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeAdmittedOperation(payload: BlocklyLiveOperationPayload, nativeSaveRequest?: ProjectSaveRequest,
    markWriter?: () => void): Promise<Record<string, any>> {
    const rejection = rejectAbsLiveRequest(payload.operation || '', payload.params || {});
    if (rejection) return { ...rejection, project: this.projectService.currentProjectPath };
    const execute = () => markWriter ? this.executeOperation(payload, nativeSaveRequest, undefined, markWriter)
      : nativeSaveRequest ? this.executeOperation(payload, nativeSaveRequest) : this.executeOperation(payload);
    // The coordinator consumes exact journal authority before invoking the
    // domain lifecycle gate. A generic mutation mask would block its own
    // reopen; all other recovery/writing operations retain their admission.
    if (payload.operation === 'library_mutation_abort' || (payload.operation === 'library_history_navigation' && payload.params?.['action'] === 'release')) return execute();
    const journalReopen = payload.operation === 'abs_recovery' && payload.params?.['action'] === 'reopen';
    const recoveryInspection = payload.operation === 'abs_recovery' && payload.params?.['action'] === 'inspect';
    const candidateBackup = payload.operation === 'abs_recovery'
      && ['preserve_candidate', 'read_candidate'].includes(payload.params?.['action']);
    const runtimeRecovery = payload.operation === 'abs_recovery'
      && (['recover_runtime', 'recover_project', 'observe_apply', 'cancel_project'].includes(payload.params?.['action'])
        || projectLockMaintenance.has(payload.params?.['action']));
    const recoveryPath = payload.path || this.projectService.currentProjectPath;
    // A navigation can already own the target even though its editor failed or
    // is still loading. Advertise only the verified on-disk engine in that case.
    if (payload.operation === 'abs_protocol' && payload.params?.['action'] === 'prepare_workspace_migration'
      && this.projectService.getProjectMode(recoveryPath) === 'blockly' && !this.getProjectRuntimeStatus(recoveryPath).ready) {
      return this.observeDeferredWorkspacePreparation(payload);
    }
    const recoveryDependencyReload = payload.operation === 'library_runtime_sync'
      && this.projectService.hasSavedRecoveryTarget?.(recoveryPath)
      && this.projectService.getBlocklyProjectLoadStatus(recoveryPath).ready === false;
    if (journalReopen || recoveryInspection || observesAbsDisk(payload) || candidateBackup || runtimeRecovery || recoveryDependencyReload || (!PROJECT_MUTATIONS.has(payload.operation || '')
      && !(payload.operation === 'blocks_set_state' && payload.params?.['action'] === 'update')
      && !(payload.operation === 'abs_protocol' && payload.params?.['action'] === 'prepare_workspace_migration'))) return execute();
    const projectPath = payload.path || this.projectService.currentProjectPath;
    if (this.projectService.isProjectTransitionInProgress(projectPath)
      && !(this.projectService.isLibraryMutationInProgress(projectPath)
        && (['library_runtime_sync', 'library_mutation_abort'].includes(payload.operation || '') || this.isOwnedLibraryHistorySync(payload, projectPath)))) {
      return { ok: false, operation: payload.operation, project: projectPath, reason: 'project_lifecycle_busy',
        ...(payload.operation === 'project_build' ? { buildOutcome: 'not-started' } : {}),
        message: '项目正在切换、重载或关闭；本次写入尚未开始，请等待该宿主操作完成。' };
    }
    const source = `live-project-mutation:${++this.mutationSequence}`;
    this.aiOperations.setActive(source, true, { projectPath, blocksProjectLifecycle: true });
    try { return await execute(); }
    finally { this.aiOperations.setActive(source, false); }
  }

  private async observeDeferredWorkspacePreparation(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    const input = payload.params || {};
    if (input['version'] !== 1 || Object.keys(input).some(key => !['version', 'action'].includes(key))) {
      return { ok: false, operation: 'abs_protocol', commandDispatched: false, code: 'ABS_REQUEST_INVALID',
        message: 'Migration preparation requires version 1 and its runtime action.' };
    }
    const scope = await this.admissionGuard(payload.path);
    if (!scope || this.projectService.getProjectMode(scope.project) !== 'blockly') {
      return { ok: false, operation: 'abs_protocol', commandDispatched: false, code: 'PROJECT_ADMISSION_CONTEXT_STALE',
        message: 'The original prepared workspace no longer belongs to the current project.' };
    }
    const reply = await absWorkspaceProtocol(scope.project, { version: 1 }, scope.guard);
    return reply.ok && reply.protocol && 'workspaceMode' in reply.protocol && reply.protocol.workspaceMode === 'overlay-v1'
      ? { ...reply, migrationDeferred: { version: 1, reason: 'editor-not-ready' } } : reply;
  }

  private isOwnedLibraryHistorySync(payload: BlocklyLiveOperationPayload, projectPath: string): boolean {
    return payload.operation === 'library_history_navigation' && payload.params?.['action'] === 'synchronize'
      && this.projectService.ownsLibraryHistoryNavigation(payload.params['token'], projectPath);
  }

  private async retireProjectLock(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    const { path, params = {}, originalAdmissionAttachment } = payload;
    const { version, action, requestId, attachment, marker } = params;
    const result = { operation: 'abs_recovery', project: path };
    const complete = action === 'retire_project_file_lock';
    const allowed = ['version', 'action', 'requestId', 'attachment', 'marker'];
    if (version !== 2 || !path || !window['path']?.isAbsolute(path)
      || Object.keys(params).some(key => !allowed.includes(key)) || !attachment || !marker) {
      return { ...result, ok: false, code: 'ABS_REQUEST_INVALID' };
    }
    const stale = () => Object.assign(new Error('The project no longer owns this lock recovery.'), { code: 'PROJECT_ADMISSION_CONTEXT_STALE' });
    try {
      const view = this.projectService.projectViewRevision, renderer = this.electronService.currentRendererGeneration;
      const scope = await this.admissionGuard(path);
      if (!scope || !originalAdmissionAttachment || this.projectService.getProjectMode(scope.project) !== 'blockly') throw stale();
      const current = () => {
        scope.guard();
        if (this.projectService.projectViewRevision !== view || this.electronService.currentRendererGeneration !== renderer
          || payload.rendererGeneration !== undefined && payload.rendererGeneration !== renderer
          || this.projectService.isProjectTransitionInProgress(scope.project)) throw stale();
      };
      const port = await openAbsHostStorage(scope.project, current);
      if (absJson(port.attachment) !== absJson(originalAdmissionAttachment)
        || absJson(port.attachment) !== absJson(attachment)) throw stale();
      const retire = complete ? port.retireProjectFileLock : port.retireEmptyProjectFileLock;
      if (!retire) return { ...result, ok: false, code: 'PROJECT_LOCK_RECOVERY_UNSUPPORTED' };
      const retired = await retire({ attachment, marker });
      return { ...result, project: scope.project, ok: true, receipt: { version, action, requestId }, retired };
    } catch (error) {
      return { ...result, ok: false, code: (error as { code?: string })?.code ?? 'PROJECT_LOCK_RECOVERY_UNAVAILABLE' };
    }
  }

  private async executeOperation(payload: BlocklyLiveOperationPayload, nativeSaveRequest?: ProjectSaveRequest, lifecycleOwner?: symbol,
    markWriter?: () => void,
    onViewActivated?: (project: string | null, revision: number) => void | Promise<void>,
    navigation?: { requestId: string; transition: ProjectNavigationTransition }): Promise<Record<string, any>> {
    if (payload.operation === 'project_navigation_status'
      || ['project_open', 'project_close'].includes(payload.operation || '') && Object.hasOwn(payload.params || {}, 'navigationRequest')) {
      return this.executeProjectNavigationSettlement(payload);
    }
    if (payload.operation === 'project_create_status' || payload.operation === 'project_create_cancel'
      || payload.operation === 'project_create' && Object.hasOwn(payload.params || {}, 'createRequest')) {
      return this.executeProjectCreateSettlement(payload);
    }
    if (payload.lifecycle !== undefined && lifecycleOwner === undefined
      && ['project_create', 'project_open', 'project_close', 'project_reload'].includes(payload.operation || '')) {
      const assertCurrent = createProjectLifecycleAssertion(payload.lifecycle,
        () => this.projectService.currentProjectPath || null,
        () => this.electronService.currentRendererGeneration, payload.rendererGeneration);
      return this.projectService.withProjectLifecycleAdmission(assertCurrent,
        owner => this.executeOperation(payload, nativeSaveRequest, owner));
    }
    if (payload.operation === 'abs_recovery' && ['preserve_candidate', 'read_candidate'].includes(payload.params?.['action'])) {
      const project = this.projectService.currentProjectPath;
      const check = () => { if (!project || this.projectService.currentProjectPath !== project)
        throw Object.assign(new Error('The candidate backup project is no longer current.'), { code: 'ABS_CANDIDATE_ARCHIVE_CONTEXT_STALE' }); };
      const matches = !payload.path || await sameAbsProjectDirectory(payload.path, project,
        window['fs']?.realpathAsync, window['platform']?.isWindows === true);
      if (!project || !matches || this.projectService.currentProjectPath !== project) return {
        ok: false, operation: 'abs_recovery', project, code: 'ABS_CANDIDATE_ARCHIVE_CONTEXT_STALE', candidateApplied: false,
        message: 'The current project does not match this candidate backup; no source was changed.' };
      return this.absGenerationTools.candidateBackup(project, payload.params || {}, check);
    }
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
    if (payload.operation === 'abs_recovery' && projectLockMaintenance.has(payload.params?.['action'])) {
      return this.retireProjectLock(payload);
    }
    if (payload.operation === 'abs_recovery' && payload.params?.['action'] === 'cancel_project') {
      const { path, params } = payload;
      if (params['version'] !== 2 || !path || !window['path']?.isAbsolute(path)
        || Object.keys(params).some(key => !['version', 'action', 'requestId'].includes(key))) {
        return { ok: false, operation: 'abs_recovery', code: 'ABS_REQUEST_INVALID' };
      }
      return this.projectService.cancelFailedBlocklyProject(path, params['requestId']);
    }
    if (payload.operation === 'abs_recovery' && payload.params?.['action'] === 'recover_project' && payload.params?.['observe'] === true) {
      const active = this.projectService.currentProjectPath, original = payload.path;
      if (original && !window['path']?.isAbsolute(original)) return { ok: false, operation: 'abs_recovery', code: 'ABS_REQUEST_INVALID' };
      const matches = original && active && await sameAbsProjectDirectory(original, active,
        window['fs']?.realpathAsync, window['platform']?.isWindows === true);
      return this.projectService.recoverFailedBlocklyProject(payload.params['requestId'], true, undefined, undefined,
        matches ? active : original);
    }
    const inspection = ['project_load_status', 'app_info', 'search_boards_libraries'].includes(payload.operation || '')
      || payload.operation === 'abs_recovery' && payload.params?.['action'] === 'observe_apply'
      || observesAbsDisk(payload);
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
      return onViewActivated ? this.executeProjectOpen(payload.path || '', lifecycleOwner, onViewActivated, navigation)
        : this.executeProjectOpen(payload.path || '', lifecycleOwner);
    }
    if (payload.operation === 'project_close') {
      return onViewActivated ? this.executeProjectClose(payload.path, lifecycleOwner, onViewActivated)
        : this.executeProjectClose(payload.path, lifecycleOwner);
    }
    if (payload.operation === 'project_load_status') {
      const path = payload.path || this.projectService.currentProjectPath;
      const buildPreparation = {
        dependenciesPreparing: this.projectService.isProjectDependencyPreparationInProgress(path),
        compileBackend: this.projectService.isCloudBuild(path) ? 'cloud' : 'local',
      };
      if (this.projectService.getProjectMode(path) === 'coder') {
        const opened = this.projectService.coderProjects.some(project => this.normalizePath(project.path) === this.normalizePath(path));
        const ready = opened && this.coderRuntime.getSession(path).editorReady;
        return { ok: opened, operation: payload.operation, project: path, state: ready ? 'loaded' : opened ? 'loading' : 'default', ready, ...buildPreparation };
      }
      return {
        ok: true,
        operation: 'project_load_status',
        ...this.projectService.getBlocklyProjectLoadStatus(payload.path || undefined),
        ...buildPreparation,
      };
    }
    if (payload.operation === 'app_info') {
      return this.executeAppInfo();
    }
    if (payload.operation === 'search_boards_libraries') {
      return this.executeSearchBoardsLibraries(payload.params || {});
    }
    if (payload.operation === 'project_create') {
      return this.executeProjectCreate(payload.params || {}, lifecycleOwner);
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
      if (payload.operation === 'project_upload'
        && ['preparedFirmware', 'reuseCloudFirmware'].some(key => Object.hasOwn(payload.params ?? {}, key))) {
        return { ok: false, operation: 'project_upload', project: coderPath, code: 'PREPARED_FIRMWARE_UNAVAILABLE',
          message: 'Firmware reuse requires an active Blockly project.' };
      }
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
    if (payload.operation === 'library_history_navigation' && payload.params?.['action'] === 'release') {
      this.projectService.releaseLibraryHistoryNavigation(payload.params['token']);
      return { ok: true };
    }
    if (payload.operation === 'library_mutation_abort') {
      const current = this.projectService.currentProjectPath;
      const matches = payload.path && current && await sameAbsProjectDirectory(payload.path, current,
        window['fs']?.realpathAsync, window['platform']?.isWindows === true);
      await this.projectService.abortLibraryMutation(payload.params?.['token'], payload.params?.['requestId'], matches ? current : payload.path);
      return { ok: true, operation: payload.operation };
    }
    const requestedProject = payload.path;
    const currentProject = this.projectService.currentProjectPath;
    const recoveryView = this.projectService.projectViewRevision;
    if (!currentProject) {
      return { ok: false, ...buildNotStarted, message: '当前主程序未打开项目' };
    }
    const matchesProject = !requestedProject || await sameAbsProjectDirectory(requestedProject, currentProject,
      window['fs']?.realpathAsync, window['platform']?.isWindows === true);
    if (payload.operation === 'abs_recovery' && payload.params?.['action'] === 'recover_project'
      && (recoveryView !== this.projectService.projectViewRevision || payload.rendererGeneration !== undefined
        && payload.rendererGeneration !== this.electronService.currentRendererGeneration)) {
      return { ok: false, operation: 'abs_recovery', project: currentProject, code: 'PROJECT_RECOVERY_CONTEXT_STALE' };
    }
    if (!matchesProject || currentProject !== this.projectService.currentProjectPath) {
      if (payload.operation === 'project_reload') return {
        ok: false, operation: 'project_reload', code: 'PROJECT_RELOAD_TARGET_MISMATCH', commandDispatched: false,
        message: 'Reload requires the currently open project. Use the project-open operation to switch projects.',
      };
      return {
        ok: false,
        ...buildNotStarted,
        message: `当前打开项目不匹配: ${this.projectService.currentProjectPath}`,
        currentProject: this.projectService.currentProjectPath,
      };
    }

    // Static negotiation must remain reachable after failed loading. Its route
    // is still bound to this original project and its actual project mode.
    if (payload.operation === 'abs_protocol' && payload.params?.['action'] !== 'prepare_workspace_migration') {
      if (this.projectService.getProjectMode(currentProject) !== 'blockly') return {
        ok: false, operation: 'abs_protocol', project: currentProject, code: 'ABS_WORKING_CANDIDATE_UNSUPPORTED',
        message: 'This project is not a Blockly program.' };
      return absWorkspaceProtocol(currentProject, payload.params || {}, () => {
        if (this.projectService.currentProjectPath !== currentProject) throw new Error('The protocol project changed.');
      });
    }

    // Dependency evidence is independent of native canvas readiness and never
    // serializes or replaces a failed/partially loaded workspace.
    if (payload.operation === 'project_dependency_recovery') {
      try {
        const result = await this.projectService.recoverLibraryDependencies(payload.params || {});
        return { operation: payload.operation, project: currentProject, ...result };
      } catch (error) { return { ok: false, operation: payload.operation, project: currentProject,
        code: (error as any)?.code || 'LIBRARY_DEPENDENCY_RECOVERY_FAILED', message: error instanceof Error ? error.message : String(error) }; }
    }
    if (payload.operation === 'project_abi_check' && window['libraryDependencies']) {
      const dependencies = await window['libraryDependencies'].status(currentProject);
      if (dependencies.dependencyConflict) return { ok: false, operation: payload.operation, project: currentProject,
        code: 'LIBRARY_DEPENDENCY_CONFLICT', dependencyConflict: dependencies.dependencyConflict,
        unsavedLibraryChanges: true };
    }

    if (payload.operation === 'abs_recovery' && payload.params?.['action'] === 'observe_apply') {
      const source = this.projectService.currentProjectPath;
      const guard = () => { if (this.projectService.currentProjectPath !== source) throw new Error('Application observation project changed.'); };
      try {
        if (this.getProjectRuntimeStatus(source).ready && !this.projectService.hasBlocklyRuntimeRecovery?.()) {
          return await this.absGenerationTools.observeApplication(payload.params['requestId']);
        }
        const observed = await new AbsApplicationJournal(await openAbsHostStorage(source, guard), source).observe(payload.params['requestId'], guard);
        observed.result.applicationObservation.current = false;
        return observed.result;
      } catch (error) { return { ok: false, operation: 'abs_apply', project: source, code: (error as any)?.code ?? 'ABS_APPLY_OBSERVATION_UNKNOWN',
        publication: { status: 'UNKNOWN' }, message: error instanceof Error ? error.message : String(error) }; }
    }
    if (payload.operation === 'abs_recovery' && payload.params?.['action'] === 'recover_project'
      && this.getProjectRuntimeStatus(currentProject).ready) {
      return this.projectService.recoverFailedBlocklyProject(payload.params['requestId'], false, async check => {
        check();
        if (this.projectService.isProjectOpening || this.projectService.isProjectTransitionInProgress(currentProject)
          || this.aiOperations.hasBlocking(currentProject)) throw Object.assign(new Error('An active project owner must finish before recovery.'), { code: 'PROJECT_RECOVERY_SOURCE_BUSY' });
        const port = await openAbsHostStorage(currentProject, check);
        await settleAbsProjectOpen(port, currentProject, check);
        const operation = await new AbsOperationJournal(port, currentProject).inspect();
        if (operation) {
          const repaired = await recoverAbsBaseline(port, currentProject, check);
          if (repaired.changed) await new AbsOperationJournal(port, currentProject).reanchorSource(operation.id, check);
          await recoverAbsProjectOperation(port, currentProject, check);
          const opened = await this.projectService.reopenRecoveredBlocklyProject(currentProject, check);
          return { ok: opened.activated, ready: opened.activated, loadStatus: this.getProjectRuntimeStatus(currentProject) };
        }
        const recovery = await recoverAbsBaseline(port, currentProject, check);
        await restoreAbsProjectCaches(port, currentProject, check);
        return { ok: true, ready: true, loadStatus: this.getProjectRuntimeStatus(currentProject), ...recovery };
      });
    }
    if (payload.operation !== 'project_reload') {
      const isBlocklyProject = this.projectService.getProjectMode(this.projectService.currentProjectPath) !== 'coder';
      // Exact archived drafts and original History receipts do not need the current canvas.
      if (isBlocklyProject && observesAbsDisk(payload)) return this.executeAbsRecovery(payload.params ?? {});
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
        if (isBlocklyProject && payload.operation === 'abs_recovery' && payload.params?.['action'] === 'recover_project') {
          const params = payload.params || {};
          const source = this.projectService.currentProjectPath;
          try {
            return await this.projectService.recoverFailedBlocklyProject(params['requestId'], false, undefined, async assertCurrent => {
              const check = () => {
                assertCurrent();
                if (this.projectService.isProjectOpening || this.projectService.isProjectTransitionInProgress(source)
                  || this.aiOperations.hasBlocking(source)) {
                  throw Object.assign(new Error('The failed project has an active owner.'), { code: 'PROJECT_RECOVERY_SOURCE_BUSY' });
                }
              };
              check();
              const port = await openAbsHostStorage(source, check);
              await settleAbsProjectOpen(port, source, check);
              const operation = await new AbsOperationJournal(port, source).inspect();
              if (!operation) await recoverAbsProjectOperation(port, source, check);
              if (await port.read('committed.json') !== null || await port.read('project.abs.map.json') !== null) {
                const repaired = await recoverAbsBaseline(port, source, check);
                if (repaired.changed && operation) await new AbsOperationJournal(port, source).reanchorSource(operation.id, check);
                await restoreAbsProjectCaches(port, source, check);
              }
              if (operation) await recoverAbsProjectOperation(port, source, check);
            });
          } catch (error) { return { ok: false, operation: payload.operation, project: source, recoveryState: 'failed',
            code: (error as any)?.code ?? 'PROJECT_RECOVERY_LOAD_FAILED', message: error instanceof Error ? error.message : String(error) }; }
        }
        // A failed in-place library rebuild retains the complete pre-rebuild
        // snapshot. Its own bounded inspection/recovery does not require the
        // partial canvas to pass ordinary editor-readiness admission.
        if (isBlocklyProject && payload.operation === 'abs_recovery'
          && ['inspect', 'recover_runtime'].includes(payload.params?.['action'])
          && this.projectService.hasBlocklyRuntimeRecovery?.()) {
          if (payload.params?.['observe'] !== true && (this.projectService.isProjectOpening
            || this.projectService.isProjectTransitionInProgress(currentProject) || this.aiOperations.hasBlocking(currentProject))) {
            return { ok: false, operation: payload.operation, project: currentProject,
              code: 'PROJECT_RECOVERY_SOURCE_BUSY', message: 'Observe the active project operation before runtime recovery.' };
          }
          return this.executeAbsRecovery(payload.params || {});
        }
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
          code: loadStatus.error ? 'PROJECT_LOAD_FAILED' : 'PROJECT_NOT_READY',
          ...(['abs_validate', 'abs_apply'].includes(payload.operation || '') ? { publication: { status: 'NOT_COMMITTED' } } : {}),
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

    if (this.projectService.isLibraryMutationInProgress(currentProject)
      && !['library_runtime_sync', 'library_mutation_abort', 'project_abi_check'].includes(payload.operation || '')
      && !this.isOwnedLibraryHistorySync(payload, currentProject)) {
      return { ok: false, code: 'LIBRARY_MUTATION_BUSY', project: currentProject,
        message: '库依赖正在更新，请等待运行时同步结束。' };
    }
    switch (payload.operation) {
      case 'abs_protocol':
        return this.absGenerationTools.workspaceMigration('prepare', payload.params || {});
      case 'abs_workspace_migrate':
        return this.runAbsOperation(() => this.absGenerationTools.workspaceMigration('select', payload.params || {}));
      case 'blocks_set_state':
        return payload.params?.['action'] === 'inspect'
          ? this.absGenerationTools.blockState(payload.params)
          : this.runAbsOperation(() => this.absGenerationTools.blockState(payload.params || {}, markWriter));
      case 'project_media_import':
        return importProjectMedia(currentProject, payload.params as any, undefined,
          target => this.absGenerationTools.captureMediaImportTarget(target));
      case 'abs_apply':
        return this.runAbsOperation(() => this.executeAbsApply(payload.params || {}, markWriter));
      case 'abs_projection':
        return this.executeAbsProjection(payload.params || {});
      case 'abs_validate':
        return this.executeAbsCandidateValidation(payload.params || {});
      case 'abs_recovery':
        return this.executeAbsRecovery(payload.params || {});
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
      case 'library_history_navigation': {
        const params = payload.params || {};
        if (params['action'] === 'begin') return { ok: true, ...await this.projectService.beginLibraryHistoryNavigation(params['changedPaths']) };
        if (params['action'] === 'synchronize') {
          await this.projectService.synchronizeLibraryHistoryNavigation(params['token'], params['changedPaths']);
          return { ok: true };
        }
        throw new Error('Unknown library history action');
      }
      case 'library_mutation_prepare': {
        const params = payload.params || {};
        const request = (params['requestId'] !== undefined || params['expiresAt'] !== undefined)
          ? { requestId: params['requestId'], expiresAt: params['expiresAt'] } : undefined;
        const result = await this.projectService.beginLibraryMutation(params['packages'], params['savedHashes'], params['removedPackages'], request);
        return { ok: true, operation: payload.operation, project: currentProject, ...result };
      }
      case 'library_runtime_sync':
        // The native rebuild owns its workspace edit lease. Discovery and
        // dependency waits must leave the existing canvas interactive.
        return this.executeLibraryRuntimeSync(payload.params || {});
      case 'project_abi_check':
        return this.executeProjectAbiCheck();
      case 'project_build':
        return this.executeProjectBuild(payload.params || {}, currentProject);
      case 'get_board_config':
        return getBoardConfig(this.projectService, payload.params?.['section']);
      case 'board_switch':
        markWriter?.();
        return this.executeBoardSwitch(payload.params || {});
      case 'set_board_config':
        markWriter?.();
        return setBoardConfig(this.projectService, this.builderService, this.electronService, payload.params || {},
          this.projectService.getProjectMode(this.projectService.currentProjectPath) === 'coder'
            ? project => this.coderRuntime.build(project, { preprocessOnly: true }) : undefined,
          this.readBoardPublicationRequest(payload.params || {}, { kind: 'board-config',
            configKey: payload.params?.['config_key'], configValue: payload.params?.['config_value'] }));
      case 'serial_ports_list':
        return this.executeSerialPortsList(payload.params || {});
      case 'project_upload':
        return this.executeProjectUpload(payload.params || {});
      case 'blocks_tidy':
        markWriter?.();
        return this.runBlockWritingOperation(() => this.executeBlocksTidy(nativeSaveRequest));
      case 'project_save':
        markWriter?.();
        return this.runBlockWritingOperation(() => this.executeProjectSave(nativeSaveRequest));
      case 'project_reload':
        return this.executeProjectReload(lifecycleOwner);
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
      'abs_protocol',
      'abs_workspace_migrate',
      'abs_capabilities',
      'abs_compose',
      'abs_precheck',
      'block_metadata_snapshot',
      'library_runtime_sync',
      'library_history_navigation',
      'library_mutation_prepare',
      'library_mutation_abort',
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
      capabilities: { projectBuildReceipts: 1, projectForkReceipts: 1, projectRecoveryOpen: 1,
        projectProgramPublication: 1, projectLifecycle: 1, projectCreateSettlement: 1,
        ...(typeof window['fs']?.captureProjectAttachment === 'function' && this.configService.getPreferredChatAgentRuntimeMode() === 'blockly'
          ? { projectNavigationSettlement: 1, ...(window['projectLock']?.recordNavigation ? { projectNavigationRecovery: 1 } : {}) } : {}),
        ...(window['projectLock']?.recordCreatedActive && this.configService.getPreferredChatAgentRuntimeMode() === 'blockly'
          ? { projectCreateRecovery: 1 } : {}),
        projectPreparedFirmwareUpload: 1, projectCloudFirmwareReuse: 1 },
      lifecycle: { version: 1, sourceProject: this.projectService.currentProjectPath || null },
      projectViewRevision: this.projectService.projectViewRevision,
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
        compileBackend: this.projectService.isCloudBuild() ? 'cloud' : 'local',
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

  private readAbsSource(params: Record<string, any>, allowEmpty = false): string {
    const hasText = typeof params['abs'] === 'string', hasPath = typeof params['absPath'] === 'string';
    if (hasText === hasPath) throw new Error('必须且只能提供 abs 或 absPath。');
    const source = hasPath ? this.electronService.readFile(params['absPath']) : params['abs'];
    if (typeof source !== 'string' || !allowEmpty && !source.trim()) throw new Error('缺少 ABS 内容');
    return source;
  }

  private async executeAbsProjection(params: Record<string, any>) {
    await this.projectService.ensureBlocklyLibraryRuntimeReady();

    return this.absGenerationTools.execute('abs_projection', params);
  }

  private async executeAbsRecovery(params: Record<string, any>) {
    let acknowledgeRuntime: (() => boolean) | undefined;
    if (params['action'] === 'recover_runtime' && params['observe'] !== true) {
      const path = this.projectService.currentProjectPath;
      if (this.projectService.isProjectOpening || this.projectService.isProjectTransitionInProgress(path)
        || this.aiOperations.hasBlocking(path)) {
        return { ok: false, operation: 'abs_recovery', project: path, code: 'PROJECT_RECOVERY_SOURCE_BUSY',
          message: 'Observe the current project owner before restoring the retained runtime; no operation was started.' };
      }
      acknowledgeRuntime = await this.projectService.captureBlocklyRuntimeRecoveryAcknowledgement(path);
    }
    const native = params['action'] === 'prepare_native';
    const recoveryKey = native ? `${params['requestId']}:${params['token']}` : undefined;
    if (native) {
      try { this.absGenerationTools.assertNativeRecoveryRequest(params); }
      catch (error) { return absPrecommitFailure('abs_recovery', error); }
    }
    if (native && params['observe'] !== true) {
      const current = await this.projectService.getBlocklyLibraryRuntimeFingerprint();
      const expected = this.nativeRecoveryRuntime;
      const changed = rejectAbsRuntime('abs_validate', expected?.key === recoveryKey ? current : null, expected?.fingerprint);
      if (changed) return { ...changed, operation: 'abs_recovery', project: this.projectService.currentProjectPath };
    }
    const result = { project: this.projectService.currentProjectPath,
      ...await this.absGenerationTools.execute('abs_recovery', params, undefined, undefined,
        (path, assertCurrent) => this.projectService.reopenRecoveredBlocklyProject(path, assertCurrent), this.projectService.currentProjectPath) };
    if (params['action'] === 'inspect' && (!result.ok || (result as any).diagnostics?.issues?.length)) {
      const source = this.projectService.currentProjectPath;
      const check = () => { if (this.projectService.currentProjectPath !== source) throw new Error('The inspected project changed.'); };
      try {
        const port = await openAbsHostStorage(source, check), operation = await new AbsOperationJournal(port, source).inspect();
        const offer = operation ? { version: 1, action: 'recover_project', sameProject: true, candidateApplied: false,
          source: 'operation-journal', operationId: operation.id,
          ...(operation.application ? { originalApplyRequestId: operation.application.requestId } : {}) }
          : await inspectAbsBaselineRecovery(port, source);
        if (offer) return { ok: true, operation: 'abs_recovery', project: source, requiresReload: false, pending: null,
          receipt: { version: 2, requestId: params['requestId'], action: 'inspect' },
          diagnostics: { inPlaceRecovery: offer }, nextAction: { tool: 'project_recover', input: { project: source, action: 'recover_project' } },
          guidance: 'The host verified a complete preserving source for same-project recovery. Recover this exact project, then read its fresh generation; the retained candidate is not applied. Never create another project or ask the user to open a copy.' };
      } catch { /* Retain the original typed diagnosis when no complete source can be verified. */ }
    }
    if (result.ok && (result as any).runtimeRecoveredNow === true) {
      // Repeated starts and read-only observations return the old receipt, but
      // cannot label newly edited generator files as already loaded.
      acknowledgeRuntime?.();
    }
    if (!result.ok || params['action'] !== 'prepare_native') return result;
    this.absGenerationTools.assertNativeRecoveryCurrent(params);
    const expected = this.nativeRecoveryRuntime;
    const current = await this.projectService.getBlocklyLibraryRuntimeFingerprint();
    this.absGenerationTools.assertNativeRecoveryCurrent(params);
    const unavailable = !expected || expected.key !== recoveryKey
      ? rejectAbsRuntime('abs_validate', null)
      : rejectAbsRuntime('abs_validate', current, expected.fingerprint);
    if (unavailable) return { ...unavailable, operation: 'abs_recovery', project: result.project };
    const receipt = (result as any).receipt;
    return { ...result, receipt: { ...receipt, prepared: { ...receipt.prepared, libraryRuntimeFingerprint: expected!.fingerprint } } };
  }

  private async executeAbsCandidateValidation(params: Record<string, any>) {
    const source = this.readAbsSource(params);
    const project = this.projectService.currentProjectPath;
    const isCurrent = this.projectService.captureCurrentProjectGuard();
    let libraryRuntimeFingerprint: string | null = null;
    const assertCurrent = () => { if (!isCurrent())
      throw Object.assign(new Error('The candidate validation project changed.'), { code: 'ABS_CANDIDATE_ARCHIVE_CONTEXT_STALE' }); };
    const result = await this.absGenerationTools.execute('abs_validate', params, source, undefined, undefined, project,
      { archive: { assertCurrent, prepareRuntime: async () => {
        await this.projectService.ensureBlocklyLibraryRuntimeReady();
        libraryRuntimeFingerprint = await this.projectService.getBlocklyLibraryRuntimeFingerprint();
        if (!libraryRuntimeFingerprint) throw Object.assign(new Error('The current library runtime is not ready; the candidate was retained.'),
          { code: 'ABS_RUNTIME_NOT_READY' });
      } } });

    if (!result.ok) {
      this.retainNativeFailureRuntime(result, libraryRuntimeFingerprint!);
      return result;
    }

    const changed = rejectAbsRuntime('abs_validate', await this.projectService.getBlocklyLibraryRuntimeFingerprint(), libraryRuntimeFingerprint!);
    if (changed) return { ...changed, project: this.projectService.currentProjectPath,
      ...((result as any).candidateArchive ? { candidateArchive: (result as any).candidateArchive } : {}) };

    const reserveWriter = Boolean(params['workingCandidate'] && window['fs']?.projectSyncStorageVersion === 2);
    if (reserveWriter) {
      const receipt = (result as any).receipt;
      try {
        const port = await openAbsHostStorage(project, assertCurrent);
        await new OriginalRequestAdmissions(port, project).reserveApplication(receipt.requestId, receipt.candidate.hash, assertCurrent);
      } catch (error) {
        return { ...absPrecommitFailure('abs_validate', error), project };
      }
    }
    return { ...result, ...(reserveWriter ? { applicationWriterReserved: true } : {}),
      receipt: { ...(result as any).receipt, libraryRuntimeFingerprint } };
  }

  private retainNativeFailureRuntime(result: Record<string, any>, fingerprint: string) {
    if (!fingerprint) return;
    const recovery = result['nativeCandidateFailure']?.recovery;
    if (!recovery?.token || !recovery?.requestId) return;
    const key = `${recovery.requestId}:${recovery.token}`;
    // Bind to the failed execution, not later library files. Inspection and
    // transport retries cannot renew the authority of an existing failure.
    if (this.nativeRecoveryRuntime?.key !== key) this.nativeRecoveryRuntime = { key, fingerprint };
  }

  private async executeAbsApply(params: Record<string, any>, markWriter?: () => void) {
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
      (blocks, batches) => progress('progress', `已装载 ${blocks} 个块，完成 ${batches} 批`), undefined, undefined,
      { markApplyWriter: markWriter }));
    if (!result.ok) this.retainNativeFailureRuntime(result, params['validation'].libraryRuntimeFingerprint);
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
    if (!recovery && params['mutationToken']) {
      if (!params['managedEnvironment']) return { ok: false, operation: 'library_runtime_sync', ready: false,
        code: 'LIBRARY_ENVIRONMENT_RUNTIME_REFERENCE_REQUIRED', message: 'Managed library refresh requires its original completed environment reference.' };
      await this.projectService.finishLibraryMutation(params['mutationToken'], false, params['managedEnvironment']);
    }
    else if (!recovery) await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);

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

  private readBoardPublicationRequest(params: Record<string, any>, input: Parameters<typeof boardPublicationRequest>[0]) {
    if (this.projectService.getProjectMode(this.projectService.currentProjectPath) === 'coder') return undefined;
    if (params['saveRequest'] === undefined) throw Object.assign(new Error('Board operations require the matching SDK original publication request.'),
      { code: 'PROJECT_SAVE_PROTOCOL_UPGRADE_REQUIRED' });
    return boardPublicationRequest(input, params['saveRequest']);
  }

  private async executeBoardSwitch(params: Record<string, any>): Promise<Record<string, any>> {
    const developmentMode = this.projectService.getProjectMode(this.projectService.currentProjectPath) === 'coder' ? 'coder' : 'blockly';
    if (params['developmentMode'] && params['developmentMode'] !== developmentMode) {
      return { ok: false, changed: false, operation: 'board_switch', reason: 'project_mode_mismatch', developmentMode };
    }
    const saveRequest = this.readBoardPublicationRequest(params, { kind: 'board-switch', boardName: params['boardName'] });
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
        changeBoard: board => this.projectService.changeBoard(board, saveRequest),
        ...(saveRequest ? { saveUnchanged: async () => {
          const saved = await this.projectService.save(this.projectService.currentProjectPath, undefined, saveRequest);
          if (!saved.success) throw Object.assign(new Error(saved.error || 'The original unchanged board publication is not complete.'), saved);
          return { ...saved };
        } } : {}),
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

  private async executeProjectNavigationSettlement(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    const params = payload.params || {}, observing = payload.operation === 'project_navigation_status';
    const path = window['path'], captureAttachment = window['fs']?.captureProjectAttachment;
    const request = readProjectNavigationRequest(params['navigationRequest'], value => !!path?.isAbsolute(value));
    const reopen = params['reopenFrom'] === undefined ? undefined
      : readProjectNavigationRequest(params['reopenFrom'], value => !!path?.isAbsolute(value));
    const sessionId: unknown = params['navigationSessionId'];
    const hasSession = typeof sessionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(sessionId);
    const reopenProof = params['reopenProof'];
    const proofRequest = reopenProof === undefined ? undefined
      : readProjectNavigationRequest(reopenProof?.navigationRequest, value => !!path?.isAbsolute(value));
    const sameProject = (left: string, right: string) => {
      const a = path.normalize(left), b = path.normalize(right);
      return window['platform']?.isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
    };
    const originalPath = request?.operation === 'project_open' ? request.targetProject : request?.sourceProject;
    if (!request || typeof captureAttachment !== 'function' || request.rendererGeneration !== payload.rendererGeneration
      || request.rendererGeneration !== this.electronService.currentRendererGeneration
      || Object.keys(params).some(key => key !== 'navigationRequest'
        && (observing || !['reopenFrom', 'navigationSessionId', 'reopenProof'].includes(key)))
      || sessionId !== undefined && !hasSession
      || reopenProof !== undefined && (!hasSession || reopenProof?.sessionId !== sessionId || !proofRequest
        || request.operation !== 'project_open' || request.sourceProject !== null || !proofRequest.sourceProject
        || !sameProject(proofRequest.sourceProject, request.targetProject!)
        || (reopen ? proofRequest.operation !== 'project_close' || proofRequest.requestId !== reopen.requestId
          : proofRequest.operation !== 'project_open'))
      || payload.path && (!originalPath || !sameProject(originalPath, payload.path))
      || !observing && (this.configService.getPreferredChatAgentRuntimeMode() !== 'blockly'
        || request.operation !== payload.operation || request.sourceProject !== payload.lifecycle?.sourceProject
        || request.operation === 'project_open' && !payload.path)
      || params['reopenFrom'] !== undefined && (!reopen || request.operation !== 'project_open' || request.sourceProject !== null
        || reopen.operation !== 'project_close' || !reopenProof && reopen.rendererGeneration !== request.rendererGeneration)) {
      return { ok: false, code: 'PROJECT_NAVIGATION_RECEIPT_SCOPE_INVALID', commandDispatched: false,
        message: 'The navigation request must match the original renderer, operation, and project scope.' };
    }
    const receipts = this.navigationReceipts ??= new ProjectNavigationReceipts(
      () => ({ project: this.projectService.currentProjectPath || null, revision: this.projectService.projectViewRevision }),
      captureAttachment, sameProject);
    if (observing) return receipts.observe(request);
    const assertCurrent = createProjectLifecycleAssertion(payload.lifecycle,
      () => this.projectService.currentProjectPath || null,
      () => this.electronService.currentRendererGeneration, payload.rendererGeneration);
    const admit = () => {
      assertCurrent();
      if (request.deadlineAt <= Date.now() || reopen && !reopenProof && !receipts.canReopenFrom(reopen, request.targetProject!)) {
        const code = request.deadlineAt <= Date.now() ? 'PROJECT_NAVIGATION_EXPIRED' : 'PROJECT_NAVIGATION_CLOSE_SUPERSEDED';
        throw Object.assign(new Error('The original navigation scope is no longer current.'), { code, commandDispatched: false });
      }
    };
    return receipts.start(request, (record, transition) => this.projectService.withProjectLifecycleAdmission(admit, async owner => {
      if (reopenProof) {
        const allowed = await window['projectLock']?.canReopenNavigation(reopenProof, request.targetProject!);
        assertCurrent();
        if (!allowed) return { ok: false, operation: request.operation, code: 'PROJECT_NAVIGATION_CLOSE_SUPERSEDED', commandDispatched: false };
      }
      receipts.captureSource(request);
      return this.executeOperation({ ...payload, params: {} }, undefined, owner, undefined,
        async (project, revision) => {
          record({ project, revision });
          if (!hasSession || !window['projectLock']?.recordNavigation) return;
          const activation = receipts.observe(request).navigationReceipt.activation;
          if (!activation) return;
          try { await window['projectLock'].recordNavigation({ requestId: request.requestId, activation }); }
          catch (error) { console.warn('The original navigation proof could not be recorded:', error); }
        }, { requestId: request.requestId, transition });
    }));
  }

  private async executeProjectCreateSettlement(payload: BlocklyLiveOperationPayload): Promise<Record<string, any>> {
    const params = payload.params || {};
    const request = readProjectCreateRequest(params['createRequest']);
    if (!request || request.rendererGeneration !== payload.rendererGeneration
      || request.rendererGeneration !== this.electronService.currentRendererGeneration
      || payload.operation !== 'project_create' && Object.keys(params).some(key => key !== 'createRequest')) {
      return { ok: false, code: 'PROJECT_CREATE_RECEIPT_SCOPE_INVALID', commandDispatched: false,
        message: 'Observe only the exact original creation in its renderer generation.' };
    }
    const captureAttachment = window['fs']?.captureProjectAttachment;
    const receipts = this.createReceipts ??= new ProjectCreateReceipts(captureAttachment);
    const isCurrentActivation = () => receipts.isActivationCurrent(request, this.projectService.currentProjectPath || '',
      (a, b) => this.normalizePath(a) === this.normalizePath(b));
    if (payload.operation !== 'project_create') {
      const state = payload.operation === 'project_create_cancel' ? receipts.cancel(request) : receipts.observe(request);
      const project = state.createReceipt.createdProject;
      const activationCurrent = isCurrentActivation();
      // The loopback discovery project must remain the actual active tab.
      return { ok: true, operation: payload.operation, createReceipt: state.createReceipt, activationCurrent,
        ...(activationCurrent && project ? { projectType: this.projectService.getProjectMode(project) } : {}),
        result: state.createReceipt.state === 'unknown' ? undefined : state };
    }
    const assertCurrent = createProjectLifecycleAssertion(payload.lifecycle,
      () => this.projectService.currentProjectPath || null,
      () => this.electronService.currentRendererGeneration, payload.rendererGeneration);
    const operationKey = JSON.stringify([(payload.lifecycle as { sourceProject?: string | null }).sourceProject,
      ...['name', 'path', 'boardName', 'board', 'boardVersion', 'version', 'boardNickname', 'nickname',
        'prefix', 'devmode', 'developmentMode', 'recoverySessionId'].map(key => params[key])]);
    const recordCreatedActive = window['projectLock']?.recordCreatedActive;
    const recoverySessionId = params['recoverySessionId'];
    const recordActivation = typeof recordCreatedActive === 'function' && typeof recoverySessionId === 'string'
      ? async (projectPath: string, attachment: ProjectStorageAttachment) => {
          const recorded = await recordCreatedActive({ projectPath, request, recoverySessionId, attachment });
          if (recorded?.ok !== true) console.warn('Original create navigation could not be recorded:', recorded);
          return recorded?.ok === true;
        }
      : undefined;
    const result = await receipts.run(request, async guard => {
      assertCurrent();
      return this.executeProjectCreate(params, undefined, guard, assertCurrent);
    }, operationKey, recordActivation);
    return { ...result, activationCurrent: result.createReceipt.activationCommitted && isCurrentActivation() };
  }

  private openCreatedProject(project: string, lifecycleOwner?: symbol, authority?: ProjectCreateGuard, assertSource?: () => void): Promise<boolean> {
    if (!authority || !assertSource) return this.projectService.projectOpen(project,
      { reason: 'chat-tool-create', interactive: false, lifecycleOwner });
    authority.assertCurrent();
    const check = () => { authority.assertCurrent(); assertSource(); };
    return this.projectService.withProjectLifecycleAdmission(check, async owner => {
      const opened = await this.projectService.projectOpen(project, {
        reason: 'chat-tool-create', interactive: false, lifecycleOwner: owner,
        createActivation: { signal: authority.signal, assertCurrent: check,
          beginHandoff: authority.beginHandoff, recordActivation: authority.recordActivation, markActivated: authority.markActivated },
      });
      if (opened) authority.markActivated();
      return opened;
    }, authority.signal);
  }

  private async executeProjectCreate(params: Record<string, any>, lifecycleOwner?: symbol,
    authority?: ProjectCreateGuard, assertSource?: () => void): Promise<Record<string, any> & { ok: boolean }> {
    await this.configService.init();
    authority?.assertCurrent();
    const mode = this.configService.getPreferredChatAgentRuntimeMode();
    const modeError = getProjectCreationModeError(mode, params);
    if (modeError) {
      return { ok: false, operation: 'project_create', reason: 'project_mode_mismatch', developmentMode: mode, message: modeError };
    }
    if (mode === 'coder') {
      return this.executeCoderProjectCreate(params, lifecycleOwner, authority, assertSource);
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

    authority?.assertCurrent();
    const creation = await this.projectService.projectNewWithResult(
      newProjectData,
      { activationReason: 'chat-tool-create', ...(lifecycleOwner || authority ? { deferActivation: true } : {}),
        ...(authority ? { createAuthority: authority } : {}) },
    );
    const created = creation.ok;
    const failure = creation.ok === false ? creation : undefined;
    let ok = created;
    let activationError: unknown;
    if (created && (lifecycleOwner || authority)) {
      authority?.markCreated(projectPath);
      try { ok = await this.openCreatedProject(projectPath, lifecycleOwner, authority, assertSource); }
      catch (error) { ok = false; activationError = error; }
    }

    return {
      ok,
      operation: 'project_create',
      developmentMode: mode,
      projectType: mode,
      project: created ? projectPath : failure?.projectPath || null,
      ...(failure ? { stage: failure.stage, error: failure.error,
        ...(failure.npmExitCode === undefined ? {} : { npmExitCode: failure.npmExitCode }),
        ...(failure.partialMutation ? { partialMutation: true } : {}) } : {}),
      ...(created && !ok ? { projectCreated: true, createdProject: projectPath,
        stage: 'activation', partialMutation: true,
        activation: { completed: false, currentProject: this.projectService.currentProjectPath || null },
        code: (activationError as any)?.code || 'PROJECT_CREATE_ACTIVATION_FAILED' } : {}),
      message: ok ? `项目已创建并打开: ${projectPath}` : created
        ? (activationError instanceof Error ? activationError.message : activationError ? String(activationError) : '项目已创建，但未确认打开完成')
        : failure?.error || '项目创建失败',
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

  private async executeCoderProjectCreate(params: Record<string, any>, lifecycleOwner?: symbol,
    authority?: ProjectCreateGuard, assertSource?: () => void): Promise<Record<string, any> & { ok: boolean }> {
    const result = await executeCoderProjectCreateOperation(params, {
      normalizeBoardName: (value) => this.normalizeAilyBoardPackageName(value),
      getBoards: () => this.configService.getBoardListForSelector(),
      loadBoards: () => this.configService.loadBoardList(),
      defaultParentPath: () => this.projectService.getDefaultProjectParentPath(),
      generateUniqueName: (parentPath, prefix) =>
        this.projectService.generateUniqueProjectName(parentPath, prefix),
      createProject: (data) => this.projectService.projectNewWithResult(data, {
        deferActivation: true,
        templateDirectory: 'template_arduino',
        activationReason: 'chat-tool-create',
        ...(authority ? { createAuthority: authority } : {}),
      }),
      openProject: (projectPath) => {
        authority?.markCreated(projectPath);
        return this.openCreatedProject(projectPath, lifecycleOwner, authority, assertSource);
      },
      recordBoardUsage: (boardName) => this.configService.recordBoardUsage(boardName),
    });
    return {
      ...result,
      ok: result['ok'] === true,
      ...(result['ok'] === true && this.projectService.coderWorkspace
        ? { coderWorkspace: this.projectService.coderWorkspace }
        : {}),
    };
  }

  private async executeCoderProjectOperation(path: string, operation: string, params: ProjectBuildParameters): Promise<Record<string, any>> {
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
        : await this.coderRuntime.build(path, { preprocessOnly: params['preprocess_only'] === true, clearCache: params['clear_cache'] === true,
          requestId: params['buildLogRequestId'], ...(params[buildFallbackControl] ? { localFallback: params[buildFallbackControl] } : {}) });
      return { ok: true, operation, project: path, message: result?.text || '', result, ...(result?.buildLog ? { buildLog: result.buildLog } : {}) };
    } catch (error: any) {
      return { ok: false, operation, project: path, buildOutcome: error?.buildOutcome, ...(error?.code ? { code: error.code } : {}),
        message: error?.text || error?.message || String(error), result: error?.result || error?.buildResult,
        ...(error?.buildLog || error?.buildResult?.buildLog ? { buildLog: error.buildLog || error.buildResult.buildLog } : {}) };
    }
  }

  private async executeProjectBuild(params: ProjectBuildParameters, projectPath = this.projectService.currentProjectPath): Promise<Record<string, any>> {
    const projectCurrent = this.projectService.captureCurrentProjectGuard();
    const assertCurrent = () => {
      if (this.projectService.currentProjectPath !== projectPath || !projectCurrent()) {
        throw Object.assign(new Error('The requested Blockly build project is no longer active.'), { code: 'BUILD_SOURCE_STALE' });
      }
    };
    try {
      assertCurrent();
      await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);
      assertCurrent();
    } catch (error) {
      return { ok: false, operation: 'project_build', project: projectPath,
        buildOutcome: 'not-started', code: (error as any)?.code,
        message: error instanceof Error ? error.message : String(error) };
    }
    const toolResult = await runProjectBuild(
      this.builderService,
      {
        preprocessOnly: params['preprocess_only'] === true,
        clearCache: params['clear_cache'] === true,
        requestId: params['buildLogRequestId'],
        localFallback: params[buildFallbackControl],
      },
      projectPath,
    );
    return {
      ok: toolResult.is_error !== true,
      operation: 'project_build',
      project: projectPath,
      message: this.extractToolContent(toolResult),
      metadata: toolResult.metadata,
      buildOutcome: toolResult.metadata?.['buildOutcome'],
      code: toolResult.metadata?.['code'],
      ...(toolResult.metadata?.['sourceReason'] ? { sourceReason: toolResult.metadata['sourceReason'] } : {}),
      result: toolResult.metadata?.['buildResult'],
      ...(toolResult.metadata?.['buildResult']?.['buildInput'] ? { buildInput: toolResult.metadata['buildResult']['buildInput'] } : {}),
      ...(toolResult.metadata?.['buildResult']?.['buildSource'] ? { buildSource: toolResult.metadata['buildResult']['buildSource'] } : {}),
      ...(toolResult.metadata?.['buildResult']?.['buildSnapshot'] ? { buildSnapshot: toolResult.metadata['buildResult']['buildSnapshot'] } : {}),
      ...(toolResult.metadata?.['buildResult']?.['buildHistory'] ? { buildHistory: toolResult.metadata['buildResult']['buildHistory'] } : {}),
      ...(toolResult.metadata?.['buildResult']?.['buildLog'] ? { buildLog: toolResult.metadata['buildResult']['buildLog'] } : {}),
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
    const project = this.projectService.currentProjectPath;
    const firmware = Object.hasOwn(params, 'preparedFirmware') ? readPreparedBuildInput(params['preparedFirmware']) : undefined;
    const reuseCloud = Object.hasOwn(params, 'reuseCloudFirmware');
    if (reuseCloud && (params['reuseCloudFirmware'] !== true || firmware)) {
      throw Object.assign(new Error('Invalid cloud firmware reuse request.'), { code: 'PREPARED_FIRMWARE_INVALID' });
    }
    const options: FirmwareUploadOptions | undefined = firmware ? { preparedFirmware: firmware }
      : reuseCloud ? { reuseCloudFirmware: true } : undefined;
    const current = options ? this.projectService.captureCurrentProjectGuard() : undefined;
    const preparedInCloudProject = !!firmware && this.projectService.isCloudBuild();
    if (firmware && (window['builder']?.isolatedBuildExecutionVersion !== 1
      || (preparedInCloudProject && !await window['builder']?.requiresIsolatedBuildRecovery?.(project)))) {
      throw Object.assign(new Error('Prepared firmware upload requires an isolated local Blockly build.'),
        { code: 'PREPARED_FIRMWARE_UNAVAILABLE' });
    }
    if (reuseCloud && !this.projectService.isCloudBuild()) {
      throw Object.assign(new Error('Cloud firmware reuse requires the active Blockly cloud build backend.'),
        { code: 'PREPARED_FIRMWARE_UNAVAILABLE' });
    }
    if (firmware && !requirePreparedBuildExecution(project, firmware).isolatedRecovery && preparedInCloudProject) {
      throw Object.assign(new Error('Prepared firmware belongs to a different build backend.'),
        { code: 'PREPARED_FIRMWARE_UNAVAILABLE' });
    }
    await this.projectService.ensureBlocklyLibraryRuntimeReady(project);
    const requestedPort = typeof params['port'] === 'string' ? params['port'].trim() : undefined;
    let recoveryBackend: ReturnType<ProjectService['beginBuildBackendOperation']> | undefined;
    try {
      if (preparedInCloudProject) {
        if (!current?.() || !this.projectService.isCloudBuild()) {
          throw Object.assign(new Error('The active Blockly project changed before upload.'), { code: 'BUILD_ARTIFACT_STALE' });
        }
        recoveryBackend = this.projectService.beginBuildBackendOperation(project);
        recoveryBackend.useLocal();
      }
      const { ports, selection } = await this.getSerialPortSelection(requestedPort);
      if (options) {
        const revision = await this.blocklyEditor.getProjectRevisionSnapshot();
        if (!current?.() || revision.changed || this.projectService.isCloudBuild() !== reuseCloud) {
          throw Object.assign(new Error('The active Blockly project changed after compilation.'), { code: 'BUILD_ARTIFACT_STALE' });
        }
        if (firmware) requirePreparedBuildExecution(project, firmware);
      }
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
      if (options && !current?.()) {
        throw Object.assign(new Error('The active Blockly project changed before upload.'), { code: 'BUILD_ARTIFACT_STALE' });
      }
      const uploadResult = options ? await this.uploaderService.upload(project, selectedPort.name, options)
        : await this.uploaderService.upload();
      if (options && uploadResult?.state !== 'done') {
        throw Object.assign(new Error('The host did not confirm completion of the prepared firmware upload.'),
          { code: 'PREPARED_FIRMWARE_UPLOAD_UNCONFIRMED' });
      }
      return {
        ok: true,
        operation: 'project_upload',
        project: options ? project : this.projectService.currentProjectPath,
        ...options,
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
        ...(options && typeof error?.code === 'string' ? { code: error.code } : {}),
        selectedPort: this.serialService.currentPort || null,
        message: error?.text || error?.message || String(error),
        uploadResult: error?.result,
      };
    } finally {
      recoveryBackend?.release();
    }
  }

  private async executeBlocksTidy(request?: ProjectSaveRequest): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);
    const assertProject = () => {
      if (projectPath !== this.projectService.currentProjectPath) throw new Error('整理操作所属项目已改变。');
    };
    assertProject();
    if (request?.version === 2) {
      // The publisher owns the pre-transform snapshot, layout and save under
      // one lease. An outer transport receipt never runs cleanUp twice.
      const outcome = await this.blocklyEditor.saveProject(projectPath, request);
      if (!outcome) return { ok: false, operation: 'blocks_tidy', project: projectPath,
        code: 'PROJECT_SAVE_UNVERIFIED', message: 'The native publisher did not return an original result.' };
      const noOp = outcome.code === 'BLOCKS_TIDY_NOOP';
      return { ...outcome, ok: noOp || outcome.projectSaved === true && !outcome.partial,
        operation: 'blocks_tidy', project: projectPath,
        message: outcome.error ?? (noOp ? '顶层块数量不足，无需整理' : '已整理并完成原项目保存') };
    }
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

    let saveOutcome: Awaited<ReturnType<BlocklyLiveEditorPort['saveProject']>>;
    try {
      // The editor port resolves when the real save settles. A UI Action's
      // five-second feedback timeout does not cancel its save or release leases.
      saveOutcome = await this.blocklyEditor.saveProject(projectPath);
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
      ...(saveOutcome || {}),
      ok: true,
      operation: 'blocks_tidy',
      project: projectPath,
      message: `已整理 ${topBlocks.length} 个顶层 Blockly 块并保存项目`,
      topBlockCount: topBlocks.length,
    };
  }

  private async executeProjectSave(request?: ProjectSaveRequest): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return { ok: false, message: '当前未打开 Blockly 项目' };
    }
    await this.projectService.prepareResolvedLibraryChangesForSave?.(projectPath);
    await this.projectService.ensureBlocklyLibraryRuntimeReady(projectPath);
    if (projectPath !== this.projectService.currentProjectPath) throw new Error('保存操作所属项目已改变。');
    let saveOutcome: Awaited<ReturnType<BlocklyLiveEditorPort['saveProject']>>;
    try {
      saveOutcome = request?.version === 2 ? await this.blocklyEditor.saveProject(projectPath, request)
        : await this.blocklyEditor.saveProject(projectPath);
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
      ...(saveOutcome || {}),
      ok: request?.version === 2 ? Boolean(saveOutcome && saveOutcome.projectSaved === true && !saveOutcome.partial) : true,
      operation: 'project_save',
      project: projectPath,
      message: '项目已保存',
    };
  }

  private saveFailureFacts(error: unknown): Record<string, unknown> {
    const failure = error as any;
    if (typeof failure?.projectSaved !== 'boolean') return typeof failure?.code === 'string' ? { code: failure.code } : {};
    return { projectSaved: failure.projectSaved, generatedCodePublished: failure.generatedCodePublished === true,
      partial: failure.partial === true, ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
      ...(failure.projectSaved ? { recovery: 'The project source is saved; the reported generated-output or dependency stage remains incomplete. Continue recovery in this same project and observe the original save/build request when its result is uncertain. Keep the candidate and ownership records; do not create or ask the user to open another project.' } : {}) };
  }

  private async executeProjectOpen(projectPath: string, lifecycleOwner?: symbol,
    onViewActivated?: (project: string | null, revision: number) => void | Promise<void>,
    navigation?: { requestId: string; transition: ProjectNavigationTransition }): Promise<Record<string, any>> {
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
        ...(lifecycleOwner ? { lifecycleOwner } : {}),
        reason: sameProject ? 'chat-tool-reload' : 'chat-tool-open',
        interactive: false,
        ...(onViewActivated ? { onViewActivated } : {}),
        ...(navigation ? { navigation } : {}),
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
          ...projectLoadFailureGuidance(requestedProject, loadStatus, developmentMode === 'blockly'),
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
      const viewFailure = projectViewRecoveryFailure(error, requestedProject);
      if (viewFailure) return viewFailure;
      const loadStatus = this.projectService.getBlocklyProjectLoadStatus(requestedProject);
      return {
        ok: false,
        operation: 'project_open',
        project: requestedProject,
        reason: 'project_load_failed',
        message: error instanceof Error ? error.message : String(error),
        loadStatus,
        ...projectLoadFailureGuidance(requestedProject, loadStatus, developmentMode === 'blockly'),
      };
    }
  }

  private async executeProjectClose(requestedPath?: string, lifecycleOwner?: symbol,
    onViewActivated?: (project: string | null, revision: number) => void | Promise<void>): Promise<Record<string, any>> {
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
    try { closed = await this.projectService.close({ save: true, lifecycleOwner, ...(onViewActivated ? { onViewActivated } : {}) }); }
    catch (error) {
      return { ok: false, operation: 'project_close', project: projectPath, reason: 'project_close_failed',
        code: (error as any)?.code, message: error instanceof Error ? error.message : String(error), loadStatus };
    }
    return {
      ok: closed === true,
      operation: 'project_close',
      project: closed === true ? null : projectPath,
      ...(closed === true ? {} : { reason: 'project_close_rejected' }),
      message: closed === true ? '项目已关闭' : '项目关闭被拒绝',
      previousLoadStatus: loadStatus,
    };
  }

  private async executeProjectReload(lifecycleOwner?: symbol): Promise<Record<string, any>> {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) {
      return { ok: false, message: '当前未打开 Blockly 项目' };
    }
    try {
      const opened = await this.projectService.projectOpen(projectPath, { reason: 'chat-tool-reload', lifecycleOwner });
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
          ...projectLoadFailureGuidance(projectPath, loadStatus, this.projectService.getProjectMode(projectPath) === 'blockly'),
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
        ...projectLoadFailureGuidance(projectPath, loadStatus, this.projectService.getProjectMode(projectPath) === 'blockly'),
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
