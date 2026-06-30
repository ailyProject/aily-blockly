import { ChangeDetectionStrategy, Component, HostBinding, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

import { ChatRuntimeInteractionHostService } from '../services/chat-runtime-interaction-host.service';
import { XAilyQuestionViewerComponent } from './x-dialog/x-aily-question-viewer/x-aily-question-viewer.component';
import type { AskUserAnswer } from '../core/ask-user';

@Component({
  selector: 'aily-chat-runtime-question-carousel',
  standalone: true,
  imports: [CommonModule, XAilyQuestionViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (activeQuestion; as active) {
      <div class="rtq-shell">
        <x-aily-question-viewer
          class="rtq-viewer"
          [data]="active.data"
          [interactive]="true"
          (answered)="onAnswered($event)" />
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }

    .rtq-shell {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin: 0;
      padding: 0 5px;
      box-sizing: border-box;
      border: 1px solid var(--aily-chat-xdialog-msg-divider, rgba(255,255,255,0.08));
      border-bottom: none;
      border-radius: var(--aily-chat-widget-top-radius, 8px) var(--aily-chat-widget-top-radius, 8px) 0 0;
      background: color-mix(in srgb, var(--aily-bg-elevated, #1f1f1f) 72%, transparent);
      backdrop-filter: blur(6px);
      color: var(--aily-text-tertiary, #cccccc);
      overflow: hidden;
    }

    .rtq-viewer {
      margin: 0;
    }

    :host ::ng-deep .rtq-viewer .aq-container {
      padding: 0;
    }

    :host ::ng-deep .rtq-viewer .aq-card {
      border: none;
      border-radius: 0;
      background: transparent;
    }

    :host ::ng-deep .rtq-viewer .aq-card .cphs-header {
      min-height: 22px;
      padding: 10px 5px;
      border-radius: 2px;
      background: transparent;
    }

    :host ::ng-deep .rtq-viewer .aq-body {
      border-top: none;
    }

    :host ::ng-deep .rtq-viewer .aq-input-container {
      gap: 4px;
      padding: 0;
      margin-bottom: 5px;
    }

    :host ::ng-deep .rtq-viewer .aq-options {
      gap: 5px;
    }

    :host ::ng-deep .rtq-viewer .aq-option {
      min-height: 22px;
      padding: 5px;
      border-color: transparent;
      border-radius: 2px;
      background: transparent;
    }

    :host ::ng-deep .rtq-viewer .aq-option:hover:not(.aq-disabled) {
      background: var(--aily-chat-viewer-option-hover, var(--aily-chat-viewer-overlay-hover, rgba(255,255,255,0.06)));
      border-color: var(--aq-border-soft, transparent);
    }

    :host ::ng-deep .rtq-viewer .aq-option.aq-checked {
      background: var(--aily-chat-viewer-option-selected-bg, rgba(24,144,255,0.08));
      border-color: var(--aily-chat-viewer-option-selected-border, rgba(24,144,255,0.35));
    }

    :host ::ng-deep .rtq-viewer .aq-freeform {
      padding: 0 3px;
    }
  `],
})
export class ChatRuntimeQuestionCarouselComponent {
  @Input() sessionId = '';

  private readonly runtimeHost = inject(ChatRuntimeInteractionHostService);

  @HostBinding('class.has-question')
  get hasQuestion(): boolean {
    return !!this.activeQuestion;
  }

  get activeQuestion() {
    return this.sessionId ? this.runtimeHost.getQuestionWidget(this.sessionId) : null;
  }

  onAnswered(result: { answers: Record<string, AskUserAnswer> }): void {
    if (!this.sessionId) {
      return;
    }

    this.runtimeHost.completeQuestion(this.sessionId, result);
  }
}
