import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-error-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ac-error" [attr.data-sev]="data?.severity || 'error'">
      <div class="ac-error-header">
        <i class="fa-light" [class]="errorIconClass"></i>
        <span class="ac-error-title">
          @if (data?.error?.status) { 错误 {{ data.error.status }} } @else { 错误 }
        </span>
        @if (data?.timestamp) {
          <span class="ac-error-time">{{ fmtTime(data.timestamp) }}</span>
        }
      </div>
      @if (displayMessage) {
        <p class="ac-error-msg">{{ displayMessage }}</p>
      }
    </div>
  `,
  styles: [`
    .ac-error {
      border-radius: 5px; padding: 5px 10px; margin: 4px 0;
      background-color: #3a3a3a; color: #ccc;
      overflow: hidden; display: flex; flex-direction: column;
    }
    .ac-error-header {
      display: flex; align-items: center; gap: 5px;
      flex: 1; min-width: 0;
    }
    .ac-error-header i { flex-shrink: 0; font-size: 14px; color: #ff4d4f; }
    .ac-error[data-sev="warning"] .ac-error-header i { color: #faad14; }
    .ac-error-title { flex: 1; font-size: 13px; color: #ff7875; font-weight: 500; }
    .ac-error[data-sev="warning"] .ac-error-title { color: #ffd666; }
    .ac-error-time { font-size: 11px; color: #666; flex-shrink: 0; }
    .ac-error-msg { padding: 6px 0 0 0; margin: 0; font-size: 12px; color: #888; line-height: 1.6; width: 100%; }
  `],
})
export class XAilyErrorViewerComponent {
  @Input() data: {
    severity?: string;
    message?: string;
    error?: { status?: number; message?: string };
    timestamp?: string;
  } | null = null;

  /** 优先使用顶层 message，其次 error.message */
  get displayMessage(): string {
    return this.data?.message ?? this.data?.error?.message ?? '';
  }

  get errorIconClass(): string {
    return this.data?.severity === 'warning'
      ? 'fa-triangle-exclamation' : 'fa-circle-xmark';
  }

  fmtTime(ts: string): string {
    try { return new Date(ts).toLocaleString('zh-CN'); } catch { return ts; }
  }
}
