import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { ChatService } from './chat.service';

@Injectable({
  providedIn: 'root',
})
export class ChatSessionSelectionService {
  private _selectedSessionId = '';
  private readonly selectedSessionIdChangedSubject = new Subject<string>();

  readonly selectedSessionIdChanged$ = this.selectedSessionIdChangedSubject.asObservable();

  constructor(
    private readonly chatService: ChatService,
  ) {
    this._selectedSessionId = typeof this.chatService.currentSessionId === 'string'
      ? this.chatService.currentSessionId.trim()
      : '';
  }

  get selectedSessionId(): string {
    return this._selectedSessionId;
  }

  selectSession(sessionId: string): void {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (normalizedSessionId === this._selectedSessionId) {
      return;
    }

    this._selectedSessionId = normalizedSessionId;
    this.selectedSessionIdChangedSubject.next(this._selectedSessionId);
  }
}