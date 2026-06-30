import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export type ChatStatusHeaderTone = 'info' | 'success' | 'warning' | 'error' | 'muted';

@Component({
  selector: 'aily-chat-status-header',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="csh-header" [class.csh-compact]="compact">
      <div class="csh-main">
        <div class="csh-title-row">
          <div class="csh-title-group">
            @if (iconClass) {
              <i class="csh-icon" [class.csh-icon-spin]="iconSpin" [attr.data-tone]="statusTone" [ngClass]="iconClass"></i>
            }
            <div class="csh-title">{{ title }}</div>
          </div>
          @if (status) {
            <span class="csh-status" [attr.data-tone]="statusTone">{{ status }}</span>
          }
        </div>
        @if (subtitle) {
          <div class="csh-subtitle">{{ subtitle }}</div>
        }
      </div>
      <div class="csh-side">
        <ng-content select="[header-actions]"></ng-content>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }
    .csh-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .csh-main {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }
    .csh-title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .csh-title-group {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }
    .csh-icon {
      flex: none;
      font-size: 13px;
      color: var(--chat-fg-muted, #6a6a6a);
    }
    .csh-icon[data-tone="info"]    { color: var(--chat-info, #75beff); }
    .csh-icon[data-tone="success"] { color: var(--chat-success, #89d185); }
    .csh-icon[data-tone="warning"] { color: var(--chat-warn, #cca700); }
    .csh-icon[data-tone="error"]   { color: var(--chat-error, #f14c4c); }
    .csh-icon[data-tone="muted"]   { color: var(--chat-fg-muted, #6a6a6a); }
    .csh-icon-spin {
      animation: csh-spin 0.8s linear infinite;
    }
    .csh-title {
      font-size: 13px;
      font-weight: 400;
      color: var(--chat-fg, #cccccc);
      line-height: 1.35;
      flex: 1;
      min-width: 0;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    .csh-subtitle {
      font-size: 11px;
      color: var(--chat-fg-dim, #8e8e8e);
      line-height: 1.35;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    .csh-status {
      flex: none;
      font-size: 11px;
      line-height: 1.3;
      white-space: nowrap;
      color: var(--chat-fg-muted, #6a6a6a);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .csh-status[data-tone="info"]    { color: var(--chat-info, #75beff); }
    .csh-status[data-tone="success"] { color: var(--chat-success, #89d185); }
    .csh-status[data-tone="warning"] { color: var(--chat-warn, #cca700); }
    .csh-status[data-tone="error"]   { color: var(--chat-error, #f14c4c); }
    .csh-status[data-tone="muted"]   { color: var(--chat-fg-muted, #6a6a6a); }
    .csh-side {
      flex: none;
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }
    .csh-header.csh-compact {
      align-items: flex-start;
      gap: 8px;
    }
    .csh-header.csh-compact .csh-main {
      gap: 1px;
    }
    .csh-header.csh-compact .csh-title-row {
      align-items: center;
      gap: 8px;
      min-height: 22px;
    }
    .csh-header.csh-compact .csh-title-group {
      gap: 4px;
      padding-left: 3px;
    }
    .csh-header.csh-compact .csh-icon {
      width: 12px;
      font-size: 11px;
    }
    .csh-header.csh-compact .csh-title {
      font-size: 12px;
      line-height: 22px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .csh-header.csh-compact .csh-subtitle {
      font-size: 11px;
      line-height: 1.35;
      padding-left: 19px;
    }
    .csh-header.csh-compact .csh-status {
      font-size: 11px;
      line-height: 18px;
      align-self: center;
    }
    .csh-header.csh-compact .csh-side {
      align-items: center;
      gap: 4px;
      padding-right: 2px;
      min-height: 18px;
      margin-top: 2px;
    }
    @keyframes csh-spin {
      to { transform: rotate(360deg); }
    }
  `],
})
export class ChatStatusHeaderComponent {
  @Input({ required: true }) title = '';
  @Input() subtitle = '';
  @Input() status = '';
  @Input() statusTone: ChatStatusHeaderTone = 'muted';
  @Input() iconClass = '';
  @Input() iconSpin = false;
  @Input() compact = false;
}