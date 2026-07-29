import type { LexOwnerContext } from '../helpers/lex-stream.helper';
import type {
  ChatRuntimeOwnerContextBudgetPort,
} from './chat-runtime-owner-context-capabilities';

export interface ChatRuntimeOwnerContextAdapter {
  sessionId: any;
  lexStream: any;
  session: any;
  applyPendingSwitch(sessionId: any): any;
}

export interface ChatRuntimeOwnerContextCoreServices {
  readonly prjPath: string | null | undefined;
  readonly prjRootPath: string | null | undefined;
  readonly currentModel: any;
  readonly currentAgentRuntimeMode: any;
  readonly currentAgentRuntimeModeSource: any;
  readonly sessionTitle: string | null | undefined;
  readonly ailyChatConfigService: any;
  readonly mcpService: any;
  readonly runtimeInteractionHost: any;
  readonly ownerScheduler: any;
  readonly viewRequests: any;
  readonly list: any;
  readonly partStore: any;
  readonly viewAdapter: any;
  readonly scrollManager: any;
  readonly currentMessageSource: any;
  readonly toolCallingIteration: any;
  readonly contextBudgetService: ChatRuntimeOwnerContextBudgetPort;
  readonly isWaiting: any;
  readonly isCompleted: any;
  readonly repetitionDetectionService: any;
  readonly turnStartupEditLifecycle: any;
  readonly isCancelled: any;
  readonly activeToolExecutions: any;
  readonly currentStatelessMode: any;
  selectAgentRuntimeMode(mode: any, source: any, reason: any, sessionId: string): any;
  updateRuntimeProjectPath(projectPath: any, sessionId: string): any;
  currentSessionPath(sessionId: any): any;
  currentSessionPermissionMode(sessionId: any): any;
  currentSessionPermissionProfile(sessionId: any): any;
  currentSessionApprovalsReviewer(sessionId: any): any;
  currentSessionApprovalPolicy(sessionId: any): any;
  buildExecutionSaveTarget(sessionId: any): any;
  resolveActiveRuntimeSessionId(defaultSessionId: string): any;
  runWithRuntimeSessionOwner<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  handleToolApproval(request: any): any;
  checkToolApprovalPreflight(request: any): any;
  setList(value: any): void;
  invalidateHostRequestGraph(): void;
  triggerSyncDetectChanges(): void;
  setCurrentMessageSource(value: any): void;
  setToolCallingIteration(value: any): void;
  setIsWaiting(value: any): void;
  setIsCompleted(value: any): void;
  readSessionRuntimeState(sessionId: any): any;
  readSessionTurnResponses(sessionId: any): any;
  appendSessionModelTurnResponse(sessionId: any, turnResponse: any, ownerPolicy: any): any;
  syncRuntimeHostSubmitReadiness(sessionId: any): void;
  syncRuntimeAgentEntryReady(sessionId: any, disposeSession: () => void): void;
  releaseRuntimeHandle(sessionId: any): boolean;
  setRuntimeAbortController(sessionId: any, controller: AbortController | null): boolean;
  scheduleLexRequestCompleted(input: any): void;
  isRuntimeViewAttached(sessionId: any): boolean;
  readRuntimeViewAttachmentGeneration(sessionId: any): any;
  isRuntimeViewAttachmentCurrent(sessionId: any, generation: any): boolean;
  syncExecutionRuntimeState(saveTarget: any): any;
  syncExecutionRuntimeTurnResponses(sessionId: any, turnResponses: any, options: any): void;
  setIsCancelled(value: any): void;
  setActiveToolExecutions(value: any): void;
  setCurrentStatelessMode(value: any): void;
}

export function normalizeRuntimeOwnerSessionId(sessionId: unknown): string {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

export function resolveRuntimeOwnerDefaultSessionId(
  adapter: ChatRuntimeOwnerContextAdapter,
): string {
  return normalizeRuntimeOwnerSessionId(adapter.sessionId);
}

export class ChatRuntimeOwnerContextCore {
  private adapter: ChatRuntimeOwnerContextAdapter | null = null;
  private context: LexOwnerContext | null = null;

  bindAdapter(
    adapter: ChatRuntimeOwnerContextAdapter,
    createContext: (adapter: ChatRuntimeOwnerContextAdapter) => LexOwnerContext,
  ): LexOwnerContext {
    if (this.adapter && this.adapter !== adapter) {
      throw new Error('[AilyChat][RuntimeOwnerContext] Runtime owner context cannot be rebound to a different adapter.');
    }

    this.adapter = adapter;
    if (!this.context) {
      this.context = createContext(adapter);
    }
    return this.context;
  }
}

export function createChatRuntimeOwnerContext(
  adapter: ChatRuntimeOwnerContextAdapter,
  services: ChatRuntimeOwnerContextCoreServices,
  resolveDefaultRuntimeSessionId: () => string,
): LexOwnerContext {
  const context = {
    get prjPath() { return services.prjPath; },
    get prjRootPath() { return services.prjRootPath; },
    get currentModel() { return services.currentModel; },
    get currentAgentRuntimeMode() { return services.currentAgentRuntimeMode; },
    get currentAgentRuntimeModeSource() { return services.currentAgentRuntimeModeSource; },
    selectAgentRuntimeMode: (mode, source, reason) =>
      services.selectAgentRuntimeMode(mode, source, reason, resolveDefaultRuntimeSessionId()),
    updateRuntimeProjectPath: projectPath =>
      services.updateRuntimeProjectPath(projectPath, resolveDefaultRuntimeSessionId()),
    get sessionId() { return adapter.sessionId; },
    get sessionTitle() { return services.sessionTitle; },
    get currentSessionPath() { return services.currentSessionPath(adapter.sessionId); },
    get currentSessionPermissionMode() { return services.currentSessionPermissionMode(adapter.sessionId); },
    get currentSessionPermissionProfile() { return services.currentSessionPermissionProfile(adapter.sessionId); },
    get currentSessionApprovalsReviewer() { return services.currentSessionApprovalsReviewer(adapter.sessionId); },
    get currentSessionApprovalPolicy() { return services.currentSessionApprovalPolicy(adapter.sessionId); },
    get ailyChatConfigService() { return services.ailyChatConfigService; },
    get mcpService() { return services.mcpService; },
    buildExecutionSaveTarget: sessionId => services.buildExecutionSaveTarget(sessionId),
    resolveActiveRuntimeSessionId: () => services.resolveActiveRuntimeSessionId(resolveDefaultRuntimeSessionId()),
    runWithRuntimeSessionOwner: (sessionId, action) =>
      services.runWithRuntimeSessionOwner(sessionId, action),
    get runtimeInteractionHost() { return services.runtimeInteractionHost; },
    handleToolApproval: request => services.handleToolApproval(request),
    checkToolApprovalPreflight: request => services.checkToolApprovalPreflight(request),
    get lexStream() { return adapter.lexStream; },
    get ownerScheduler() { return services.ownerScheduler; },
    get viewRequests() { return services.viewRequests; },
    get list() { return services.list; },
    set list(value) { services.setList(value); },
    get partStore() { return services.partStore; },
    get viewAdapter() { return services.viewAdapter as any; },
    get scrollManager() { return services.scrollManager as any; },
    invalidateHostRequestGraph: () => services.invalidateHostRequestGraph(),
    triggerSyncDetectChanges: () => services.triggerSyncDetectChanges(),
    get currentMessageSource() { return services.currentMessageSource; },
    set currentMessageSource(value) { services.setCurrentMessageSource(value); },
    get toolCallingIteration() { return services.toolCallingIteration; },
    set toolCallingIteration(value) { services.setToolCallingIteration(value); },
    get contextBudgetService() { return services.contextBudgetService; },
    get isWaiting() { return services.isWaiting; },
    set isWaiting(value) { services.setIsWaiting(value); },
    get isCompleted() { return services.isCompleted; },
    set isCompleted(value) { services.setIsCompleted(value); },
    get session() { return adapter.session; },
    readSessionRuntimeState: sessionId => services.readSessionRuntimeState(sessionId),
    readSessionTurnResponses: sessionId => services.readSessionTurnResponses(sessionId),
    appendSessionModelTurnResponse: (sessionId, turnResponse, ownerPolicy) =>
      services.appendSessionModelTurnResponse(sessionId, turnResponse, ownerPolicy),
    syncRuntimeHostSubmitReadiness: sessionId => services.syncRuntimeHostSubmitReadiness(sessionId),
    syncRuntimeAgentEntryReady: (sessionId, disposeSession) =>
      services.syncRuntimeAgentEntryReady(sessionId, disposeSession),
    releaseRuntimeHandle: sessionId => services.releaseRuntimeHandle(sessionId),
    setRuntimeAbortController: (sessionId, controller) =>
      services.setRuntimeAbortController(sessionId, controller),
    scheduleLexRequestCompleted: input => services.scheduleLexRequestCompleted(input),
    isRuntimeViewAttached: sessionId => services.isRuntimeViewAttached(sessionId),
    readRuntimeViewAttachmentGeneration: sessionId => services.readRuntimeViewAttachmentGeneration(sessionId),
    isRuntimeViewAttachmentCurrent: (sessionId, generation) =>
      services.isRuntimeViewAttachmentCurrent(sessionId, generation),
    syncExecutionRuntimeState: saveTarget => services.syncExecutionRuntimeState(saveTarget),
    syncExecutionRuntimeTurnResponses: (sessionId, turnResponses, options) =>
      services.syncExecutionRuntimeTurnResponses(sessionId, turnResponses, options),
    applyPendingSwitch: sessionId => adapter.applyPendingSwitch(sessionId),
    get repetitionDetectionService() { return services.repetitionDetectionService; },
    get turnStartupEditLifecycle() { return services.turnStartupEditLifecycle; },
    get isCancelled() { return services.isCancelled; },
    set isCancelled(value) { services.setIsCancelled(value); },
    get activeToolExecutions() { return services.activeToolExecutions; },
    set activeToolExecutions(value) { services.setActiveToolExecutions(value); },
    get currentStatelessMode() { return services.currentStatelessMode; },
    set currentStatelessMode(value) { services.setCurrentStatelessMode(value); },
  };
  return context as LexOwnerContext;
}
