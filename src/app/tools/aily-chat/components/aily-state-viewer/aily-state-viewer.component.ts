import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzProgressModule } from 'ng-zorro-antd/progress';

export interface AilyStateData {
  type: 'aily-state';
  state?: any;
  id?: string;
  text?: string;
  metadata?: any;
  raw?: string;
  content?: string;
}

@Component({
  selector: 'app-aily-state-viewer',
  standalone: true,
  imports: [
    CommonModule,
    NzSpinModule,
    NzIconModule,
    NzProgressModule
  ],
  templateUrl: './aily-state-viewer.component.html',
  styleUrls: ['./aily-state-viewer.component.scss']
})
export class AilyStateViewerComponent implements OnInit, OnDestroy {
  @Input() data: AilyStateData | null = null;

  stateInfo: any = null;
  errorMessage = '';

  ngOnInit() {
    this.processData();
  }

  ngOnDestroy() {
    // 清理资源
  }

  /**
   * 设置组件数据（由指令调用）
   */
  setData(data: AilyStateData): void {
    this.data = data;
    this.processData();
  }

  /**
   * 处理数据
   */
  private processData(): void {
    if (!this.data) {
      this.errorMessage = '没有可显示的数据';
      return;
    }

    try {
      if (this.data.metadata?.isRawText) {
        this.parseRawContent();
      } else {
        this.stateInfo = {
          text: this.data.text || this.data.content || '',
          state: this.data.state || 'info',
          id: this.data.id,
          progress: this.data.state?.progress,
          ...this.data.state
        };
      }
      this.errorMessage = '';
    } catch (error) {
      console.error('Error processing state data:', error);
      this.errorMessage = `数据处理失败: ${error.message}`;
      this.stateInfo = {
        text: this.errorMessage,
        state: 'error'
      };
    }
  }

  /**
   * 解析原始内容
   */
  private parseRawContent(): void {
    try {
      const content = this.data?.content || this.data?.raw || '';
      if (content.trim().startsWith('{')) {
        const parsed = JSON.parse(content);
        this.stateInfo = {
          text: parsed.text || parsed.message || content,
          state: parsed.state || 'info',
          id: parsed.id,
          progress: parsed.progress
        };
      } else {
        this.stateInfo = {
          text: content,
          state: 'info'
        };
      }
    } catch (error) {
      this.stateInfo = {
        text: this.data?.content || this.data?.raw || '无法解析状态信息',
        state: 'error'
      };
    }
  }

  /**
   * 获取状态类名
   */
  getStateClass(): string {
    if (this.errorMessage) return 'error';
    if (!this.stateInfo) return 'info';
    
    const state = this.stateInfo.state || 'info';
    
    // 映射状态
    const stateMap: Record<string, string> = {
      'loading': 'loading',
      'thinking': 'loading',
      'processing': 'loading',
      'retrieving': 'loading',
      'success': 'success',
      'done': 'success',
      'completed': 'success',
      'error': 'error',
      'failed': 'error',
      'warning': 'warning',
      'warn': 'warning',
      'info': 'info',
      'default': 'info'
    };
    
    return stateMap[state.toLowerCase()] || 'info';
  }

  /**
   * 获取状态图标
   */
  getStateIcon(): string | null {
    if (this.errorMessage) return 'exclamation-circle';
    if (!this.stateInfo) return 'info-circle';
    
    const state = this.stateInfo.state || 'info';
    
    const iconMap: Record<string, string> = {
      'loading': 'loading',
      'thinking': 'loading',
      'processing': 'loading',
      'retrieving': 'search',
      'success': 'check-circle',
      'done': 'check-circle',
      'completed': 'check-circle',
      'error': 'exclamation-circle',
      'failed': 'close-circle',
      'warning': 'warning',
      'warn': 'warning',
      'info': 'info-circle'
    };
    
    return iconMap[state.toLowerCase()] || 'info-circle';
  }

  /**
   * 是否显示旋转动画
   */
  isSpinning(): boolean {
    if (!this.stateInfo) return false;
    
    const state = this.stateInfo.state || 'info';
    return ['loading', 'thinking', 'processing'].includes(state.toLowerCase());
  }

  /**
   * 获取显示文本
   */
  getDisplayText(): string {
    if (this.errorMessage) return this.errorMessage;
    if (!this.stateInfo) return '无状态信息';
    
    return this.stateInfo.text || '正在处理...';
  }
}
