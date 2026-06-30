import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, Output, QueryList, ViewChildren } from '@angular/core';

import type { ImportedDebugResourceSummary } from '../../services/chat-debug-browser.service';

const PAGE_SIZE = 5;

@Component({
  selector: 'aily-chat-debug-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-chat-debug-home.component.html',
  styleUrl: './aily-chat-debug-home.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatDebugHomeComponent {
  @Input() sessions: readonly ImportedDebugResourceSummary[] = [];
  @Input() activeSessionId: string | null = null;

  @ViewChildren('sessionButton')
  private readonly sessionButtons!: QueryList<ElementRef<HTMLButtonElement>>;

  @Output() closeRequested = new EventEmitter<void>();
  @Output() importRequested = new EventEmitter<void>();
  @Output() sessionRequested = new EventEmitter<string>();

  private visibleCount = PAGE_SIZE;

  get visibleSessions(): readonly ImportedDebugResourceSummary[] {
    return this.sessions.slice(0, this.visibleCount);
  }

  get hasMoreSessions(): boolean {
    return this.sessions.length > this.visibleCount;
  }

  get remainingSessionCount(): number {
    return Math.max(this.sessions.length - this.visibleCount, 0);
  }

  showMore(): void {
    this.visibleCount += PAGE_SIZE;
  }

  onListKeydown(event: KeyboardEvent): void {
    const buttons = this.sessionButtons.toArray().map(button => button.nativeElement);
    if (buttons.length === 0) {
      return;
    }

    const currentIndex = buttons.findIndex(button => button === document.activeElement);
    if (currentIndex < 0) {
      return;
    }

    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = Math.min(currentIndex + 1, buttons.length - 1);
        break;
      case 'ArrowUp':
        nextIndex = Math.max(currentIndex - 1, 0);
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = buttons.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    buttons[nextIndex].focus();
  }

  getSessionAriaLabel(session: ImportedDebugResourceSummary): string {
    return this.activeSessionId === session.sessionId
      ? `${session.displayTitle}（当前）`
      : session.displayTitle;
  }
}