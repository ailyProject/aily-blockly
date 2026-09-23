import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, ViewChild } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';
import { ThemeService } from '@core/preferences/public-api';

const CHANNEL = 'aily-native-observer-v1';

/** Transport only. Rendering stays in the installed Subapp; this component
 * neither acquires a Runtime nor exposes host APIs to the sandboxed iframe. */
@Component({
  selector: 'app-child-tool-native-observer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (html) {
      <iframe #frame sandbox="allow-scripts" [srcdoc]="html" [title]="toolId + ' observer'" (load)="sendSnapshot()"></iframe>
    }
    @if (error) { <p role="alert">{{ error }}</p> }
  `,
  styles: [`:host { display:block; width:100%; height:100%; min-height:260px; }
    iframe { width:100%; height:100%; min-height:260px; border:0; display:block; }
    p { padding:12px; overflow-wrap:anywhere; }`],
})
export class ChildToolNativeObserverComponent implements OnChanges, OnDestroy {
  @Input() toolId = '';
  @Input() sessionId = '';
  @Input() compact = false;
  @Output() readonly ready = new EventEmitter<void>();
  @Output() readonly failed = new EventEmitter<string>();
  @ViewChild('frame') frame?: ElementRef<HTMLIFrameElement>;
  html: SafeHtml | null = null;
  error = '';
  private snapshot: any;
  private generation = 0;
  private readSequence = 0;
  private unsubscribe?: () => void;
  private readonly contextSubscriptions = new Subscription();
  private get api(): any { return (window as any).electronAPI?.childToolSession; }

  constructor(private readonly sanitizer: DomSanitizer, private readonly zone: NgZone,
    private readonly themeService: ThemeService, private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef) {
    window.addEventListener('message', this.onMessage);
    this.contextSubscriptions.add(themeService.themeChanged$.subscribe(() => this.sendSnapshot()));
    this.contextSubscriptions.add(translate.onLangChange.subscribe(() => this.sendSnapshot()));
  }

  ngOnChanges(): void { void this.load(); }
  ngOnDestroy(): void {
    this.generation++; this.unsubscribe?.();
    this.contextSubscriptions.unsubscribe();
    window.removeEventListener('message', this.onMessage);
  }
  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.html = null; this.snapshot = undefined; this.error = '';
    try {
      if (!this.api?.observeNative) throw new Error('Update/restart the host to display native observers.');
      this.unsubscribe = this.api.onNativeObserverChanged(() => { void this.refresh(generation); });
      const result = await this.request('document');
      if (generation !== this.generation) return;
      if (!result.ok || !result.html) throw new Error(result.error || result.errorCode || 'Observer unavailable');
      this.zone.run(() => {
        this.snapshot = result.snapshot;
        this.html = this.sanitizer.bypassSecurityTrustHtml(result.html);
        this.cdr.markForCheck(); // The Dock's OnPush parent must see async asset arrival before tool completion.
      });
      await this.refresh(generation); // Covers progress racing the document load.
    } catch (error) {
      if (generation === this.generation) this.zone.run(() => {
        this.error = String((error as Error).message || error); this.cdr.markForCheck();
        this.failed.emit(this.error);
      });
    }
  }
  private async refresh(generation: number): Promise<void> {
    const sequence = ++this.readSequence;
    try {
      const result = await this.request('snapshot');
      if (generation !== this.generation || sequence !== this.readSequence || !result.ok) return;
      this.snapshot = result.snapshot; this.sendSnapshot();
    } catch { /* A disappearing host does not authorize replay or execution. */ }
  }
  sendSnapshot(): void {
    if (this.snapshot) this.post({ type: 'snapshot', snapshot: this.snapshot, compact: this.compact,
      context: { theme: this.themeService.theme(), language: this.translate.currentLang || this.translate.defaultLang || 'en' } });
  }
  private request(action: string, fields: Record<string, unknown> = {}): Promise<any> {
    return this.api.observeNative({ action, toolId: this.toolId, sessionId: this.sessionId, ...fields });
  }
  private post(data: Record<string, unknown>): void {
    // The destination is opaque; exact contentWindow matching authenticates replies.
    this.frame?.nativeElement.contentWindow?.postMessage({ channel: CHANNEL, ...data }, '*');
  }
  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.frame?.nativeElement.contentWindow || event.origin !== 'null' || event.data?.channel !== CHANNEL) return;
    if (event.data.type === 'ready') {
      this.sendSnapshot(); this.zone.run(() => this.ready.emit());
    } else if (event.data.type === 'stop' && typeof event.data.runId === 'string' && Number.isSafeInteger(event.data.id)) {
      const { runId, id } = event.data, generation = this.generation;
      if (runId !== this.snapshot?.runId) return;
      void this.request('stop', { runId }).then(result => {
        if (generation === this.generation) this.post({ type: 'stop-result', id, result });
      }).catch(() => { if (generation === this.generation) this.post({ type: 'stop-result', id, result: { ok: false } }); });
    }
  };
}
