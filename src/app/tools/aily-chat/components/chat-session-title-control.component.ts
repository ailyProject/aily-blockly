import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import type { ChatSessionTitleAction, ChatSessionTitleActionRequest, ChatSessionTitleSurfaceModel } from '../core/chat-session-title-actions';

const EMPTY_TITLE_SURFACE: ChatSessionTitleSurfaceModel = {
  shouldRender: false,
  title: '',
  navigationIconActions: [],
  titleAction: null,
  actions: [],
};

@Component({
  selector: 'aily-chat-session-title-control',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './chat-session-title-control.component.html',
  styleUrl: './chat-session-title-control.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatSessionTitleControlComponent {
  @Input({ required: true }) surface: ChatSessionTitleSurfaceModel = EMPTY_TITLE_SURFACE;
  @Input() surfaceClickEnabled = false;

  @Output() actionRequested = new EventEmitter<ChatSessionTitleActionRequest>();
  @Output() surfaceClicked = new EventEmitter<void>();

  get showStaticTitle(): boolean {
    return this.surface.shouldRender && !this.surface.titleAction && this.surface.title.trim().length > 0;
  }

  requestAction(action: ChatSessionTitleAction, event: MouseEvent): void {
    event.stopPropagation();
    this.actionRequested.emit({ action, event });
  }

  requestSurfaceClick(): void {
    if (!this.surfaceClickEnabled) {
      return;
    }

    this.surfaceClicked.emit();
  }
}
