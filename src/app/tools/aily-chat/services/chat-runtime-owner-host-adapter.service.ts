import { Injectable, inject } from '@angular/core';

import type { HostSessionSaveTarget } from '../helpers/host-session-save-bridge';
import type { HostResponseProjection } from '../helpers/host-turn-response-state';
import type { ChatListItem } from './chat-history.service';
import type { ChatRuntimeOwnerContextAdapter } from './chat-runtime-owner-context.service';
import type { LexOwnerFacade } from '../helpers/lex-stream.helper';
import {
  CHAT_RUNTIME_OWNER_CONTEXT_BINDER,
  CHAT_RUNTIME_OWNER_CONTEXT_MATERIALIZER,
  CHAT_RUNTIME_OWNER_SAVE_BRIDGE,
  CHAT_RUNTIME_OWNER_SESSION_CONTEXT,
  CHAT_RUNTIME_OWNER_STATE,
  type ChatRuntimeOwnerContextBinderPort,
  type ChatRuntimeOwnerContextMaterializerPort,
  type ChatRuntimeOwnerHostAdapterPort,
  type ChatRuntimeOwnerSaveBridgePort,
  type ChatRuntimeOwnerSessionContextPort,
  type ChatRuntimeOwnerStatePort,
} from './chat-runtime-owner-ports';

/**
 * Host-level adapter for the single Lex runtime owner.
 *
 * This is intentionally registered from ChatRuntimeHostBootstrapService rather
 * than ChatEngineService, so visible chat surfaces behave like VS Code chat
 * widgets: they attach to an existing session model/runtime instead of owning it.
 */
@Injectable()
export class ChatRuntimeOwnerHostAdapterService implements ChatRuntimeOwnerContextAdapter, ChatRuntimeOwnerHostAdapterPort {
  private readonly contextBinder = inject<ChatRuntimeOwnerContextBinderPort>(CHAT_RUNTIME_OWNER_CONTEXT_BINDER);
  private readonly contextMaterializer = inject<ChatRuntimeOwnerContextMaterializerPort>(
    CHAT_RUNTIME_OWNER_CONTEXT_MATERIALIZER,
  );
  private readonly ownerSaveBridge = inject<ChatRuntimeOwnerSaveBridgePort>(CHAT_RUNTIME_OWNER_SAVE_BRIDGE);
  private readonly ownerState = inject<ChatRuntimeOwnerStatePort>(CHAT_RUNTIME_OWNER_STATE);
  private readonly ownerSessionContext = inject<ChatRuntimeOwnerSessionContextPort>(CHAT_RUNTIME_OWNER_SESSION_CONTEXT);

  private ownerFacade: LexOwnerFacade | null = null;

  readonly session = {
    saveCurrentSession: (options?: {
      hostProjection?: HostResponseProjection | null;
      visibleChatList?: readonly ChatListItem[];
      hostRequestModel?: import('../helpers/host-turn-response-state').HostRequestModel | null;
      target?: HostSessionSaveTarget | null;
    }): void => {
      this.saveCurrentSession(options);
    },
  };

  ensureBound(): LexOwnerFacade {
    if (!this.ownerFacade) {
      const context = this.contextMaterializer.bindAdapter(this);
      this.ownerFacade = this.contextBinder.bindContext(context);
    }
    return this.ownerFacade;
  }

  get sessionId(): string {
    return this.ownerState.resolveActiveRuntimeSessionId(this.ownerSessionContext.currentSessionId);
  }

  get lexStream(): LexOwnerFacade {
    if (!this.ownerFacade) {
      throw new Error('[AilyChat][RuntimeOwnerHostAdapter] Runtime owner facade is not bound yet.');
    }
    return this.ownerFacade;
  }

  get sessionTitle(): string {
    return this.ownerSessionContext.sessionTitle;
  }

  async applyPendingSwitch(_sessionId?: string | null): Promise<void> {
    // Pending model/mode switches are initiated from visible surfaces. The host
    // owner must not reach back into a view-scoped coordinator here.
  }

  private saveCurrentSession(options?: {
    hostProjection?: HostResponseProjection | null;
    visibleChatList?: readonly ChatListItem[];
    hostRequestModel?: import('../helpers/host-turn-response-state').HostRequestModel | null;
    target?: HostSessionSaveTarget | null;
  }): void {
    this.ownerSaveBridge.saveCurrentSession({
      sessionId: this.sessionId,
      sessionTitle: this.sessionTitle,
      lexStream: this.lexStream,
      hostProjection: options?.hostProjection ?? null,
      visibleChatList: options?.visibleChatList,
      hostRequestModel: options?.hostRequestModel ?? null,
      target: options?.target ?? null,
    });
  }
}
