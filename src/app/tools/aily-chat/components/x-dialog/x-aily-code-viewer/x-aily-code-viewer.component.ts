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
        background: #1e1e1e;
        padding: 12px;
        border: 1px solid #444;
      }
      pre code {
        font-family: Consolas, 'Courier New', monospace;
        font-size: 12px;
        line-height: 1.4;
        color: #abb2bf;
      }
      code {
        font-family: Consolas, 'Courier New', monospace;
        font-size: 12px;
        color: #ffbd08;
        padding: 1px 4px;
        border-radius: 3px;
        background: #1e1e1e;
      }
    `,
  ],
})
export class XAilyCodeViewerComponent {
  @Input() children: string = '';
  @Input() block: boolean = false;
  @Input() lang: string = '';
}
