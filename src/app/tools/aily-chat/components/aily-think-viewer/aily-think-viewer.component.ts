import { Component, Input, OnInit, OnDestroy, HostBinding, ElementRef, ViewChild, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface AilyThinkData {
  type: 'aily-think';
  content?: string;
  isComplete?: boolean;
  metadata?: any;
  raw?: string;
}

@Component({
  selector: 'app-aily-think-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-think-viewer.component.html',
  styleUrls: ['./aily-think-viewer.component.scss']
})
export class AilyThinkViewerComponent implements OnInit, OnDestroy, AfterViewChecked {
  @Input() data: AilyThinkData | null = null;
  @ViewChild('thinkContentElement') thinkContentElement?: ElementRef<HTMLDivElement>;
  
  @HostBinding('class.expanded') 
  isExpanded = false;
  thinkContent = '';
  isComplete = false;
  
  private updateListener?: (event: CustomEvent) => void;
  private shouldScrollToBottom = false;

  constructor(private elementRef: ElementRef) {}

  ngOnInit() {
    this.processData();
    
    // 监听自定义事件来更新数据（用于流式更新）
    this.updateListener = ((event: CustomEvent) => {
      if (event.detail) {
        this.setData(event.detail);
      }
    }) as (event: CustomEvent) => void;
    
    this.elementRef.nativeElement.addEventListener('think-data-update', this.updateListener);
  }

  ngOnDestroy() {
    // 清理事件监听器
    if (this.updateListener) {
      this.elementRef.nativeElement.removeEventListener('think-data-update', this.updateListener);
    }
  }

  /**
   * 设置组件数据（由指令调用）
   */
  setData(data: AilyThinkData | string): void {
    // 如果是字符串，尝试解析为 JSON
    if (typeof data === 'string') {
      try {
        this.data = JSON.parse(data);
      } catch {
        // 解析失败，当作纯文本内容
        this.data = { type: 'aily-think', content: data, isComplete: true };
      }
    } else {
      this.data = data;
    }
    
    this.processData();
  }

  /**
   * 处理数据
   */
  processData(): void {
    if (!this.data) {
      return;
    }

    // 提取内容
    const newContent = this.data.content || this.data.raw || '';
    
    // 如果内容发生变化，标记需要滚动到底部
    if (newContent !== this.thinkContent && newContent.length > this.thinkContent.length) {
      this.shouldScrollToBottom = true;
    }
    
    this.thinkContent = newContent;
    
    // 检查是否完成，undefined 视为完成
    this.isComplete = this.data.isComplete === true || this.data.isComplete === undefined;
    
    // 如果正在思考中，默认展开
    if (!this.isComplete) {
      this.isExpanded = true;
    }
  }

  /**
   * 视图更新后检查是否需要滚动
   */
  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom && this.thinkContentElement?.nativeElement) {
      this.scrollToBottom();
      this.shouldScrollToBottom = false;
    }
  }

  /**
   * 滚动内容到底部
   */
  private scrollToBottom(): void {
    const element = this.thinkContentElement?.nativeElement;
    if (!element) {
      return;
    }

    // 检查内容是否超过最大高度
    const maxHeight = 200; // 与 CSS 中的 max-height 一致
    const scrollHeight = element.scrollHeight;
    const clientHeight = element.clientHeight;

    // 如果内容高度超过可视区域，滚动到底部
    if (scrollHeight > clientHeight) {
      // 使用 setTimeout 确保 DOM 更新完成后再滚动
      setTimeout(() => {
        element.scrollTop = element.scrollHeight;
      }, 0);
    }
  }

  /**
   * 切换展开/折叠状态
   */
  toggleExpand(): void {
    this.isExpanded = !this.isExpanded;
  }

  /**
   * 获取标题文本
   */
  getTitle(): string {
    return this.isComplete ? ' Think' : ' Thinking...';
  }
}
