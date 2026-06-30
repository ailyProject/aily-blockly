import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';

import type { ActivityToolbarActionDisplayData } from '../chat-activity-group.types';

@Component({
  selector: 'aily-chat-terminal-part',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="terminal-tool-card" [attr.data-tone]="tone">
      <div class="terminal-tool-title">
        <span class="terminal-tool-decoration" [attr.data-tone]="tone" aria-hidden="true">
          <i [class]="iconClass"></i>
        </span>
        <div class="terminal-tool-command">
          <span class="terminal-tool-command-label">{{ 'AILY_CHAT.PROCESS_COMMAND_LABEL' | translate }}</span>
          <code [textContent]="command || 'terminal command'"></code>
        </div>
        @if (subtitle) {
          <span class="terminal-tool-subtitle">{{ subtitle }}</span>
        }
        @if (status) {
          <span class="terminal-tool-status" [attr.data-tone]="tone">{{ status }}</span>
        }
        @if (actions.length) {
          <span class="terminal-action-bar" [attr.aria-label]="'AILY_CHAT.PROCESS_ACTIONS_ARIA' | translate">
            @for (action of actions; track action.id) {
              <button
                type="button"
                class="terminal-action-button"
                [disabled]="action.disabled"
                [attr.title]="(action.tooltip || action.label) | translate"
                [attr.aria-label]="action.label | translate"
                (click)="selectAction(action, $event)">
                <i [class]="action.iconClass"></i>
              </button>
            }
          </span>
        }
      </div>
      <div
        class="terminal-output-container"
        #outputContainer
        [class.terminal-output-container-no-output]="!hasOutput"
        role="region"
        [attr.aria-label]="('AILY_CHAT.PROCESS_OUTPUT_TERMINAL' | translate) + '：' + (command || 'terminal command')">
        @if (hasOutput) {
          <div class="terminal-output-label">{{ 'AILY_CHAT.PROCESS_OUTPUT_STDOUT' | translate }}</div>
          <pre class="terminal-output"><code [textContent]="output"></code></pre>
        } @else {
          <div class="terminal-output-empty">{{ 'AILY_CHAT.PROCESS_OUTPUT_NONE' | translate }}</div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }

    .terminal-tool-card {
      min-width: 0;
      overflow: hidden;
      border-radius: 6px;
      background: var(--aily-chat-viewer-code-bg, var(--chat-bg-subtle, #181818));
    }

    .terminal-tool-title {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 5px 8px;
      border: 1px solid var(--chat-border, rgba(255,255,255,0.12));
      border-bottom: 0;
      border-top-left-radius: 6px;
      border-top-right-radius: 6px;
      background: color-mix(in srgb, var(--aily-chat-viewer-panel, var(--chat-bg-subtle, #252526)) 88%, var(--chat-bg-hover, transparent) 12%);
    }

    .terminal-tool-decoration {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 12px;
    }

    .terminal-tool-decoration[data-tone='success'] { color: var(--chat-success, #89d185); }
    .terminal-tool-decoration[data-tone='error'] { color: var(--chat-error, #f14c4c); }
    .terminal-tool-decoration[data-tone='info'] { color: var(--chat-info, #75beff); }

    @keyframes terminal-tool-spin {
      to { transform: rotate(360deg); }
    }

    .terminal-tool-decoration i.cag-spin,
    .terminal-tool-decoration i.fa-spin {
      display: inline-block;
      transform-origin: center center;
      will-change: transform;
      animation: terminal-tool-spin 0.8s linear infinite;
    }

    .terminal-tool-command {
      flex: 1 1 auto;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .terminal-tool-command-label {
      flex: 0 0 auto;
      font-size: 11px;
      line-height: 1.3;
      color: var(--chat-fg-muted, #6a6a6a);
    }

    .terminal-tool-command code {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border: 0;
      background: transparent;
      color: var(--chat-fg, #cccccc);
      font-family: Consolas, 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.35;
    }

    .terminal-tool-subtitle {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 11px;
      line-height: 1.3;
    }

    .terminal-tool-status {
      flex: 0 0 auto;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.1));
      color: var(--chat-fg-dim, #8e8e8e);
      background: var(--chat-bg-subtle, rgba(255,255,255,0.04));
      font-size: 10px;
      line-height: 1.4;
    }

    .terminal-tool-status[data-tone='success'] {
      color: var(--chat-success, #89d185);
      border-color: color-mix(in srgb, var(--chat-success, #89d185) 32%, transparent);
      background: color-mix(in srgb, var(--chat-success, #89d185) 10%, transparent);
    }

    .terminal-tool-status[data-tone='error'] {
      color: var(--chat-error, #f14c4c);
      border-color: color-mix(in srgb, var(--chat-error, #f14c4c) 32%, transparent);
      background: color-mix(in srgb, var(--chat-error, #f14c4c) 10%, transparent);
    }

    .terminal-tool-status[data-tone='info'] {
      color: var(--chat-info, #75beff);
      border-color: color-mix(in srgb, var(--chat-info, #75beff) 30%, transparent);
      background: color-mix(in srgb, var(--chat-info, #75beff) 10%, transparent);
    }

    .terminal-action-bar {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
    }

    .terminal-action-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--chat-fg-dim, #8e8e8e);
      cursor: pointer;
      line-height: 1;
    }

    .terminal-action-button:hover:not(:disabled),
    .terminal-action-button:focus-visible:not(:disabled) {
      color: var(--chat-fg, #cccccc);
      background: var(--chat-bg-hover, rgba(255,255,255,0.08));
      border-color: var(--chat-border-dim, rgba(255,255,255,0.12));
      outline: none;
    }

    .terminal-action-button:disabled {
      opacity: 0.38;
      cursor: not-allowed;
    }

    .terminal-output-container {
      max-height: 300px;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--chat-border, rgba(255,255,255,0.12));
      border-bottom-left-radius: 6px;
      border-bottom-right-radius: 6px;
      background: var(--aily-chat-viewer-code-bg, color-mix(in srgb, var(--aily-chat-viewer-panel, #181818) 88%, #000 12%));
      scrollbar-width: thin;
      scrollbar-color: var(--aily-chat-viewer-scrollbar, rgba(255,255,255,0.22)) transparent;
    }

    .terminal-output-container:focus-visible {
      outline: 1px solid var(--chat-focus, #4da3ff);
      outline-offset: 2px;
    }

    .terminal-output-container-no-output {
      min-height: 30px;
      display: flex;
      align-items: center;
    }

    .terminal-output {
      margin: 0;
      padding: 7px 10px;
      white-space: pre;
      font-family: Consolas, 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.45;
      color: var(--aily-chat-viewer-code-fg, var(--chat-fg, #cccccc));
    }

    .terminal-output-label {
      padding: 6px 10px 0;
      color: var(--chat-fg-muted, #a6a6a6);
      font-size: 11px;
      font-weight: 600;
    }

    .terminal-output code {
      display: block;
      white-space: pre;
      font: inherit;
      color: inherit;
    }

    .terminal-output-empty {
      padding: 6px 10px;
      color: var(--chat-fg-dim, #8e8e8e);
      font-size: 12px;
      line-height: 1.35;
      font-style: italic;
    }
  `],
})
export class ChatTerminalPartComponent implements OnChanges, AfterViewChecked, OnDestroy {
  @Input() command = '';
  @Input() subtitle?: string;
  @Input() status?: string;
  @Input() tone: 'info' | 'success' | 'error' | 'neutral' = 'neutral';
  @Input() iconClass = 'fa-light fa-terminal';
  @Input() output = '';
  @Input() hasOutput = false;
  @Input() actions: readonly ActivityToolbarActionDisplayData[] = [];

  @Output() actionSelected = new EventEmitter<ActivityToolbarActionDisplayData>();

  @ViewChild('outputContainer') outputContainer?: ElementRef<HTMLElement>;

  private shouldAutoScroll = false;
  private scrollFrameId: number | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['output'] || changes['hasOutput']) {
      this.shouldAutoScroll = true;
    }
  }

  ngAfterViewChecked(): void {
    if (!this.shouldAutoScroll || !this.outputContainer) {
      return;
    }

    this.shouldAutoScroll = false;
    this.scheduleAutoScroll();
  }

  ngOnDestroy(): void {
    this.cancelAutoScroll();
  }

  selectAction(action: ActivityToolbarActionDisplayData, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (action.disabled) {
      return;
    }
    this.actionSelected.emit(action);
  }

  private scheduleAutoScroll(): void {
    if (this.scrollFrameId !== null || typeof globalThis.requestAnimationFrame !== 'function') {
      if (typeof globalThis.requestAnimationFrame !== 'function') {
        this.scrollToBottom();
      }
      return;
    }

    this.scrollFrameId = globalThis.requestAnimationFrame(() => {
      this.scrollFrameId = null;
      this.scrollToBottom();
    });
  }

  private cancelAutoScroll(): void {
    if (this.scrollFrameId === null) {
      return;
    }
    globalThis.cancelAnimationFrame?.(this.scrollFrameId);
    this.scrollFrameId = null;
  }

  private scrollToBottom(): void {
    const element = this.outputContainer?.nativeElement;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }
}
