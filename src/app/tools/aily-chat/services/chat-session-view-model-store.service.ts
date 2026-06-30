import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import {
  ChatSessionModel,
  ChatSessionModelReference,
  ChatSessionModelStoreService,
  normalizeChatSessionResource,
  type ChatSessionResource,
} from './chat-session-model-store.service';

export interface ChatSessionViewModelChangedEvent {
  readonly previousSessionResource: ChatSessionResource | null;
  readonly currentSessionResource: ChatSessionResource | null;
}

export class ChatSessionViewModel {
  constructor(
    private readonly modelReference: ChatSessionModelReference,
  ) {}

  get model(): ChatSessionModel {
    return this.modelReference.object;
  }

  get sessionResource(): ChatSessionResource {
    return this.model.sessionResource;
  }

  get sessionId(): string {
    return this.model.sessionId;
  }

  dispose(): void {
    this.modelReference.dispose();
  }
}

@Injectable()
export class ChatSessionViewModelStoreService {
  private currentViewModelValue: ChatSessionViewModel | null = null;
  private readonly changedSubject = new Subject<ChatSessionViewModelChangedEvent>();

  readonly changed$ = this.changedSubject.asObservable();

  constructor(
    private readonly modelStore: ChatSessionModelStoreService,
  ) {}

  get currentViewModel(): ChatSessionViewModel | null {
    return this.currentViewModelValue;
  }

  get currentSessionResource(): ChatSessionResource | null {
    return this.currentViewModelValue?.sessionResource ?? null;
  }

  attach(sessionResource: string | null | undefined): ChatSessionViewModel | null {
    const normalizedResource = normalizeChatSessionResource(sessionResource);
    if (!normalizedResource) {
      this.detach();
      return null;
    }

    const current = this.currentViewModelValue;
    if (current?.sessionResource === normalizedResource) {
      return current;
    }

    const modelReference = this.modelStore.acquireExisting(normalizedResource);
    if (!modelReference) {
      return null;
    }

    const previousSessionResource = current?.sessionResource ?? null;
    current?.dispose();
    const viewModel = new ChatSessionViewModel(modelReference);
    this.currentViewModelValue = viewModel;
    this.changedSubject.next({
      previousSessionResource,
      currentSessionResource: viewModel.sessionResource,
    });
    return viewModel;
  }

  detach(sessionResource?: string | null): void {
    const normalizedResource = normalizeChatSessionResource(sessionResource);
    const current = this.currentViewModelValue;
    if (!current) {
      return;
    }
    if (normalizedResource && current.sessionResource !== normalizedResource) {
      return;
    }

    const previousSessionResource = current.sessionResource;
    current.dispose();
    this.currentViewModelValue = null;
    this.changedSubject.next({
      previousSessionResource,
      currentSessionResource: null,
    });
  }
}
