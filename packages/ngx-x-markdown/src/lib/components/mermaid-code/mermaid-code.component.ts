import {
  Component,
  Input,
  ElementRef,
  ViewChild,
  OnChanges,
  SimpleChanges,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';

/**
 * Mermaid 感知的 Code 组件。
 *
 * 用法：通过 `[components]="{ code: MermaidCodeComponent }"` 注册到 `<x-markdown>`。
 *
 * 行为：
 * - **非 mermaid 代码块**：正常渲染 `<code>` / `<pre><code>`
 * - **mermaid + streamStatus === 'loading'**：显示"正在生成图表…"占位符
 * - **mermaid + streamStatus === 'done'**：一次性调用 mermaid.render() 渲染 SVG
 *
 * 需要在模块初始化时调用 `MermaidCodeComponent.setMermaidInstance(mermaid)` 传入 mermaid 实例。
 */
@Component({
  selector: 'ngx-mermaid-code',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isMermaid) {
      <!-- 占位符：图表渲染完成前一直显示 -->
      <div class="x-mermaid-placeholder" [style.display]="diagramReady ? 'none' : ''">
        <div class="x-mermaid-placeholder-spinner"></div>
        <span class="x-mermaid-placeholder-text">{{ placeholderText }}</span>
      </div>
      <!-- SVG 容器：始终在 DOM 中（供 ViewChild），渲染完成后切换显示 -->
      <div class="x-mermaid-diagram" #diagramContainer [style.display]="diagramReady ? '' : 'none'"></div>
      @if (renderError) {
        <div class="x-mermaid-error">{{ renderError }}</div>
      }
    }

    <!-- 非 mermaid：正常代码渲染 -->
    @if (!isMermaid) {
      @if (block) {
        <pre><code [class]="langClass" [innerHTML]="children"></code></pre>
      } @else {
        <code [innerHTML]="children"></code>
      }
    }
  `,
  styles: [`
    :host {
      display: block;
    }

    .x-mermaid-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 32px 16px;
      border: 1px dashed #d9d9d9;
      border-radius: 8px;
      background: #fafafa;
      color: #8c8c8c;
      font-size: 14px;
      min-height: 120px;
    }

    .x-mermaid-placeholder-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid #d9d9d9;
      border-top-color: #1677ff;
      border-radius: 50%;
      animation: x-mermaid-spin 0.8s linear infinite;
    }

    @keyframes x-mermaid-spin {
      to { transform: rotate(360deg); }
    }

    .x-mermaid-diagram {
      text-align: center;
      overflow-x: auto;
    }

    .x-mermaid-diagram :host ::ng-deep svg {
      max-width: 100%;
      height: auto;
    }

    .x-mermaid-error {
      padding: 12px 16px;
      border: 1px solid #ff4d4f;
      border-radius: 8px;
      background: #fff2f0;
      color: #ff4d4f;
      font-size: 13px;
    }
  `],
})
export class MermaidCodeComponent implements OnChanges, OnDestroy {
  // ===================== Inputs (由 x-markdown 动态注入) =====================

  /** 代码块的文本内容 */
  @Input() children: string = '';

  /** 是否为块级代码（true = <pre><code>） */
  @Input() block: boolean = false;

  /** 语言标识（如 'mermaid', 'javascript' 等） */
  @Input() lang: string = '';

  /** 流式状态：'loading' | 'done' */
  @Input() streamStatus: string = 'done';

  /** 占位符文字，可自定义 */
  @Input() placeholderText: string = '正在生成图表…';

  // ===================== View =====================

  @ViewChild('diagramContainer') diagramContainer?: ElementRef<HTMLElement>;

  // ===================== Internal State =====================

  /** 是否为 mermaid 代码块 */
  get isMermaid(): boolean {
    return this.block && this.lang === 'mermaid';
  }

  /** 语言 CSS 类名 */
  get langClass(): string {
    return this.lang ? `language-${this.lang}` : '';
  }

  /** 渲染错误信息 */
  renderError: string = '';

  /** 图表 SVG 是否已渲染就绪（控制占位符 ↔ 图表显示切换） */
  diagramReady: boolean = false;

  /** 已渲染的 mermaid 源码（防止重复渲染） */
  private renderedSource: string = '';

  /** 是否正在渲染 */
  private rendering = false;

  /** 渲染定时器 */
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  // ===================== 静态 mermaid 实例 =====================

  private static mermaidInstance: any = null;
  private static mermaidInitialized = false;
  private static idCounter = 0;

  /**
   * 设置 mermaid 实例。在应用启动时调用一次即可。
   *
   * @example
   * ```typescript
   * import mermaid from 'mermaid';
   * MermaidCodeComponent.setMermaidInstance(mermaid, { theme: 'default' });
   * ```
   */
  static setMermaidInstance(instance: any, config?: Record<string, any>): void {
    MermaidCodeComponent.mermaidInstance = instance;
    if (instance) {
      instance.initialize({
        startOnLoad: false,
        ...config,
      });
      MermaidCodeComponent.mermaidInitialized = true;
    }
  }

  constructor(
    private cdr: ChangeDetectorRef,
    private hostRef: ElementRef<HTMLElement>,
  ) {}

  // ===================== Lifecycle =====================

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.isMermaid) return;

    // 当 streamStatus 回到 loading（组件被复用），重置渲染状态
    if (changes['streamStatus'] && this.streamStatus === 'loading') {
      this.diagramReady = false;
      this.renderedSource = '';
    }

    // 当 streamStatus 为 done 且内容有变化，触发渲染
    if (this.streamStatus === 'done') {
      const source = this.stripHtmlEntities(this.children).trim();
      if (source && source !== this.renderedSource) {
        this.scheduleRender(source);
      }
    }
  }

  ngOnDestroy(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  // ===================== Mermaid Rendering =====================

  /**
   * 防抖调度渲染（50ms），避免快速连续更新
   */
  private scheduleRender(source: string): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
    }
    this.renderTimer = setTimeout(() => {
      this.doRender(source);
    }, 50);
  }

  /**
   * 真正执行 mermaid.render()，生成 SVG 并插入 DOM。
   *
   * 滚动保护策略：
   * - mermaid.render() 使用 offscreen 容器，避免在 body 上创建临时 DOM 影响滚动
   * - 所有同步 DOM 变更（innerHTML、detectChanges）用 withScrollProtection 包裹
   * - 使用 detectChanges() 替代 markForCheck()，确保 CD 同步完成
   */
  private async doRender(source: string): Promise<void> {
    const mermaidApi = MermaidCodeComponent.mermaidInstance;
    if (!mermaidApi) {
      this.renderError = 'Mermaid 实例未设置。请调用 MermaidCodeComponent.setMermaidInstance(mermaid)。';
      this.cdr.detectChanges();
      return;
    }

    if (this.rendering) return;
    this.rendering = true;
    this.renderError = '';

    try {
      const id = `x-mermaid-${++MermaidCodeComponent.idCounter}`;

      // 使用 offscreen 容器渲染，避免 mermaid 在 body 上创建临时 DOM 影响滚动
      const offscreen = document.createElement('div');
      offscreen.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;z-index:-1';
      document.body.appendChild(offscreen);

      let svg: string;
      try {
        const result = await mermaidApi.render(id, source, offscreen);
        svg = result.svg;
      } finally {
        offscreen.remove();
        document.getElementById(id)?.remove();
      }

      this.renderedSource = source;

      // 确保 diagramContainer ViewChild 可用
      if (!this.diagramContainer) {
        this.cdr.detectChanges();
      }

      // 在 scroll 保护中一步完成：插入 SVG → 标记就绪 → 同步更新模板
      // placeholder 隐藏 + diagram 显示在同一同步块内，scrollTop 差由 withScrollProtection 补偿
      if (this.diagramContainer) {
        this.withScrollProtection(() => {
          this.diagramContainer!.nativeElement.innerHTML = svg;
          this.diagramReady = true;
          this.cdr.detectChanges();
        });
      }
    } catch (e: any) {
      this.renderError = `图表渲染失败：${e?.message || e}`;
      console.warn('[MermaidCodeComponent] Render error:', e);
      this.cdr.detectChanges();
    } finally {
      this.rendering = false;
    }
  }

  // ===================== Scroll Preservation =====================

  /**
   * 在回调执行前后保存/恢复所有可滚动祖先的滚动位置。
   * 回调必须是同步的，这样 snapshot 不会过期。
   */
  private withScrollProtection(fn: () => void): void {
    const snap = this.captureScrollableAncestors();
    fn();
    this.restoreScrollableAncestors(snap);
  }

  /**
   * 遍历祖先链，记录所有有滚动偏移的元素
   */
  private captureScrollableAncestors(): Array<[Element, number, number]> {
    const positions: Array<[Element, number, number]> = [];
    let el: Element | null = this.hostRef.nativeElement;
    while (el) {
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
        positions.push([el, el.scrollTop, el.scrollLeft]);
      }
      el = el.parentElement;
    }
    return positions;
  }

  private restoreScrollableAncestors(snapshot: Array<[Element, number, number]>): void {
    for (const [el, top, left] of snapshot) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }

  // ===================== Util =====================

  /**
   * 解码 HTML 实体（parser 输出的 code 内容可能被转义）
   */
  private stripHtmlEntities(html: string): string {
    if (typeof document === 'undefined') return html;
    const el = document.createElement('textarea');
    el.innerHTML = html;
    return el.value;
  }
}
