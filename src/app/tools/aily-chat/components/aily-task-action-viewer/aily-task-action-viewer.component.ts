import { Component, Input, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

export type TaskActionType = 'max_messages' | 'error' | 'timeout' | 'unknown';

export interface AilyTaskActionData {
  type: 'aily-task-action';
  actionType: TaskActionType;
  message?: string;
  stopReason?: string;
  metadata?: {
    maxMessages?: number;
    currentMessages?: number;
    errorCode?: string;
    [key: string]: any;
  };
}

/**
 * 任务操作查看器组件
 * 用于在任务完成后显示操作按钮（继续对话、重试等）
 * 类似于 GitHub Copilot 的交互方式
 */
@Component({
  selector: 'app-aily-task-action-viewer',
  standalone: true,
  imports: [
    CommonModule,
    NzButtonModule,
    NzToolTipModule,
    TranslateModule
  ],
  templateUrl: './aily-task-action-viewer.component.html',
  styleUrls: ['./aily-task-action-viewer.component.scss']
})
export class AilyTaskActionViewerComponent implements OnInit, OnDestroy {
  @Input() data: AilyTaskActionData | null = null;
  @Output() actionTriggered = new EventEmitter<{ action: string; data?: any }>();

  actionType: TaskActionType = 'unknown';
  message: string = '';
  isActionTaken: boolean = false;
  actionTakenText: string = '';
  isHistory: boolean = false; // 历史记录模式，隐藏按钮

  constructor(private translate: TranslateService) {}

  ngOnInit() {
    this.processData();
  }

  ngOnDestroy() {
    // 清理资源
  }

  /**
   * 设置组件数据（由指令调用）
   */
  setData(data: AilyTaskActionData): void {
    this.data = data;
    this.processData();
  }

  /**
   * 处理数据
   */
  private processData(): void {
    if (!this.data) {
      this.actionType = 'unknown';
      this.message = '发生未知错误';
      return;
    }

    this.actionType = this.data.actionType || 'unknown';
    this.message = this.data.message || this.getDefaultMessage();
    // 检查是否为历史记录模式
    this.isHistory = (this.data as any).isHistory === true;
  }

  /**
   * 获取默认消息
   */
  private getDefaultMessage(): string {
    switch (this.actionType) {
      case 'max_messages':
        const maxMsg = this.data?.metadata?.maxMessages || 10;
        return `已达到最大消息数限制（${maxMsg}条），您可以选择继续对话或开始新会话。`;
      case 'error':
        return this.data?.stopReason || '任务执行过程中发生错误，请重试。';
      case 'timeout':
        return '请求超时，请检查网络连接后重试。';
      default:
        return '任务已完成，是否需要继续？';
    }
  }

  /**
   * 获取图标类名
   */
  getIconClass(): string {
    switch (this.actionType) {
      case 'max_messages':
        return 'fa-light fa-message-exclamation';
      case 'error':
        return 'fa-light fa-circle-exclamation';
      case 'timeout':
        return 'fa-light fa-clock-rotate-left';
      default:
        return 'fa-light fa-circle-info';
    }
  }

  /**
   * 获取图标状态类名
   */
  getIconStateClass(): string {
    switch (this.actionType) {
      case 'max_messages':
        return 'warn';
      case 'error':
        return 'error';
      case 'timeout':
        return 'warn';
      default:
        return 'info';
    }
  }

  /**
   * 继续对话
   */
  onContinue(): void {
    if (this.isActionTaken) return;
    
    this.isActionTaken = true;
    this.actionTakenText = '正在继续...';
    
    // 触发自定义事件
    this.dispatchAction('continue');
  }

  /**
   * 重试操作
   */
  onRetry(): void {
    if (this.isActionTaken) return;
    
    this.isActionTaken = true;
    this.actionTakenText = '正在重试...';
    
    // 触发自定义事件
    this.dispatchAction('retry');
  }

  /**
   * 开始新会话
   */
  onNewChat(): void {
    if (this.isActionTaken) return;
    
    this.isActionTaken = true;
    this.actionTakenText = '正在创建新会话...';
    
    // 触发自定义事件
    this.dispatchAction('newChat');
  }

  /**
   * 取消/关闭
   */
  onDismiss(): void {
    if (this.isActionTaken) return;
    
    this.isActionTaken = true;
    this.actionTakenText = '已关闭';
    
    // 触发自定义事件
    this.dispatchAction('dismiss');
  }

  /**
   * 触发操作事件
   */
  private dispatchAction(action: string): void {
    // 发送到父组件
    this.actionTriggered.emit({ action, data: this.data });
    
    // 同时触发自定义 DOM 事件，以便在 directive 场景下也能被捕获
    const event = new CustomEvent('aily-task-action', {
      bubbles: true,
      detail: {
        action,
        data: this.data
      }
    });
    document.dispatchEvent(event);
  }

  /**
   * 调试日志
   */
  logDetail(): void {
    console.log('Task Action Viewer Data:', this.data);
  }
}
