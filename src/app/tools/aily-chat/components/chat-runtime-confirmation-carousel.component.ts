import { ChangeDetectionStrategy, Component, HostBinding, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';

import { OPEN_MAX_REQUESTS_SETTINGS_ACTION_ID } from '../core/chat-runtime-confirmation-actions';
import { ChatRuntimeInteractionHostService, type RuntimeConfirmationDecision } from '../services/chat-runtime-interaction-host.service';
import { ChatViewService } from '../services/chat-view.service';
import { XAilyConfirmationViewerComponent } from './x-dialog/x-aily-confirmation-viewer/x-aily-confirmation-viewer.component';

@Component({
  selector: 'aily-chat-runtime-confirmation-carousel',
  standalone: true,
  imports: [CommonModule, TranslateModule, XAilyConfirmationViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (activeConfirmation; as active) {
      <div class="rtc-shell">
        @if (queue.length > 1) {
          <div class="rtc-header">
            <div class="rtc-title-group">
              <div class="rtc-title">{{ active.kind === 'approval' ? ('AILY_CHAT.PROCESS_CAROUSEL_APPROVAL_TITLE' | translate) : ('AILY_CHAT.PROCESS_CAROUSEL_CONFIRMATION_TITLE' | translate) }}</div>
              <div class="rtc-step">{{ activeIndex + 1 }}/{{ queue.length }}</div>
            </div>
            <div class="rtc-nav">
              <button type="button" class="rtc-nav-btn" (click)="navigate(-1)" [attr.aria-label]="'AILY_CHAT.PROCESS_CAROUSEL_PREVIOUS' | translate">
                <i class="fa-light fa-chevron-left"></i>
              </button>
              <button type="button" class="rtc-nav-btn" (click)="navigate(1)" [attr.aria-label]="'AILY_CHAT.PROCESS_CAROUSEL_NEXT' | translate">
                <i class="fa-light fa-chevron-right"></i>
              </button>
            </div>
          </div>
        }

        <x-aily-confirmation-viewer
          class="rtc-viewer"
          [data]="active.data"
          [interactive]="true"
          (decision)="onDecision($event)" />
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
      position: relative;
      z-index: 2;
    }

    .rtc-shell {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 0;
      padding: 4px 3px;
      box-sizing: border-box;
      border: 1px solid var(--aily-chat-xdialog-msg-divider, rgba(255,255,255,0.08));
      border-bottom: none;
      border-radius: var(--aily-chat-widget-top-radius, 8px) var(--aily-chat-widget-top-radius, 8px) 0 0;
      background: color-mix(in srgb, var(--aily-bg-elevated, #1f1f1f) 72%, transparent);
      backdrop-filter: blur(6px);
      color: var(--aily-text-tertiary, #cccccc);
      overflow: visible;
    }

    .rtc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 22px;
      padding: 0 3px;
    }

    .rtc-title-group {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .rtc-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .rtc-step {
      font-size: 11px;
      color: var(--chat-fg-dim, #8e8e8e);
    }

    .rtc-nav {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .rtc-nav-btn {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--chat-fg-dim, #8e8e8e);
      cursor: pointer;
    }

    .rtc-nav-btn:hover {
      background: rgba(255,255,255,0.05);
      color: var(--chat-fg, #cccccc);
    }

    .rtc-viewer {
      margin: 0;
    }

    :host ::ng-deep .rtc-viewer .aa-message {
      padding: 0 3px;
    }

    :host ::ng-deep .rtc-viewer .aa-actions {
      margin-top: 0;
    }

    :host ::ng-deep .rtc-viewer .cca-actions {
      padding: 0 3px 3px;
      margin-bottom: 0;
      gap: 4px;
    }

    :host ::ng-deep .rtc-viewer .cca-btn-primary,
    :host ::ng-deep .rtc-viewer .cca-btn-caret,
    :host ::ng-deep .rtc-viewer .cca-btn-reject {
      min-height: 22px;
      border-radius: 2px;
    }

    :host ::ng-deep .rtc-viewer .cca-btn-primary:not(.cca-btn-primary-standalone) {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }

    :host ::ng-deep .rtc-viewer .cca-btn-caret {
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
    }

    :host ::ng-deep .rtc-viewer .cmdp-container {
      border-radius: 2px;
    }
  `],
})
export class ChatRuntimeConfirmationCarouselComponent {
  @Input() sessionId = '';

  private readonly runtimeHost = inject(ChatRuntimeInteractionHostService);
  private readonly chatViewState = inject(ChatViewService);

  get queue() {
    return this.sessionId ? this.runtimeHost.getConfirmationQueue(this.sessionId) : [];
  }

  get activeIndex(): number {
    return this.sessionId ? this.runtimeHost.getActiveConfirmationIndex(this.sessionId) : 0;
  }

  get activeConfirmation() {
    return this.sessionId ? this.runtimeHost.getActiveConfirmation(this.sessionId) : null;
  }

  @HostBinding('class.has-confirmation')
  get hasConfirmation(): boolean {
    return !!this.activeConfirmation;
  }

  navigate(delta: number): void {
    if (!this.sessionId) {
      return;
    }

    this.runtimeHost.navigateConfirmation(this.sessionId, delta);
  }

  onDecision(decision: RuntimeConfirmationDecision): void {
    const active = this.activeConfirmation;
    if (!active || !this.sessionId) {
      return;
    }

    if (decision.sideEffectOnly && typeof decision.actionId === 'string' && decision.actionId.length > 0) {
      if (decision.actionId === OPEN_MAX_REQUESTS_SETTINGS_ACTION_ID) {
        this.chatViewState.openSettings();
        return;
      }

      this.runtimeHost.triggerConfirmationAction(this.sessionId, active.id, decision.actionId);
      return;
    }

    if (active.toolCallId) {
      this.runtimeHost.resolveToolApproval(this.sessionId, active.toolCallId, decision);
      return;
    }

    this.runtimeHost.resolveConfirmation(this.sessionId, active.id, decision);
  }
}
