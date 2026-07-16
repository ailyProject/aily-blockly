import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  ChangeDetectionStrategy,
  ElementRef,
  EventEmitter,
  ViewChild,
  ViewContainerRef,
  OnDestroy,
  NgZone,
  Output,
  Type,
  Injector,
  ComponentRef,
  createComponent,
  EnvironmentInjector,
  ApplicationRef,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MarkdownParser } from '../../core/parser';
import { MarkdownRenderer } from '../../core/renderer';
import {
  WordBuffer,
  getParagraphBufferedMarkdown,
} from '../../services/streaming';
import type {
  XMarkdownConfig,
  StreamingOption,
  ComponentMap,
} from '../../interfaces';

/**
 * 宸叉敞鍏ョ殑鍔ㄦ€佺粍浠剁殑杩借釜璁板綍
 * 閫氳繃 fingerprint 鏉ュ垽鏂槸鍚﹀彲浠ュ鐢紝閬垮厤閿€姣?閲嶅缓瀵艰嚧鐨勯棯鐑? */
/** 缁勪欢瑙嗗浘鐨勬寕杞芥柟寮?*/
type AttachMode = 'viewContainer' | 'appRef';

interface InjectedEntry {
  /** 鐢ㄤ簬鍒ゆ柇鏄惁鍙鐢ㄧ殑鎸囩汗锛坱agName + 鍏抽敭灞炴€?+ 鍐呭鎽樿锛?*/
  fingerprint: string;
  /** Angular ComponentRef */
  componentRef: ComponentRef<any>;
  /** 缁勪欢瀹夸富 DOM 鍏冪礌 */
  hostElement: HTMLElement;
  /** 涓婃娉ㄥ叆鏃舵墍鐢ㄧ殑鏍囩鍚?*/
  tagName: string;
  /** 瑙嗗浘鎸傝浇鏂瑰紡锛岀敤浜庨攢姣佹椂姝ｇ‘ detach */
  attachMode?: AttachMode;
}

interface MarkdownRenderTarget {
  element: HTMLElement;
  lastHtml: string;
  revision: number;
}

export interface XMarkdownIncrementalFallbackEvent {
  readonly previousLength: number;
  readonly nextLength: number;
  readonly reason: 'non-append';
}

export interface XMarkdownIncrementalRenderEvent {
  readonly durationMs: number;
  readonly markdownLength: number;
  readonly renderedLength: number;
  readonly buffering: NonNullable<StreamingOption['buffering']>;
  readonly isFinalChunk: boolean;
}

@Component({
  selector: 'x-markdown',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [class]="mergedCls"
         [style]="customStyle"
         #markdownContainer>
    </div>
  `,
  styleUrls: ['./x-markdown.component.css'],
})
export class XMarkdownComponent implements OnChanges, OnDestroy {
  // ===================== Inputs =====================

  /** Markdown 鍐呭 */
  @Input() content: string = '';

  /** Stable external markdown content reference. Used for append-only streaming without passing large strings through Angular. */
  @Input() contentRef?: string;

  /** External markdown content revision signal. The renderer resolves content when this changes. */
  @Input() contentLength?: number;

  /** Resolves external markdown content by contentRef. Kept as a stable input owned by the host chat renderer. */
  @Input() contentResolver?: (contentRef: string) => string;

  /** 娴佸紡娓叉煋閰嶇疆 */
  @Input() streaming?: StreamingOption;

  /** Marked.js 鎵╁睍閰嶇疆 */
  @Input() config?: XMarkdownConfig['config'];

  /** 鑷畾涔夌粍浠舵槧灏? { tagName: AngularComponentClass } */
  @Input() components?: ComponentMap;

  /** 娈佃惤鏍囩鍚?*/
  @Input() paragraphTag?: string;

  /** 鏍瑰厓绱犻澶?CSS 绫诲悕 */
  @Input() rootClassName?: string;

  /** 鏍瑰厓绱犻澶?CSS 绫诲悕 */
  @Input() className?: string;

  /** 鍐呰仈鏍峰紡 */
  @Input() customStyle?: { [key: string]: string };

  /** 鏄惁鍦ㄦ柊鏍囩椤垫墦寮€閾炬帴 */
  @Input() openLinksInNewTab?: boolean;

  /** DOMPurify 閰嶇疆 */
  @Input() dompurifyConfig?: XMarkdownConfig['dompurifyConfig'];

  /** 淇濇姢鑷畾涔夋爣绛炬崲琛岀 */
  @Input() protectCustomTagNewlines?: boolean;

  /** Fires after markdown DOM is incrementally committed and its height may have changed. */
  @Output() heightChange = new EventEmitter<void>();

  /** Imperative content-part callback that bypasses Angular template listeners. */
  @Input() heightChangeCallback?: () => void;

  /** Fires when append-only incremental rendering must fall back to a reset/re-render path. */
  @Output() incrementalFallback = new EventEmitter<XMarkdownIncrementalFallbackEvent>();

  /** Imperative fallback callback for mounted list-item renderers. */
  @Input() incrementalFallbackCallback?: (event: XMarkdownIncrementalFallbackEvent) => void;

  /** Fires after an incremental markdown flush so the chat renderer can record scalar perf diagnostics. */
  @Output() incrementalRender = new EventEmitter<XMarkdownIncrementalRenderEvent>();

  /** Imperative render callback for mounted list-item renderers. */
  @Input() incrementalRenderCallback?: (event: XMarkdownIncrementalRenderEvent) => void;

  // ===================== View =====================

  @ViewChild('markdownContainer', { static: true }) containerRef!: ElementRef<HTMLElement>;

  // ===================== Internal State =====================

  mergedCls: string = 'x-markdown';

  private parser!: MarkdownParser;
  private renderer!: MarkdownRenderer;
  private displayContent: string = '';

  /**
   * 宸叉敞鍏ョ殑鍔ㄦ€佺粍浠跺垪琛紝鎸?fingerprint 绱㈠紩浠ユ敮鎸佸鐢?   */
  private injectedEntries: InjectedEntry[] = [];

  /**
   * 涓婁竴娆℃覆鏌撶殑 sanitized HTML锛岀敤浜庡垽鏂?DOM 鏄惁闇€瑕佹洿鏂?   */
  private renderTarget: MarkdownRenderTarget | null = null;
  private lastRenderedHtml: string = '';
  private tempFingerprintByElement: WeakMap<Element, string> | null = null;
  private incrementalLastMarkdown = '';
  private incrementalRenderedMarkdown = '';
  private incrementalPendingMarkdown: string | null = null;
  private incrementalPendingIsFinal = false;
  private incrementalRafHandle: number | null = null;
  private incrementalActive = false;
  private wordBuffer = new WordBuffer();

  private ngZone = inject(NgZone);
  private appRef = inject(ApplicationRef);
  private viewContainerRef = inject(ViewContainerRef);
  private injector = inject(Injector);
  private envInjector = inject(EnvironmentInjector);

  // ===================== Lifecycle =====================

  ngOnChanges(changes: SimpleChanges): void {
    const needsParserRebuild =
      changes['config'] ||
      changes['paragraphTag'] ||
      changes['openLinksInNewTab'] ||
      changes['components'] ||
      changes['protectCustomTagNewlines'];

    const needsRendererRebuild =
      changes['components'] ||
      changes['dompurifyConfig'];

    if (changes['contentRef']) {
      this.resetIncrementalRenderer();
    }

    if (needsParserRebuild || !this.parser) {
      this.parser = new MarkdownParser({
        markedConfig: this.config,
        paragraphTag: this.paragraphTag,
        openLinksInNewTab: this.openLinksInNewTab,
        components: this.components,
        protectCustomTagNewlines: this.protectCustomTagNewlines,
      });
      this.resetIncrementalRenderer();
    }

    if (needsRendererRebuild || !this.renderer) {
      this.renderer = new MarkdownRenderer({
        components: this.components,
        dompurifyConfig: this.dompurifyConfig,
      });
      this.resetIncrementalRenderer();
    }

    // Update class
    this.mergedCls = ['x-markdown', this.rootClassName, this.className]
      .filter(Boolean)
      .join(' ');

    this.processContent();
  }

  /**
   * Refresh an external append-only content reference without requiring the
   * parent Angular view to rebuild the markdown part. This mirrors VS Code's
   * chat content-part model: the stable markdown part owns its incremental DOM
   * update after the host response model reports a new revision.
   */
  refreshExternalContent(contentLength?: number): void {
    if (typeof contentLength === 'number' && Number.isFinite(contentLength)) {
      this.contentLength = contentLength;
    }
    this.processContent();
  }

  // ===================== Content Processing =====================

  private processContent(): void {
    const rawContent = this.resolveContent();
    const isStreaming = this.streaming?.hasNextChunk === true;
    if (isStreaming) {
      this.scheduleIncrementalMarkdown(rawContent, false);
      return;
    }

    if (
      this.streaming?.buffering === 'word'
      && this.incrementalActive
      && rawContent
      && rawContent.startsWith(this.incrementalLastMarkdown)
    ) {
      this.scheduleIncrementalMarkdown(rawContent, true);
      return;
    }

    this.cancelIncrementalRender();
    this.incrementalLastMarkdown = rawContent;
    this.incrementalRenderedMarkdown = rawContent;
    this.processContentNow(rawContent, true);
  }

  private resolveContent(): string {
    const ref = typeof this.contentRef === 'string' ? this.contentRef.trim() : '';
    if (ref && typeof this.contentResolver === 'function') {
      try {
        return this.contentResolver(ref) || this.content || '';
      } catch {
        return this.content || '';
      }
    }

    return this.content || '';
  }

  private processContentNow(rawContent: string, isFinalChunk: boolean): void {
    const shouldUseParagraphBuffer = this.streaming?.hasNextChunk === true
      && (this.streaming?.buffering ?? 'paragraph') === 'paragraph';
    this.displayContent = shouldUseParagraphBuffer
      ? getParagraphBufferedMarkdown(rawContent, isFinalChunk)
      : rawContent;

    if (!this.displayContent) {
      this.commitRenderedHtml('');
      return;
    }

    // Parse markdown to HTML
    const htmlString = this.parser.parse(this.displayContent, {
      fillIncompleteTokens: this.streaming?.hasNextChunk === true,
    });

    // Render (sanitize + inject attributes)
    const cleanHtml = this.renderer.render(htmlString);

    this.commitRenderedHtml(cleanHtml);
  }

  private scheduleIncrementalMarkdown(rawContent: string, isFinalChunk: boolean): void {
    if (!this.incrementalActive) {
      this.incrementalActive = true;
      this.incrementalLastMarkdown = '';
      this.incrementalRenderedMarkdown = '';
      this.wordBuffer.reset();
    }

    if (!rawContent.startsWith(this.incrementalLastMarkdown)) {
      const event: XMarkdownIncrementalFallbackEvent = {
        previousLength: this.incrementalLastMarkdown.length,
        nextLength: rawContent.length,
        reason: 'non-append',
      };
      this.incrementalFallbackCallback?.(event);
      this.incrementalFallback.emit(event);
      this.resetIncrementalRenderer();
    }

    this.incrementalLastMarkdown = rawContent;
    this.incrementalPendingMarkdown = rawContent;
    this.incrementalPendingIsFinal = this.incrementalPendingIsFinal || isFinalChunk;
    this.scheduleIncrementalFlush();
  }

  private scheduleIncrementalFlush(): void {
    if (this.incrementalRafHandle !== null) {
      return;
    }

    this.ngZone.runOutsideAngular(() => {
      const schedule = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
      this.incrementalRafHandle = schedule(() => {
        this.incrementalRafHandle = null;
        this.flushIncrementalMarkdown();
      });
    });
  }

  private flushIncrementalMarkdown(): void {
    const pendingMarkdown = this.incrementalPendingMarkdown;
    const pendingIsFinal = this.incrementalPendingIsFinal;
    this.incrementalPendingMarkdown = null;
    this.incrementalPendingIsFinal = false;
    if (pendingMarkdown === null) {
      return;
    }

    let renderMarkdown = pendingMarkdown;
    let renderIsFinal = pendingIsFinal;
    if (this.streaming?.buffering === 'word') {
      if (pendingIsFinal) {
        // The response-model completion pass is also the final list-item diff.
        // Do not keep draining a stale word-buffer after the host response has
        // completed: commit the authoritative markdown through the existing
        // morph target once, then discard the streaming presentation state.
        this.wordBuffer.reset();
      } else {
        this.wordBuffer.setRate(this.streaming?.impliedWordLoadRate, false);
        const filteredMarkdown = this.wordBuffer.filterFlush(pendingMarkdown);
        if (filteredMarkdown === undefined) {
          if (this.wordBuffer.needsNextFrame) {
            this.incrementalPendingMarkdown = pendingMarkdown;
            this.incrementalPendingIsFinal = false;
            this.scheduleIncrementalFlush();
          }
          return;
        }
        renderMarkdown = filteredMarkdown;
        renderIsFinal = false;
      }
    }

    if (renderMarkdown === this.incrementalRenderedMarkdown) {
      if (this.wordBuffer.needsNextFrame) {
        this.incrementalPendingMarkdown = pendingMarkdown;
        this.incrementalPendingIsFinal = pendingIsFinal;
        this.scheduleIncrementalFlush();
      }
      return;
    }

    const flushStartedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    this.incrementalRenderedMarkdown = renderMarkdown;
    this.processContentNow(renderMarkdown, renderIsFinal);
    const flushEndedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    const event: XMarkdownIncrementalRenderEvent = {
      durationMs: Math.max(0, flushEndedAt - flushStartedAt),
      markdownLength: pendingMarkdown.length,
      renderedLength: renderMarkdown.length,
      buffering: this.streaming?.buffering ?? 'paragraph',
      isFinalChunk: renderIsFinal,
    };
    this.incrementalRenderCallback?.(event);
    this.incrementalRender.emit(event);

    if (this.wordBuffer.needsNextFrame) {
      this.incrementalPendingMarkdown = pendingMarkdown;
      this.incrementalPendingIsFinal = pendingIsFinal;
      this.scheduleIncrementalFlush();
    }
  }

  private cancelIncrementalRender(): void {
    if (this.incrementalRafHandle === null) {
      return;
    }

    if (typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(this.incrementalRafHandle);
    } else {
      globalThis.clearTimeout(this.incrementalRafHandle);
    }
    this.incrementalRafHandle = null;
    this.incrementalPendingMarkdown = null;
    this.incrementalPendingIsFinal = false;
  }

  private resetIncrementalRenderer(): void {
    this.cancelIncrementalRender();
    this.incrementalActive = false;
    this.incrementalLastMarkdown = '';
    this.incrementalRenderedMarkdown = '';
    this.wordBuffer.reset();
  }

  private commitRenderedHtml(cleanHtml: string): void {
    const target = this.getRenderTarget();
    if (!target || cleanHtml === target.lastHtml) {
      return;
    }

    target.lastHtml = cleanHtml;
    target.revision++;
    this.updateDom(cleanHtml);
    this.injectDynamicComponents();
    // The owning chat list persists bottom-follow around this height change.
    // A markdown content part must not read and restore ancestor scrollTop:
    // that races the list's item-height transaction and emits extra scroll
    // events on every streaming commit.
    this.heightChangeCallback?.();
    this.heightChange.emit();
  }

  private getRenderTarget(): MarkdownRenderTarget | null {
    const element = this.containerRef?.nativeElement;
    if (!element) {
      return null;
    }

    if (!this.renderTarget || this.renderTarget.element !== element) {
      this.renderTarget = { element, lastHtml: '', revision: 0 };
    }
    return this.renderTarget;
  }

  // ===================== Incremental DOM Update =====================

  /**
   * 澧為噺鏇存柊 DOM锛氭瘮杈冩柊鏃?HTML 瀵瑰簲鐨勯《灞傚瓙鑺傜偣锛屼粎鏇挎崲鍙戠敓鍙樺寲鐨勫熬閮ㄣ€?   * 绋冲畾鐨勫墠缂€鑺傜偣锛堝強鍏跺唴閮ㄥ凡娉ㄥ叆鐨勫姩鎬佺粍浠讹級淇濇寔涓嶅姩锛岄伩鍏嶅叏閲?innerHTML 閲嶅缓銆?   */
  private updateDom(newHtml: string): void {
    const container = this.containerRef?.nativeElement;
    if (!container) return;

    if (newHtml === this.lastRenderedHtml) return;
    this.lastRenderedHtml = newHtml;

    const temp = document.createElement('div');
    temp.innerHTML = newHtml;

    this._tempPropsMap = new Map<string, Record<string, any>>();
    this.tempFingerprintByElement = new WeakMap<Element, string>();
    if (this.components) {
      for (const [tagName] of Object.entries(this.components)) {
        const selector = this.getComponentSelector(tagName);
        const elements = temp.querySelectorAll(selector);
        elements.forEach((el: Element, idx: number) => {
          const fp = this.getElementFingerprint(tagName, el, idx);
          const props = this.extractElementProps(tagName, el);
          this._tempPropsMap!.set(fp, props);
          this.tempFingerprintByElement!.set(el, fp);
        });
      }
    }

    this._pendingDetachedMap = new Map<string, InjectedEntry[]>();
    this.morphChildren(container, temp);
    this.pruneDisconnectedInjectedComponents(container);
  }

  private morphChildren(targetParent: Node, sourceParent: Node): void {
    let index = 0;
    while (index < sourceParent.childNodes.length) {
      const sourceChild = sourceParent.childNodes[index];
      const targetChild = targetParent.childNodes[index] || null;

      if (sourceChild instanceof Element) {
        const reusableEntry = this.getReusableEntryForSourceElement(sourceChild);
        if (reusableEntry) {
          this.placeReusableComponentHost(targetParent, targetChild, reusableEntry);
          index++;
          continue;
        }
      }

      if (!targetChild) {
        targetParent.appendChild(sourceChild.cloneNode(true));
        index++;
        continue;
      }

      if (this.canMorphNode(targetChild, sourceChild)) {
        this.morphNode(targetChild, sourceChild);
      } else {
        targetParent.replaceChild(sourceChild.cloneNode(true), targetChild);
      }
      index++;
    }

    while (targetParent.childNodes.length > sourceParent.childNodes.length) {
      targetParent.removeChild(targetParent.lastChild!);
    }
  }

  private morphNode(target: Node, source: Node): void {
    if (target.nodeType === Node.TEXT_NODE && source.nodeType === Node.TEXT_NODE) {
      if (target.nodeValue !== source.nodeValue) {
        target.nodeValue = source.nodeValue;
      }
      return;
    }

    if (!(target instanceof Element) || !(source instanceof Element)) {
      if (!target.isEqualNode(source)) {
        target.parentNode?.replaceChild(source.cloneNode(true), target);
      }
      return;
    }

    if (this.isInjectedHostElement(target)) {
      return;
    }

    this.patchAttributes(target, source);
    this.morphChildren(target, source);
  }

  private canMorphNode(target: Node, source: Node): boolean {
    if (target.nodeType === Node.TEXT_NODE || source.nodeType === Node.TEXT_NODE) {
      return target.nodeType === source.nodeType;
    }

    if (target instanceof Element && source instanceof Element) {
      return target.tagName === source.tagName && !this.isInjectedHostElement(target);
    }

    return target.nodeType === source.nodeType;
  }

  private patchAttributes(target: Element, source: Element): void {
    for (let i = target.attributes.length - 1; i >= 0; i--) {
      const attr = target.attributes[i];
      if (!source.hasAttribute(attr.name)) {
        target.removeAttribute(attr.name);
      }
    }

    for (let i = 0; i < source.attributes.length; i++) {
      const attr = source.attributes[i];
      if (target.getAttribute(attr.name) !== attr.value) {
        target.setAttribute(attr.name, attr.value);
      }
    }
  }

  private getReusableEntryForSourceElement(source: Element): InjectedEntry | null {
    const fingerprint = this.tempFingerprintByElement?.get(source);
    if (!fingerprint) {
      return null;
    }

    const entry = this.injectedEntries.find((candidate) => candidate.fingerprint === fingerprint);
    if (!entry) {
      return null;
    }

    // Props are committed once in injectDynamicComponents after the DOM morph.
    // Updating here as well checked every reused code-block component twice in
    // the same frame and made fenced-code streaming block the loading animation.
    return entry;
  }

  private placeReusableComponentHost(parent: Node, currentAtIndex: Node | null, entry: InjectedEntry): void {
    if (currentAtIndex === entry.hostElement) {
      return;
    }

    parent.insertBefore(entry.hostElement, currentAtIndex);
    if (currentAtIndex && currentAtIndex !== entry.hostElement) {
      parent.removeChild(currentAtIndex);
    }
  }

  private isInjectedHostElement(element: Element): boolean {
    return this.injectedEntries.some((entry) => entry.hostElement === element);
  }

  private pruneDisconnectedInjectedComponents(container: HTMLElement): void {
    const retained: InjectedEntry[] = [];
    for (const entry of this.injectedEntries) {
      if (container.contains(entry.hostElement)) {
        retained.push(entry);
        continue;
      }

      const list = this._pendingDetachedMap?.get(entry.fingerprint) || [];
      list.push(entry);
      this._pendingDetachedMap?.set(entry.fingerprint, list);
    }
    this.injectedEntries = retained;
  }

  private _pendingDetachedMap: Map<string, InjectedEntry[]> | null = null;

  /** 鏆傚瓨鐨?temp DOM 鑷畾涔夌粍浠?props 鏄犲皠锛堜緵绋冲畾鍖哄煙缁勪欢鏇存柊锛?*/
  private _tempPropsMap: Map<string, Record<string, any>> | null = null;

  // ===================== Dynamic Component Injection =====================

  /**
   * 鑾峰彇鑷畾涔夌粍浠剁殑 DOM 閫夋嫨鍣ㄣ€?   * 瀵逛簬 code锛氫粎閫夋嫨鍧楃骇浠ｇ爜锛坉ata-block="true"锛夛紝琛屽唴浠ｇ爜淇濈暀鍘熷 HTML 娓叉煋銆?   */
  private getComponentSelector(tagName: string): string {
    if (tagName === 'code') {
      return 'code[data-block="true"]';
    }
    return tagName;
  }

  /**
   * 涓轰竴涓?DOM 鍏冪礌鐢熸垚 fingerprint锛岀敤浜庤法娓叉煋鍛ㄦ湡鐨勭粍浠跺鐢ㄥ尮閰?   * 瀵逛簬 code 鍧楋細tagName + lang + block
   * 瀵逛簬鍏朵粬鑷畾涔夋爣绛撅細tagName + 灞炴€х鍚?   */
  private getElementFingerprint(tagName: string, element: Element, index?: number): string {
    if (tagName === 'code') {
      const lang = element.getAttribute('data-lang') ||
        element.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] || '';
      const block = element.getAttribute('data-block') || 'false';
      // Keep same-language code blocks distinct by their render position.
      return `code::${lang}::${block}::${index ?? 0}`;
    }

    const attrs: string[] = [];
    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes[i];
      if (attr.name !== 'data-stream-status') {
        attrs.push(`${attr.name}=${attr.value}`);
      }
    }
    attrs.sort();
    return `${tagName}::${attrs.join('|')}`;
  }

  /**
   * 鎻愬彇鍏冪礌鐨?props锛堝睘鎬?+ children + 鐗规畩澶勭悊锛?   */
  private extractElementProps(tagName: string, element: Element): Record<string, any> {
    const props: Record<string, any> = {};

    for (let i = 0; i < element.attributes.length; i++) {
      const attr = element.attributes[i];
      const propName = this.attrToProp(attr.name);
      props[propName] = attr.value;
    }

    props['children'] = element.innerHTML || '';

    // stream status
    const streamStatus = element.getAttribute('data-stream-status');
    if (streamStatus) {
      props['streamStatus'] = streamStatus;
    }

    if (tagName === 'code') {
      const block = element.getAttribute('data-block');
      const codeStreamStatus = element.getAttribute('data-state');
      const lang =
        element.getAttribute('data-lang') ||
        element.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ||
        element.className?.match(/(?:^|\s)lang-([^\s]+)/)?.[1];

      props['block'] = block === 'true';
      props['streamStatus'] = codeStreamStatus === 'loading' ? 'loading' : 'done';
      if (lang) {
        props['lang'] = lang;
      }
    }

    return props;
  }

  /**
   * 鍦?DOM 娓叉煋鍚庯紝鏌ユ壘鑷畾涔夋爣绛惧苟鍒涘缓/澶嶇敤 Angular 缁勪欢
   * 鍏抽敭鏀硅繘锛氶€氳繃 fingerprint 鍖归厤瀹炵幇缁勪欢澶嶇敤锛岄伩鍏嶉棯鐑?   */
  private injectDynamicComponents(): void {
    const container = this.containerRef?.nativeElement;
    if (!container) return;

    const detachedMap = this._pendingDetachedMap || new Map<string, InjectedEntry[]>();
    this._pendingDetachedMap = null;

    // --- 鏇存柊绋冲畾鍖哄煙宸叉湁缁勪欢鐨?props锛堝 streamStatus 浠?loading 鈫?done锛?---
    const tempPropsMap = this._tempPropsMap;
    this._tempPropsMap = null;
    if (tempPropsMap) {
      for (const entry of this.injectedEntries) {
        const newProps = tempPropsMap.get(entry.fingerprint);
        if (newProps) {
          this.updateComponentProps(entry.componentRef, newProps);
          entry.componentRef.changeDetectorRef.detectChanges();
        }
      }
    }

    // 濡傛灉娌℃湁 components 閰嶇疆锛岄攢姣佹墍鏈夊凡鎽樺嚭鐨勭粍浠跺苟杩斿洖
    if (!this.components || Object.keys(this.components).length === 0) {
      for (const [, entries] of detachedMap) {
        for (const entry of entries) {
          try {
            this.detachComponentView(entry);
            entry.componentRef.destroy();
          } catch { /* ignore */ }
        }
      }
      // 鍚屾椂閿€姣佺暀鍦ㄧǔ瀹氬尯鍩熺殑鏃х粍浠讹紙components 閰嶇疆宸叉竻闄わ級
      this.destroyInjectedComponents();
      return;
    }

    const newEntries: InjectedEntry[] = [];
    const reusedFingerprints = new Set<InjectedEntry>();

    // 璁＄畻姣忎釜 tagName 鐨勭ǔ瀹氱粍浠舵暟閲忥紝浣滀负鏂扮粍浠剁殑绱㈠紩鍋忕Щ锛堥伩鍏嶆寚绾圭鎾烇級
    const stableCountByTag = new Map<string, number>();
    for (const entry of this.injectedEntries) {
      stableCountByTag.set(entry.tagName, (stableCountByTag.get(entry.tagName) || 0) + 1);
    }

    for (const [tagName, componentClass] of Object.entries(this.components)) {
      if (!componentClass) continue;
      const selector = this.getComponentSelector(tagName);
      const elements = container.querySelectorAll(selector);
      const indexOffset = stableCountByTag.get(tagName) || 0;

      elements.forEach((element: Element, index: number) => {
        const fingerprint = this.getElementFingerprint(tagName, element, indexOffset + index);
        const props = this.extractElementProps(tagName, element);

        const detachedList = detachedMap.get(fingerprint);
        const reusable = detachedList?.shift();

        if (reusable) {
          // ====== 澶嶇敤宸叉湁缁勪欢 ======
          reusedFingerprints.add(reusable);

          // 閫氳繃 setInput 鏇存柊 props锛岀‘淇?ngOnChanges 姝ｇ‘瑙﹀彂
          this.updateComponentProps(reusable.componentRef, props);
          reusable.componentRef.changeDetectorRef.detectChanges();

          element.parentNode?.replaceChild(reusable.hostElement, element);
          newEntries.push(reusable);
        } else {
          // ====== 鍒涘缓鏂扮粍浠?======
          try {
            const componentRef = createComponent(componentClass as Type<any>, {
              environmentInjector: this.envInjector,
              elementInjector: this.injector,
            });

            this.updateComponentProps(componentRef, props);
            componentRef.changeDetectorRef.detectChanges();

            const hostElement = componentRef.location.nativeElement;
            element.parentNode?.replaceChild(hostElement, element);

            const mode = this.attachComponentView(componentRef);
            newEntries.push({
              fingerprint,
              componentRef,
              hostElement,
              tagName,
              attachMode: mode,
            });
          } catch (e) {
            console.warn(`[ngx-x-markdown] Failed to inject component for <${tagName}>:`, e);
          }
        }
      });
    }

    for (const [, entries] of detachedMap) {
      for (const entry of entries) {
        if (!reusedFingerprints.has(entry)) {
          try {
            this.detachComponentView(entry);
            entry.componentRef.destroy();
          } catch {
            // ignore
          }
        }
      }
    }

    // 淇濈暀绋冲畾鍖哄煙宸叉湁鐨勭粍浠讹紝鍔犱笂鏈疆鏂版敞鍏ョ殑缁勪欢
    this.injectedEntries = [...this.injectedEntries, ...newEntries];
  }

  /**
   * 閫氳繃 ComponentRef.setInput() 鏇存柊缁勪欢灞炴€с€?   * 鍏堟瘮杈冨€兼槸鍚﹀彉鍖栵紝閬垮厤涓嶅繀瑕佺殑 setInput 璋冪敤瑙﹀彂 ngOnChanges銆?   * 瀵逛簬闈?@Input 灞炴€э紝鍥為€€鍒扮洿鎺ヨ祴鍊笺€?   */
  private updateComponentProps(componentRef: ComponentRef<any>, props: Record<string, any>): void {
    const instance = componentRef.instance;
    for (const [key, value] of Object.entries(props)) {
      try {
        // 鍊兼湭鍙樺垯璺宠繃锛岄伩鍏嶄笉蹇呰鍦拌Е鍙?ngOnChanges
        if (Object.is(instance[key], value)) continue;
        componentRef.setInput(key, value);
      } catch {
        if (key in instance && !Object.is(instance[key], value)) {
          instance[key] = value;
        }
      }
    }
  }

  private destroyInjectedComponents(): void {
    for (const entry of this.injectedEntries) {
      try {
        this.detachComponentView(entry);
        entry.componentRef.destroy();
      } catch {
        // ignore
      }
    }
    this.injectedEntries = [];
  }

  /**
   * 鏍规嵁娴佸紡/闈炴祦寮忔ā寮忛€夋嫨鎸傝浇鏂瑰紡锛?   * - 娴佸紡 (hasNextChunk): 浣跨敤 ViewContainerRef.insert锛屼繚璇佸彉鏇存娴嬩笌瑙嗗浘灞傜骇姝ｇ‘
   * - 闈炴祦寮?(杩藉姞): 浣跨敤 ApplicationRef.attachView锛岄伩鍏嶇粍浠惰鎻掑叆鍒?x-markdown 澶栭儴
   */
  private attachComponentView(componentRef: ComponentRef<any>): AttachMode {
    const isStreaming = this.streaming?.hasNextChunk ?? false;
    if (isStreaming) {
      this.viewContainerRef.insert(componentRef.hostView);
      return 'viewContainer';
    }
    this.appRef.attachView(componentRef.hostView);
    return 'appRef';
  }

  private detachComponentView(entry: InjectedEntry): void {
    const mode = entry.attachMode ?? 'appRef';
    try {
      if (mode === 'viewContainer') {
        const idx = this.viewContainerRef.indexOf(entry.componentRef.hostView);
        if (idx !== -1) this.viewContainerRef.remove(idx);
      } else {
        this.appRef.detachView(entry.componentRef.hostView);
      }
    } catch {
      // 鍏煎鏃ф暟鎹垨寮傚父鎯呭喌
      try {
        this.appRef.detachView(entry.componentRef.hostView);
      } catch {
        /* ignore */
      }
    }
  }

  // ===================== Scroll Preservation =====================

  /**
   * 閬嶅巻绁栧厛閾撅紝璁板綍鎵€鏈夋湁婊氬姩鍋忕Щ鐨勫厓绱犵殑婊氬姩浣嶇疆
   */
  /**
   * 鎭㈠涔嬪墠淇濆瓨鐨勬粴鍔ㄤ綅缃?   */
  private attrToProp(attrName: string): string {
    // Convert kebab-case to camelCase
    return attrName.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
  }

  ngOnDestroy(): void {
    this.cancelIncrementalRender();
    this.destroyInjectedComponents();
  }
}
