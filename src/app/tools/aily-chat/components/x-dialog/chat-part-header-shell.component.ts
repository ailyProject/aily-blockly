import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'aily-chat-part-header-shell',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="cphs-header"
      [class.cphs-header-clickable]="clickable"
      [class.cphs-header-expanded]="expanded"
      [class.cphs-header-with-connector]="showExpandedConnector"
      [attr.data-tone]="tone"
      [attr.role]="clickable ? 'button' : null"
      [attr.tabindex]="clickable ? '0' : null"
      [attr.aria-expanded]="clickable ? expanded : null"
      (click)="onHeaderClick($event)"
      (keydown.enter)="onHeaderClick($event)"
      (keydown.space)="onHeaderSpace($event)">
      <span class="cphs-main">
        @if (showIcon) {
          <span class="cphs-icon-shell">
            <i
              [class]="iconClass"
              [class.cphs-spin]="iconSpin"
              class="cphs-icon"
              [style.color]="iconColor || null"></i>
          </span>
        }

        <span class="cphs-title-wrap">
          <span class="cphs-title">{{ title }}</span>
          @if (subtitle) {
            <small class="cphs-subtitle">{{ subtitle }}</small>
          }
        </span>
      </span>

      <span class="cphs-side">
        @if (meta) {
          <span class="cphs-meta">{{ meta }}</span>
        }
        @if (pill) {
          <span class="cphs-pill" [attr.data-tone]="pillTone || tone || 'neutral'">{{ pill }}</span>
        }
        <ng-content select="[header-actions]"></ng-content>
        @if (showChevron) {
          <span class="cphs-chevron-wrap" aria-hidden="true">
            <i class="fa-light fa-chevron-down cphs-chevron" [class.cphs-chevron-expanded]="expanded"></i>
          </span>
        }
      </span>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
    }

    .cphs-header {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
      padding: 3px 4px;
      margin: 0;
      border-radius: 5px;
      user-select: none;
      transition: background 0.15s;
    }

    .cphs-header[data-tone='info'] .cphs-icon {
      color: var(--chat-info, #75beff);
    }

    .cphs-header[data-tone='success'] .cphs-icon {
      color: var(--chat-success, #89d185);
    }

    .cphs-header[data-tone='warn'] .cphs-icon {
      color: var(--chat-warn, #cca700);
    }

    .cphs-header[data-tone='error'] .cphs-icon {
      color: var(--chat-error, #f14c4c);
    }

    .cphs-header-clickable {
      cursor: pointer;
    }

    .cphs-header-clickable:hover {
      background: var(--chat-bg-hover, rgba(255,255,255,0.06));
    }

    .cphs-header:focus-visible {
      outline: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      outline-offset: 2px;
    }

    .cphs-main {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }

    .cphs-icon-shell {
      width: 14px;
      height: 12px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .cphs-icon {
      width: 12px;
      height: 12px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      line-height: 1;
    }

    .cphs-title-wrap {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: baseline;
      min-width: 0;
      color: var(--chat-fg-dim, #8e8e8e);
      line-height: 1.35;
      white-space: normal;
    }

    .cphs-title {
      display: inline;
      min-width: 0;
      font-size: 12px;
      line-height: 1.4;
      color: inherit;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cphs-subtitle {
      font-size: 1em;
      line-height: 1.35;
      opacity: 0.7;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .cphs-subtitle::before {
      content: ' - ';
    }

    .cphs-side {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
      min-width: 0;
    }

    .cphs-meta {
      color: var(--chat-fg-muted, #6a6a6a);
      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
    }

    .cphs-pill {
      flex-shrink: 0;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 5px;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
      color: var(--chat-fg-muted, #6a6a6a);
      line-height: 1.2;
      white-space: nowrap;
    }

    .cphs-pill[data-tone='info'] {
      color: var(--chat-info, #75beff);
    }

    .cphs-pill[data-tone='success'] {
      color: var(--chat-success, #89d185);
    }

    .cphs-pill[data-tone='warn'] {
      color: var(--chat-warn, #cca700);
    }

    .cphs-pill[data-tone='error'] {
      color: var(--chat-error, #f14c4c);
    }

    .cphs-chevron-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 12px;
    }

    .cphs-chevron {
      font-size: 9px;
      color: var(--chat-fg-muted, #6a6a6a);
      transition: transform 0.15s ease;
    }

    .cphs-chevron-expanded {
      transform: rotate(180deg);
    }

    :host ::ng-deep button[header-actions] {
      min-width: 22px;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--chat-fg-dim, #8e8e8e);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s;
      flex-shrink: 0;
    }

    :host ::ng-deep button[header-actions]:hover {
      color: var(--chat-fg, #cccccc);
      background: var(--chat-bg-hover, rgba(255,255,255,0.06));
      border-color: var(--chat-border-dim, rgba(255,255,255,0.08));
    }

    :host ::ng-deep button[header-actions] i {
      font-size: 11px;
      line-height: 1;
    }

    .cphs-header-expanded.cphs-header-with-connector::after {
      content: '';
      position: absolute;
      left: 9px;
      top: 20px;
      width: 6px;
      height: 10px;
      border-left: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-bottom: 1px solid var(--chat-border, rgba(255,255,255,0.10));
      border-bottom-left-radius: 5px;
      pointer-events: none;
    }

    @keyframes cphs-spin {
      to { transform: rotate(360deg); }
    }

    .cphs-spin {
      animation: cphs-spin 0.8s linear infinite;
    }
  `],
})
export class ChatPartHeaderShellComponent {
  @Input({ required: true }) title = '';
  @Input() subtitle?: string;
  @Input() meta?: string;
  @Input() pill?: string;
  @Input() pillTone?: string;
  @Input() tone: 'neutral' | 'muted' | 'info' | 'success' | 'warn' | 'error' = 'neutral';
  @Input() iconClass = 'fa-light fa-circle';
  @Input() iconColor?: string;
  @Input() iconSpin = false;
  @Input() showIcon = true;
  @Input() showChevron = false;
  @Input() showExpandedConnector = true;
  @Input() clickable = false;
  @Input() expanded = false;

  @Output() toggleRequested = new EventEmitter<void>();

  onHeaderClick(event: Event): void {
    if (!this.clickable) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) {
      return;
    }

    this.toggleRequested.emit();
  }

  onHeaderSpace(event: Event): void {
    if (!this.clickable) {
      return;
    }

    event.preventDefault();
    this.onHeaderClick(event);
  }
}