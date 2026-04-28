import { Component, Input, OnInit, HostBinding, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface AilyContextData {
  type: 'aily-context';
  /** 折叠时显示的标签，如 "blockly:20-38" */
  label?: string;
  /** 完整的上下文内容（可能经 base64 编码） */
  content?: string;
  /** 是否 base64 编码 */
  encoded?: boolean;
}

@Component({
  selector: 'app-aily-context-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-context-viewer.component.html',
  styleUrls: ['./aily-context-viewer.component.scss']
})
export class AilyContextViewerComponent implements OnInit {
  @Input() data: AilyContextData | null = null;

  @HostBinding('class.expanded')
  isExpanded = false;

  label = '';
  contextContent = '';

  constructor(private elementRef: ElementRef) {}

  ngOnInit() {
    this.processData();
  }

  /**
   * 设置组件数据（由指令调用）
   */
  setData(data: AilyContextData | string): void {
    if (typeof data === 'string') {
      try {
        this.data = JSON.parse(data);
      } catch {
        this.data = { type: 'aily-context', content: data };
      }
    } else {
      this.data = data;
    }
    this.processData();
  }

  processData(): void {
    if (!this.data) return;

    this.label = this.data.label || '上下文';

    let content = this.data.content || '';
    if (this.data.encoded && content) {
      try {
        content = decodeURIComponent(atob(content));
      } catch {
        // 解码失败，使用原始内容
      }
    }
    this.contextContent = content;
  }

  toggleExpand(): void {
    this.isExpanded = !this.isExpanded;
  }
}
