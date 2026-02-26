import {
  Component,
  Input,
  ViewChild,
  ElementRef,
  AfterViewChecked,
  OnChanges,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-think-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ac-think" [class.expanded]="thinkExpanded">
      <div class="ac-think-header" (click)="thinkExpanded = !thinkExpanded">
        @if (data?.isComplete) {
          <i class="fa-light fa-circle-check ac-think-icon done"></i>
        } @else {
          <i class="fa-duotone fa-solid fa-loader ac-think-icon loading ac-spin"></i>
        }
        <span>{{ data?.isComplete ? 'Think' : 'Thinking...' }}</span>
        <i class="fa-light fa-chevron-down ac-think-arrow"></i>
      </div>
      @if (thinkExpanded) {
        <div class="ac-think-body" #thinkBody>{{ thinkContent }}</div>
      }
    </div>
  `,
  styles: [
    `
      .ac-think {
        border-radius: 5px;
        padding: 5px 10px;
        margin: 4px 0;
        overflow: hidden;
        background-color: #3a3a3a;
        color: #ccc;
      }
      .ac-think-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0;
        cursor: pointer;
        font-size: 13px;
        user-select: none;
        transition: background 0.2s;
      }
      .ac-think-header:hover {
        background: rgba(255, 255, 255, 0.05);
        margin: -5px -10px;
        padding: 5px 10px;
      }
      .ac-think-icon { flex-shrink: 0; }
      .ac-think-icon.loading { color: #1890ff; }
      .ac-think-icon.done { color: #52c41a; }
      .ac-think-arrow {
        margin-left: auto;
        font-size: 10px;
        color: #888;
        transition: transform 0.2s;
      }
      .ac-think.expanded .ac-think-arrow {
        transform: rotate(180deg);
      }
      .ac-think-body {
        padding: 8px 2px;
        margin: 5px -10px 0 0;
        font-size: 12px;
        line-height: 1.6;
        color: #999;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 200px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
      }
      @keyframes ac-spin {
        to {
          transform: rotate(360deg);
        }
      }
      .ac-spin {
        animation: ac-spin 0.8s linear infinite;
        display: inline-block;
      }
    `,
  ],
})
export class XAilyThinkViewerComponent implements AfterViewChecked, OnChanges {
  @Input() data: {
    content?: string;
    encoded?: boolean;
    isComplete?: boolean;
  } | null = null;
  @ViewChild('thinkBody') thinkBodyRef?: ElementRef<HTMLElement>;

  thinkContent = '';
  thinkExpanded = false;
  private shouldScrollThink = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) {
      if (!this.data) return;
      let raw = this.data.content || '';
      if (this.data.encoded) {
        try {
          raw = decodeURIComponent(atob(raw));
        } catch {
          /* ignore */
        }
      }
      const prev = this.thinkContent;
      this.thinkContent = raw;
      if (raw.length > prev.length) this.shouldScrollThink = true;
      this.thinkExpanded = !this.data.isComplete;
    }
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollThink && this.thinkBodyRef?.nativeElement) {
      const el = this.thinkBodyRef.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScrollThink = false;
    }
  }
}
