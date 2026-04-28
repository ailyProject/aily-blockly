import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../../services/chat.service';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { CmdService } from '../../../../../services/cmd.service';
import { ElectronService } from '../../../../../services/electron.service';
import { ProjectService } from '../../../../../services/project.service';
import { executeCommandTool } from '../../../tools/executeCommandTool';
import { AilyHost } from '../../../core/host';

/**
 * actionType 标识按钮点击后的行为：
 * - 'chat'  (默认) 发送 text 到对话
 * - 'cmd'   执行 actionPayload 中的命令，结果回显到对话
 * - 'url'   用浏览器打开 actionPayload 中的链接
 * - 'path'  用资源管理器打开 actionPayload 中的本地路径
 */
type ButtonActionType = 'chat' | 'cmd' | 'url' | 'path';

interface ButtonData {
  text: string;
  action: string;
  type?: 'primary' | 'default' | 'dashed' | 'link' | 'text';
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
  size?: 'small' | 'default' | 'large';
  danger?: boolean;
  actionType?: ButtonActionType;
  actionPayload?: string;
}

@Component({
  selector: 'x-aily-button-viewer',
  standalone: true,
  imports: [CommonModule, NzButtonModule],
  template: `
    @if (!isHistory && streamStatus === 'loading' && !buttons.length) {
      <div class="ac-btns ac-loading">
        <i class="fa-light fa-spinner-third fa-spin"></i>
      </div>
    }
    @if (!isHistory && buttons.length) {
      <div class="ac-btns">
        @for (btn of buttons; track btn.action || $index) {
          <button
            class="ac-btn"
            nz-button
            [nzType]="btn.type"
            [disabled]="isDisabled || btn.disabled || btn.loading"
            [nzSize]="btn.size"
            [nzDanger]="btn.danger"
            [nzLoading]="!!btn.loading"
            (click)="onButtonClick(btn)"
          >
            @if (btn.icon && !btn.loading) { <i class="fa-light" [class]="btn.icon"></i> }
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
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.645, 0.045, 0.355, 1);

      > i {
        margin-right: 6px;
      }
    }
    .ac-btn:hover:not(:disabled) {
      transform: translateY(-1px);
    }
    .ac-btn:active:not(:disabled) { transform: translateY(0); }
    .ac-btn[data-type="primary"] { background: var(--aily-chat-viewer-primary, #1890ff); border-color: var(--aily-chat-viewer-primary, #1890ff); color: var(--aily-chat-viewer-on-primary, #ffffff); }
    .ac-btn[data-type="primary"]:hover:not(:disabled) { background: var(--aily-chat-viewer-primary-hover, #40a9ff); }
    .ac-btn[data-type="dashed"] { border-style: dashed; }
    .ac-btn[data-type="link"] { border: none; background: none; color: var(--aily-chat-viewer-primary, #1890ff); padding: 4px 6px; min-width: auto; height: auto; }
    .ac-btn[data-type="link"]:hover { color: var(--aily-chat-viewer-primary-hover, #40a9ff); transform: none; box-shadow: none; }
    .ac-btn[data-type="text"] { border: none; background: none; min-width: auto; height: auto; }
    .ac-btn:disabled { opacity: 0.6; cursor: not-allowed; transform: none; box-shadow: none; }
    .ac-loading {
      min-height: 48px;
      align-items: center;
      justify-content: flex-start;
      margin: 0;
      border-radius: 4px;
      overflow-x: auto;
      background: var(--aily-chat-viewer-code-bg, #0d1117);
      padding: 12px;
      border: 1px solid var(--aily-chat-viewer-code-border, #444444);
      color: var(--aily-text-hint, #8c8c8c);
    }
  `],
})
export class XAilyButtonViewerComponent implements OnChanges {
  @Input() data: any = null;
  @Input() streamStatus: string = 'done';

  buttons: ButtonData[] = [];
  isDisabled = false;
  isHistory = false;

  constructor(
    private chatService: ChatService,
    private cmdService: CmdService,
    private electronService: ElectronService,
    private projectService: ProjectService,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) this.processData();
  }

  private processData(): void {
    if (!this.data) {
      // 流式过程中 parse 可能因中间 chunk 失败，data 短暂为 null，此时保留已有按钮避免闪烁
      if (this.streamStatus === 'done') this.buttons = [];
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
      type: b.type ?? 'primary',
      icon: b.icon,
      disabled: b.disabled,
      loading: false,
      size: b.size ?? 'default',
      danger: b.danger ?? false,
      actionType: b.actionType ?? b.action_type ?? 'chat',
      actionPayload: b.actionPayload ?? b.action_payload ?? b.payload ?? b.command ?? '',
    };
  }

  onButtonClick(btn: ButtonData): void {
    switch (btn.actionType) {
      case 'cmd':
        this.handleCmd(btn);
        break;
      case 'url':
        this.handleUrl(btn);
        break;
      case 'path':
        this.handlePath(btn);
        break;
      default:
        this.chatService.sendTextToChat(btn.text, { sender: 'button', type: 'button', cover: false });
        break;
    }
  }

  /** 执行命令并将结果回显到对话 */
  private async handleCmd(btn: ButtonData): Promise<void> {
    const command = btn.actionPayload;
    if (!command) return;

    const cwd = this.projectService.currentProjectPath;

    // 回显「正在执行」状态到对话
    this.chatService.sendTextToChat(
      `\`\`\`aily-state\n${JSON.stringify({ state: 'doing', text: `${btn.text}: ${command}` })}\n\`\`\``,
      { sender: 'button', type: 'button-cmd', cover: false },
    );

    btn.loading = true;
    btn.disabled = true;

    try {
      const result = await executeCommandTool(this.cmdService, { command, cwd }, {
        currentProjectPath: cwd,
        allowProjectPathAccess: true,
      });

      const state = result.is_error ? 'error' : 'done';
      const stateText = result.is_error ? `${btn.text} 执行失败` : `${btn.text} 执行完成`;

      // 回显执行结果
      this.chatService.sendTextToChat(
        `\`\`\`aily-state\n${JSON.stringify({ state, text: stateText })}\n\`\`\`\n\`\`\`\n${result.content}\n\`\`\``,
        { sender: 'button', type: 'button-cmd-result', cover: false },
      );
    } catch (e: any) {
      this.chatService.sendTextToChat(
        `\`\`\`aily-state\n${JSON.stringify({ state: 'error', text: `${btn.text} 执行异常` })}\n\`\`\`\n\`\`\`\n${e.message ?? e}\n\`\`\``,
        { sender: 'button', type: 'button-cmd-result', cover: false },
      );
    } finally {
      btn.loading = false;
      btn.disabled = false;
    }
  }

  /** 用浏览器打开 URL */
  private handleUrl(btn: ButtonData): void {
    const url = btn.actionPayload;
    if (!url) return;
    this.electronService.openUrl(url);
  }

  /** 用资源管理器打开本地路径 */
  private handlePath(btn: ButtonData): void {
    const path = btn.actionPayload;
    if (!path) return;
    if (AilyHost.get().shell?.openByExplorer) {
      AilyHost.get().shell.openByExplorer(path);
    }
  }
}
