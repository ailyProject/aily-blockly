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
    const service = this;
    const interaction = new UserInteractionHelper({
      get lexStream() { return input.lexStream; },
      get isLoggedIn() { return false; },
      getCurrentProjectPath: () => normalizeRuntimeOwnerSessionId(service.ownerSessionContext.prjPath),
      get sessionId() { return input.sessionId; },
      resolveActiveRuntimeSessionId: () =>
        service.ownerState.resolveActiveRuntimeSessionId(input.defaultSessionId),
      get runtimeInteractionHost() { return service.runtimeInteractionHost; },
      get toolApprovalPolicy() { return service.toolApprovalPolicy; },
    });

    return interaction.handleToolApproval(input.request);
  }
}
