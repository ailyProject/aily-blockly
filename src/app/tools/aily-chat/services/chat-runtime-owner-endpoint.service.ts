import { DestroyRef, Injectable, inject } from '@angular/core';

import {
  registerElectronChatRuntimeOwner,
  type ElectronChatRuntimeOwnerRegistration,
} from '../core/electron-chat-runtime-host-transport';
import {
  CHAT_RUNTIME_OWNER_HOST,
  CHAT_RUNTIME_OWNER_HOST_ADAPTER,
  type ChatRuntimeOwnerHostAdapterPort,
  type ChatRuntimeOwnerHostPort,
} from './chat-runtime-owner-ports';

@Injectable()
export class ChatRuntimeOwnerEndpointService {
  private readonly runtimeOwner = inject<ChatRuntimeOwnerHostPort>(CHAT_RUNTIME_OWNER_HOST);
  private readonly runtimeOwnerHostAdapter = inject<ChatRuntimeOwnerHostAdapterPort>(CHAT_RUNTIME_OWNER_HOST_ADAPTER);
  private readonly destroyRef = inject(DestroyRef);
  private electronHostRuntimeOwnerRegistration: ElectronChatRuntimeOwnerRegistration | null = null;
  private electronHostRuntimeOwnerRegistrationPromise: Promise<void> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      const registration = this.electronHostRuntimeOwnerRegistration;
      this.electronHostRuntimeOwnerRegistration = null;
      if (registration) {
        void registration.dispose().catch((error) => {
          console.error('[AilyChat][RuntimeOwnerEndpoint] Failed to unregister Electron host runtime owner:', error);
        });
      }
    });
  }

  async startElectronHostRuntimeOwner(runtimeOwnerId = 'aily-chat-host-runtime-owner'): Promise<void> {
    const runtimeOwner = this.runtimeOwnerHostAdapter.ensureBound();
    const moduleLoaded = await runtimeOwner.agent.loadModule();
    if (!moduleLoaded) {
      throw new Error('[AilyChat][RuntimeHost] aily-lex module failed to load in host runtime owner.');
    }
    await this.registerElectronHostRuntimeOwner(runtimeOwnerId);
  }

  private async registerElectronHostRuntimeOwner(runtimeOwnerId: string): Promise<void> {
    if (this.electronHostRuntimeOwnerRegistration) {
      return;
    }
    if (this.electronHostRuntimeOwnerRegistrationPromise) {
      return this.electronHostRuntimeOwnerRegistrationPromise;
    }

    this.electronHostRuntimeOwnerRegistrationPromise = registerElectronChatRuntimeOwner(
      this.runtimeOwner,
      runtimeOwnerId,
    )
      .then((registration) => {
        this.electronHostRuntimeOwnerRegistration = registration;
      })
      .finally(() => {
        this.electronHostRuntimeOwnerRegistrationPromise = null;
      });
    return this.electronHostRuntimeOwnerRegistrationPromise;
  }
}



