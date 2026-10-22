import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, Input, OnChanges, OnDestroy, ViewChild, inject } from '@angular/core';
import { CODER_BROWSER_EMBED_CONFIGURATION } from './coder-browser-embed.providers';
import { openCoderBrowserDocument } from './coder-browser-document';
import { BrowserProjectDocumentService } from '../project/browser-project-document.service';

/** A presentation of the application-owned document. UI visibility/destruction
 * never closes the selected project or establishes a second connection. */
@Component({
  selector: 'app-browser-project-view',
  standalone: true,
  template: '<div #anchor class="project-anchor" aria-label="Aily Coder"></div><div role="status">{{ status }}</div>',
  styles: [':host{display:flex;position:relative;flex-direction:column;min-height:0;height:100%}.project-anchor{flex:1;min-height:0}[role=status]:empty{display:none}'],
})
export class BrowserProjectViewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() active = true;
  @ViewChild('anchor', { static: true }) private anchor!: ElementRef<HTMLElement>;
  private readonly configuration = inject(CODER_BROWSER_EMBED_CONFIGURATION);
  private readonly documents = inject(BrowserProjectDocumentService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private view: { setVisible(visible: boolean): void; detach(): void } | null = null;
  private destroyed = false;
  status = this.configuration ? 'Editor loading' : 'Trusted Browser editor deployment is not configured.';

  ngAfterViewInit(): void {
    if (!this.configuration) return;
    try {
      const original = openCoderBrowserDocument({ documents: this.documents, configuration: this.configuration });
      this.view = original.host.attachView(this.anchor.nativeElement, this.active);
      void original.host.ready.then(() => this.setStatus(''), error => this.setStatus(error instanceof Error ? error.message : String(error)));
    } catch (error) {
      // Preserve Angular's checked initial value during the view-init hook.
      queueMicrotask(() => this.setStatus(error instanceof Error ? error.message : String(error)));
    }
  }

  ngOnChanges(): void { this.view?.setVisible(this.active); }
  ngOnDestroy(): void { this.destroyed = true; this.view?.detach(); this.view = null; }
  private setStatus(status: string): void {
    if (this.destroyed) return;
    this.status = status; this.changeDetector.markForCheck();
  }
}
