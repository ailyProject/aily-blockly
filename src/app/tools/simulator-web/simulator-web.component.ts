import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnDestroy, ViewChild, inject } from '@angular/core';
import { SimulatorWebProductService } from '../../integrations/simulator/simulator-web-product.service';
import { SIMULATOR_WEB_PRODUCT_SOURCE } from '../../integrations/simulator/simulator-web-product.providers';
import { ChildAppHostRegistryService } from '../../services/integrations/subapps/child-app-host-registry.service';
import { registerWebToolLifecycle } from '../child-tool-presentation/web-tool-lifecycle';
import { SimulatorStartupStatusComponent, type SimulatorStartupPhase } from './simulator-startup-status.component';

@Component({
  selector: 'app-simulator-web',
  standalone: true,
  imports: [SimulatorStartupStatusComponent],
  template: `
    @if (phase) { <app-simulator-startup-status [phase]="phase" [message]="status" [inline]="true" /> }
    <div #controls></div><div #surface class="simulator-surface"></div>
  `,
  host: { '[attr.aria-busy]': "phase === 'project' || phase === 'view' ? 'true' : 'false'" },
  styles: [':host { position: relative; display: flex; flex-direction: column; min-height: 0; height: 100%; } .simulator-surface { flex: 1; min-height: 0; }'],
})
export class SimulatorWebComponent implements AfterViewInit, OnDestroy {
  @Input() toolId = 'simulator';
  @ViewChild('controls', { static: true }) private controls!: ElementRef<HTMLElement>;
  @ViewChild('surface', { static: true }) private surface!: ElementRef<HTMLElement>;
  private readonly product = new SimulatorWebProductService(inject(SIMULATOR_WEB_PRODUCT_SOURCE));
  private readonly registry = inject(ChildAppHostRegistryService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private lifecycle: ReturnType<typeof registerWebToolLifecycle> | null = null;
  phase: SimulatorStartupPhase | null = 'project';
  status = '';
  shellVisible = false;
  private destroyed = false;
  private closing = false;

  ngAfterViewInit(): void {
    this.lifecycle = registerWebToolLifecycle(this.registry, {
      toolId: this.toolId, instanceId: crypto.randomUUID(),
    }, {
      // Only the presentation observes close here. The original product still
      // owns the operation, Agent route and all cleanup/retry responsibility.
      close: () => this.closeProduct(),
      snapshot: () => this.product.snapshot(),
      agentRequest: this.product.agentRequest.bind(this.product),
    });
    void this.product.mount({ window, document, controls: this.controls.nativeElement, container: this.surface.nativeElement }, () => {
      if (!this.destroyed && !this.closing && !this.shellVisible) {
        this.shellVisible = true;
        // The original asynchronous document callback can arrive outside the
        // next application check. Flush only this live view; admission and its
        // busy phase continue to follow their original promises.
        this.changeDetector.detectChanges();
      }
    })
      .then(() => {
        if (this.destroyed || this.closing) return;
        this.phase = 'view'; this.changeDetector.markForCheck();
        return this.product.present();
      })
      .then(() => {
        if (!this.destroyed && !this.closing) { this.phase = null; this.changeDetector.markForCheck(); }
      }, error => {
        if (!this.destroyed && !this.closing) {
          this.phase = 'error';
          this.status = error?.code === 'web-product-unavailable'
            ? '仿真器配置尚不可用，请关闭后重试。' : '仿真器启动未完成，请关闭后重试。';
          this.changeDetector.markForCheck();
        }
        void this.lifecycle!.close().then(result => {
          if (!this.destroyed && result['ok'] !== true) this.showCleanupFailure();
        });
      });
  }

  private closeProduct(): Promise<void> {
    this.closing = true;
    if (this.phase !== 'error') this.phase = null;
    if (!this.destroyed) this.changeDetector.markForCheck();
    return this.product.close().catch(error => {
      if (!this.destroyed) this.showCleanupFailure();
      throw error;
    });
  }

  private showCleanupFailure(): void {
    this.phase = 'error'; this.status = '仿真器清理尚未确认，请重试关闭。';
    this.changeDetector.markForCheck();
  }

  ngOnDestroy(): void {
    this.destroyed = true; this.phase = null;
    // Keep an unconfirmed original close registered for an explicit retry.
    if (this.lifecycle) void this.lifecycle.close();
  }
}
