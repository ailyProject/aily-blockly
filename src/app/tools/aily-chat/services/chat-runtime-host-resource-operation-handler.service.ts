import { Injectable, OnDestroy, Optional } from '@angular/core';

import type {
  ChatRuntimeHostResourceOperationPayload,
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostSyncAbsPayload,
  ChatRuntimeHostWorkspaceMutationBatch,
} from '../core/chat-runtime-host-contract';
import {
  registerElectronChatRuntimeResourceOperationHandler,
  type ElectronChatRuntimeResourceOperationHandlerRegistration,
} from '../core/electron-chat-runtime-host-transport';
import { ElectronService } from '../../../services/electron.service';
import { ProjectService } from '../../../services/project.service';
import { BuilderService } from '../../../services/builder.service';
import { UploaderService } from '../../../services/uploader.service';
import { SerialService } from '../../../services/serial.service';
import { ConfigService } from '../../../services/config.service';
import { ConnectionGraphService } from '../../../services/connection-graph.service';
import { SubappAgentBridgeService } from '../../../services/subapp-agent-bridge.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import {
  runSyncAbsFileConcreteHandler,
  type SyncAbsArgs,
} from '../tools/syncAbsFileTool';
import { ChatRuntimeHostWorkspaceMutationTransaction } from './chat-runtime-host-workspace-mutation-transaction';
import { analyzeLibraryBlocksTool } from '../tools/editBlockTool';
import { reloadProjectTool } from '../tools/reloadProjectTool';
import { switchBoardTool } from '../tools/switchBoardTool';
import { setBoardConfigTool } from '../tools/boardConfigTool';
import { collectDiagnostics } from '../core/diagnostics';
import { AbsAutoSyncService } from './abs-auto-sync.service';
import { ChatHistoryService, type LiveHostSessionRecord } from './chat-history.service';
import { ArduinoLintService } from './arduino-lint.service';
import { AilyHost } from '../core/host';
import { AilyChatConfigService } from './aily-chat-config.service';
import { ChatRuntimeOwnerSubmittedTurnTitleService } from './chat-runtime-owner-submitted-turn-title.service';
import { ChatRuntimeOwnerToolApprovalService } from './chat-runtime-owner-tool-approval.service';
import { normalizeToolApprovalArgs } from '../core/tool-approval-input';
import {
  applySchematicTool,
  generateConnectionGraphTool,
  generatePinmapTool,
  getCurrentSchematicTool,
  getPinmapSummaryTool,
  getProjectContextTool,
  getSensorPinmapCatalogTool,
  savePinmapTool,
  validateConnectionGraphTool,
} from '../tools/connectionGraphTool';
import {
  createProjectSceneGenerationHandlers,
  GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL,
  SUBMIT_PROJECT_SCENE_GENERATION_PROPOSAL_TOOL,
} from '../core/blockly-project-scene-tools';
import {
  createSceneCodeReconciliationHandlers,
  GET_SCENE_CODE_RECONCILIATION_CONTEXT_TOOL,
  SUBMIT_SCENE_CODE_RECONCILIATION_CANDIDATE_TOOL,
} from '../core/blockly-scene-code-reconciliation-tools';

type HostResourceOperationPayload = {
  readonly adapter?: unknown;
  readonly action?: unknown;
  readonly record?: unknown;
  readonly hostRecord?: unknown;
  readonly liveHostSessionRecord?: unknown;
  readonly allowEmptyTranscript?: unknown;
  readonly projectPath?: unknown;
  readonly args?: unknown;
  readonly autoSaveEdits?: unknown;
  readonly workspaceRoot?: unknown;
  readonly turnIndex?: unknown;
  readonly turnStartListIndex?: unknown;
  readonly responseStartListIndex?: unknown;
  readonly turnId?: unknown;
  readonly requestContent?: unknown;
  readonly displayContent?: unknown;
  readonly checkpointId?: unknown;
  readonly requestId?: unknown;
  readonly requestMetadata?: unknown;
  readonly turnResponses?: unknown;
  readonly retainedTurnResponses?: unknown;
  readonly sourceSessionResource?: unknown;
  readonly targetSessionResource?: unknown;
  readonly requestDiffPreview?: unknown;
  readonly dismissSummary?: unknown;
  readonly paths?: unknown;
  readonly filePath?: unknown;
  readonly editType?: unknown;
  readonly code?: unknown;
  readonly options?: unknown;
  readonly xml?: unknown;
  readonly port?: unknown;
  readonly requestText?: unknown;
  readonly query?: unknown;
  readonly searchType?: unknown;
  readonly categoryType?: unknown;
  readonly dimension?: unknown;
  readonly libraryId?: unknown;
  readonly libraryIds?: unknown;
  readonly mode?: unknown;
  readonly filePaths?: unknown;
  readonly ranges?: unknown;
  readonly approvalTraceId?: unknown;
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly title?: unknown;
  readonly subtitle?: unknown;
  readonly message?: unknown;
  readonly source?: unknown;
  readonly actions?: unknown;
  readonly primaryScope?: unknown;
  readonly allowAutoConfirm?: unknown;
  readonly approveCombination?: unknown;
  readonly name?: unknown;
  readonly path?: unknown;
  readonly board?: unknown;
  readonly config?: unknown;
  readonly configKey?: unknown;
  readonly configValue?: unknown;
  readonly config_key?: unknown;
  readonly config_value?: unknown;
  readonly transactionId?: unknown;
  readonly input?: unknown;
};

class HostResourceOperationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

@Injectable()
export class ChatRuntimeHostResourceOperationHandlerService implements OnDestroy {
  private registration: ElectronChatRuntimeResourceOperationHandlerRegistration | null = null;
  private registrationPromise: Promise<void> | null = null;
  private readonly pendingProjectCreations = new Map<string, {
    readonly sessionId: string;
    readonly turnId: string;
    readonly toolCallId: string;
    readonly projectPath: string;
  }>();
  private readonly pendingWorkspaceMutations = new Map<string, {
    readonly batch: ChatRuntimeHostWorkspaceMutationBatch;
    readonly transaction: ChatRuntimeHostWorkspaceMutationTransaction;
  }>();

  constructor(
    private readonly chatHistoryService: ChatHistoryService,
    private readonly absAutoSyncService: AbsAutoSyncService,
    private readonly projectService: ProjectService,
    private readonly electronService: ElectronService,
    private readonly builderService: BuilderService,
    private readonly uploaderService: UploaderService,
    private readonly serialService: SerialService,
    private readonly arduinoLintService: ArduinoLintService,
    private readonly blocklyService: BlocklyService,
    private readonly connectionGraphService: ConnectionGraphService,
    private readonly configService: ConfigService,
    private readonly chatConfigService: AilyChatConfigService,
    private readonly submittedTurnTitleService: ChatRuntimeOwnerSubmittedTurnTitleService,
    private readonly ownerToolApproval?: ChatRuntimeOwnerToolApprovalService,
    @Optional() private readonly subappAgentBridgeService?: SubappAgentBridgeService,
  ) {}

  start(): Promise<void> {
    if (this.registration) {
      return Promise.resolve();
    }
    if (this.registrationPromise) {
      return this.registrationPromise;
    }

    this.registrationPromise = registerElectronChatRuntimeResourceOperationHandler(request =>
      this.handleResourceOperation(request),
    )
      .then(registration => {
        this.registration = registration;
      })
      .finally(() => {
        this.registrationPromise = null;
      });

    return this.registrationPromise;
  }

  ngOnDestroy(): void {
    const registration = this.registration;
    this.registration = null;
    this.registrationPromise = null;
    if (registration) {
      void registration.dispose();
    }
    for (const pending of this.pendingProjectCreations.values()) {
      this.deletePendingProjectDirectory(pending.projectPath);
    }
    this.pendingProjectCreations.clear();
    for (const pending of this.pendingWorkspaceMutations.values()) {
      void pending.transaction.rollback().catch(() => undefined);
    }
    this.pendingWorkspaceMutations.clear();
  }

  private handleResourceOperation(request: ChatRuntimeHostResourceOperationRequest): unknown {
    switch (request.kind) {
      case 'abs-workspace-export':
        return this.ensureWorkspaceAbsExport(request);
      case 'file-read':
      case 'file-write':
        return this.runSyncAbsResourceOperation(request);
      case 'workspace-mutation':
        return request.payload?.adapter === 'workspaceMutation'
          ? this.runWorkspaceMutationControl(request)
          : this.runSyncAbsResourceOperation(request);
      case 'project-info':
        return this.runProjectInfoOperation(request);
      case 'project-build':
        return this.runProjectBuildOperation(request);
      case 'project-lint':
        return this.runProjectLintOperation(request);
      case 'tool-approval':
        return this.runToolApprovalOperation(request);
      case 'blockly-workspace':
        return this.runBlocklyWorkspaceOperation(request);
      case 'connection-graph':
        return this.runConnectionGraphOperation(request);
      case 'subapp-agent':
        return this.runSubappAgentOperation(request);
      case 'project-scene-proposal':
        return this.runProjectSceneProposalOperation(request);
      case 'scene-code-reconciliation':
        return this.runSceneCodeReconciliationOperation(request);
      case 'board-search':
        return this.runBoardSearchOperation(request);
      case 'library-analysis':
        return this.runLibraryAnalysisOperation(request);
      case 'diagnostics':
        return this.runDiagnosticsOperation(request);
      case 'session-title':
        return this.applySubmittedTurnTitle(request);
      case 'save-current-session':
      case 'history-persistence':
        return this.persistHostSessionRecord(request);
      default:
        throw new HostResourceOperationError(
          `[AilyChat][RuntimeHost] Unsupported host resource operation: ${request.kind}.`,
          'resource_operation_unsupported',
          false,
        );
    }
  }

  private async runProjectSceneProposalOperation(
    request: ChatRuntimeHostResourceOperationRequest,
  ): Promise<Record<string, unknown>> {
    this.requireSessionId(request, 'Project Scene proposal');
    const payload = this.requirePayloadAdapter(
      request.payload,
      'projectSceneProposal',
      'Project Scene proposal',
    );
    const toolName = payload.action === 'readContext'
      ? GET_PROJECT_SCENE_GENERATION_CONTEXT_TOOL
      : payload.action === 'submitProposal'
        ? SUBMIT_PROJECT_SCENE_GENERATION_PROPOSAL_TOOL
        : '';
    if (!toolName) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported Project Scene proposal action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    const input = payload.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Project Scene proposal tool requires an input object.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    const handler = createProjectSceneGenerationHandlers()[toolName];
    const result = await handler(
      input as Record<string, unknown>,
      {} as never,
      {
        toolCallId: this.normalizeSessionId(request.toolCallId),
        trace: { turnId: this.normalizeSessionId(request.turnId) },
      },
    );
    const text = result.content
      .filter(item => item.type === 'text')
      .map(item => item.type === 'text' ? item.text : '')
      .join('\n')
      .trim();
    if (result.isError) {
      throw new HostResourceOperationError(
        text || 'Project Scene proposal tool failed.',
        'project_scene_proposal_tool_failed',
        false,
      );
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('result is not an object');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Project Scene proposal tool returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        'project_scene_proposal_tool_result_invalid',
        false,
      );
    }
  }

  private async runSceneCodeReconciliationOperation(
    request: ChatRuntimeHostResourceOperationRequest,
  ): Promise<Record<string, unknown>> {
    this.requireSessionId(request, 'Scene code reconciliation');
    const payload = this.requirePayloadAdapter(
      request.payload,
      'sceneCodeReconciliation',
      'Scene code reconciliation',
    );
    const toolName = payload.action === 'readContext'
      ? GET_SCENE_CODE_RECONCILIATION_CONTEXT_TOOL
      : payload.action === 'submitCandidate'
        ? SUBMIT_SCENE_CODE_RECONCILIATION_CANDIDATE_TOOL
        : '';
    if (!toolName) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported Scene code reconciliation action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    const input = payload.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Scene code reconciliation tool requires an input object.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    const handler = createSceneCodeReconciliationHandlers()[toolName];
    const result = await handler(
      input as Record<string, unknown>,
      {} as never,
      {
        toolCallId: this.normalizeSessionId(request.toolCallId),
        trace: { turnId: this.normalizeSessionId(request.turnId) },
      },
    );
    const text = result.content
      .filter(item => item.type === 'text')
      .map(item => item.type === 'text' ? item.text : '')
      .join('\n')
      .trim();
    if (result.isError) {
      throw new HostResourceOperationError(
        text || 'Scene code reconciliation tool failed.',
        'scene_code_reconciliation_tool_failed',
        false,
      );
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('result is not an object');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Scene code reconciliation tool returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        'scene_code_reconciliation_tool_result_invalid',
        false,
      );
    }
  }

  private async applySubmittedTurnTitle(request: ChatRuntimeHostResourceOperationRequest): Promise<{
    readonly applied: boolean;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
  }> {
    const sessionId = this.requireSessionId(request, 'generated session title');
    const payload = this.requirePayloadAdapter(request.payload, 'chatTitle', 'generated session title');
    if (payload.action !== 'applyGeneratedTitle') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported session title action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    const title = this.normalizeSessionId(payload.title);
    if (!title) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] generated session title requires title text.',
        'resource_operation_payload_missing',
        false,
      );
    }
    const applied = this.submittedTurnTitleService.applyGeneratedTitle({
      sessionId,
      title,
      source: 'generated',
    });
    if (applied) {
      await this.chatHistoryService.updateTitleAsync(sessionId, title, { source: 'generated' });
    }
    return {
      applied,
      sessionId,
      kind: request.kind,
    };
  }

  private async ensureWorkspaceAbsExport(request: ChatRuntimeHostResourceOperationRequest): Promise<{
    readonly synchronized: true;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
    readonly projectPath: string | null;
    readonly mirrorState: ReturnType<AbsAutoSyncService['getWorkspaceMirrorState']>;
  }> {
    const sessionId = this.requireSessionId(request, 'ABS workspace export');
    this.requireAbsWorkspaceExportPayload(request.payload);
    const projectPath = this.readProjectPath(request.payload) || this.normalizeSessionId(request.resource?.['projectPath']);
    if (!projectPath) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] ABS workspace export requires a project path.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    this.absAutoSyncService.initialize(projectPath);
    // A submitted Blockly request captures the current working copy even when
    // the local revision counter was restored or reused by a workspace reload.
    await this.absAutoSyncService.exportToAbs();
    return {
      synchronized: true,
      sessionId,
      kind: request.kind,
      projectPath,
      mirrorState: this.absAutoSyncService.getWorkspaceMirrorState(),
    };
  }

  private async runSyncAbsResourceOperation(request: ChatRuntimeHostResourceOperationRequest) {
    const sessionId = this.requireSessionId(request, 'syncAbs resource operation');
    const args = this.readSyncAbsArgs(request);
    this.assertSyncAbsKindMatchesRequest(request, args.operation);
    const isMutation = args.operation === 'export' || args.operation === 'import';
    const turnId = this.normalizeSessionId(request.turnId);
    const toolCallId = this.normalizeSessionId(request.toolCallId);
    if (isMutation && (!turnId || !toolCallId)) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Mutating syncAbs operations require canonical turn and tool identities.',
        'resource_operation_mutation_identity_missing',
        false,
      );
    }
    const transactionId = `syncabs:${turnId}:${toolCallId}`;
    if (isMutation) {
      this.assertWorkspaceMutationNotPrepared(transactionId);
    }
    const mutationTransaction = isMutation
      ? new ChatRuntimeHostWorkspaceMutationTransaction({
          sessionId,
          turnId,
          toolCallId,
          transactionId,
        }, this.electronService)
      : null;
    let result;
    try {
      result = await runSyncAbsFileConcreteHandler(
        args,
        this.projectService,
        this.electronService,
        this.absAutoSyncService,
        {
          sessionId,
          turnId,
          toolCallId,
          recordMutationReceipt: mutationTransaction?.record,
        },
      );
    } catch (error) {
      await mutationTransaction?.rollback();
      throw error;
    }
    if (result.is_error) {
      await mutationTransaction?.rollback();
      throw new HostResourceOperationError(
        result.content || '[AilyChat][RuntimeHost] syncAbs resource operation failed.',
        'syncabs_operation_failed',
        false,
      );
    }
    if (!mutationTransaction?.hasMutations) {
      return result;
    }
    return {
      ...result,
      mutationBatch: this.prepareWorkspaceMutation(mutationTransaction),
    };
  }

  private async runProjectInfoOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'project info');
    const payload = this.requirePayloadAdapter(request.payload, 'project', 'project info');
    switch (payload.action) {
      case 'getProjectInfo':
        return this.withRuntimeConfigSnapshot(this.buildProjectInfoSnapshot());
      case 'createProject':
        return await this.runProjectCreateOperation(request, payload);
      case 'activateCreatedProject':
        return await this.runProjectCreatedProjectActivation(request, payload);
      case 'discardCreatedProject':
        return this.runProjectCreatedProjectDiscard(request, payload);
      case 'getPackageJson':
        return typeof this.projectService.getPackageJson === 'function'
          ? await this.projectService.getPackageJson()
          : this.projectService.currentPackageData ?? null;
      case 'getBoardJson':
        return typeof this.projectService.getBoardJson === 'function'
          ? await this.projectService.getBoardJson()
          : null;
      case 'getBoardModule':
        return typeof this.projectService.getBoardModule === 'function'
          ? await this.projectService.getBoardModule()
          : null;
      case 'getBoardPackageJson':
        return typeof this.projectService.getBoardPackageJson === 'function'
          ? await this.projectService.getBoardPackageJson()
          : null;
      case 'reloadProject':
        return await reloadProjectTool(this.projectService, {});
      case 'switchBoard': {
        const board = this.normalizeSessionId(payload.board);
        if (!board) {
          throw new HostResourceOperationError(
            '[AilyChat][RuntimeHost] switchBoard requires board.',
            'resource_operation_payload_invalid',
            false,
          );
        }
        return await this.runProjectDeclaredMutationOperation(request, 'switchBoard', [
          'package.json',
          '.temp/package.json',
          'project.aci',
        ], () => switchBoardTool(this.projectService, { board_name: board }));
      }
      case 'setBoardConfig': {
        const configEntry = this.readBoardConfigEntry(payload);
        return await this.runProjectDeclaredMutationOperation(request, 'setBoardConfig', [
          'package.json',
          '.temp/package.json',
        ], () => setBoardConfigTool(this.projectService, this.builderService, {
            config_key: configEntry.key,
            config_value: configEntry.value,
          }));
      }
      default:
        throw new HostResourceOperationError(
          `[AilyChat][RuntimeHost] Unsupported project info action: ${String(payload.action || '<missing>')}.`,
          'resource_operation_payload_invalid',
          false,
        );
    }
  }

  private async runProjectDeclaredMutationOperation(
    request: ChatRuntimeHostResourceOperationRequest,
    action: 'switchBoard' | 'setBoardConfig',
    relativeFilePaths: readonly string[],
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const sessionId = this.requireSessionId(request, `project ${action}`);
    const turnId = this.normalizeSessionId(request.turnId);
    const toolCallId = this.normalizeSessionId(request.toolCallId);
    if (!turnId || !toolCallId) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Project ${action} requires canonical turn and tool identities.`,
        'resource_operation_mutation_identity_missing',
        false,
      );
    }
    const projectPath = this.normalizeSessionId(this.projectService.currentProjectPath);
    if (!projectPath) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Project ${action} requires an active project.`,
        'resource_operation_payload_invalid',
        false,
      );
    }

    const transactionId = `project:${turnId}:${toolCallId}:${action}`;
    this.assertWorkspaceMutationNotPrepared(transactionId);
    const transaction = new ChatRuntimeHostWorkspaceMutationTransaction({
      sessionId,
      turnId,
      toolCallId,
      transactionId,
    }, this.electronService);
    await transaction.captureTextFiles(relativeFilePaths.map(filePath => this.joinProjectPath(projectPath, filePath)));

    let result: unknown;
    try {
      result = await operation();
      if (this.isToolUseError(result)) {
        await transaction.rollback();
        return result;
      }
      await transaction.recordCapturedTextFileChanges();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    return transaction.hasMutations
      ? {
          ...(result && typeof result === 'object' ? result : { result }),
          mutationBatch: this.prepareWorkspaceMutation(transaction),
        }
      : result;
  }

  private async runProjectCreateOperation(
    request: ChatRuntimeHostResourceOperationRequest,
    payload: HostResourceOperationPayload,
  ): Promise<unknown> {
    const sessionId = this.requireSessionId(request, 'project create');
    const turnId = this.normalizeSessionId(request.turnId);
    const toolCallId = this.normalizeSessionId(request.toolCallId);
    if (!turnId || !toolCallId) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Project create requires canonical turn and tool identities.',
        'resource_operation_mutation_identity_missing',
        false,
      );
    }
    const basePath = this.normalizeSessionId(payload.path)
      || this.normalizeSessionId(this.projectService.projectRootPath);
    if (!basePath) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] createProject requires a target project root path.',
        'resource_operation_payload_invalid',
        false,
      );
    }

    const boardInput = this.normalizeSessionId(payload.board);
    if (!boardInput) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] createProject requires board.',
        'resource_operation_payload_invalid',
        false,
      );
    }

    const boardInfo = this.resolveBoardForProjectCreate(boardInput);
    const boardName = this.normalizeSessionId(boardInfo['name']) || boardInput;
    const projectName = this.resolveProjectCreateName(basePath, payload.name);
    const boardNickname = this.normalizeSessionId(boardInfo['nickname'])
      || this.normalizeSessionId(boardInfo['displayName'])
      || boardName;
    const boardVersion = this.normalizeSessionId(boardInfo['version']) || 'latest';
    const devmode = this.resolveBoardDevelopmentMode(boardInfo);
    const projectPath = this.joinProjectPath(basePath, projectName.replace(/\s/g, '_'));
    if (this.projectPathExists(projectPath)) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Project create target already exists.',
        'project_create_target_exists',
        false,
      );
    }
    const transaction = new ChatRuntimeHostWorkspaceMutationTransaction({
      sessionId,
      turnId,
      toolCallId,
      transactionId: `project:${turnId}:${toolCallId}:createProject`,
    }, this.electronService);

    const result = await this.projectService.projectNew({
      name: projectName,
      path: basePath,
      board: {
        ...boardInfo,
        name: boardName,
        nickname: boardNickname,
        version: boardVersion,
      },
      ...(devmode ? { devmode } : {}),
    }, {
      activationReason: 'chat-tool-create',
      sessionResource: request.sessionId ?? null,
      deferActivation: true,
    });
    if (result === false) {
      this.deletePendingProjectDirectory(projectPath);
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Project service returned false while creating project.',
        'project_create_failed',
        false,
      );
    }
    try {
      for (const filePath of this.collectProjectCreatedFiles(projectPath)) {
        const bytes = this.electronService.readFileBytes(filePath);
        const textContent = this.decodeProjectTextFile(bytes);
        transaction.record(textContent === null
          ? {
              filePath,
              existedBefore: false,
              contentKind: 'binary',
              beforeBytes: null,
              afterBytes: bytes,
            }
          : {
              filePath,
              existedBefore: false,
              contentKind: 'text',
              beforeContent: null,
              afterContent: textContent,
            });
      }
      if (!transaction.hasMutations) {
        throw new Error('Created project contains no files.');
      }
    } catch (error) {
      this.deletePendingProjectDirectory(projectPath);
      throw error;
    }

    const mutationBatch = transaction.createBatch();
    this.pendingProjectCreations.set(mutationBatch.transactionId, {
      sessionId,
      turnId,
      toolCallId,
      projectPath,
    });
    this.configService.recordBoardUsage?.(boardName);
    return {
      projectOpened: false,
      projectPrepared: true,
      projectPath,
      path: projectPath,
      projectName,
      board: {
        name: boardName,
        nickname: boardNickname,
        version: boardVersion,
      },
      mutationBatch,
    };
  }

  private async runProjectCreatedProjectActivation(
    request: ChatRuntimeHostResourceOperationRequest,
    payload: HostResourceOperationPayload,
  ): Promise<unknown> {
    const pending = this.consumePendingProjectCreation(request, payload);
    const activated = await this.projectService.activateCreatedProject(pending.projectPath, {
      activationReason: 'chat-tool-create',
      sessionResource: request.sessionId ?? null,
    });
    if (!activated) {
      this.deletePendingProjectDirectory(pending.projectPath);
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Created project could not be activated.',
        'project_create_activation_failed',
        false,
      );
    }
    return {
      projectOpened: true,
      projectPath: pending.projectPath,
      path: pending.projectPath,
    };
  }

  private runProjectCreatedProjectDiscard(
    request: ChatRuntimeHostResourceOperationRequest,
    payload: HostResourceOperationPayload,
  ): unknown {
    const pending = this.consumePendingProjectCreation(request, payload);
    this.deletePendingProjectDirectory(pending.projectPath);
    return { discarded: true, projectPath: pending.projectPath };
  }

  private consumePendingProjectCreation(
    request: ChatRuntimeHostResourceOperationRequest,
    payload: HostResourceOperationPayload,
  ): { readonly sessionId: string; readonly turnId: string; readonly toolCallId: string; readonly projectPath: string } {
    const transactionId = this.normalizeSessionId(payload.transactionId);
    const pending = this.pendingProjectCreations.get(transactionId);
    if (!pending
      || pending.sessionId !== this.normalizeSessionId(request.sessionId)
      || pending.turnId !== this.normalizeSessionId(request.turnId)
      || pending.toolCallId !== this.normalizeSessionId(request.toolCallId)) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Created project transaction is missing or has stale identity.',
        'project_create_transaction_stale',
        false,
      );
    }
    this.pendingProjectCreations.delete(transactionId);
    return pending;
  }

  private collectProjectCreatedFiles(rootPath: string): string[] {
    const files: string[] = [];
    const visit = (directoryPath: string) => {
      const entries = this.electronService.readDir(directoryPath) as Array<string | { name?: string; _isDirectory?: boolean }>;
      for (const entry of entries) {
        const name = typeof entry === 'string' ? entry : this.normalizeSessionId(entry.name);
        if (!name) {
          continue;
        }
        const childPath = this.joinProjectPath(directoryPath, name);
        const isDirectory = typeof entry === 'object' && typeof entry._isDirectory === 'boolean'
          ? entry._isDirectory
          : this.electronService.isDirectory(childPath);
        if (isDirectory) {
          visit(childPath);
        } else {
          files.push(childPath);
        }
      }
    };
    visit(rootPath);
    return files.sort((left, right) => left.localeCompare(right));
  }

  private decodeProjectTextFile(bytes: Uint8Array): string | null {
    if (bytes.some(byte => byte === 0)) {
      return null;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  private deletePendingProjectDirectory(projectPath: string): void {
    try {
      if (projectPath && this.electronService.exists(projectPath)) {
        this.electronService.deleteDir(projectPath);
      }
    } catch (error) {
      console.error('[AilyChat][RuntimeHost] Failed to discard uncommitted project directory:', error);
    }
  }

  private resolveProjectCreateName(basePath: string, requestedName: unknown): string {
    const normalizedName = this.normalizeSessionId(requestedName);
    if (!normalizedName) {
      return this.projectService.generateUniqueProjectName(basePath);
    }
    const fileName = normalizedName.replace(/\s/g, '_');
    if (!this.projectPathExists(this.joinProjectPath(basePath, fileName))) {
      return normalizedName;
    }
    const prefix = `${fileName}_`;
    return this.projectService.generateUniqueProjectName(basePath, prefix);
  }

  private resolveBoardForProjectCreate(board: string): Record<string, unknown> {
    const parsedBoard = this.tryParseBoardInfo(board);
    if (parsedBoard) {
      return parsedBoard;
    }

    const candidates = this.readBoardCandidates(board);
    const boardDict = this.configService.boardDict && typeof this.configService.boardDict === 'object'
      ? this.configService.boardDict as Record<string, unknown>
      : {};
    for (const candidate of candidates) {
      const boardInfo = boardDict[candidate];
      if (boardInfo && typeof boardInfo === 'object') {
        return boardInfo as Record<string, unknown>;
      }
    }

    const boardList = Array.isArray(this.configService.boardList) ? this.configService.boardList : [];
    const normalizedCandidates = candidates.map(candidate => candidate.toLowerCase());
    const matchedBoard = boardList.find(item => {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const names = [
        this.normalizeSessionId(record['name']),
        this.normalizeSessionId(record['nickname']),
        this.normalizeSessionId(record['displayName']),
      ].filter(Boolean).map(value => value.toLowerCase());
      return names.some(name => normalizedCandidates.includes(name));
    });
    if (matchedBoard && typeof matchedBoard === 'object') {
      return matchedBoard as Record<string, unknown>;
    }

    throw new HostResourceOperationError(
      `[AilyChat][RuntimeHost] Board not found for project creation: ${board}.`,
      'project_create_board_not_found',
      false,
    );
  }

  private tryParseBoardInfo(board: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(board);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const name = this.normalizeSessionId((parsed as Record<string, unknown>)['name']);
        if (name) {
          return {
            ...(parsed as Record<string, unknown>),
            name,
          };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private readBoardCandidates(board: string): string[] {
    const normalized = this.normalizeSessionId(board);
    if (!normalized) {
      return [];
    }
    const candidates = [normalized];
    if (!normalized.startsWith('@aily-project/')) {
      candidates.push(`@aily-project/${normalized}`);
      if (!normalized.startsWith('board-')) {
        candidates.push(`@aily-project/board-${normalized}`);
      }
    }
    return Array.from(new Set(candidates));
  }

  private resolveBoardDevelopmentMode(boardInfo: Record<string, unknown>): string | undefined {
    const mode = boardInfo['mode'];
    if (Array.isArray(mode)) {
      return this.normalizeSessionId(mode[0]) || undefined;
    }
    return this.normalizeSessionId(mode) || undefined;
  }

  private joinProjectPath(basePath: string, fileName: string): string {
    const pathApi = (globalThis as unknown as { window?: { path?: { join?: (...parts: string[]) => string } } }).window?.path;
    if (typeof pathApi?.join === 'function') {
      return pathApi.join(basePath, fileName);
    }
    return `${basePath.replace(/[\\/]+$/, '')}/${fileName}`;
  }

  private projectPathExists(projectPath: string): boolean {
    const pathApi = (globalThis as unknown as { window?: { path?: { isExists?: (path: string) => boolean } } }).window?.path;
    if (typeof pathApi?.isExists === 'function') {
      return pathApi.isExists(projectPath);
    }
    const fsApi = (globalThis as unknown as { window?: { fs?: { existsSync?: (path: string) => boolean } } }).window?.fs;
    return typeof fsApi?.existsSync === 'function' ? fsApi.existsSync(projectPath) : false;
  }

  private buildProjectInfoSnapshot(): Record<string, unknown> {
    const path = this.normalizeSessionId(this.projectService.currentProjectPath);
    const rootPath = this.normalizeSessionId(this.projectService.projectRootPath);
    const packageData = this.projectService.currentPackageData && typeof this.projectService.currentPackageData === 'object'
      ? this.projectService.currentPackageData as unknown as Record<string, unknown>
      : {};
    return {
      projectOpened: Boolean(path),
      path,
      rootPath: rootPath || path,
      board: this.normalizeSessionId(packageData['board']),
      name: this.normalizeSessionId(packageData['nickname']) || this.normalizeSessionId(packageData['name']),
      package: packageData,
    };
  }

  private withRuntimeConfigSnapshot(projectInfo: unknown): unknown {
    const base = projectInfo && typeof projectInfo === 'object'
      ? { ...(projectInfo as Record<string, unknown>) }
      : {};
    return {
      ...base,
      runtimeConfig: this.buildRuntimeConfigSnapshot(),
    };
  }

  private buildRuntimeConfigSnapshot(): {
    readonly apiEndpoint: string;
    readonly authToken: string;
    readonly isLoggedIn: boolean;
    readonly userId: string | null;
    readonly maxRequests: number;
    readonly memoryToolEnabled: boolean;
    readonly repositoryMemoryEnabled: boolean;
  } {
    if (!AilyHost.isInitialized()) {
      return {
        apiEndpoint: '',
        authToken: '',
        isLoggedIn: false,
        userId: null,
        maxRequests: this.normalizeMaxRequests(this.chatConfigService.maxRequests),
        memoryToolEnabled: this.chatConfigService.memoryToolEnabled !== false,
        repositoryMemoryEnabled: this.chatConfigService.repositoryMemoryEnabled === true,
      };
    }

    const host = AilyHost.get();
    const auth = host.auth;
    const snapshot = typeof auth?.getSnapshot === 'function' ? auth.getSnapshot() : null;
    const userInfo = auth?.userInfo ?? (snapshot && typeof snapshot === 'object' ? (snapshot as { userInfo?: unknown }).userInfo : null);
    const userId = userInfo && typeof userInfo === 'object'
      ? this.normalizeSessionId((userInfo as { id?: unknown }).id)
      : '';
    return {
      apiEndpoint: this.normalizeSessionId(host.config?.apiEndpoint),
      authToken: this.readRuntimeAuthTokenSnapshot(auth),
      isLoggedIn: Boolean(auth?.isLoggedIn),
      userId: userId || null,
      maxRequests: this.normalizeMaxRequests(this.chatConfigService.maxRequests),
      memoryToolEnabled: this.chatConfigService.memoryToolEnabled !== false,
      repositoryMemoryEnabled: this.chatConfigService.repositoryMemoryEnabled === true,
    };
  }

  private readRuntimeAuthTokenSnapshot(auth: unknown): string {
    const authRecord = auth && typeof auth === 'object' ? auth as {
      token?: unknown;
      getAuthHeaders?: () => Record<string, string> | null | undefined;
    } : {};
    const directToken = this.normalizeBearerToken(this.normalizeSessionId(authRecord.token));
    if (directToken) {
      return directToken;
    }

    const headerToken = this.readAuthorizationHeaderToken(authRecord);
    if (headerToken) {
      return headerToken;
    }

    const storedToken = this.readStoredAuthTokenSnapshot();
    return this.normalizeBearerToken(storedToken);
  }

  private readAuthorizationHeaderToken(auth: { getAuthHeaders?: () => Record<string, string> | null | undefined }): string {
    if (typeof auth.getAuthHeaders !== 'function') {
      return '';
    }
    try {
      const headers = auth.getAuthHeaders() ?? {};
      return this.normalizeBearerToken(
        this.normalizeSessionId(headers['Authorization'])
        || this.normalizeSessionId(headers['authorization']),
      );
    } catch {
      return '';
    }
  }

  private readStoredAuthTokenSnapshot(): string {
    const globalWindow = (globalThis as unknown as { window?: unknown }).window as {
      electronAPI?: {
        path?: {
          getAppDataPath?: () => string;
          join?: (...parts: string[]) => string;
        };
        fs?: {
          existsSync?: (path: string) => boolean;
          readFileSync?: (path: string, encoding?: string) => string;
        };
      };
      localStorage?: {
        getItem?: (key: string) => string | null;
      };
    } | undefined;

    try {
      const pathApi = globalWindow?.electronAPI?.path;
      const fsApi = globalWindow?.electronAPI?.fs;
      if (pathApi?.getAppDataPath && pathApi?.join && fsApi?.existsSync && fsApi?.readFileSync) {
        const authFilePath = pathApi.join(pathApi.getAppDataPath(), '.aily');
        if (fsApi.existsSync(authFilePath)) {
          const content = fsApi.readFileSync(authFilePath, 'utf8');
          const parsed = JSON.parse(content) as { access_token?: unknown };
          const token = this.normalizeSessionId(parsed.access_token);
          if (token) {
            return token;
          }
        }
      }
    } catch {
      // Fall through to localStorage.
    }

    try {
      return this.normalizeSessionId(globalWindow?.localStorage?.getItem?.('aily_auth_token'));
    } catch {
      return '';
    }
  }

  private normalizeBearerToken(value: string): string {
    const token = value.trim();
    if (!token) {
      return '';
    }
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(token);
    return bearerMatch ? bearerMatch[1].trim() : token;
  }

  private normalizeMaxRequests(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 200;
    }
    return Math.max(1, Math.min(200, Math.trunc(value)));
  }

  private readBoardConfigEntry(payload: HostResourceOperationPayload): { readonly key: string; readonly value: string } {
    const directKey = this.normalizeSessionId(payload.configKey ?? payload.config_key);
    const directValue = this.normalizeSessionId(payload.configValue ?? payload.config_value);
    if (directKey && directValue) {
      return { key: directKey, value: directValue };
    }
    const config = payload.config && typeof payload.config === 'object'
      ? payload.config as Record<string, unknown>
      : {};
    const entries = Object.entries(config);
    if (entries.length === 1) {
      const [key, value] = entries[0];
      const normalizedKey = this.normalizeSessionId(key);
      const normalizedValue = value === undefined || value === null ? '' : String(value);
      if (normalizedKey && normalizedValue) {
        return { key: normalizedKey, value: normalizedValue };
      }
    }
    throw new HostResourceOperationError(
      '[AilyChat][RuntimeHost] setBoardConfig requires configKey/configValue or a single-entry config object.',
      'resource_operation_payload_invalid',
      false,
    );
  }

  private async runProjectBuildOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'project build');
    const payload = this.requirePayloadAdapter(request.payload, 'builder', 'project build');
    if (payload.action === 'listSerialPorts') {
      const ports = await this.serialService.getSerialPorts();
      return ports
        .map(port => ({
          port: this.normalizeSessionId(port.name),
          label: this.normalizeSessionId(port.text) || this.normalizeSessionId(port.name),
          type: this.normalizeSessionId(port.type) || 'serial',
          selected: this.normalizeSessionId(this.serialService.currentPort) === this.normalizeSessionId(port.name),
        }))
        .filter(port => !!port.port);
    }

    const projectPath = this.normalizeSessionId(payload.projectPath);
    if (!projectPath) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] project build requires projectPath.',
        'resource_operation_payload_invalid',
        false,
      );
    }

    if (payload.action === 'build') {
      return await this.builderService.build(projectPath);
    }
    if (payload.action === 'upload') {
      const port = this.normalizeSessionId(payload.port);
      if (!port) {
        throw new HostResourceOperationError(
          '[AilyChat][RuntimeHost] project upload requires an explicit serial port.',
          'resource_operation_payload_invalid',
          false,
        );
      }
      await this.serialService.selectSerialPort(port);
      return await this.uploaderService.upload();
    }
    throw new HostResourceOperationError(
      `[AilyChat][RuntimeHost] Unsupported project build action: ${String(payload.action || '<missing>')}.`,
      'resource_operation_payload_invalid',
      false,
    );
  }

  private async runProjectLintOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'project lint');
    const payload = this.requirePayloadAdapter(request.payload, 'arduinoLint', 'project lint');
    if (payload.action !== 'checkSyntax') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported project lint action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    const code = typeof payload.code === 'string' ? payload.code : '';
    if (!code.trim()) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] project lint requires source code.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    const options = payload.options && typeof payload.options === 'object'
      ? payload.options as Record<string, unknown>
      : {};
    return await this.arduinoLintService.checkSyntax(code, options as never);
  }

  private async runToolApprovalOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'tool approval');
    const payload = this.requirePayloadAdapter(request.payload, 'toolApproval', 'tool approval');
    if (payload.action !== 'preflight') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported tool approval action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    if (!this.ownerToolApproval) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] tool approval service is unavailable.',
        'resource_operation_unavailable',
        false,
      );
    }
    const toolCallId = this.normalizeSessionId(payload.toolCallId);
    const toolName = this.normalizeSessionId(payload.toolName);
    if (!toolCallId || !toolName) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] tool approval preflight requires toolCallId and toolName.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    return await this.ownerToolApproval.checkToolApprovalPreflight({
      lexStream: null,
      sessionId: request.sessionId,
      defaultSessionId: request.sessionId,
      request: {
        approvalTraceId: this.normalizeSessionId(payload.approvalTraceId) || undefined,
        toolCallId,
        toolName,
        title: this.normalizeSessionId(payload.title),
        subtitle: this.normalizeSessionId(payload.subtitle) || undefined,
        message: this.normalizeSessionId(payload.message),
        source: this.normalizeSessionId(payload.source) || undefined,
        actions: Array.isArray(payload.actions) ? payload.actions as never : undefined,
        primaryScope: this.normalizeSessionId(payload.primaryScope) as never,
        allowAutoConfirm: payload.allowAutoConfirm !== false,
        approveCombination: payload.approveCombination && typeof payload.approveCombination === 'object'
          ? payload.approveCombination as never
          : undefined,
        args: normalizeToolApprovalArgs(toolName, payload.args, payload.message || payload.title),
      },
    });
  }

  private async runBlocklyWorkspaceOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'Blockly workspace');
    const payload = this.requirePayloadAdapter(request.payload, 'blockly', 'Blockly workspace');
    const blocklyService = this.blocklyService as unknown as Record<string, unknown>;
    switch (payload.action) {
      case 'getWorkspaceXml':
        return typeof blocklyService['getWorkspaceXml'] === 'function'
          ? blocklyService['getWorkspaceXml'].call(this.blocklyService)
          : undefined;
      case 'loadWorkspace':
        return typeof blocklyService['loadWorkspace'] === 'function'
          ? blocklyService['loadWorkspace'].call(this.blocklyService, typeof payload.xml === 'string' ? payload.xml : '')
          : undefined;
      case 'getGeneratedCode':
        return typeof blocklyService['getGeneratedCode'] === 'function'
          ? blocklyService['getGeneratedCode'].call(this.blocklyService)
          : undefined;
      case 'reloadAbiJson':
        return typeof blocklyService['reloadAbiJson'] === 'function'
          ? blocklyService['reloadAbiJson'].call(this.blocklyService)
          : undefined;
      case 'getBlockDefinitions':
        return typeof blocklyService['getBlockDefinitions'] === 'function'
          ? blocklyService['getBlockDefinitions'].call(this.blocklyService)
          : undefined;
      default:
        throw new HostResourceOperationError(
          `[AilyChat][RuntimeHost] Unsupported Blockly workspace action: ${String(payload.action || '<missing>')}.`,
          'resource_operation_payload_invalid',
          false,
        );
    }
  }

  private async runConnectionGraphOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    const sessionId = this.requireSessionId(request, 'connection graph');
    const payload = this.requirePayloadAdapter(request.payload, 'connectionGraph', 'connection graph');
    const action = typeof payload.action === 'string' ? payload.action : '';
    const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
      ? payload.args as Record<string, unknown>
      : {};
    const usesWorkspaceMutation = action === 'generateConnectionGraph'
      || action === 'getPinmapSummary'
      || action === 'validateConnectionGraph'
      || action === 'savePinmap'
      || action === 'applySchematic';
    const turnId = this.normalizeSessionId(request.turnId);
    const toolCallId = this.normalizeSessionId(request.toolCallId);
    if (usesWorkspaceMutation && (!turnId || !toolCallId)) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Mutating connection graph operations require canonical turn and tool identities.',
        'resource_operation_mutation_identity_missing',
        false,
      );
    }
    const transactionId = `connection-graph:${turnId}:${toolCallId}:${action}`;
    if (usesWorkspaceMutation) {
      this.assertWorkspaceMutationNotPrepared(transactionId);
    }
    const mutationTransaction = usesWorkspaceMutation
      ? new ChatRuntimeHostWorkspaceMutationTransaction({
          sessionId,
          turnId,
          toolCallId,
          transactionId,
        }, this.electronService)
      : null;
    const invocationContext = {
      turnId,
      toolCallId,
      recordMutationReceipt: mutationTransaction?.record,
    };

    let result: unknown;
    try {
      switch (action) {
        case 'generateConnectionGraph':
          result = await generateConnectionGraphTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
          break;
        case 'getPinmapSummary':
          result = await getPinmapSummaryTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
          break;
        case 'getProjectContext':
          result = await getProjectContextTool(this.connectionGraphService, this.projectService, args as never);
          break;
        case 'getSensorPinmapCatalog':
          result = await getSensorPinmapCatalogTool(this.connectionGraphService, this.projectService, args as never);
          break;
        case 'validateConnectionGraph':
          result = await validateConnectionGraphTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
          break;
        case 'generatePinmap':
          result = await generatePinmapTool(this.connectionGraphService, this.projectService, args as never);
          break;
        case 'savePinmap':
          result = await savePinmapTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
          break;
        case 'getCurrentSchematic':
          result = await getCurrentSchematicTool(this.connectionGraphService, this.projectService, args);
          break;
        case 'applySchematic':
          result = await applySchematicTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
          break;
        default:
          throw new HostResourceOperationError(
            `[AilyChat][RuntimeHost] Unsupported connection graph action: ${String(payload.action || '<missing>')}.`,
            'resource_operation_payload_invalid',
            false,
          );
      }
    } catch (error) {
      await mutationTransaction?.rollback();
      throw error;
    }

    if (this.isToolUseError(result)) {
      await mutationTransaction?.rollback();
      return result;
    }
    if (!mutationTransaction?.hasMutations) {
      return result;
    }
    return {
      ...(result && typeof result === 'object' ? result : { content: result }),
      mutationBatch: this.prepareWorkspaceMutation(mutationTransaction),
    };
  }

  private async runSubappAgentOperation(
    request: ChatRuntimeHostResourceOperationRequest,
  ): Promise<Record<string, unknown>> {
    const payload = this.requirePayloadAdapter(request.payload, 'subappAgent', 'subapp Agent operation');
    if (!this.subappAgentBridgeService) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] subapp Agent bridge is unavailable.',
        'resource_operation_unavailable',
        true,
      );
    }
    if (payload.action === 'releaseSession') {
      return this.subappAgentBridgeService.releaseSession(request.sessionId);
    }
    if (payload.action !== 'execute') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported subapp Agent action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    const input = payload.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] subapp Agent operation requires an input object.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    return this.subappAgentBridgeService.execute(
      input as Record<string, unknown>,
      undefined,
      {
        sessionId: request.sessionId,
        turnId: request.turnId,
        toolCallId: request.toolCallId,
      },
    );
  }

  private prepareWorkspaceMutation(
    transaction: ChatRuntimeHostWorkspaceMutationTransaction,
  ): ChatRuntimeHostWorkspaceMutationBatch {
    const batch = transaction.createBatch('prepared');
    if (this.pendingWorkspaceMutations.has(batch.transactionId)) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Workspace mutation is already prepared: ${batch.transactionId}.`,
        'resource_operation_mutation_already_prepared',
        false,
      );
    }
    this.pendingWorkspaceMutations.set(batch.transactionId, { batch, transaction });
    return batch;
  }

  private assertWorkspaceMutationNotPrepared(transactionId: string): void {
    if (!this.pendingWorkspaceMutations.has(transactionId)) {
      return;
    }
    throw new HostResourceOperationError(
      `[AilyChat][RuntimeHost] Workspace mutation is already prepared: ${transactionId}.`,
      'resource_operation_mutation_already_prepared',
      false,
    );
  }

  private async runWorkspaceMutationControl(
    request: ChatRuntimeHostResourceOperationRequest,
  ): Promise<{
    readonly transactionId: string;
    readonly status: 'committed' | 'rolled-back' | 'not-found';
  }> {
    const sessionId = this.requireSessionId(request, 'workspace mutation control');
    const payload = this.requirePayloadAdapter(
      request.payload,
      'workspaceMutation',
      'workspace mutation control',
    );
    const transactionId = this.normalizeSessionId(payload.transactionId);
    if (!transactionId || (payload.action !== 'commit' && payload.action !== 'rollback')) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Workspace mutation control requires action and transaction identity.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    const pending = this.pendingWorkspaceMutations.get(transactionId);
    if (!pending) {
      return { transactionId, status: 'not-found' };
    }
    const turnId = this.normalizeSessionId(request.turnId);
    const toolCallId = this.normalizeSessionId(request.toolCallId);
    if (pending.batch.sessionId !== sessionId
      || pending.batch.turnId !== turnId
      || pending.batch.toolCallId !== toolCallId) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Workspace mutation control identity mismatch.',
        'resource_operation_mutation_identity_mismatch',
        false,
      );
    }
    this.pendingWorkspaceMutations.delete(transactionId);
    if (payload.action === 'rollback') {
      await pending.transaction.rollback();
      return { transactionId, status: 'rolled-back' };
    }
    return { transactionId, status: 'committed' };
  }

  private async runBoardSearchOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'board search');
    const payload = this.requirePayloadAdapter(request.payload, 'boardSearch', 'board search');
    const action = this.normalizeSessionId(payload.action);
    if (typeof this.configService.loadHardwareIndexForAI === 'function') {
      await this.configService.loadHardwareIndexForAI();
    }

    if (action === 'search') {
      const query = this.normalizeSessionId(payload.query);
      const searchType = this.normalizeBoardSearchType(payload.searchType);
      return this.searchBoardLibraryIndexes(query, searchType);
    }

    if (action === 'getCategories') {
      const categoryType = this.normalizeCategoryType(payload.categoryType);
      const dimension = this.normalizeSessionId(payload.dimension);
      if (!dimension) {
        throw new HostResourceOperationError(
          '[AilyChat][RuntimeHost] board search getCategories requires dimension.',
          'resource_operation_payload_invalid',
          false,
        );
      }
      return this.getBoardLibraryCategories(categoryType, dimension);
    }

    throw new HostResourceOperationError(
      `[AilyChat][RuntimeHost] Unsupported board search action: ${String(payload.action || '<missing>')}.`,
      'resource_operation_payload_invalid',
      false,
    );
  }

  private normalizeBoardSearchType(value: unknown): 'boards' | 'libraries' | 'both' {
    const normalized = this.normalizeSessionId(value);
    return normalized === 'boards' || normalized === 'libraries' ? normalized : 'both';
  }

  private normalizeCategoryType(value: unknown): 'boards' | 'libraries' {
    return this.normalizeSessionId(value) === 'libraries' ? 'libraries' : 'boards';
  }

  private searchBoardLibraryIndexes(query: string, searchType: 'boards' | 'libraries' | 'both'): {
    readonly boards?: readonly unknown[];
    readonly libraries?: readonly unknown[];
  } {
    const includeBoards = searchType === 'boards' || searchType === 'both';
    const includeLibraries = searchType === 'libraries' || searchType === 'both';
    const tokens = this.tokenizeSearchQuery(query);
    return {
      ...(includeBoards ? { boards: this.searchIndexItems(this.readBoardSearchItems(), tokens) } : {}),
      ...(includeLibraries ? { libraries: this.searchIndexItems(this.readLibrarySearchItems(), tokens) } : {}),
    };
  }

  private getBoardLibraryCategories(type: 'boards' | 'libraries', dimension: string): readonly { readonly value: string; readonly count: number }[] {
    const items = type === 'boards' ? this.readBoardSearchItems() : this.readLibrarySearchItems();
    const counts = new Map<string, number>();
    for (const item of items) {
      const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const value = record[dimension];
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        const normalized = this.normalizeSessionId(entry);
        if (normalized) {
          counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([value, count]) => ({ value, count }));
  }

  private readBoardSearchItems(): readonly unknown[] {
    const indexed = Array.isArray(this.configService.boardIndex) ? this.configService.boardIndex : [];
    return indexed.length > 0
      ? indexed
      : Array.isArray(this.configService.boardList)
        ? this.configService.boardList
        : [];
  }

  private readLibrarySearchItems(): readonly unknown[] {
    const indexed = Array.isArray(this.configService.libraryIndex) ? this.configService.libraryIndex : [];
    return indexed.length > 0
      ? indexed
      : Array.isArray(this.configService.libraryList)
        ? this.configService.libraryList
        : [];
  }

  private tokenizeSearchQuery(query: string): readonly string[] {
    return query
      .toLowerCase()
      .split(/[\s,，;；]+/)
      .map(token => token.trim())
      .filter(Boolean);
  }

  private searchIndexItems(items: readonly unknown[], tokens: readonly string[]): readonly unknown[] {
    const scored = items.map(item => ({
      item,
      score: this.scoreSearchItem(item, tokens),
    }));
    return scored
      .filter(entry => tokens.length === 0 || entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 50)
      .map(entry => entry.item);
  }

  private scoreSearchItem(item: unknown, tokens: readonly string[]): number {
    if (tokens.length === 0) {
      return 1;
    }
    const haystack = JSON.stringify(item ?? '').toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += 1;
      }
    }
    return score;
  }

  private async runLibraryAnalysisOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'library analysis');
    const payload = this.requirePayloadAdapter(request.payload, 'libraryAnalysis', 'library analysis');
    if (payload.action !== 'analyzeLibrary') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported library analysis action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }

    const libraryIds = this.normalizeStringListOrSingle(payload.libraryIds);
    const libraryNames = libraryIds.length > 0
      ? libraryIds
      : this.normalizeStringListOrSingle(payload.libraryId);
    if (libraryNames.length === 0) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] library analysis requires libraryId.',
        'resource_operation_payload_invalid',
        false,
      );
    }

    const mode = this.normalizeLibraryAnalysisMode(payload.mode);
    return await analyzeLibraryBlocksTool(this.projectService, {
      libraryNames,
      mode,
    });
  }

  private async runDiagnosticsOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'diagnostics');
    const payload = this.requirePayloadAdapter(request.payload, 'diagnostics', 'diagnostics');
    if (payload.action !== 'getErrors') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] Unsupported diagnostics action: ${String(payload.action || '<missing>')}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    return await collectDiagnostics(this.normalizeStringList(payload.filePaths));
  }

  private normalizeLibraryAnalysisMode(value: unknown): 'auto' | 'readme_ref' | 'analysis' {
    const normalized = this.normalizeSessionId(value);
    return normalized === 'readme_ref' || normalized === 'analysis' ? normalized : 'auto';
  }

  private normalizeStringListOrSingle(value: unknown): string[] {
    const list = this.normalizeStringList(value);
    if (list.length > 0) {
      return list;
    }
    const single = this.normalizeSessionId(value);
    if (single) {
      return [single];
    }
    return [];
  }

  private async persistHostSessionRecord(request: ChatRuntimeHostResourceOperationRequest): Promise<{
    readonly saved: true;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
    readonly metadataOnly?: true;
  }> {
    const record = this.readLiveHostSessionRecord(request.payload);
    const sessionId = this.normalizeSessionId(record?.sessionId || request.sessionId);
    if (!record || !sessionId) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] ${request.kind} requires a live host session record payload.`,
        'resource_operation_payload_missing',
        false,
      );
    }

    const normalizedRecord = {
      ...record,
      sessionId,
      metadata: {
        ...record.metadata,
        sessionId,
      },
    };

    if (request.kind === 'history-persistence') {
      await this.chatHistoryService.saveHostRecordMetadataOnlyAsync(normalizedRecord);
      return {
        saved: true,
        sessionId,
        kind: request.kind,
        metadataOnly: true,
      };
    }

    await this.chatHistoryService.saveHostRecordAsync(normalizedRecord, {
      allowEmptyTranscript: (request.payload as HostResourceOperationPayload | undefined)?.allowEmptyTranscript === true,
    });

    return {
      saved: true,
      sessionId,
      kind: request.kind,
    };
  }

  private readLiveHostSessionRecord(payload: unknown): LiveHostSessionRecord | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const payloadObject = payload as HostResourceOperationPayload;
    if (payloadObject.adapter !== 'chatHistory') {
      return null;
    }
    const candidate = payloadObject.record ?? payloadObject.hostRecord ?? payloadObject.liveHostSessionRecord;
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const record = candidate as Partial<LiveHostSessionRecord>;
    const sessionId = this.normalizeSessionId(record.sessionId);
    const metadataSessionId = this.normalizeSessionId(record.metadata?.sessionId);
    if (!sessionId && !metadataSessionId) {
      return null;
    }

    return {
      ...(record as LiveHostSessionRecord),
      sessionId: sessionId || metadataSessionId,
      metadata: {
        ...record.metadata,
        sessionId: sessionId || metadataSessionId,
      },
    };
  }

  private normalizeSessionId(sessionId: unknown): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
  }

  private requirePayloadAdapter(
    payload: unknown,
    adapter: string,
    operation: string,
  ): HostResourceOperationPayload {
    if (!payload || typeof payload !== 'object') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] ${operation} requires a payload.`,
        'resource_operation_payload_missing',
        false,
      );
    }

    const payloadObject = payload as HostResourceOperationPayload;
    if (payloadObject.adapter !== adapter) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] ${operation} payload must use adapter=${adapter}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
    return payloadObject;
  }

  private normalizeNullableString(value: unknown): string | null {
    const normalized = this.normalizeSessionId(value);
    return normalized || null;
  }

  private normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map(item => this.normalizeSessionId(item))
      .filter(item => item.length > 0);
  }

  private normalizeFiniteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private normalizeNullableFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private optionalStringProperty<const K extends string>(
    key: K,
    value: unknown,
  ): { readonly [P in K]?: string } {
    const normalized = this.normalizeSessionId(value);
    return normalized ? { [key]: normalized } as { readonly [P in K]?: string } : {};
  }

  private readProjectPath(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return '';
    }
    return this.normalizeSessionId((payload as HostResourceOperationPayload).projectPath);
  }

  private requireAbsWorkspaceExportPayload(payload: ChatRuntimeHostResourceOperationPayload | undefined): void {
    if (!payload || typeof payload !== 'object') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] ABS workspace export requires a typed payload.',
        'resource_operation_payload_missing',
        false,
      );
    }
    const payloadObject = payload as HostResourceOperationPayload;
    if (payloadObject.adapter !== 'absAutoSync' || payloadObject.action !== 'ensureWorkspaceExport') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] ABS workspace export payload must use absAutoSync.ensureWorkspaceExport.',
        'resource_operation_payload_invalid',
        false,
      );
    }
  }

  private readSyncAbsArgs(request: ChatRuntimeHostResourceOperationRequest): SyncAbsArgs {
    const payload = request.payload;
    if (!payload || typeof payload !== 'object') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] syncAbs resource operation requires a payload.',
        'resource_operation_payload_missing',
        false,
      );
    }
    const payloadObject = payload as ChatRuntimeHostSyncAbsPayload;
    if (payloadObject.adapter !== 'syncAbs') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] File/workspace resource operation payload is not syncAbs.',
        'resource_operation_unsupported',
        false,
      );
    }
    const args = payloadObject.args;
    if (!args || typeof args !== 'object') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] syncAbs resource operation requires args.',
        'resource_operation_payload_missing',
        false,
      );
    }
    const argsObject = args as Partial<SyncAbsArgs>;
    if (argsObject.operation !== 'export'
      && argsObject.operation !== 'import'
      && argsObject.operation !== 'status') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] syncAbs resource operation has an unsupported action.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    return {
      operation: argsObject.operation,
      ...(typeof argsObject.includeHeader === 'boolean' ? { includeHeader: argsObject.includeHeader } : {}),
      ...(typeof argsObject.pendingAbsContent === 'string' ? { pendingAbsContent: argsObject.pendingAbsContent } : {}),
    };
  }

  private assertSyncAbsKindMatchesRequest(
    request: ChatRuntimeHostResourceOperationRequest,
    operation: SyncAbsArgs['operation'],
  ): void {
    const expectedKind = operation === 'import'
      ? 'workspace-mutation'
      : operation === 'export'
        ? 'file-write'
        : 'file-read';
    if (request.kind !== expectedKind) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] syncAbs ${operation} must use ${expectedKind}, got ${request.kind}.`,
        'resource_operation_kind_mismatch',
        false,
      );
    }
  }

  private isToolUseError(result: unknown): boolean {
    if (!result || typeof result !== 'object') {
      return false;
    }
    const candidate = result as { readonly is_error?: unknown; readonly isError?: unknown };
    return candidate.is_error === true || candidate.isError === true;
  }

  private requireSessionId(request: ChatRuntimeHostResourceOperationRequest, operation: string): string {
    const sessionId = this.normalizeSessionId(request.sessionId);
    if (!sessionId) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] ${operation} requires a host session id.`,
        'resource_operation_session_missing',
        false,
      );
    }
    return sessionId;
  }
}
