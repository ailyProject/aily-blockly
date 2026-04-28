import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-default-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="aily-default-viewer" [innerHTML]="content"></div>
  `,
  styles: [`
    .aily-default-viewer {
      font-size: 13px;
      line-height: 1.5;
      color: var(--aily-chat-viewer-code-fg, #abb2bf);
      white-space: pre-wrap;
      word-break: break-word;
    }
  `],
})
export class XAilyDefaultViewerComponent {
  @Input() content: string = '';
}
