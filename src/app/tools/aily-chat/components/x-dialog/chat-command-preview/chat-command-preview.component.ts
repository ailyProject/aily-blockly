import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'aily-chat-command-preview',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cmdp-block">
      @if (meta) {
        <div class="cmdp-meta">{{ meta }}</div>
      }
      <pre class="cmdp-command"><code>{{ command }}</code></pre>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 0;
      min-height: 0;
    }
    .cmdp-block {
      min-width: 0;
      max-height: min(240px, 35vh);
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      box-sizing: border-box;
      padding: 5px;
      background: rgba(255,255,255,0.025);
      border-radius: 5px;
      border: 1px solid var(--chat-border-dim, rgba(255,255,255,0.06));
    }
    .cmdp-block::-webkit-scrollbar {
      width: 6px;
    }
    .cmdp-block::-webkit-scrollbar-thumb {
      border-radius: 999px;
      background: var(--chat-scrollbar-thumb, rgba(255,255,255,0.16));
    }
    .cmdp-block::-webkit-scrollbar-track {
      background: transparent;
    }
    .cmdp-command {
      margin: 0;
      padding: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--chat-fg, #cccccc);
      font-family: Consolas, 'Courier New', monospace;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;
      background: transparent;
      border: 0;
      user-select: none;
      -webkit-user-select: none;
    }
    .cmdp-meta {
      margin-bottom: 4px;
      font-size: 11px;
      line-height: 1.35;
      color: var(--chat-fg-muted, #6a6a6a);
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;
      letter-spacing: 0.01em;
      user-select: none;
      -webkit-user-select: none;
    }
  `],
})
export class ChatCommandPreviewComponent {
  @Input() command = '';
  @Input() meta: string | null = null;
}
