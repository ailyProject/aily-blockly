import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-context-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ac-context" [class.expanded]="!collapsed">
      <div class="ac-context-header" (click)="collapsed = !collapsed">
        <i class="fa-light fa-file-code ac-context-icon"></i>
        <span>{{ data?.label || '代码上下文' }}</span>
        <i class="fa-light fa-chevron-down ac-context-arrow"></i>
      </div>
      @if (!collapsed) {
        <div class="ac-context-body">{{ content }}</div>
      }
    </div>
  `,
  styles: [`
    .ac-context {
      border-radius: 5px; padding: 5px 10px;
      background-color: var(--aily-chat-viewer-context-bg, rgba(212, 160, 23, 0.1));
      border: 1px solid var(--aily-chat-viewer-context-border, rgba(212, 160, 23, 0.3));
      color: var(--aily-chat-viewer-fg, #cccccc); overflow: hidden; margin: 4px 0;
    }
    .ac-context.collapsed {
      padding: 5px 10px;
      margin: 0;
      overflow: hidden;
      background-color: var(--aily-chat-viewer-card-bg, #3a3a3a);
      color: var(--aily-chat-viewer-fg, #cccccc);
    }
    .ac-context-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      cursor: pointer;
      font-size: 13px;
      user-select: none;
      transition: background 0.2s;
    }
    .ac-context-header:hover {
      background: var(--aily-chat-viewer-context-header-hover, rgba(255, 255, 255, 0.05));
      margin: -5px -10px;
      padding: 5px 10px;
    }
    .ac-context-icon {
      flex-shrink: 0;
      margin-right: 5px;
      color: var(--aily-chat-viewer-context-accent, #d4a017);
    }
    .ac-context-arrow {
      margin-left: auto;
      font-size: 10px;
      color: var(--aily-chat-viewer-muted, #888888);
      transition: transform 0.2s;
    }
    .ac-context.expanded .ac-context-arrow {
      transform: rotate(180deg);
    }
    .ac-context-body {
      padding: 8px 2px;
      margin: 5px -10px 0 0;
      font-size: 12px;
      line-height: 1.6;
      color: var(--aily-chat-viewer-subtle, #999999);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--aily-chat-viewer-scrollbar, rgba(255, 255, 255, 0.2)) transparent;
    }
  `],
})
export class XAilyContextViewerComponent {
  @Input() data: { label?: string; content?: string; encoded?: boolean } | null = null;

  /** 默认折叠 */
  collapsed = true;

  get content(): string {
    if (!this.data?.content) return '';
    if (this.data.encoded) {
      try { return decodeURIComponent(atob(this.data.content)); } catch {
        try { return atob(this.data.content); } catch { return this.data.content; }
      }
    }
    return this.data.content;
  }
}
