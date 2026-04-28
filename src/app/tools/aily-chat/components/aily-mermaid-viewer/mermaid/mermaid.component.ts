import { Component, Inject, OnInit, OnDestroy, AfterViewInit, ElementRef, ViewChild, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';

export interface MermaidModalData {
  svg?: string;
  rawCode?: string;
}

@Component({
  selector: 'app-mermaid',
  standalone: true,
  imports: [CommonModule, NzButtonModule, NzIconModule],
  templateUrl: './mermaid.component.html',
  styleUrl: './mermaid.component.scss'
})
export class MermaidComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('svgContainer') svgContainer!: ElementRef<HTMLElement>;
  @ViewChild('svgContainer', { read: ElementRef }) private svgContainerRef!: ElementRef;
  renderedSvg: SafeHtml = '';
  private rafId = 0;
  private contentEl: HTMLElement | null = null;
  
  // 缩放和拖拽相关属性
  scale = 1;
  translateX = 0;
  translateY = 0;
  
  // 拖拽状态
  isDragging = false;
  dragStartX = 0;
  dragStartY = 0;
  lastTranslateX = 0;
  lastTranslateY = 0;
  /** 是否发生了拖拽（用于区分点击与拖拽，点击时关闭弹窗） */
  hasDragged = false;
  
  // 缩放参数
  readonly MIN_SCALE = 0.1;
  readonly MAX_SCALE = 5;
  readonly SCALE_STEP = 0.1;
  
  constructor(
    private modal: NzModalRef,
    private sanitizer: DomSanitizer,
    private ngZone: NgZone,
    @Inject(NZ_MODAL_DATA) public data: MermaidModalData
  ) {}

  ngOnInit(): void {
    if (this.data?.svg) {
      this.renderedSvg = this.sanitizer.bypassSecurityTrustHtml(this.data.svg);
    }
  }

  ngAfterViewInit(): void {
    this.contentEl = this.svgContainer?.nativeElement?.parentElement;
    this.injectHitRect();
  }

  /** 在根 g 内注入透明 rect，使点击 svg>g 区域时 target 为 g/rect 而非 svg */
  private injectHitRect(): void {
    setTimeout(() => {
      const container = this.svgContainer?.nativeElement;
      const svg = container?.querySelector?.('svg');
      if (!svg) return;
      const rootG = Array.from(svg.children).find((el) => el.tagName?.toLowerCase() === 'g') as SVGGElement | undefined;
      if (!rootG || rootG.tagName?.toLowerCase() !== 'g') return;
      const vb = (svg.getAttribute('viewBox') || '0 0 800 600').split(/\s+/);
      const w = vb[2] || '800';
      const h = vb[3] || '600';
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '0');
      rect.setAttribute('y', '0');
      rect.setAttribute('width', w);
      rect.setAttribute('height', h);
      rect.setAttribute('fill', 'black');
      rect.setAttribute('fill-opacity', '0.001');
      rect.style.pointerEvents = 'all';
      rootG.insertBefore(rect, rootG.firstChild);
    });
  }

  ngOnDestroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
    document.body.style.userSelect = '';
  }

  // 鼠标滚轮缩放
  onWheel(event: WheelEvent): void {
    event.preventDefault();
    
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    
    const delta = event.deltaY > 0 ? -this.SCALE_STEP : this.SCALE_STEP;
    const newScale = Math.max(this.MIN_SCALE, Math.min(this.MAX_SCALE, this.scale + delta));
    
    if (newScale !== this.scale) {
      // 以鼠标位置为中心缩放
      const scaleRatio = newScale / this.scale;
      this.translateX = mouseX - (mouseX - this.translateX) * scaleRatio;
      this.translateY = mouseY - (mouseY - this.translateY) * scaleRatio;
      this.scale = newScale;
    }
  }

  // 鼠标按下开始拖拽
  onMouseDown(event: MouseEvent): void {
    if (event.button === 0) { // 左键
      this.hasDragged = false;
      this.isDragging = true;
      this.dragStartX = event.clientX;
      this.dragStartY = event.clientY;
      this.lastTranslateX = this.translateX;
      this.lastTranslateY = this.translateY;
      
      // 拖拽期间禁用 CSS transition
      if (this.contentEl) this.contentEl.style.transition = 'none';
      
      // 防止文本选择
      event.preventDefault();
      document.body.style.userSelect = 'none';
      
      // 在 Angular zone 外添加全局鼠标事件监听，避免每次 mousemove 触发变更检测
      this.ngZone.runOutsideAngular(() => {
        document.addEventListener('mousemove', this.onDocumentMouseMove);
        document.addEventListener('mouseup', this.onDocumentMouseUp);
      });
    }
  }

  // 全局鼠标移动事件（运行在 Angular zone 外）
  onDocumentMouseMove = (event: MouseEvent): void => {
    if (!this.isDragging) return;
    const deltaX = event.clientX - this.dragStartX;
    const deltaY = event.clientY - this.dragStartY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
      this.hasDragged = true;
    }
    this.translateX = this.lastTranslateX + deltaX;
    this.translateY = this.lastTranslateY + deltaY;
    // 用 rAF 合并渲染，直接操作 DOM 跳过 Angular 变更检测
    if (!this.rafId) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        if (this.contentEl) {
          this.contentEl.style.transform = `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
        }
      });
    }
  }

  // 全局鼠标松开事件
  onDocumentMouseUp = (_event: MouseEvent): void => {
    this.isDragging = false;
    document.body.style.userSelect = '';
    
    // 恢复 CSS transition
    if (this.contentEl) this.contentEl.style.transition = '';
    
    // 移除全局事件监听
    document.removeEventListener('mousemove', this.onDocumentMouseMove);
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
    
    // 回到 Angular zone 同步状态，触发一次变更检测
    this.ngZone.run(() => {});
  }

  // 获取变换样式
  getTransform(): string {
    return `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
  }

  async saveSvg(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!this.data?.svg) return;

    const filePath = await window['ipcRenderer'].invoke('select-folder-saveAs', {
      suggestedName: 'mermaid_diagram.svg',
      title: '保存 SVG',
      filters: [
        { name: 'SVG 文件', extensions: ['svg'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });

    if (!filePath) return;
    window['fs'].writeFileSync(filePath, this.cleanSvgForSave(this.data.svg));
  }

  /** 通过 DOM 解析清理 SVG 中的重复属性（如重复 id），并移除仅用于显示的属性 */
  private cleanSvgForSave(svg: string): string {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = svg;
    const svgEl = wrapper.querySelector('svg');
    if (!svgEl) return svg;
    svgEl.removeAttribute('data-mermaid-svg');
    return new XMLSerializer().serializeToString(svgEl);
  }

  close(): void {
    this.modal.close();
  }

  /** 点击 svg 根关闭弹窗；点击 svg>g 等子元素时阻止关闭 */
  onContainerClick(event: MouseEvent): void {
    if (this.hasDragged) return;
    const target = event.target as Element;
    const isSvgRoot = target?.tagName?.toLowerCase() === 'svg';
    if (isSvgRoot) {
      this.close();
      return;
    }
    const inSvg = target?.closest?.('svg');
    if (inSvg) return; // 点击 svg 内部子元素（g、rect、path 等）不关闭
    this.close(); // 点击容器空白关闭
  }
}
