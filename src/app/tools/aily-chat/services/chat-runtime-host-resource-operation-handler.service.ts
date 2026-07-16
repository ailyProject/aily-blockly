import { Injectable, OnDestroy } from '@angular/core';

import type {
  ChatRuntimeHostEditTrackingPayload,
  ChatRuntimeHostResourceOperationPayload,
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostSyncAbsPayload,
} from '../core/chat-runtime-host-contract';
import {
  registerElectronChatRuntimeResourceOperationHandler,
  type ElectronChatRuntimeResourceOperationHandlerRegistration,
} from '../core/electron-chat-runtime-host-transport';
import { ElectronService } from '../../../services/electron.service';
import { ProjectService } from '../../../services/project.service';
import { BuilderService } from '../../../services/builder.service';
import { ConfigService } from '../../../services/config.service';
import { ConnectionGraphService } from '../../../services/connection-graph.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import {
  runSyncAbsFileConcreteHandler,
  type SyncAbsArgs,
} from '../tools/syncAbsFileTool';
import { analyzeLibraryBlocksTool } from '../tools/editBlockTool';
import { reloadProjectTool } from '../tools/reloadProjectTool';
import { switchBoardTool } from '../tools/switchBoardTool';
import { setBoardConfigTool } from '../tools/boardConfigTool';
import { collectDiagnostics } from '../core/diagnostics';
import { AbsAutoSyncService } from './abs-auto-sync.service';
import { ChatHistoryService, type LiveHostSessionRecord } from './chat-history.service';
import { EditCheckpointService } from './edit-checkpoint.service';
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

  constructor(
    private readonly chatHistoryService: ChatHistoryService,
    private readonly absAutoSyncService: AbsAutoSyncService,
    private readonly editCheckpointService: EditCheckpointService,
    private readonly projectService: ProjectService,
    private readonly electronService: ElectronService,
    private readonly builderService: BuilderService,
    private readonly arduinoLintService: ArduinoLintService,
    private readonly blocklyService: BlocklyService,
    private readonly connectionGraphService: ConnectionGraphService,
    private readonly configService: ConfigService,
    private readonly chatConfigService: AilyChatConfigService,
    private readonly submittedTurnTitleService: ChatRuntimeOwnerSubmittedTurnTitleService,
    private readonly ownerToolApproval?: ChatRuntimeOwnerToolApprovalService,
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
  }

  private handleResourceOperation(request: ChatRuntimeHostResourceOperationRequest): unknown {
    switch (request.kind) {
      case 'abs-session-start-export':
        return this.scheduleSessionStartAbsExport(request);
      case 'checkpoint-commit':
        return this.commitWorkspaceCheckpoint(request);
      case 'checkpoint-settle':
        return this.waitForWorkspaceCheckpointMetadata(request);
      case 'edit-tracking':
        return this.runEditTrackingOperation(request);
      case 'file-read':
      case 'file-write':
      case 'workspace-mutation':
        return this.runSyncAbsResourceOperation(request);
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

  private scheduleSessionStartAbsExport(request: ChatRuntimeHostResourceOperationRequest): {
    readonly scheduled: true;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
    readonly projectPath: string | null;
  } {
    const sessionId = this.requireSessionId(request, 'ABS session-start export');
    this.requireAbsSessionStartExportPayload(request.payload);
    const projectPath = this.readProjectPath(request.payload) || this.normalizeSessionId(request.resource?.['projectPath']);
    if (projectPath) {
      this.absAutoSyncService.initialize(projectPath);
    }
    this.absAutoSyncService.scheduleSessionStartExport();
    return {
      scheduled: true,
      sessionId,
      kind: request.kind,
      projectPath: projectPath || null,
    };
  }

  private async commitWorkspaceCheckpoint(request: ChatRuntimeHostResourceOperationRequest): Promise<{
    readonly committed: boolean;
    readonly skipped: boolean;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
  }> {
    const sessionId = this.requireSessionId(request, 'checkpoint commit');
    this.requireEditCheckpointPayload(request.payload, 'commitCurrentTurn', 'checkpoint commit');
    if (this.editCheckpointService.getTotalEditCount() === 0) {
      await this.editCheckpointService.waitForCheckpointMetadataSettled();
      return {
        committed: false,
        skipped: true,
        sessionId,
        kind: request.kind,
      };
    }

    await this.editCheckpointService.commitCurrentTurn();
    return {
      committed: true,
      skipped: false,
      sessionId,
      kind: request.kind,
    };
  }

  private async waitForWorkspaceCheckpointMetadata(request: ChatRuntimeHostResourceOperationRequest): Promise<{
    readonly settled: true;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
  }> {
    const sessionId = this.requireSessionId(request, 'checkpoint settle');
    this.requireEditCheckpointPayload(request.payload, 'settleMetadata', 'checkpoint settle');
    await this.editCheckpointService.waitForCheckpointMetadataSettled();
    return {
      settled: true,
      sessionId,
      kind: request.kind,
    };
  }

  private async runEditTrackingOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<{
    readonly applied: true;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
    readonly action: ChatRuntimeHostEditTrackingPayload['action'];
    readonly checkpointMetadata?: unknown;
    readonly forkedTurnResponses?: readonly unknown[] | null;
  }> {
    const sessionId = this.requireSessionId(request, 'edit tracking');
    const payload = this.readEditTrackingPayload(request.payload);
    switch (payload.action) {
      case 'setAutoSaveEdits':
        this.editCheckpointService.autoSaveEdits = payload.autoSaveEdits;
        break;
      case 'setTimelineContext':
        this.editCheckpointService.setTimelineContext(sessionId, payload.workspaceRoot ?? null);
        break;
      case 'startTurn':
        if (typeof payload.autoSaveEdits === 'boolean') {
          this.editCheckpointService.autoSaveEdits = payload.autoSaveEdits;
        }
        this.editCheckpointService.startTurn(
          payload.turnIndex,
          payload.turnStartListIndex,
          payload.responseStartListIndex,
          payload.turnId,
          payload.requestContent,
          payload.displayContent,
          payload.checkpointId,
          payload.requestMetadata as never,
        );
        break;
      case 'recordAdditionalRepositoryRootCandidates':
        this.editCheckpointService.recordAdditionalRepositoryRootCandidates(payload.paths);
        break;
      case 'recordEdit':
        this.editCheckpointService.recordEdit(payload.filePath, payload.editType);
        break;
      case 'publishCurrentSummary':
        await this.editCheckpointService.publishCurrentSummary();
        break;
      case 'finalizeCurrentTurn':
        if (typeof payload.autoSaveEdits === 'boolean') {
          this.editCheckpointService.autoSaveEdits = payload.autoSaveEdits;
        }
        await this.editCheckpointService.commitCurrentTurn();
        if (this.editCheckpointService.hasEditsInCurrentTurn()) {
          const summary = await this.editCheckpointService.getEditsSummary();
          if (payload.requestDiffPreview !== false) {
            this.editCheckpointService.requestDiffPreview(summary);
          }
          if (payload.autoSaveEdits === true) {
            this.editCheckpointService.acceptAllAsBaseline();
            this.editCheckpointService.dismissSummary();
          } else {
            this.editCheckpointService.publishSummary(summary);
          }
        }
        return {
          applied: true,
          sessionId,
          kind: request.kind,
          action: payload.action,
          checkpointMetadata: await this.readFinalizedCheckpointMetadata(payload),
        };
      case 'readFinalizedCheckpointMetadata':
        return {
          applied: true,
          sessionId,
          kind: request.kind,
          action: payload.action,
          checkpointMetadata: await this.readFinalizedCheckpointMetadata(payload),
        };
      case 'restoreFromTurnResponses':
        this.editCheckpointService.clear();
        if (typeof payload.autoSaveEdits === 'boolean') {
          this.editCheckpointService.autoSaveEdits = payload.autoSaveEdits;
        }
        this.editCheckpointService.setTimelineContext(sessionId, payload.workspaceRoot ?? null);
        await this.editCheckpointService.rebuildFromTurnResponses(payload.turnResponses as never);
        if (this.editCheckpointService.hasUnsavedEdits()) {
          if (payload.autoSaveEdits === true) {
            this.editCheckpointService.acceptAllAsBaseline();
            this.editCheckpointService.dismissSummary();
          } else {
            await this.editCheckpointService.publishCurrentSummary();
          }
        } else {
          this.editCheckpointService.dismissSummary();
        }
        break;
      case 'forkRequestCheckpointMetadata': {
        const forkedTurnResponses = await this.editCheckpointService.forkRequestCheckpointMetadata?.({
          sourceSessionResource: payload.sourceSessionResource,
          targetSessionResource: payload.targetSessionResource,
          retainedTurnResponses: payload.retainedTurnResponses as never,
        });
        return {
          applied: true,
          sessionId,
          kind: request.kind,
          action: payload.action,
          forkedTurnResponses: Array.isArray(forkedTurnResponses) ? forkedTurnResponses : null,
        };
      }
      case 'clearSessionState':
        this.editCheckpointService.clear();
        if (payload.dismissSummary !== false) {
          this.editCheckpointService.dismissSummary();
        }
        break;
    }
    return {
      applied: true,
      sessionId,
      kind: request.kind,
      action: payload.action,
    };
  }

  private async runSyncAbsResourceOperation(request: ChatRuntimeHostResourceOperationRequest) {
    this.requireSessionId(request, 'syncAbs resource operation');
    const args = this.readSyncAbsArgs(request);
    this.assertSyncAbsKindMatchesRequest(request, args.operation);
    const result = await runSyncAbsFileConcreteHandler(
      args,
      this.projectService,
      this.electronService,
      this.absAutoSyncService,
      {
        sessionId: request.sessionId,
      },
    );
    if (result.is_error) {
      throw new HostResourceOperationError(
        result.content || '[AilyChat][RuntimeHost] syncAbs resource operation failed.',
        'syncabs_operation_failed',
        false,
      );
    }
    return result;
  }

  private async runProjectInfoOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<unknown> {
    this.requireSessionId(request, 'project info');
    const payload = this.requirePayloadAdapter(request.payload, 'project', 'project info');
    switch (payload.action) {
      case 'getProjectInfo':
        return this.withRuntimeConfigSnapshot(this.buildProjectInfoSnapshot());
      case 'createProject':
        return await this.runProjectCreateOperation(request, payload);
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
        return await switchBoardTool(this.projectService, { board_name: board });
      }
      case 'setBoardConfig': {
        const configEntry = this.readBoardConfigEntry(payload);
        return await setBoardConfigTool(this.projectService, this.builderService, {
          config_key: configEntry.key,
          config_value: configEntry.value,
        });
      }
      default:
        throw new HostResourceOperationError(
          `[AilyChat][RuntimeHost] Unsupported project info action: ${String(payload.action || '<missing>')}.`,
          'resource_operation_payload_invalid',
          false,
        );
    }
  }

  private async runProjectCreateOperation(
    request: ChatRuntimeHostResourceOperationRequest,
    payload: HostResourceOperationPayload,
  ): Promise<unknown> {
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
    });
    if (result === false) {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] Project service returned false while creating project.',
        'project_create_failed',
        false,
      );
    }
    this.configService.recordBoardUsage?.(boardName);
    const projectPath = this.joinProjectPath(basePath, projectName.replace(/\s/g, '_'));
    return {
      projectOpened: true,
      projectPath,
      path: projectPath,
      projectName,
      board: {
        name: boardName,
        nickname: boardNickname,
        version: boardVersion,
      },
    };
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
      const upload = (this.builderService as unknown as {
        upload?: (projectPath: string, port?: string) => Promise<unknown>;
      }).upload;
      if (typeof upload !== 'function') {
        throw new HostResourceOperationError(
          '[AilyChat][RuntimeHost] project upload is not available.',
          'resource_operation_unavailable',
          false,
        );
      }
      return await upload.call(this.builderService, projectPath, this.normalizeSessionId(payload.port));
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
    this.requireSessionId(request, 'connection graph');
    const payload = this.requirePayloadAdapter(request.payload, 'connectionGraph', 'connection graph');
    const action = typeof payload.action === 'string' ? payload.action : '';
    const args = payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
      ? payload.args as Record<string, unknown>
      : {};
    const invocationContext = {
      turnId: this.normalizeSessionId(payload.turnId),
      toolCallId: this.normalizeSessionId(payload.toolCallId),
    };

    switch (action) {
      case 'generateConnectionGraph':
        return generateConnectionGraphTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
      case 'getPinmapSummary':
        return getPinmapSummaryTool(this.connectionGraphService, this.projectService, args as never);
      case 'getProjectContext':
        return getProjectContextTool(this.connectionGraphService, this.projectService, args as never);
      case 'getSensorPinmapCatalog':
        return getSensorPinmapCatalogTool(this.connectionGraphService, this.projectService, args as never);
      case 'validateConnectionGraph':
        return validateConnectionGraphTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
      case 'generatePinmap':
        return generatePinmapTool(this.connectionGraphService, this.projectService, args as never);
      case 'savePinmap':
        return savePinmapTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
      case 'getCurrentSchematic':
        return getCurrentSchematicTool(this.connectionGraphService, this.projectService, args);
      case 'applySchematic':
        return applySchematicTool(this.connectionGraphService, this.projectService, args as never, invocationContext);
      default:
        throw new HostResourceOperationError(
          `[AilyChat][RuntimeHost] Unsupported connection graph action: ${String(payload.action || '<missing>')}.`,
          'resource_operation_payload_invalid',
          false,
        );
    }
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

  private requireAbsSessionStartExportPayload(payload: ChatRuntimeHostResourceOperationPayload | undefined): void {
    if (!payload || typeof payload !== 'object') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] ABS session-start export requires a typed payload.',
        'resource_operation_payload_missing',
        false,
      );
    }
    const payloadObject = payload as HostResourceOperationPayload;
    if (payloadObject.adapter !== 'absAutoSync' || payloadObject.action !== 'scheduleSessionStartExport') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] ABS session-start export payload must use absAutoSync.scheduleSessionStartExport.',
        'resource_operation_payload_invalid',
        false,
      );
    }
  }

  private requireEditCheckpointPayload(
    payload: ChatRuntimeHostResourceOperationPayload | undefined,
    action: 'commitCurrentTurn' | 'settleMetadata',
    operation: string,
  ): void {
    if (!payload || typeof payload !== 'object') {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] ${operation} requires a typed payload.`,
        'resource_operation_payload_missing',
        false,
      );
    }
    const payloadObject = payload as HostResourceOperationPayload;
    if (payloadObject.adapter !== 'editCheckpoint' || payloadObject.action !== action) {
      throw new HostResourceOperationError(
        `[AilyChat][RuntimeHost] ${operation} payload must use editCheckpoint.${action}.`,
        'resource_operation_payload_invalid',
        false,
      );
    }
  }

  private readEditTrackingPayload(
    payload: ChatRuntimeHostResourceOperationPayload | undefined,
  ): ChatRuntimeHostEditTrackingPayload {
    if (!payload || typeof payload !== 'object') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] edit tracking operation requires a typed payload.',
        'resource_operation_payload_missing',
        false,
      );
    }
    const payloadObject = payload as HostResourceOperationPayload;
    if (payloadObject.adapter !== 'editTracking') {
      throw new HostResourceOperationError(
        '[AilyChat][RuntimeHost] edit tracking operation payload must use editTracking.',
        'resource_operation_payload_invalid',
        false,
      );
    }
    switch (payloadObject.action) {
      case 'setAutoSaveEdits':
        return {
          adapter: 'editTracking',
          action: 'setAutoSaveEdits',
          autoSaveEdits: payloadObject.autoSaveEdits === true,
        };
      case 'setTimelineContext':
        return {
          adapter: 'editTracking',
          action: 'setTimelineContext',
          workspaceRoot: this.normalizeNullableString(payloadObject.workspaceRoot),
        };
      case 'startTurn':
        return {
          adapter: 'editTracking',
          action: 'startTurn',
          turnIndex: this.normalizeFiniteNumber(payloadObject.turnIndex, 0),
          turnStartListIndex: this.normalizeNullableFiniteNumber(payloadObject.turnStartListIndex),
          responseStartListIndex: this.normalizeNullableFiniteNumber(payloadObject.responseStartListIndex),
          ...this.optionalStringProperty('turnId', payloadObject.turnId),
          ...this.optionalStringProperty('requestContent', payloadObject.requestContent),
          ...this.optionalStringProperty('displayContent', payloadObject.displayContent),
          ...this.optionalStringProperty('checkpointId', payloadObject.checkpointId),
          ...(payloadObject.requestMetadata !== undefined ? { requestMetadata: payloadObject.requestMetadata } : {}),
          ...(typeof payloadObject.autoSaveEdits === 'boolean' ? { autoSaveEdits: payloadObject.autoSaveEdits } : {}),
        };
      case 'recordAdditionalRepositoryRootCandidates':
        return {
          adapter: 'editTracking',
          action: 'recordAdditionalRepositoryRootCandidates',
          paths: this.normalizeStringList(payloadObject.paths),
        };
      case 'recordEdit': {
        const filePath = this.normalizeSessionId(payloadObject.filePath);
        const editType = payloadObject.editType;
        if (!filePath || (editType !== 'create' && editType !== 'modify' && editType !== 'delete')) {
          throw new HostResourceOperationError(
            '[AilyChat][RuntimeHost] edit tracking recordEdit requires filePath and editType.',
            'resource_operation_payload_invalid',
            false,
          );
        }
        return {
          adapter: 'editTracking',
          action: 'recordEdit',
          filePath,
          editType,
        };
      }
      case 'publishCurrentSummary':
        return {
          adapter: 'editTracking',
          action: 'publishCurrentSummary',
        };
      case 'finalizeCurrentTurn':
        return {
          adapter: 'editTracking',
          action: 'finalizeCurrentTurn',
          ...(typeof payloadObject.checkpointId === 'string' && payloadObject.checkpointId.trim()
            ? { checkpointId: payloadObject.checkpointId.trim() }
            : {}),
          ...(typeof payloadObject.requestId === 'string' && payloadObject.requestId.trim()
            ? { requestId: payloadObject.requestId.trim() }
            : {}),
          ...(typeof payloadObject.autoSaveEdits === 'boolean' ? { autoSaveEdits: payloadObject.autoSaveEdits } : {}),
          ...(typeof payloadObject.requestDiffPreview === 'boolean'
            ? { requestDiffPreview: payloadObject.requestDiffPreview }
            : {}),
        };
      case 'readFinalizedCheckpointMetadata':
        return {
          adapter: 'editTracking',
          action: 'readFinalizedCheckpointMetadata',
          ...(typeof payloadObject.checkpointId === 'string' && payloadObject.checkpointId.trim()
            ? { checkpointId: payloadObject.checkpointId.trim() }
            : {}),
          ...(typeof payloadObject.requestId === 'string' && payloadObject.requestId.trim()
            ? { requestId: payloadObject.requestId.trim() }
            : {}),
        };
      case 'restoreFromTurnResponses':
        return {
          adapter: 'editTracking',
          action: 'restoreFromTurnResponses',
          workspaceRoot: this.normalizeNullableString(payloadObject.workspaceRoot),
          turnResponses: Array.isArray(payloadObject.turnResponses) ? payloadObject.turnResponses : [],
          ...(typeof payloadObject.autoSaveEdits === 'boolean' ? { autoSaveEdits: payloadObject.autoSaveEdits } : {}),
        };
      case 'forkRequestCheckpointMetadata': {
        const sourceSessionResource = this.normalizeSessionId(payloadObject.sourceSessionResource);
        const targetSessionResource = this.normalizeSessionId(payloadObject.targetSessionResource);
        if (!sourceSessionResource || !targetSessionResource || !Array.isArray(payloadObject.retainedTurnResponses)) {
          throw new HostResourceOperationError(
            '[AilyChat][RuntimeHost] edit tracking forkRequestCheckpointMetadata requires source, target, and retained turn responses.',
            'resource_operation_payload_invalid',
            false,
          );
        }
        return {
          adapter: 'editTracking',
          action: 'forkRequestCheckpointMetadata',
          sourceSessionResource,
          targetSessionResource,
          retainedTurnResponses: payloadObject.retainedTurnResponses,
        };
      }
      case 'clearSessionState':
        return {
          adapter: 'editTracking',
          action: 'clearSessionState',
          ...(typeof payloadObject.dismissSummary === 'boolean' ? { dismissSummary: payloadObject.dismissSummary } : {}),
        };
      default:
        throw new HostResourceOperationError(
          '[AilyChat][RuntimeHost] edit tracking operation has an unsupported action.',
          'resource_operation_payload_invalid',
          false,
        );
    }
  }

  private async readFinalizedCheckpointMetadata(payload: { checkpointId?: string; requestId?: string }): Promise<unknown> {
    const checkpointId = this.normalizeSessionId(payload.checkpointId);
    if (checkpointId) {
      const metadata = await this.editCheckpointService.getSettledRequestCheckpointMetadataByCheckpointId?.(checkpointId);
      if (metadata) {
        return metadata;
      }
    }

    const requestId = this.normalizeSessionId(payload.requestId);
    if (requestId) {
      return await this.editCheckpointService.getSettledRequestCheckpointMetadataByRequestId?.(requestId) ?? null;
    }

    return null;
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
