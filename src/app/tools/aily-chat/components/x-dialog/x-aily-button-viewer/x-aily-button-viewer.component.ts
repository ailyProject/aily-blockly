import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../../services/chat.service';
import { NzButtonModule } from 'ng-zorro-antd/button';

interface ButtonData {
  text: string;
  action: string;
  type?: 'primary' | 'default' | 'dashed' | 'link' | 'text';
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
}

@Component({
  selector: 'x-aily-button-viewer',
  standalone: true,
  imports: [CommonModule, NzButtonModule],
  template: `
    @if (!isHistory && buttons.length) {
      <div class="ac-btns">
        @for (btn of buttons; track btn.action || $index) {
          <button
            class="ac-btn"
            nz-button
            [nzType]="btn.type"
            [disabled]="isDisabled || btn.disabled"
            [nzSize]="'small'"
            (click)="onButtonClick(btn)"
          >
            @if (btn.icon) { <i class="fa-light" [class]="btn.icon"></i> }
            {{ btn.text }}
          </button>
        }
      </div>
    }
  `,
  styles: [`
    .ac-btns { display: flex; flex-wrap: wrap; gap: 5px; padding: 2px 0; }
    .ac-btn {
      align-items: center;
      min-width: 80px; height: 32px; padding: 0 12px;
      border-radius: 6px; font-size: 14px;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.645, 0.045, 0.355, 1);
    }
    .ac-btn:hover:not(:disabled) {
      transform: translateY(-1px);
    }
    .ac-btn:active:not(:disabled) { transform: translateY(0); }
    .ac-btn[data-type="primary"] { background: #1890ff; border-color: #1890ff; color: #fff; }
    .ac-btn[data-type="primary"]:hover:not(:disabled) { background: #40a9ff; }
    .ac-btn[data-type="dashed"] { border-style: dashed; }
    .ac-btn[data-type="link"] { border: none; background: none; color: #1890ff; padding: 4px 6px; min-width: auto; height: auto; }
    .ac-btn[data-type="link"]:hover { color: #40a9ff; transform: none; box-shadow: none; }
    .ac-btn[data-type="text"] { border: none; background: none; min-width: auto; height: auto; }
    .ac-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
  `],
})
export class XAilyButtonViewerComponent implements OnChanges {
  @Input() data: any = null;

  buttons: ButtonData[] = [];
  isDisabled = false;
  isHistory = false;

  constructor(private chatService: ChatService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) this.processData();
  }

  private processData(): void {
    if (!this.data) {
      this.buttons = [];
      return;
    }
    this.isHistory = this.data.isHistory === true;
    try {
      const buttonsData = this.data.buttons ?? this.data;
      if (Array.isArray(buttonsData)) {
        this.buttons = buttonsData.map((b: any) => this.normalizeButton(b));
      } else if (typeof buttonsData === 'object') {
        this.buttons = [this.normalizeButton(buttonsData)];
      } else {
        this.buttons = [];
      }
    } catch {
      this.buttons = [];
    }
  }

  private normalizeButton(b: any): ButtonData {
    return {
      text: b.text ?? b.label ?? '按钮',
      action: b.action ?? b.command ?? b.value ?? '',
      type: b.type ?? 'default',
      icon: b.icon,
      disabled: b.disabled,
      loading: b.loading,
    };
  }

  onButtonClick(btn: ButtonData): void {
    this.chatService.sendTextToChat(btn.text, { sender: 'button', type: 'button', cover: false });
  }
}
