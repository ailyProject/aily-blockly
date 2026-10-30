import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { ChildToolHostInfo } from '../../services/integrations/subapps/child-tool-process.service';
import { SubappBrowserSurfaceService, type SubappBrowserSurfaceGeometry, type SubappBrowserSurfaceHandle } from '../../services/integrations/subapps/subapp-browser-surface.service';

@Component({
  selector: 'app-child-tool-browser-surface',
  template: '',
  styles: [':host { display: block; position: absolute; inset: 0; }'],
})
export class ChildToolBrowserSurfaceComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() toolId = '';
  @Input() active = true;
  @Input() presentationId = '';
  @Input() workspace: string | null = null;
  @Output() readonly ready = new EventEmitter<ChildToolHostInfo>();
  @Output() readonly failed = new EventEmitter<string>();
  ownerSessionId = '';
  runtimeId = '';
  connectionId = '';
  closeReceipt: Record<string, unknown> | null = null;
  private handle: SubappBrowserSurfaceHandle | null = null;
  private observer?: ResizeObserver;
  private timer?: ReturnType<typeof setTimeout>;
  private initialized = false;
  private destroyed = false;
  private lastGeometry = '';
  private geometryRetries = 0;
  private mountVersion = 0;
  private mounting: Promise<void> = Promise.resolve();
  private readonly schedule = () => {
    if (this.destroyed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.update(); }, 75);
  };

  constructor(private readonly element: ElementRef<HTMLElement>, private readonly surfaces: SubappBrowserSurfaceService) {}

  ngAfterViewInit(): void {
    this.initialized = true;
    this.observer = new ResizeObserver(this.schedule); this.observer.observe(this.element.nativeElement);
    window.addEventListener('resize', this.schedule); window.addEventListener('scroll', this.schedule, true);
    document.addEventListener('visibilitychange', this.schedule);
    void this.mount();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized) return;
    if (changes['toolId'] || changes['workspace'] || changes['presentationId']) void this.mount(); else this.schedule();
  }

  ngOnDestroy(): void {
    this.destroyed = true; clearTimeout(this.timer); this.observer?.disconnect();
    window.removeEventListener('resize', this.schedule); window.removeEventListener('scroll', this.schedule, true);
    document.removeEventListener('visibilitychange', this.schedule);
    void this.close().catch(error => console.warn('[SubappBrowserSurface] Cleanup remains owned', error));
  }

  async close(): Promise<Record<string, unknown>> {
    if (!this.handle) return { released: true };
    this.closeReceipt = await this.handle.close(); return this.closeReceipt;
  }

  private mount(): Promise<void> {
    const version = ++this.mountVersion;
    return this.mounting = this.mounting.then(async () => {
      try {
        if (this.handle) await this.close();
        if (this.destroyed || version !== this.mountVersion) return;
        const handle = this.surfaces.open(this.toolId, this.geometry(), this.presentationId); this.handle = handle;
        this.ownerSessionId = handle.ownerSessionId;
        const result = await handle.ready;
        if (this.destroyed || this.handle !== handle || version !== this.mountVersion) return;
        this.runtimeId = result.runtimeId; this.connectionId = result.connectionId;
        this.ready.emit(result.hostInfo); this.schedule();
      } catch (error) { if (!this.destroyed && version === this.mountVersion) this.failed.emit(this.error(error)); }
    });
  }

  private geometry(): SubappBrowserSurfaceGeometry {
    const rect = this.element.nativeElement.getBoundingClientRect();
    const x = Math.max(0, Math.min(window.innerWidth - 1, Math.floor(rect.left)));
    const y = Math.max(0, Math.min(window.innerHeight - 1, Math.floor(rect.top)));
    const right = Math.min(window.innerWidth, Math.floor(rect.right)), bottom = Math.min(window.innerHeight, Math.floor(rect.bottom));
    return { bounds: { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) },
      visible: this.active && document.visibilityState === 'visible' && right > x && bottom > y && rect.width > 0 && rect.height > 0 };
  }

  private async update(): Promise<void> {
    if (!this.handle || this.destroyed) return;
    const geometry = this.geometry(), identity = JSON.stringify(geometry);
    if (identity === this.lastGeometry) return;
    try { await this.handle.update(geometry); this.lastGeometry = identity; this.geometryRetries = 0; }
    catch (error) {
      if (this.destroyed) return;
      // Main may have resized before Chromium publishes its new CSS viewport.
      // Keep Main's strict bounds check; retry with freshly measured geometry.
      if (this.error(error).includes('Embedded View bounds exceed its owner viewport') && this.geometryRetries++ < 3) {
        this.schedule(); return;
      }
      this.failed.emit(this.error(error));
    }
  }

  private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
