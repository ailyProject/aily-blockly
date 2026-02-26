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
import { CommonModule } from '@angular/common';

@Component({
  selector: 'x-aily-mermaid-viewer',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ac-mermaid">
      @if (!diagramReady && !renderError) {
        <div class="ac-mermaid-pending">
          <i class="fa-light fa-spinner-third ac-spin"></i>
          <span>{{ streamStatus === 'loading' ? '正在生成图表…' : '正在渲染图表…' }}</span>
        </div>
      }
      <div class="ac-mermaid-svg" #diagramContainer [style.display]="diagramReady ? '' : 'none'"></div>
      @if (renderError) { <div class="ac-mermaid-err">{{ renderError }}</div> }
    </div>
  `,
  styles: [`
    .ac-mermaid {
      border-radius: 5px; margin: 4px 0; overflow: auto;
      background-color: #3a3a3a; max-height: 500px;
    }
    .ac-mermaid:hover { background-color: #3f3f3f; }
    .ac-mermaid-pending {
      display: flex; align-items: center; justify-content: center;
      gap: 12px; padding: 24px 16px; min-height: 120px;
      color: #888; font-size: 13px;
    }
    .ac-mermaid-svg {
      text-align: center; overflow-x: auto; padding: 16px;
    }
    .ac-mermaid-svg ::ng-deep svg { max-width: 100%; height: auto; background: transparent !important; }
    .ac-mermaid-svg ::ng-deep .label-container { fill: #333 !important; }
    .ac-mermaid-err {
      padding: 16px; display: flex; align-items: center; gap: 8px;
      color: #999; font-size: 13px;
    }
    @keyframes ac-spin { to { transform: rotate(360deg); } }
    .ac-spin { animation: ac-spin 0.8s linear infinite; display: inline-block; }
  `],
})
export class XAilyMermaidViewerComponent implements OnChanges, OnDestroy {
  @Input() data: { code?: string } | null = null;
  @Input() streamStatus: string = 'done';
  @Input() mermaidInstance: any = null;

  @ViewChild('diagramContainer') diagramContainer?: ElementRef<HTMLElement>;

  diagramReady = false;
  renderError = '';
  private renderedSource = '';
  private rendering = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private static idCtr = 0;

  constructor(
    private cdr: ChangeDetectorRef,
    private hostRef: ElementRef<HTMLElement>,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['streamStatus'] && this.streamStatus === 'loading') {
      this.diagramReady = false;
      this.renderedSource = '';
    }
    if (this.streamStatus !== 'done') return;

    const source = this.data?.code?.trim() || '';
    if (source && source !== this.renderedSource) {
      this.scheduleMermaid(source);
    }
  }

  ngOnDestroy(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
  }

  private scheduleMermaid(src: string): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.doMermaid(src), 60);
  }

  private async doMermaid(src: string): Promise<void> {
    const api = this.mermaidInstance;
    if (!api || this.rendering) return;
    this.rendering = true;
    this.renderError = '';

    try {
      const id = `aily-mermaid-${++XAilyMermaidViewerComponent.idCtr}`;
      const off = document.createElement('div');
      off.style.cssText = 'position:fixed;left:-9999px;top:-9999px;visibility:hidden;z-index:-1';
      document.body.appendChild(off);

      let svg: string;
      try {
        ({ svg } = await api.render(id, src, off));
      } finally {
        off.remove();
        document.getElementById(id)?.remove();
      }

      this.renderedSource = src;
      if (!this.diagramContainer) this.cdr.detectChanges();
      if (this.diagramContainer) {
        this.withScrollGuard(() => {
          this.diagramContainer!.nativeElement.innerHTML = svg;
          this.diagramReady = true;
          this.cdr.detectChanges();
        });
      }
    } catch (e: any) {
      this.renderError = `图表渲染失败：${e?.message || e}`;
      this.cdr.detectChanges();
    } finally {
      this.rendering = false;
    }
  }

  private withScrollGuard(fn: () => void): void {
    const snap: Array<[Element, number, number]> = [];
    let el: Element | null = this.hostRef.nativeElement;
    while (el) {
      if (el.scrollTop !== 0 || el.scrollLeft !== 0) snap.push([el, el.scrollTop, el.scrollLeft]);
      el = el.parentElement;
    }
    fn();
    for (const [e, t, l] of snap) { e.scrollTop = t; e.scrollLeft = l; }
  }
}
