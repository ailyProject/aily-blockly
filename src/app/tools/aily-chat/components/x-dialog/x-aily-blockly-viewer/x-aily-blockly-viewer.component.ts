import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-blockly-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ac-blockly">
      @if (data?.title) {
        <div class="ac-blockly-header">
          <i class="fa-light fa-puzzle-piece"></i>
          <span>{{ data.title }}</span>
        </div>
      }
      @if (data?.blocks?.length) {
        <div class="ac-blockly-chips">
          @for (blk of data.blocks; track blk.id ?? blk.type ?? $index) {
            <span class="ac-chip">
              {{ blk.type }}
              @if (blk.pin != null) { <em>Pin:{{ blk.pin }}</em> }
              @if (blk.time != null) { <em>{{ blk.time }}ms</em> }
            </span>
          }
        </div>
      }
      @if (data?.code) {
        <pre class="ac-blockly-code"><code>{{ data.code }}</code></pre>
      }
    </div>
  `,
  styles: [`
    .ac-blockly {
      border: 1px solid #444; border-radius: 5px;
      margin: 12px 0; overflow: hidden; background: #3a3a3a;
    }
    .ac-blockly:hover { background: #3f3f3f; }
    .ac-blockly-header {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 12px; border-bottom: 1px solid #444;
      font-size: 13px; font-weight: 500; color: #d4d4d4;
    }
    .ac-blockly-chips {
      display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 12px;
    }
    .ac-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 4px;
      background: rgba(24,144,255,.12);
      border: 1px solid rgba(24,144,255,.25);
      font-size: 11px; color: #91caff;
    }
    .ac-chip em { font-style: normal; color: #666; font-size: 10px; }
    .ac-blockly-code {
      margin: 0; padding: 12px; font-size: 12px;
      line-height: 1.4; overflow-x: auto;
      background: #1e1e1e; color: #abb2bf;
      border-top: 1px solid #444;
      font-family: Consolas, 'Courier New', monospace;
      border-radius: 4px;
    }
  `],
})
export class XAilyBlocklyViewerComponent {
  @Input() data: {
    title?: string;
    blocks?: Array<{ id: string; type: string; pin?: number; time?: number }>;
    code?: string;
  } | null = null;
}
