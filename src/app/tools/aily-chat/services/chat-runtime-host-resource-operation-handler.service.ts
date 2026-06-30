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
import {
  runSyncAbsFileConcreteHandler,
  type SyncAbsArgs,
} from '../tools/syncAbsFileTool';
import { AbsAutoSyncService } from './abs-auto-sync.service';
import { ChatHistoryService, type LiveHostSessionRecord } from './chat-history.service';
import { EditCheckpointService } from './edit-checkpoint.service';

type HostResourceOperationPayload = {
  readonly adapter?: unknown;
  readonly action?: unknown;
  readonly record?: unknown;
  readonly hostRecord?: unknown;
  readonly liveHostSessionRecord?: unknown;
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

  private persistHostSessionRecord(request: ChatRuntimeHostResourceOperationRequest): {
    readonly saved: true;
    readonly sessionId: string;
    readonly kind: ChatRuntimeHostResourceOperationRequest['kind'];
    readonly metadataOnly?: true;
  } {
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
      this.chatHistoryService.saveHostRecordMetadataOnly(normalizedRecord);
      return {
        saved: true,
        sessionId,
        kind: request.kind,
        metadataOnly: true,
      };
    }

    this.chatHistoryService.saveHostRecord(normalizedRecord);

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
