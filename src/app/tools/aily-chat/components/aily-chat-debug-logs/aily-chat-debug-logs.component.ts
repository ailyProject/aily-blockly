import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

import { AilyChatDebugDetailPanelComponent } from '../aily-chat-debug-detail-panel/aily-chat-debug-detail-panel.component';
import {
  buildHostSessionDebugEventSummary,
  getHostSessionDebugEventDetails,
  getHostSessionDebugEventTitle,
  isHostSessionDebugErrorEvent,
  type HostSessionDebugEvent,
  type HostSessionDebugResolvedEventContent,
} from '../../services/host-session-debug-events';
import { ChatDebugBrowserService } from '../../services/chat-debug-browser.service';
import { AilyChatDebugBreadcrumbComponent } from '../aily-chat-debug-breadcrumb/aily-chat-debug-breadcrumb.component';

@Component({
  selector: 'aily-chat-debug-logs',
  standalone: true,
  imports: [CommonModule, AilyChatDebugBreadcrumbComponent, AilyChatDebugDetailPanelComponent],
  templateUrl: './aily-chat-debug-logs.component.html',
  styleUrl: './aily-chat-debug-logs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AilyChatDebugLogsComponent {
  private _events: readonly HostSessionDebugEvent[] = [];

  @Input({ required: true }) sessionTitle = '';
  @Input({ required: true }) sessionId = '';
  @Input() sourceSessionId = '';
  @Input() importedAt = 0;
  @Input()
  set events(value: readonly HostSessionDebugEvent[]) {
    this._events = value;
    this.refreshSelection();
  }

  get events(): readonly HostSessionDebugEvent[] {
    return this._events;
  }

  @Output() overviewRequested = new EventEmitter<void>();
  @Output() homeRequested = new EventEmitter<void>();
  @Output() closeRequested = new EventEmitter<void>();

  selectedEventId: string | null = null;
  selectedEvent: HostSessionDebugEvent | null = null;
  selectedResolvedContent: HostSessionDebugResolvedEventContent | null = null;

  constructor(
    private readonly debugBrowserService: ChatDebugBrowserService,
  ) {}

  get summary() {
    return buildHostSessionDebugEventSummary(this.events);
  }

  getEventTitle(event: HostSessionDebugEvent): string {
    return getHostSessionDebugEventTitle(event);
  }

  getEventDetails(event: HostSessionDebugEvent): string | undefined {
    return getHostSessionDebugEventDetails(event);
  }

  getEventBoundaryDetails(event: HostSessionDebugEvent): string {
    const owner = event.ownerSessionId || event.sessionId;
    const mode = event.requestModeId || event.selectedModeId || '';
    return [
      `owner=${owner}`,
      `turn=${event.turnId}`,
      mode ? `mode=${mode}` : '',
      event.eventSource ? `source=${event.eventSource}` : '',
    ].filter(Boolean).join(' · ');
  }

  isErrorEvent(event: HostSessionDebugEvent): boolean {
    return isHostSessionDebugErrorEvent(event);
  }

  selectEvent(event: HostSessionDebugEvent): void {
    this.selectedEventId = event.id;
    this.refreshSelection();
  }

  clearSelection(): void {
    this.selectedEventId = null;
    this.selectedEvent = null;
    this.selectedResolvedContent = null;
  }

  isSelected(event: HostSessionDebugEvent): boolean {
    return this.selectedEventId === event.id;
  }

  private refreshSelection(): void {
    if (!this.selectedEventId) {
      this.selectedEvent = null;
      this.selectedResolvedContent = null;
      return;
    }

    const event = this._events.find((item) => item.id === this.selectedEventId) ?? null;
    this.selectedEvent = event;
    this.selectedResolvedContent = event
      ? this.debugBrowserService.resolveActiveImportedDebugEventContent(event.id)
      : null;

    if (!event) {
      this.selectedEventId = null;
    }
  }
}
