import { Injectable, inject } from '@angular/core';

import { UserInteractionHelper } from '../helpers/user-interaction.helper';
import {
  CHAT_RUNTIME_OWNER_INTERACTION_HOST,
  CHAT_RUNTIME_OWNER_SESSION_CONTEXT,
  CHAT_RUNTIME_OWNER_STATE,
  CHAT_RUNTIME_OWNER_TOOL_APPROVAL_POLICY,
  type ChatRuntimeOwnerInteractionHostPort,
  type ChatRuntimeOwnerSessionContextPort,
  type ChatRuntimeOwnerStatePort,
  type ChatRuntimeOwnerToolApprovalInput,
  type ChatRuntimeOwnerToolApprovalPolicyPort,
  type ChatRuntimeOwnerToolApprovalPort,
} from './chat-runtime-owner-ports';
import { normalizeRuntimeOwnerSessionId } from './chat-runtime-owner-context-core';
import { isAilyCategoryDebugEnabled } from '../core/chat-debug-flags';
import { COMMIT_PROJECT_SCENE_REGENERATION_TOOL } from '../core/blockly-project-scene-tools';

function shouldTraceApprovalRuntimeBoundary(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceApprovalRuntime', [
    '__AILY_CHAT_TRACE_APPROVAL_RUNTIME__',
    'AILY_CHAT_TRACE_APPROVAL_RUNTIME',
  ]);
}

@Injectable()
export class ChatRuntimeOwnerToolApprovalService implements ChatRuntimeOwnerToolApprovalPort {
  private readonly runtimeInteractionHost = inject<ChatRuntimeOwnerInteractionHostPort>(
    CHAT_RUNTIME_OWNER_INTERACTION_HOST,
  );
  private readonly ownerSessionContext = inject<ChatRuntimeOwnerSessionContextPort>(
    CHAT_RUNTIME_OWNER_SESSION_CONTEXT,
  );
  private readonly ownerState = inject<ChatRuntimeOwnerStatePort>(CHAT_RUNTIME_OWNER_STATE);
  private readonly toolApprovalPolicy = inject<ChatRuntimeOwnerToolApprovalPolicyPort>(
    CHAT_RUNTIME_OWNER_TOOL_APPROVAL_POLICY,
  );

  handleToolApproval(
    input: ChatRuntimeOwnerToolApprovalInput,
  ): Promise<{ approved: true } | { approved: false; reason?: string }> {
    const approvalInput = this.enforcePerCallProjectSceneApproval(input);
    if (shouldTraceApprovalRuntimeBoundary()) {
      console.debug('[AilyChat][RuntimeOwnerApprovalBridge]', {
        phase: 'handle-enter',
        sessionId: input.sessionId,
        defaultSessionId: input.defaultSessionId,
        toolCallId: input.request?.toolCallId,
        toolName: input.request?.toolName,
        approvalTraceId: input.request?.approvalTraceId,
      });
    }
    return this.createInteractionHelper(approvalInput).handleToolApproval(approvalInput.request).then((result) => {
      if (shouldTraceApprovalRuntimeBoundary()) {
        console.debug('[AilyChat][RuntimeOwnerApprovalBridge]', {
          phase: 'handle-result',
          sessionId: input.sessionId,
          defaultSessionId: input.defaultSessionId,
          toolCallId: input.request?.toolCallId,
          toolName: input.request?.toolName,
          approvalTraceId: input.request?.approvalTraceId,
          approved: result.approved,
          reason: result.approved === false ? result.reason : undefined,
        });
      }
      return result;
    }, (error) => {
      console.error('[AilyChat][RuntimeOwnerApprovalBridge]', {
        phase: 'handle-error',
        sessionId: input.sessionId,
        defaultSessionId: input.defaultSessionId,
        toolCallId: input.request?.toolCallId,
        toolName: input.request?.toolName,
        approvalTraceId: input.request?.approvalTraceId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    });
  }

  checkToolApprovalPreflight(
    input: ChatRuntimeOwnerToolApprovalInput,
  ): Promise<{ approved: true } | { approved: false; reason?: string }> {
    if (input.request?.toolName === COMMIT_PROJECT_SCENE_REGENERATION_TOOL) {
      return Promise.resolve({
        approved: false,
        reason: 'project-scene-regeneration-requires-per-call-confirmation',
      });
    }
    if (shouldTraceApprovalRuntimeBoundary()) {
      console.debug('[AilyChat][RuntimeOwnerApprovalBridge]', {
        phase: 'preflight-enter',
        sessionId: input.sessionId,
        defaultSessionId: input.defaultSessionId,
        toolCallId: input.request?.toolCallId,
        toolName: input.request?.toolName,
        approvalTraceId: input.request?.approvalTraceId,
      });
    }
    return this.createInteractionHelper(input).checkToolApprovalPreflight(input.request).then((result) => {
      if (shouldTraceApprovalRuntimeBoundary()) {
        console.debug('[AilyChat][RuntimeOwnerApprovalBridge]', {
          phase: 'preflight-result',
          sessionId: input.sessionId,
          defaultSessionId: input.defaultSessionId,
          toolCallId: input.request?.toolCallId,
          toolName: input.request?.toolName,
          approvalTraceId: input.request?.approvalTraceId,
          approved: result.approved,
          reason: result.approved === false ? result.reason : undefined,
        });
      }
      return result;
    }, (error) => {
      console.error('[AilyChat][RuntimeOwnerApprovalBridge]', {
        phase: 'preflight-error',
        sessionId: input.sessionId,
        defaultSessionId: input.defaultSessionId,
        toolCallId: input.request?.toolCallId,
        toolName: input.request?.toolName,
        approvalTraceId: input.request?.approvalTraceId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    });
  }

  private createInteractionHelper(input: ChatRuntimeOwnerToolApprovalInput): UserInteractionHelper {
    const service = this;
    const explicitSessionId = normalizeRuntimeOwnerSessionId(input.sessionId);
    return new UserInteractionHelper({
      get lexStream() { return input.lexStream; },
      get isLoggedIn() { return false; },
      getCurrentProjectPath: () => normalizeRuntimeOwnerSessionId(service.ownerSessionContext.prjPath),
      get sessionId() { return input.sessionId; },
      resolveActiveRuntimeSessionId: () =>
        explicitSessionId || service.ownerState.resolveActiveRuntimeSessionId(input.defaultSessionId),
      get runtimeInteractionHost() { return service.runtimeInteractionHost; },
      get toolApprovalPolicy() { return service.toolApprovalPolicy; },
    });
  }

  private enforcePerCallProjectSceneApproval(
    input: ChatRuntimeOwnerToolApprovalInput,
  ): ChatRuntimeOwnerToolApprovalInput {
    if (input.request?.toolName !== COMMIT_PROJECT_SCENE_REGENERATION_TOOL) {
      return input;
    }
    return {
      ...input,
      request: {
        ...input.request,
        title: '确认生成新的 v2 连线图',
        message: 'Agent 将按下列 Component Package 与连线提案原子生成新的 v2 Project Scene。此操作不会修改旧 connection_output.json。',
        primaryScope: 'once',
        allowAutoConfirm: false,
        approveCombination: undefined,
      },
    };
  }
}
