import type { ChatPartStore, TextPayloadPartPatch } from './chat-part-store';
import { mkTerminal, type ChatPartScope, type ConfirmationPart, type ToolCallPart } from './chat-parts';
import { normalizeChatErrorNotice } from './chat-error-notice-normalizer';
import type { CanonicalRenderLifecycleEvent } from './render-event-item-lifecycle';

type CanonicalPayloadProjectionHandle = Parameters<ChatPartStore['upsertTextPayloadPartForHandle']>[0];

type CanonicalPayloadProjectionStore = Pick<
  ChatPartStore,
  | 'upsertTextPayloadPartForHandle'
  | 'upsertToolCallPartForHandle'
  | 'patchToolCallForHandle'
  | 'upsertQuestionPartForHandle'
  | 'upsertConfirmationPartForHandle'
  | 'upsertStateForHandle'
  | 'upsertTerminalForHandle'
  | 'upsertNoticePartForHandle'
  | 'upsertSubagentForHandle'
  | 'upsertPlanPartForHandle'
>;

/**
 * Projects Codex-style canonical item payload deltas into the visible ChatPartStore.
 *
 * This is intentionally payload-only. Completion/finalization stays in
 * LexRenderProjectionSync so old and new live paths cannot race over terminal
 * states while the legacy RenderEventPartAdapter is being retired.
 */
export class CanonicalRenderPayloadProjector {
  constructor(private readonly store: CanonicalPayloadProjectionStore) {}

  project(
    handle: CanonicalPayloadProjectionHandle,
    events: readonly CanonicalRenderLifecycleEvent[],
  ): boolean {
    let changed = false;

    for (const event of events) {
      if (event.type !== 'itemDelta') {
        continue;
      }

      changed = this.projectStructuredPayload(handle, event) || changed;

      if (event.payloadRef?.type === 'text' && (event.itemKind === 'markdown' || event.itemKind === 'thinking')) {
        changed = this.store.upsertTextPayloadPartForHandle(
          handle,
          canonicalTextPartId(event),
          payloadRefToTextPatch(event.payloadRef),
          canonicalScopeToChatPartScope(event.scope),
        ) || changed;
      }
    }

    return changed;
  }

  private projectStructuredPayload(
    handle: CanonicalPayloadProjectionHandle,
    event: Extract<CanonicalRenderLifecycleEvent, { type: 'itemDelta' }>,
  ): boolean {
    const payload = event.structuredPayload;
    if (!payload) {
      return false;
    }

    const scope = canonicalScopeToChatPartScope(event.scope);
    switch (payload.type) {
      case 'tool':
        return this.store.upsertToolCallPartForHandle(handle, {
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          text: payload.text,
          state: payload.state,
          args: payload.args,
          metadata: payload.metadata,
          scope,
        });

      case 'question':
        return this.store.upsertQuestionPartForHandle(handle, payload.requestId, [...payload.questions], scope);

      case 'confirmation':
        if (payload.toolCallId) {
          if (payload.resolved === true) {
            return this.store.patchToolCallForHandle(handle, payload.toolCallId, {
              state: payload.result === 'approved' ? 'doing' : 'error',
              metadata: {
                approval: confirmationPayloadToMetadata(payload),
              },
            });
          }
          return this.store.upsertToolCallPartForHandle(handle, {
            toolCallId: payload.toolCallId,
            toolName: payload.toolName || 'tool',
            text: payload.message || payload.title || `${payload.toolName || 'Tool'} requires approval`,
            state: 'pending_approval',
            args: payload.args,
            metadata: {
              approval: confirmationPayloadToMetadata(payload),
            },
            scope,
          });
        }
        return this.store.upsertConfirmationPartForHandle(
          handle,
          payload.askId,
          payload.message,
          payload.toolName,
          payload.source,
          {
            title: payload.title,
            subtitle: payload.subtitle,
            description: payload.description,
            actions: payload.actions as ConfirmationPart['actions'],
            primaryScope: payload.primaryScope as ConfirmationPart['primaryScope'],
            args: payload.args,
            ...scope,
          },
        );

      case 'state':
        this.store.upsertStateForHandle(handle, payload.stateId, {
          state: payload.state,
          text: payload.text,
          kind: payload.kind as Parameters<ChatPartStore['upsertStateForHandle']>[2]['kind'],
          progress: payload.progress,
          metadata: payload.metadata,
        });
        return true;

      case 'notice':
        const normalizedNotice = payload.severity === 'error'
          ? normalizeChatErrorNotice({
            message: payload.message,
            code: payload.code,
            details: payload.metadata?.['details'],
            metadata: payload.metadata,
          })
          : undefined;
        return this.store.upsertNoticePartForHandle(
          handle,
          `canonical:notice:${event.itemId}`,
          normalizedNotice?.message ?? payload.message,
          payload.severity,
          normalizedNotice?.metadata ?? noticePayloadToMetadata(payload),
          scope,
        );

      case 'subagent':
        return this.store.upsertSubagentForHandle(handle, {
          toolCallId: payload.toolCallId,
          subAgentInvocationId: payload.subAgentInvocationId,
          agentName: payload.agentName,
          description: payload.description,
          state: payload.state,
          resultText: payload.resultText || '',
          childItems: [],
          metadata: payload.metadata,
        });

      case 'plan':
        return this.store.upsertPlanPartForHandle(
          handle,
          payload.partId,
          payload.text,
          payload.status,
          payload.source,
        );

      case 'terminal': {
        const terminal = mkTerminal(payload.terminal.command, payload.toolCallId, `canonical:terminal:${event.itemId}`, {
          processId: payload.terminal.processId,
          outputSessionId: payload.terminal.outputSessionId,
          terminalId: payload.terminal.terminalId,
          outputFilePath: payload.terminal.outputFilePath,
          cwd: payload.terminal.cwd,
          status: payload.terminal.status,
          bytesTotal: payload.terminal.bytesTotal,
          lastOutputAt: payload.terminal.lastOutputAt,
          outputUpdateKind: payload.outputUpdateKind || 'snapshot',
          ...scope,
        });
        terminal.output = payload.terminal.output;
        terminal.stderr = payload.terminal.stderr;
        terminal.exitCode = payload.terminal.exitCode;
        terminal.isRunning = payload.terminal.isRunning;
        return this.store.upsertTerminalForHandle(handle, terminal) >= 0;
      }
    }
  }
}

function canonicalTextPartId(event: Extract<CanonicalRenderLifecycleEvent, { type: 'itemDelta' }>): string {
  return `canonical:${event.itemKind}:${event.itemId}`;
}

function payloadRefToTextPatch(
  payloadRef: NonNullable<Extract<CanonicalRenderLifecycleEvent, { type: 'itemDelta' }>['payloadRef']>,
): TextPayloadPartPatch {
  return {
    contentKind: payloadRef.contentKind,
    contentRef: payloadRef.contentRef,
    text: payloadRef.text,
    contentLength: payloadRef.contentLength,
  };
}

function canonicalScopeToChatPartScope(
  scope: Extract<CanonicalRenderLifecycleEvent, { type: 'itemDelta' }>['scope'],
): ChatPartScope | undefined {
  if (!scope) {
    return undefined;
  }

  return {
    ...(scope.sourceAgentRole ? { sourceAgentRole: scope.sourceAgentRole } : {}),
    ...(scope.subAgentInvocationId ? { subAgentInvocationId: scope.subAgentInvocationId } : {}),
    ...(scope.parentToolCallId ? { parentToolCallId: scope.parentToolCallId } : {}),
  };
}

function confirmationPayloadToMetadata(
  payload: Extract<NonNullable<Extract<CanonicalRenderLifecycleEvent, { type: 'itemDelta' }>['structuredPayload']>, { type: 'confirmation' }>,
): NonNullable<ToolCallPart['metadata']>['approval'] {
  return {
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    title: payload.title,
    subtitle: payload.subtitle,
    message: payload.message,
    description: payload.description,
    source: payload.source,
    actions: payload.actions,
    primaryScope: payload.primaryScope,
    args: payload.args,
    resolved: payload.resolved === true,
    result: payload.result,
    scope: payload.scope,
    reviewer: payload.reviewer,
    reviewStatus: payload.reviewStatus,
    reviewRiskLevel: payload.reviewRiskLevel,
    reviewStartedAt: payload.reviewStartedAt,
    reviewCompletedAt: payload.reviewCompletedAt,
    decisionSource: payload.decisionSource,
  };
}

function noticePayloadToMetadata(
  payload: Extract<NonNullable<Extract<CanonicalRenderLifecycleEvent, { type: 'itemDelta' }>['structuredPayload']>, { type: 'notice' }>,
): Record<string, unknown> | undefined {
  if (payload.severity !== 'error') {
    const base = payload.metadata ? { ...payload.metadata } : {};
    if (payload.code) {
      base['code'] = payload.code;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  return normalizeChatErrorNotice({
    message: payload.message,
    code: payload.code,
    details: payload.metadata?.['details'],
    metadata: payload.metadata,
  }).metadata;
}
