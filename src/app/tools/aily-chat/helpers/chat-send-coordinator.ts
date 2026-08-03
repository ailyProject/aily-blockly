import {
  createTurnRequestModeInfoFromResolvedMode,
  isSameChatSelectedMode,
  normalizeChatModeId,
  normalizeChatSelectedMode,
  resolveChatCurrentMode,
  resolveChatSelectedCustomAgentTarget,
  type ChatResolvedMode,
  type ChatSelectedMode,
} from '../core/chat-mode';
import type { ResourceItem } from '../core/chat-types';
import {
  cloneChatImageAttachmentDraft,
  type ChatImageAttachmentDraft,
} from '../core/chat-image-attachment';
import type { IAgentLifecycle, IChatCoordination, IProjectContext, ISessionAccess } from '../core/chat-context';
import { SkillRegistry } from '../core/skill-registry';
import { buildUserTurnPayload, type UserTurnPayload } from './chat-user-turn-payload';
import { buildExplicitAgentInvocationPayload } from './explicit-agent-invocation';
import type { RequestUserSelectedTools } from './lex-agent-bootstrap';
import {
  applyTurnRequestPromptContextSnapshot,
  captureTurnRequestPromptContextSnapshot,
} from './turn-request-prompt-context';
import type { PendingFollowupUserSelectedTools, PreparedPendingFollowupRequest } from './chat-pending-request';

function clonePendingResourceItems(resourceItems?: readonly ResourceItem[]): ResourceItem[] | undefined {
  if (!Array.isArray(resourceItems) || resourceItems.length === 0) {
    return undefined;
  }

  return resourceItems.map((item) => ({
    ...item,
    ...(item.imageAttachment
      ? { imageAttachment: cloneChatImageAttachmentDraft(item.imageAttachment) }
      : {}),
  }));
}

function collectPendingImageAttachments(resourceItems?: readonly ResourceItem[]): ChatImageAttachmentDraft[] | undefined {
  const images = (resourceItems ?? [])
    .filter((item): item is ResourceItem & { imageAttachment: ChatImageAttachmentDraft } => (
      item.type === 'image' && !!item.imageAttachment
    ))
    .map(item => cloneChatImageAttachmentDraft(item.imageAttachment));
  return images.length > 0 ? images : undefined;
}

function clonePendingAllowedPaths(paths?: readonly string[]): string[] | undefined {
  if (!Array.isArray(paths) || paths.length === 0) {
    return undefined;
  }

  const normalized = paths.filter((path): path is string => typeof path === 'string' && path.length > 0);
  return normalized.length > 0 ? [...normalized] : undefined;
}

function clonePendingUserSelectedTools(
  userSelectedTools?: RequestUserSelectedTools,
): PendingFollowupUserSelectedTools | undefined {
  if (!userSelectedTools) {
    return undefined;
  }

  const entries = Object.entries(userSelectedTools).filter(([toolName]) => toolName.trim().length > 0);
  return entries.length > 0
    ? Object.fromEntries(entries)
    : undefined;
}

export interface PreparedUserSend extends PreparedPendingFollowupRequest {}

type ChatSendCoordinatorContext = Pick<
  IAgentLifecycle,
  'isCancelled' | 'isCompleted' | 'isWaiting' | 'pendingUserInput' | 'activeToolExecutions'
  | 'pendingEditFeedback' | 'readPendingEditFeedback' | 'writePendingEditFeedback'
> & Pick<ISessionAccess, 'sessionId'>
  & Pick<IProjectContext, 'currentMode' | 'currentModel'>
  & {
    readonly currentCustomAgentTarget?: string;
    readonly currentSessionPermissionLevel?: string;
    readonly currentSessionApprovalsReviewer?: 'user' | 'auto_review';
    readonly currentSessionApprovalPolicy?: 'on_request' | 'never';
    readonly selectedMode?: ChatSelectedMode;
    readonly currentResolvedMode?: ChatResolvedMode;
  }
  & Partial<Pick<IChatCoordination, 'lexStream'>>;

/**
 * Coordinates host-side preflight for a new user send.
 *
 * This keeps ChatEngineService.send focused on shell orchestration while the
 * mutable host state resets and payload shaping stay in one place.
 */
export class ChatSendCoordinator {
  constructor(
    private readonly ctx: ChatSendCoordinatorContext,
    private readonly getResourcesText: () => string,
    private readonly getUserSelectedTools?: (requestAgentId?: string) => RequestUserSelectedTools | undefined,
    private readonly getResourceItems: () => readonly ResourceItem[] = () => [],
    private readonly getSessionAllowedPaths: () => readonly string[] = () => [],
    private readonly getPendingRuntimeSnapshot: (
      sessionId?: string | null,
    ) => {
      readonly runtimeOwnerSessionId?: string;
      readonly providerOptionsKey?: string;
      readonly selectedMode?: ChatSelectedMode;
      readonly currentMode?: string;
      readonly currentResolvedMode?: ChatResolvedMode;
      readonly currentSessionPermissionLevel?: string;
      readonly currentSessionApprovalsReviewer?: 'user' | 'auto_review';
      readonly currentSessionApprovalPolicy?: 'on_request' | 'never';
    } = () => ({}),
    private readonly createRequestId: () => string = () => globalThis.crypto.randomUUID(),
  ) {}

  private hasImageAttachments(): boolean {
    return this.getResourceItems().some(item => item.type === 'image' && !!item.imageAttachment);
  }

  private readPendingEditFeedback(sessionId?: string | null): string | null {
    if (this.ctx.readPendingEditFeedback) {
      return this.ctx.readPendingEditFeedback(sessionId);
    }

    return this.ctx.pendingEditFeedback;
  }

  private clearPendingEditFeedback(sessionId?: string | null): void {
    if (this.ctx.writePendingEditFeedback) {
      this.ctx.writePendingEditFeedback(sessionId, null);
      return;
    }

    this.ctx.pendingEditFeedback = null;
  }

  private resolveRequestId(
    requestMetadata?: UserTurnPayload['requestMetadata'],
  ): string | undefined {
    const existingRequestId = typeof requestMetadata?.['requestId'] === 'string'
      ? requestMetadata['requestId'].trim()
      : '';
    if (existingRequestId) {
      return existingRequestId;
    }

    const nextRequestId = this.createRequestId().trim();
    return nextRequestId || undefined;
  }

  private applyRuntimeRequestId(
    requestMetadata?: UserTurnPayload['requestMetadata'],
  ): UserTurnPayload['requestMetadata'] {
    const requestId = this.resolveRequestId(requestMetadata);
    if (!requestId) {
      return requestMetadata;
    }

    return {
      ...(requestMetadata ?? {}),
      requestId,
    };
  }

  private resolveAgentModeDefinition(
    agentId: string,
  ): unknown {
    const liveAgent = this.ctx.lexStream?.agent?.getHandle?.()?.agent
      ?? this.ctx.lexStream?.agent?.getAgent?.();
    const agentModeManager = liveAgent && typeof liveAgent === 'object' && 'agentModeManager' in liveAgent
      ? (liveAgent as { readonly agentModeManager?: { readonly get?: (agentType: string) => unknown } }).agentModeManager
      : undefined;
    const agentMode = typeof agentModeManager?.get === 'function'
      ? agentModeManager.get(agentId)
      : undefined;

    return agentMode && typeof agentMode === 'object' && !Array.isArray(agentMode)
      ? agentMode
      : undefined;
  }

  private resolveCurrentMode(
    selectedMode: ChatSelectedMode,
  ): ChatResolvedMode {
    const currentResolvedMode = this.ctx.currentResolvedMode;
    if (currentResolvedMode && isSameChatSelectedMode(selectedMode, {
      modeId: currentResolvedMode.kind,
      customAgentTarget: currentResolvedMode.customAgentTarget,
    })) {
      return currentResolvedMode;
    }

    return resolveChatCurrentMode(selectedMode, {
      resolveAgentModeDefinition: (agentId) => this.resolveAgentModeDefinition(agentId),
    });
  }

  private applyRuntimeModeMetadata(
    requestMetadata?: UserTurnPayload['requestMetadata'],
    sessionId?: string | null,
  ): UserTurnPayload['requestMetadata'] {
    const runtimeSnapshot = this.getPendingRuntimeSnapshot(sessionId);
    const selectedMode = runtimeSnapshot.selectedMode
      ? normalizeChatSelectedMode(runtimeSnapshot.selectedMode)
      : this.ctx.selectedMode
      ? normalizeChatSelectedMode(this.ctx.selectedMode)
      : normalizeChatSelectedMode({
          modeId: runtimeSnapshot.currentMode ?? this.ctx.currentMode,
          customAgentTarget: this.ctx.currentCustomAgentTarget,
        });
    const selectedCustomAgentTarget = resolveChatSelectedCustomAgentTarget(selectedMode);
    const payloadRequestRouting = requestMetadata?.requestRouting && typeof requestMetadata.requestRouting === 'object' && !Array.isArray(requestMetadata.requestRouting)
      ? requestMetadata.requestRouting as Record<string, unknown>
      : undefined;
    const resolvedMode = runtimeSnapshot.currentResolvedMode ?? this.resolveCurrentMode(selectedMode);
    const modeInfo = createTurnRequestModeInfoFromResolvedMode(resolvedMode);
    const payloadCustomAgentTarget = typeof payloadRequestRouting?.['customAgentTarget'] === 'string' && payloadRequestRouting['customAgentTarget'].trim()
      ? payloadRequestRouting['customAgentTarget'].trim()
      : undefined;
    const modeCustomAgentTarget = resolvedMode.isBuiltin === false
      ? resolvedMode.customAgentTarget ?? selectedCustomAgentTarget
      : undefined;
    const requestAgentId = modeCustomAgentTarget ?? payloadCustomAgentTarget ?? selectedCustomAgentTarget;
    const snapshotPermissionLevel = runtimeSnapshot.currentSessionPermissionLevel;
    const currentSessionPermissionLevel = typeof snapshotPermissionLevel === 'string'
      && snapshotPermissionLevel.trim().length > 0
      ? snapshotPermissionLevel.trim()
      : typeof this.ctx.currentSessionPermissionLevel === 'string'
      && this.ctx.currentSessionPermissionLevel.trim().length > 0
      ? this.ctx.currentSessionPermissionLevel.trim()
      : undefined;
    const snapshotApprovalsReviewer = runtimeSnapshot.currentSessionApprovalsReviewer;
    const currentSessionApprovalsReviewer = snapshotApprovalsReviewer === 'auto_review'
      || snapshotApprovalsReviewer === 'user'
      ? snapshotApprovalsReviewer
      : this.ctx.currentSessionApprovalsReviewer === 'auto_review'
      || this.ctx.currentSessionApprovalsReviewer === 'user'
      ? this.ctx.currentSessionApprovalsReviewer
      : undefined;
    const snapshotApprovalPolicy = runtimeSnapshot.currentSessionApprovalPolicy;
    const currentSessionApprovalPolicy = snapshotApprovalPolicy === 'never'
      || snapshotApprovalPolicy === 'on_request'
      ? snapshotApprovalPolicy
      : this.ctx.currentSessionApprovalPolicy === 'never'
      || this.ctx.currentSessionApprovalPolicy === 'on_request'
      ? this.ctx.currentSessionApprovalPolicy
      : undefined;
    const existingModeInfo = requestMetadata?.modeInfo && typeof requestMetadata.modeInfo === 'object' && !Array.isArray(requestMetadata.modeInfo)
      ? requestMetadata.modeInfo as Record<string, unknown>
      : undefined;
    const requestMetadataWithMode = {
      ...(requestMetadata ?? {}),
      modeId: selectedMode.modeId,
      modeInfo: {
        ...modeInfo,
        ...(currentSessionPermissionLevel ? { permissionLevel: currentSessionPermissionLevel } : {}),
        ...(currentSessionApprovalsReviewer ? { approvalsReviewer: currentSessionApprovalsReviewer } : {}),
        ...(currentSessionApprovalPolicy ? { approvalPolicy: currentSessionApprovalPolicy } : {}),
        ...(existingModeInfo ?? {}),
      },
      requestRouting: {
        ...(currentSessionPermissionLevel ? { permissionLevel: currentSessionPermissionLevel } : {}),
        ...(currentSessionApprovalsReviewer ? { approvalsReviewer: currentSessionApprovalsReviewer } : {}),
        ...(currentSessionApprovalPolicy ? { approvalPolicy: currentSessionApprovalPolicy } : {}),
        ...(payloadRequestRouting ?? {}),
        modeId: selectedMode.modeId,
        ...(requestAgentId ? { customAgentTarget: requestAgentId } : {}),
      },
    };
    const userSelectedTools = this.getUserSelectedTools?.(
      requestAgentId,
    );

    return userSelectedTools
      ? {
          ...requestMetadataWithMode,
          userSelectedTools,
        }
      : requestMetadataWithMode;
  }

  applyRuntimeRequestMetadata(
    requestMetadata?: UserTurnPayload['requestMetadata'],
    sessionId?: string | null,
  ): UserTurnPayload['requestMetadata'] {
    return this.applyRuntimePromptContext(
      this.applyRequestModelMetadata(requestMetadata, sessionId),
    );
  }

  /**
   * Captures the immutable request-model fields before host invocation.
   * VS Code creates ChatRequestModel with mode/model/tool selection already
   * attached; only execution prompt context is allowed to arrive after paint.
   */
  private applyRequestModelMetadata(
    requestMetadata?: UserTurnPayload['requestMetadata'],
    sessionId?: string | null,
  ): UserTurnPayload['requestMetadata'] {
    return this.applyRuntimeModelRoutingMetadata(
      this.applyRuntimeModeMetadata(
        this.applyRuntimeRequestId(requestMetadata),
        sessionId,
      ),
    );
  }

  private applyRuntimeModelRoutingMetadata(
    requestMetadata?: UserTurnPayload['requestMetadata'],
  ): UserTurnPayload['requestMetadata'] {
    const rawModelRouting = requestMetadata?.['modelRouting'];
    const requestedModel = typeof this.ctx.currentModel?.model === 'string' && this.ctx.currentModel.model.trim().length > 0
      ? this.ctx.currentModel.model.trim()
      : undefined;
    const requestedPresetId = typeof this.ctx.currentModel?.presetId === 'string' && this.ctx.currentModel.presetId.trim().length > 0
      ? this.ctx.currentModel.presetId.trim()
      : undefined;
    const existingModelRouting = rawModelRouting && typeof rawModelRouting === 'object' && !Array.isArray(rawModelRouting)
      ? rawModelRouting as Record<string, unknown>
      : undefined;

    if (!requestedModel && !requestedPresetId && !existingModelRouting) {
      return requestMetadata;
    }

    return {
      ...(requestMetadata ?? {}),
      modelRouting: {
        ...(requestedModel ? { requestedModel } : {}),
        ...(requestedPresetId ? { requestedPresetId } : {}),
        ...(existingModelRouting ?? {}),
      },
    };
  }

  private buildPreparedUserSend(
    text: string,
    pendingEditFeedback?: string | null,
    sessionId?: string | null,
    options: { readonly runtimeMetadata?: boolean } = {},
  ): PreparedPendingFollowupRequest | null {
    const targetSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : this.ctx.sessionId;
    if (!targetSessionId || (!text && !this.hasImageAttachments())) {
      return null;
    }

    const resourcesText = this.getResourcesText();
    const payload = buildUserTurnPayload(
      text,
      resourcesText,
      pendingEditFeedback,
      {
        resolveCommand: ({ agentId, name, kind }) => this.ctx.lexStream
          ?.agent
          .getHandle?.()
          ?.resolveRequestCommand(name, kind, agentId)
          ?? this.ctx.lexStream
            ?.agent
            .getAgent()
            ?.resolveRequestCommand(name, kind, agentId),
      },
    );
    const explicitAgentInvocation = payload.requestMetadata?.explicitAgentInvocation;
    const requestMetadata = explicitAgentInvocation && typeof explicitAgentInvocation === 'object'
      ? {
          ...Object.fromEntries(
            Object.entries(payload.requestMetadata ?? {}).filter(([key]) => key !== 'agentId'),
          ),
          explicitAgentInvocation: buildExplicitAgentInvocationPayload({
            targetAgent: typeof explicitAgentInvocation.targetAgent === 'string' ? explicitAgentInvocation.targetAgent : '',
            strippedPrompt: typeof explicitAgentInvocation.strippedPrompt === 'string' ? explicitAgentInvocation.strippedPrompt : '',
            originalText: typeof explicitAgentInvocation.originalText === 'string' ? explicitAgentInvocation.originalText : text,
            resourcesText,
            editFeedback: pendingEditFeedback,
            childRequest: explicitAgentInvocation.childRequest,
          }),
        }
      : payload.requestMetadata;
    const requestMetadataWithPromptContext = options.runtimeMetadata === false
      ? this.applyRequestModelMetadata(requestMetadata, targetSessionId)
      : this.applyRuntimeRequestMetadata(requestMetadata, targetSessionId);

    return {
      text,
      ...payload,
      ...(requestMetadataWithPromptContext ? { requestMetadata: requestMetadataWithPromptContext } : {}),
    };
  }

  private capturePendingSnapshot(
    prepared: PreparedPendingFollowupRequest,
    sessionId?: string | null,
  ): PreparedPendingFollowupRequest {
    const requestMetadata = prepared.requestMetadata;
    const requestRouting = requestMetadata?.requestRouting && typeof requestMetadata.requestRouting === 'object' && !Array.isArray(requestMetadata.requestRouting)
      ? requestMetadata.requestRouting as Record<string, unknown>
      : undefined;
    const modelRouting = requestMetadata?.['modelRouting'] && typeof requestMetadata['modelRouting'] === 'object' && !Array.isArray(requestMetadata['modelRouting'])
      ? requestMetadata['modelRouting'] as Record<string, unknown>
      : undefined;
    const userSelectedTools = clonePendingUserSelectedTools(
      requestMetadata?.['userSelectedTools'] as RequestUserSelectedTools | undefined,
    );
    const permissionLevel = typeof requestRouting?.['permissionLevel'] === 'string' && requestRouting['permissionLevel'].trim().length > 0
      ? requestRouting['permissionLevel'].trim()
      : undefined;
    const approvalsReviewer = requestRouting?.['approvalsReviewer'] === 'auto_review' || requestRouting?.['approvalsReviewer'] === 'user'
      ? requestRouting['approvalsReviewer']
      : undefined;
    const approvalPolicy = requestRouting?.['approvalPolicy'] === 'never' || requestRouting?.['approvalPolicy'] === 'on_request'
      ? requestRouting['approvalPolicy']
      : undefined;
    const requestedModel = typeof modelRouting?.['requestedModel'] === 'string' && modelRouting['requestedModel'].trim().length > 0
      ? modelRouting['requestedModel'].trim()
      : undefined;
    const requestedPresetId = typeof modelRouting?.['requestedPresetId'] === 'string' && modelRouting['requestedPresetId'].trim().length > 0
      ? modelRouting['requestedPresetId'].trim()
      : undefined;
    const requestModeId = typeof requestMetadata?.modeId === 'string' && requestMetadata.modeId.trim().length > 0
      ? requestMetadata.modeId.trim()
      : undefined;
    const requestCustomAgentTarget = typeof requestRouting?.['customAgentTarget'] === 'string' && requestRouting['customAgentTarget'].trim().length > 0
      ? requestRouting['customAgentTarget'].trim()
      : undefined;
    const resourceItems = clonePendingResourceItems(this.getResourceItems());
    const imageAttachments = collectPendingImageAttachments(resourceItems);
    const sessionAllowedPaths = clonePendingAllowedPaths(this.getSessionAllowedPaths());
    const pendingRuntimeSnapshot = this.getPendingRuntimeSnapshot(sessionId);
    const runtimeOwnerSessionId = typeof pendingRuntimeSnapshot.runtimeOwnerSessionId === 'string'
      && pendingRuntimeSnapshot.runtimeOwnerSessionId.trim().length > 0
      ? pendingRuntimeSnapshot.runtimeOwnerSessionId.trim()
      : undefined;
    const providerOptionsKey = typeof pendingRuntimeSnapshot.providerOptionsKey === 'string'
      && pendingRuntimeSnapshot.providerOptionsKey.trim().length > 0
      ? pendingRuntimeSnapshot.providerOptionsKey.trim()
      : undefined;

    return {
      ...prepared,
      ...(resourceItems ? { resourceItems } : {}),
      ...(imageAttachments ? { imageAttachments } : {}),
      ...(sessionAllowedPaths ? { sessionAllowedPaths } : {}),
      ...(runtimeOwnerSessionId ? { runtimeOwnerSessionId } : {}),
      ...(providerOptionsKey ? { providerOptionsKey } : {}),
      ...(requestedModel ? { requestedModel } : {}),
      ...(requestedPresetId ? { requestedPresetId } : {}),
      ...(requestModeId ? { requestModeId } : {}),
      ...(requestCustomAgentTarget ? { requestCustomAgentTarget } : {}),
      ...(permissionLevel ? { permissionLevel } : {}),
      ...(approvalsReviewer ? { approvalsReviewer } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(userSelectedTools ? { userSelectedTools } : {}),
    };
  }

  capturePendingSend(content: string, sessionId?: string | null): PreparedPendingFollowupRequest | null {
    const text = content.trim();
    const prepared = this.buildPreparedUserSend(text, this.readPendingEditFeedback(sessionId), sessionId);
    return prepared ? this.capturePendingSnapshot(prepared, sessionId) : null;
  }

  prepareSend(
    sender: string,
    content: string,
    options: { readonly sessionId?: string | null } = {},
  ): PreparedUserSend | null {
    return this.prepareSendEnvelope(sender, content, options, true);
  }

  private prepareSendEnvelope(
    sender: string,
    content: string,
    options: { readonly sessionId?: string | null },
    runtimeMetadata: boolean,
  ): PreparedUserSend | null {
    if (this.ctx.isCancelled && sender === 'tool') {
      return null;
    }

    if (this.ctx.isCompleted) {
      this.ctx.isCancelled = false;
      this.ctx.isCompleted = false;
    }

    const text = content.trim();
    const targetSessionId = typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
      ? options.sessionId.trim()
      : this.ctx.sessionId;
    if (!targetSessionId || (!text && !this.hasImageAttachments())) {
      return null;
    }

    if (sender !== 'user') {
      return null;
    }

    if (this.ctx.isWaiting) {
      return null;
    }

    if (this.ctx.isCancelled) {
      this.ctx.isCancelled = false;
      this.ctx.pendingUserInput = false;
      this.ctx.activeToolExecutions = 0;
    }

    const prepared = this.buildPreparedUserSend(text, this.readPendingEditFeedback(targetSessionId), targetSessionId, {
      runtimeMetadata,
    });
    if (!prepared) {
      return null;
    }

    this.clearPendingEditFeedback(targetSessionId);
    return this.capturePendingSnapshot(prepared, targetSessionId);
  }

  /**
   * Builds the stable request envelope used by the visible response model.
   * Execution-only metadata is deliberately deferred until after the request
   * row has painted, matching VS Code's request-model-before-host-invocation
   * ordering.
   */
  prepareVisibleSend(
    sender: string,
    content: string,
    options: { readonly sessionId?: string | null } = {},
  ): PreparedUserSend | null {
    return this.prepareSendEnvelope(sender, content, options, false);
  }

  finalizeVisibleSend(
    prepared: PreparedPendingFollowupRequest,
  ): PreparedPendingFollowupRequest {
    const requestMetadata = this.applyRuntimePromptContext(prepared.requestMetadata);
    return {
      ...prepared,
      ...(requestMetadata ? { requestMetadata } : {}),
    };
  }

  applyRuntimePromptContext(
    requestMetadata?: UserTurnPayload['requestMetadata'],
  ): UserTurnPayload['requestMetadata'] {
    const requestId = typeof requestMetadata?.['requestId'] === 'string' && requestMetadata['requestId'].trim().length > 0
      ? requestMetadata['requestId'].trim()
      : undefined;
    const snapshot = captureTurnRequestPromptContextSnapshot({
      getSessionSnapshot: () => this.ctx.lexStream?.session?.snapshot?.() ?? null,
    });

    const requestContext = requestId
      ? {
          ...(snapshot?.requestContext ?? {}),
          requestId,
        }
      : snapshot?.requestContext;

    const requestedSkillNames = resolveRequestedSkillNames(requestMetadata);
    const nextRequestContext = requestContext || requestedSkillNames.length > 0
      ? {
          ...(requestContext ? { ...requestContext } : {}),
          ...(requestedSkillNames.length > 0 ? { requestedSkillNames } : {}),
        }
      : requestContext;

    const nextSnapshot = nextRequestContext
      ? {
          ...(nextRequestContext ? { requestContext: nextRequestContext } : {}),
        }
      : snapshot;

    return applyTurnRequestPromptContextSnapshot(requestMetadata, nextSnapshot);
  }
}

function resolveRequestedSkillNames(
  requestMetadata?: UserTurnPayload['requestMetadata'],
): string[] {
  const commandKind = requestMetadata?.commandKind;
  const commandName = typeof requestMetadata?.command?.name === 'string'
    ? requestMetadata.command.name.trim()
    : '';

  if (commandKind !== 'slash' || !commandName) {
    return [];
  }

  if (commandName.startsWith('chronicle:')) {
    const chronicleSkill = SkillRegistry.getSkillContext('chronicle');
    return chronicleSkill && chronicleSkill.userInvocable !== false
      ? [chronicleSkill.name]
      : [];
  }

  const skillContext = SkillRegistry.getSkillContext(commandName);
  if (!skillContext || skillContext.userInvocable === false) {
    return [];
  }

  return [skillContext.name];
}
