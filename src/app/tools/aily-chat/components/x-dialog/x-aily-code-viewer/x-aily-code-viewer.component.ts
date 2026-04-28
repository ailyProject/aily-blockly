import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-code-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (block) {
      <pre><code [class]="'language-' + lang" [innerHTML]="children"></code></pre>
    } @else {
      <code [innerHTML]="children"></code>
    }
  `,
  styles: [
    `
      pre {
        margin: 0;
        border-radius: 4px;
        overflow-x: auto;
        background: var(--aily-chat-viewer-code-bg, #0d1117);
        padding: 12px;
        border: 1px solid var(--aily-chat-viewer-code-border, #444444);
        scrollbar-width: thin !important;
        scrollbar-color: var(--aily-chat-viewer-scrollbar, rgba(255, 255, 255, 0.2)) transparent;
      }
      pre code {
        font-size: 12px;
        line-height: 1.4;
        color: var(--aily-chat-viewer-code-fg, #abb2bf);
      }
      code {
        font-size: 12px;
        color: var(--aily-chat-viewer-inline-code, #ffbd08);
        padding: 0;
        border-radius: 3px;
      }
    `,
  ],
})
export class XAilyCodeViewerComponent {
  @Input() children: string = '';
  @Input() block: boolean = false;
  @Input() lang: string = '';
}
