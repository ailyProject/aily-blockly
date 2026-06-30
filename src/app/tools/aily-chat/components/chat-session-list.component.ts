import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, HostBinding, Input, Output } from '@angular/core';

import type { ChatSessionInventoryGroup } from '../helpers/chat-session-presentation';
import type { ChatSessionListLoadState } from '../services/chat-session-items.service';
import type { ChatSessionListItem } from '../services/menu-manager.service';
import { ChatSessionEntriesComponent } from './chat-session-entries.component';

@Component({
  selector: 'aily-chat-session-list',
  standalone: true,
  imports: [CommonModule, ChatSessionEntriesComponent],
  templateUrl: './chat-session-list.component.html',
  styleUrl: './chat-session-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSessionListComponent {
  readonly skeletonRows = [0, 1, 2, 3, 4];

  @Input() groups: readonly ChatSessionInventoryGroup[] = [];
  @Input() items: readonly ChatSessionListItem[] = [];
  @Input() selectedSessionId = '';
  @Input() title = 'Sessions';
  @Input() emptyLabel = 'No sessions';
  @Input() showNewSession = false;
  @Input() variant: 'sidebar' | 'entry' = 'sidebar';
  @Input() loadState: ChatSessionListLoadState | null = {
    kind: 'ready',
    canRetry: false,
  };

  @Output() selectSession = new EventEmitter<{ sessionId: string; item: ChatSessionListItem }>();
  @Output() preloadSession = new EventEmitter<{ sessionId: string; item: ChatSessionListItem }>();
  @Output() actionClick = new EventEmitter<{ action: string; data: ChatSessionListItem }>();
  @Output() newSession = new EventEmitter<void>();
  @Output() retryRequested = new EventEmitter<void>();

  @HostBinding('class.is-empty')
  get hostIsEmpty(): boolean {
    return this.items.length === 0;
  }

  get currentLoadStateKind(): ChatSessionListLoadState['kind'] {
    return this.loadState?.kind ?? 'ready';
  }

  get canRetry(): boolean {
    return this.loadState?.canRetry === true;
  }

  get showSkeleton(): boolean {
    return this.items.length === 0
      && (this.currentLoadStateKind === 'idle' || this.currentLoadStateKind === 'loading-summary');
  }

  get showErrorState(): boolean {
    return this.items.length === 0 && this.currentLoadStateKind === 'error';
  }

  get showInlineErrorNotice(): boolean {
    return this.items.length > 0 && this.currentLoadStateKind === 'error';
  }

  requestNewSession(): void {
    this.newSession.emit();
  }

  requestRetry(): void {
    this.retryRequested.emit();
  }
}
