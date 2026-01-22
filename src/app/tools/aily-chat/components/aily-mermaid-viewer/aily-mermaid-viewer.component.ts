import { Component, Input, OnInit, OnDestroy, OnChanges, SimpleChanges, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import mermaid from 'mermaid';
import { NzModalService } from 'ng-zorro-antd/modal';
import { MermaidComponent } from '../../../../app-store/mermaid/mermaid.component';

export interface AilyMermaidData {
  type: 'aily-mermaid';
  code?: string;
  content?: string;
  raw?: string;
  metadata?: any;
}

/**
 * Aily Mermaid 查看器组件
 * 用于渲染 Mermaid 图表
 */
@Component({
  selector: 'app-aily-mermaid-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './aily-mermaid-viewer.component.html',
  styleUrls: ['./aily-mermaid-viewer.component.scss']
})
export class AilyMermaidViewerComponent implements OnInit, OnDestroy, OnChanges {
  @Input() data: AilyMermaidData | null = null;

  errorMessage = '';
  isLoading = true;  // 默认为 true，等待数据
  rawCode = '';
  renderedSvg: SafeHtml = '';
  rawSvgString = '';
  containerId = '';
  
  // 渲染重试相关
  private renderRetryCount = 0;
  private readonly MAX_RETRY = 3;
  private retryTimer: any = null;

  // 全屏相关属性
  isFullscreen = false;
  fullscreenContainerId = '';

  // 缩放和拖拽相关属性
  scale = 1;
  translateX = 0;
  translateY = 0;
  isDragging = false;
  lastMouseX = 0;
  lastMouseY = 0;

  // 计算transform样式
  get transform(): string {
    return `translate(calc(-50% + ${this.translateX}px), calc(-50% + ${this.translateY}px)) scale(${this.scale})`;
  }

  constructor(
    private sanitizer: DomSanitizer,
    private modal: NzModalService
  ) { }

  ngOnInit() {
    this.initializeMermaid();
    this.processData();
  }

  ngOnDestroy() {
    // 清理资源
    if (this.isFullscreen) {
      document.body.style.overflow = '';
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['data']) {
      this.processData();
    }
  }

  /**
   * 设置组件数据（由指令调用）
   */
  setData(data: AilyMermaidData): void {
    this.data = data;
    this.processData();
  }

  /**
   * 初始化 Mermaid
   */
  private initializeMermaid(): void {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      fontFamily: 'MiSans, sans-serif',
      htmlLabels: true,
      deterministicIds: false,
      deterministicIDSeed: undefined,
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis',
        padding: 20
      },
      sequence: {
        diagramMarginX: 50,
        diagramMarginY: 10,
        actorMargin: 50,
        width: 150,
        height: 65,
        boxMargin: 10,
        boxTextMargin: 5,
        noteMargin: 10,
        messageMargin: 35,
        mirrorActors: true,
        bottomMarginAdj: 1,
        useMaxWidth: true,
        rightAngles: false,
        showSequenceNumbers: false
      },
      gantt: {
        useMaxWidth: true
      }
    });
  }

  /**
   * 处理数据
   */
  private processData(): void {
    if (!this.data) {
      // 没有数据时保持 loading 状态，等待数据到达
      this.isLoading = true;
      this.errorMessage = '';
      this.renderedSvg = '';
      this.rawSvgString = '';
      return;
    }

    try {
      // 提取 Mermaid 代码
      let code = this.data.code || this.data.content || this.data.raw || '';

      // 如果数据来自原始文本，可能需要解析
      if (this.data.metadata?.isRawText && !code) {
        code = this.data.raw || '';
      }

      this.rawCode = this.preprocessMermaidCode(code.trim());

      if (!this.rawCode) {
        // 代码为空，保持 loading
        this.isLoading = true;
        this.errorMessage = '';
        this.renderedSvg = '';
        this.rawSvgString = '';
        return;
      }

      // 渲染 Mermaid 图表
      this.isLoading = true;
      this.errorMessage = '';
      this.renderMermaidDiagram(this.rawCode);
    } catch (error) {
      console.warn('Error processing mermaid data:', error);
      // 处理失败时尝试重试
      this.scheduleRetry();
    }
  }

  /**
   * 安排重试
   */
  private scheduleRetry(): void {
    if (this.renderRetryCount < this.MAX_RETRY) {
      this.renderRetryCount++;
      // console.log(`[AilyMermaid] 安排重试 ${this.renderRetryCount}/${this.MAX_RETRY}`);
      this.retryTimer = setTimeout(() => {
        this.processData();
      }, 500 * this.renderRetryCount); // 递增延迟
    } else {
      // 超过重试次数，显示错误
      this.isLoading = false;
      this.errorMessage = '图表渲染失败';
    }
  }

  /**
   * 渲染 Mermaid 图表
   */
  private async renderMermaidDiagram(code: string): Promise<void> {
    try {
      this.isLoading = true;
      this.renderedSvg = '';
      this.rawSvgString = '';

      // 生成唯一的图表 ID
      const diagramId = `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      this.containerId = `mermaid-container-${diagramId}`;

      // 验证 Mermaid 代码
      try {
        await mermaid.parse(code);
      } catch (parseError) {
        // 继续尝试渲染，因为有些情况下 parse 可能误报
      }

      const renderResult = await mermaid.render(diagramId, code);

      // 获取 SVG 内容 - 优先使用 svg 属性
      let svg: string;
      if (typeof renderResult === 'object' && renderResult.svg) {
        svg = renderResult.svg;
      } else if (typeof renderResult === 'string') {
        svg = renderResult;
      } else {
        throw new Error('Invalid render result from Mermaid');
      }

      if (!svg || typeof svg !== 'string') {
        throw new Error('Failed to get SVG from Mermaid render result');
      }

      // 清理和增强 SVG
      const enhancedSvg = this.enhanceSvg(svg, diagramId);
      this.rawSvgString = enhancedSvg;
      this.renderedSvg = this.sanitizer.bypassSecurityTrustHtml(enhancedSvg);
      this.isLoading = false;
      this.errorMessage = '';
      this.renderRetryCount = 0; // 成功后重置重试计数

      // 延迟发送事件，确保 DOM 已渲染
      setTimeout(() => {
        this.notifyMermaidReady(diagramId);
      }, 100);

    } catch (error) {
      console.warn('Mermaid rendering error:', error);
      // 渲染失败时尝试重试，而不是立即显示错误
      this.scheduleRetry();
    }
  }

  /**
   * 增强 SVG 内容
   */
  private enhanceSvg(svg: string, diagramId: string): string {
    return svg
      .replace('<svg', `<svg id="${diagramId}" data-mermaid-svg="true"`)
      .replace(/width="[^"]*"/, 'width="100%"')
      .replace(/height="[^"]*"/, 'height="auto"')
      .replace(/<svg([^>]*)>/, (match, attrs) => {
        return `<svg${attrs} style="max-width: 100%; height: auto; display: block;">`;
      });
  }

  /**
   * 获取错误信息
   */
  private getErrorMessage(error: any): string {
    if (error.message?.includes('Parse error')) {
      return '图表语法错误，请检查代码格式';
    } else if (error.message?.includes('Cannot read properties')) {
      return '图表渲染失败，可能是版本兼容性问题';
    } else if (error.message?.includes('Invalid render result')) {
      return '图表渲染失败，无法获取有效的 SVG 内容';
    }
    return error.message || '图表渲染失败';
  }

  /**
   * 通知 Mermaid 图表已准备就绪
   */
  private notifyMermaidReady(diagramId: string): void {
    try {
      // 发送自定义事件到文档
      const event = new CustomEvent('mermaidDiagramReady', {
        detail: { diagramId },
        bubbles: true
      });
      document.dispatchEvent(event);
    } catch (error) {
      console.warn('Failed to notify mermaid ready:', error);
    }
  }

  logDetail() {
    // console.log('mermaid data:');
    // console.log(this.rawCode);

    // // 检查 DOM 中的 SVG 元素
    // if (this.containerId) {
    //   const container = document.getElementById(this.containerId);
    //   console.log('Container element:', container);
    //   if (container) {
    //     const svg = container.querySelector('svg');
    //     console.log('SVG element:', svg);
    //     console.log('SVG innerHTML length:', svg?.innerHTML?.length || 0);
    //   }
    // }
  }

  /**
   * 进入全屏模式
   */
  enterFullscreen(): void {
    if (!this.rawSvgString) {
      console.warn('No SVG data available for fullscreen display');
      return;
    }

    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzContent: MermaidComponent,
      nzData: {
        svg: this.rawSvgString,
      },
      nzWidth: '500px',
    });
  }


  /**
   * 预处理 Mermaid 代码，处理特殊字符
   */
  private preprocessMermaidCode(code: string): string {
    // 保护文本节点中的括号
    return code
      // 删除包含 "direction TD" 的行
      .replace(/^.*direction\s+TD.*$/gm, '')
      // 处理节点标签中的括号 - 用引号包裹包含括号的文本
      .replace(/(\w+)\s*\[\s*([^\]]*\([^\]]*\)[^\]]*)\s*\]/g, '$1["$2"]')
      // 处理流程图节点中的括号 - 用引号包裹
      .replace(/(\w+)\s*\(\s*([^)]*\([^)]*\)[^)]*)\s*\)/g, '$1("$2")')
      // 处理箭头标签中的括号
      .replace(/-->\s*\|\s*([^|]*\([^|]*\)[^|]*)\s*\|/g, '-->|"$1"|')
      // 处理序列图中的括号
      .replace(/Note\s+(left|right|over)\s+([^:]+):\s*([^\n]*\([^\n]*\)[^\n]*)/g, 'Note $1 $2: "$3"')
      // 处理类图中的方法名括号（这些通常是正常的）
      // 不需要特殊处理，因为类图的方法声明中的括号是语法的一部分
      ;
  }

}
