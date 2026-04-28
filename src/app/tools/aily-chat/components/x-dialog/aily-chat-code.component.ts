import {
  Component,
  Input,
  OnChanges,
  SimpleChanges,
  OnDestroy,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { XAilyStateViewerComponent } from './x-aily-state-viewer/x-aily-state-viewer.component';
import { XAilyButtonViewerComponent } from './x-aily-button-viewer/x-aily-button-viewer.component';
import { XAilyBoardViewerComponent } from './x-aily-board-viewer/x-aily-board-viewer.component';
import { XAilyLibraryViewerComponent } from './x-aily-library-viewer/x-aily-library-viewer.component';
import { XAilyThinkViewerComponent } from './x-aily-think-viewer/x-aily-think-viewer.component';
import { MermaidCodeComponent } from 'ngx-x-markdown';
import { XAilyContextViewerComponent } from './x-aily-context-viewer/x-aily-context-viewer.component';
import { XAilyBlocklyViewerComponent } from './x-aily-blockly-viewer/x-aily-blockly-viewer.component';
import { XAilyErrorViewerComponent } from './x-aily-error-viewer/x-aily-error-viewer.component';
import { XAilyTaskActionViewerComponent } from './x-aily-task-action-viewer/x-aily-task-action-viewer.component';
import { XAilyQuestionViewerComponent } from './x-aily-question-viewer/x-aily-question-viewer.component';
import { XAilyApprovalViewerComponent } from './x-aily-approval-viewer/x-aily-approval-viewer.component';
import { XAilyCodeViewerComponent } from './x-aily-code-viewer/x-aily-code-viewer.component';
import { XAilyDefaultViewerComponent } from './x-aily-default-viewer/x-aily-default-viewer.component';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzPopconfirmModule } from 'ng-zorro-antd/popconfirm';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MermaidComponent } from '../aily-mermaid-viewer/mermaid/mermaid.component';
import mermaid from 'mermaid';
import { AilyHost } from '../../core/host';
import { ChatService } from '../../services/chat.service';

/** 所有 aily-* 自定义代码块类型 */
const AILY_TYPES = [
  'aily-state', 'aily-button', 'aily-board', 'aily-library',
  'aily-think', 'aily-mermaid', 'aily-context', 'aily-blockly',
  'aily-error', 'aily-task-action', 'aily-question', 'aily-approval',
] as const;

/**
 * 统一的 aily-* 自定义代码块渲染组件
 * 通过 x-markdown 的 [components]="{ code: AilyChatCodeComponent }" 注入
 *
 * 支持的代码块类型:
 * - aily-state:       任务状态提示条
 * - aily-button:      操作按钮组
 * - aily-board:       硬件开发板信息卡片
 * - aily-library:     扩展库信息卡片
 * - aily-think:       AI 思考过程折叠块
 * - aily-mermaid:     Mermaid 流程图
 * - aily-context:     代码上下文查看器
 * - aily-blockly:     Blockly 积木代码查看器
 * - aily-error:       错误信息卡片
 * - aily-task-action: 任务动作面板
 * - 其他:             标准代码块
 */
@Component({
  selector: 'aily-chat-code',
  standalone: true,
  imports: [
    CommonModule,
    NzToolTipModule,
    NzPopconfirmModule,
    TranslateModule,
    XAilyStateViewerComponent,
    XAilyButtonViewerComponent,
    XAilyBoardViewerComponent,
    XAilyLibraryViewerComponent,
    XAilyThinkViewerComponent,
    MermaidCodeComponent,
    XAilyContextViewerComponent,
    XAilyBlocklyViewerComponent,
    XAilyErrorViewerComponent,
    XAilyTaskActionViewerComponent,
    XAilyQuestionViewerComponent,
    XAilyApprovalViewerComponent,
    XAilyCodeViewerComponent,
    XAilyDefaultViewerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isType('aily-state') && parsedData) {
      <x-aily-state-viewer [data]="parsedData" />
    }
    @if (isType('aily-button') && (parsedArray || streamStatus === 'loading')) {
      <x-aily-button-viewer [data]="parsedArray" [streamStatus]="streamStatus" />
    }
    @if (isType('aily-board')) {
      <x-aily-board-viewer [data]="parsedData" />
    }
    @if (isType('aily-library')) {
      <x-aily-library-viewer [data]="parsedData" />
    }
    @if (isType('aily-think') && parsedData) {
      <x-aily-think-viewer [data]="parsedData" />
    }
    @if (isType('aily-mermaid') || isMermaidStd) {
      <div class="aily-mermaid-wrapper" (click)="openMermaidFullscreen()" title="点击全屏查看">
        <div class="aily-mermaid-toolbar" (click)="$event.stopPropagation()">
          <!-- <button type="button" class="aily-mermaid-toolbar-btn" [class.success]="mermaidCopySuccess"
            (click)="copyMermaidCode($event)"
            nz-tooltip [nzTooltipTitle]="'MENU.FILE_COPY' | translate" nzTooltipPlacement="top">
            @if (mermaidCopySuccess) {
              <i class="fa-solid fa-check"></i>
            } @else {
              <i class="fa-regular fa-copy"></i>
            }
          </button> -->
          @if (archNeedsOverwriteConfirm) {
            <button type="button" class="aily-mermaid-toolbar-btn" [class.success]="mermaidDownloadSuccess"
              nz-popconfirm
              [nzPopconfirmTitle]="'AILY_CHAT.MERMAID_ARCH_OVERWRITE_CONTENT' | translate"
              [nzOkText]="'AILY_CHAT.MERMAID_ARCH_CONFIRM' | translate"
              [nzCancelText]="'AILY_CHAT.MERMAID_ARCH_CANCEL' | translate"
              (nzOnConfirm)="doDownloadArch()"
              nz-tooltip [nzTooltipTitle]="'AILY_CHAT.MERMAID_SAVE_ARCH' | translate" nzTooltipPlacement="bottom">
              @if (mermaidDownloadSuccess) {
                <i class="fa-solid fa-check"></i>
              } @else {
                <i class="fa-regular fa-file-arrow-down"></i>
              }
            </button>
          } @else {
            <button type="button" class="aily-mermaid-toolbar-btn" [class.success]="mermaidDownloadSuccess"
              (click)="doDownloadArch($event)"
              nz-tooltip [nzTooltipTitle]="'AILY_CHAT.MERMAID_SAVE_ARCH' | translate" nzTooltipPlacement="top">
              @if (mermaidDownloadSuccess) {
                <i class="fa-solid fa-check"></i>
              } @else {
                <i class="fa-regular fa-file-arrow-down"></i>
              }
            </button>
          }
        </div>
        <div class="aily-mermaid-clickable">
          <ngx-mermaid-code
            [children]="mermaidCode"
            [block]="true"
            [lang]="'mermaid'"
            [streamStatus]="streamStatus"
            placeholderText="正在生成图表…"
          />
        </div>
      </div>
    }
    @if (isType('aily-context') && parsedData) {
      <x-aily-context-viewer [data]="parsedData" />
    }
    @if (isType('aily-blockly') && parsedData) {
      <x-aily-blockly-viewer [data]="parsedData" />
    }
    @if (isType('aily-error') && parsedData) {
      <x-aily-error-viewer [data]="parsedData" />
    }
    @if (isType('aily-task-action') && parsedData) {
      <x-aily-task-action-viewer [data]="parsedData" />
    }
    @if (isType('aily-question') && (parsedData || parsedArray)) {
      <x-aily-question-viewer [data]="parsedData || parsedArray" [streamStatus]="streamStatus" />
    }
    @if (isType('aily-approval') && parsedData) {
      <x-aily-approval-viewer [data]="parsedData" />
    }
    @if (isRegularCode) {
      <x-aily-code-viewer [children]="children" [block]="block" [lang]="lang" />
    }
    @if (isDefaultBlock) {
      <x-aily-default-viewer [content]="children" />
    }
  `,
  styles: [`
    :host { display: block; padding: 0.5em 0; overflow: hidden; min-width: 0; max-width: 100%; }
    .aily-mermaid-wrapper {
      position: relative;
      cursor: pointer;
    }
    .aily-mermaid-toolbar {
      position: absolute;
      top: 4px;
      right: 12px;
      display: flex;
      gap: 3px;
      opacity: 0;
      transition: opacity 0.2s;
      z-index: 1;
      border: 1px solid var(--aily-border-tertiary, #767676);
      border-radius: 8px;
      padding: 3px;
      background: var(--aily-bg-tertiary, #333333);
    }
    .aily-mermaid-wrapper:hover .aily-mermaid-toolbar {
      opacity: 1;
    }
    .aily-mermaid-toolbar-btn {
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--aily-text-muted, #bababa);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      transition: background 0.2s, color 0.25s ease;
    }
    .aily-mermaid-toolbar-btn:hover {
      color: var(--aily-text-quaternary, #e3e2e2);
    }
    .aily-mermaid-toolbar-btn.success {
      color: var(--aily-chat-viewer-state-done, #52c41a);
    }
    .aily-mermaid-clickable {
      transition: opacity 0.2s;
    }
    .aily-mermaid-wrapper:hover .aily-mermaid-clickable {
      opacity: 0.95;
    }
  `],
})
export class AilyChatCodeComponent implements OnChanges, OnDestroy {
  // ===== Inputs (由 x-markdown 注入) =====
  @Input() children: string = '';
  @Input() block: boolean = false;
  @Input() lang: string = '';
  @Input() streamStatus: string = 'done';
  // x-markdown 通用属性循环产生的 data-* / class 等衍生字段，声明以避免 NG0303
  @Input() dataState: string = '';
  @Input() dataLang: string = '';
  @Input() dataBlock: string = '';
  @Input() dataStreamStatus: string = '';
  @Input('class') classValue?: string;

  // ===== State =====
  parsedData: any = null;
  parsedArray: any[] | null = null;
  mermaidCopySuccess = false;
  mermaidDownloadSuccess = false;
  private copySuccessTimer: ReturnType<typeof setTimeout> | null = null;
  private downloadSuccessTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private cdr: ChangeDetectorRef,
    private modal: NzModalService,
    private message: NzMessageService,
    private translate: TranslateService,
    private chatService: ChatService,
  ) {}

  // ===== Getters =====
  isType(t: string): boolean { return this.block && this.lang === t; }

  get isRegularCode(): boolean {
    if (!this.block) return false;
    if (this.isMermaidStd) return false;
    return !AILY_TYPES.includes(this.lang as any);
  }

  get isMermaidStd(): boolean { return this.block && this.lang === 'mermaid'; }

  /** 非支持的 block 类型时使用默认 viewer 渲染（如 inline、aily-* 解析失败等） */
  get isDefaultBlock(): boolean {
    if (!this.block) return true;
    return false;
  }

  get mermaidData(): { code?: string } | null {
    if (this.isMermaidStd) {
      return { code: this.decodeEntities(this.children).trim() };
    }
    if (this.isType('aily-mermaid')) {
      if (this.parsedData && typeof this.parsedData.code === 'string') return this.parsedData;
      const raw = this.decodeEntities(this.children).trim();
      return raw ? { code: raw } : null;
    }
    return this.parsedData;
  }

  /** 供 MermaidCodeComponent 使用的 code 字符串（aily-mermaid 需解析 JSON 取 code） */
  get mermaidCode(): string {
    return this.mermaidData?.code?.trim() ?? '';
  }

  /** 项目目录下是否已存在 arch.md（用于决定是否显示覆盖确认） */
  get archExistsInProject(): boolean {
    const host = AilyHost.get();
    const projectPath = host?.project?.currentProjectPath || host?.project?.projectRootPath;
    if (!projectPath || !host?.fs || !host?.path) return false;
    const archPath = host.path.join(projectPath, 'arch.md');
    return host.fs.existsSync(archPath);
  }

  /** 孤儿模式下 .chat_history 下是否已存在 {sessionId}_arch.md（用于决定是否显示覆盖确认） */
  get archExistsInOrphanChatHistory(): boolean {
    const host = AilyHost.get();
    const rootPath = host?.project?.projectRootPath;
    const projectPath = host?.project?.currentProjectPath || rootPath;
    const isOrphan = !projectPath || (rootPath && projectPath === rootPath);
    if (!isOrphan || !rootPath || !host?.fs || !host?.path) return false;
    const sessionId = this.chatService.currentSessionId;
    if (!sessionId) return false;
    const archPath = host.path.join(rootPath, '.chat_history', `${sessionId}_arch.md`);
    return host.fs.existsSync(archPath);
  }

  /** 是否需要覆盖确认（项目 arch 或孤儿 arch 已存在） */
  get archNeedsOverwriteConfirm(): boolean {
    return this.archExistsInProject || this.archExistsInOrphanChatHistory;
  }

  // ===== Lifecycle =====
  ngOnChanges(changes: SimpleChanges): void {
    this.parseContent();
  }

  ngOnDestroy(): void {
    if (this.copySuccessTimer) clearTimeout(this.copySuccessTimer);
    if (this.downloadSuccessTimer) clearTimeout(this.downloadSuccessTimer);
  }

  // ===== Parsing =====
  private parseContent(): void {
    const prevParsedArray = this.lang === 'aily-button' ? this.parsedArray : null;
    this.parsedData = null;
    this.parsedArray = null;

    if (!this.block || !AILY_TYPES.includes(this.lang as any)) return;

    try {
      const raw = this.decodeEntities(this.children).trim();
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.parsedArray = parsed;
      } else {
        this.parsedData = parsed;
      }
    } catch {
      // 流式过程中 parse 可能因中间 chunk 失败，保留上次成功结果避免按钮闪烁
      if (this.streamStatus === 'loading' && prevParsedArray?.length) {
        this.parsedArray = prevParsedArray;
      }
    }
  }

  private decodeEntities(html: string): string {
    if (typeof document === 'undefined') return html;
    const el = document.createElement('textarea');
    el.innerHTML = html;
    return el.value;
  }

  /** 点击 mermaid 块时打开全屏 SVG 查看 */
  async openMermaidFullscreen(): Promise<void> {
    const code = this.mermaidCode;
    if (!code?.trim()) return;

    try {
      const diagramId = `mermaid-fullscreen-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const result = await mermaid.render(diagramId, code);
      const svg = typeof result === 'object' && result?.svg ? result.svg : typeof result === 'string' ? result : '';

      // 清理 mermaid 渲染时可能插入的临时节点
      document.getElementById(diagramId)?.remove();

      if (!svg?.trim()) {
        console.warn('Mermaid render returned empty SVG');
        return;
      }

      const forcedStyle = 'width: 60vw !important; height: 80vh !important; max-width: 100% !important; display: block !important;';
      const enhancedSvg = svg
        .replace('<svg', `<svg id="${diagramId}" data-mermaid-svg="true"`)
        .replace(/width="[^"]*"/, 'width="60vw"')
        .replace(/height="[^"]*"/, 'height="80vh"')
        .replace(/<svg([^>]*)>/, (_m: string, attrs: string) => {
          const merged = /style=/.test(attrs)
            ? attrs.replace(/style="[^"]*"/, `style="${forcedStyle}"`)
            : `${attrs} style="${forcedStyle}"`;
          return `<svg${merged}>`;
        });

      this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzContent: MermaidComponent,
        nzData: { svg: enhancedSvg },
        nzWidth: 'fit-content',
      });
    } catch (err) {
      console.warn('Mermaid fullscreen failed:', err);
    }
  }

  /** 复制 mermaid 代码到剪贴板 */
  async copyMermaidCode(ev: Event): Promise<void> {
    ev.stopPropagation();
    const code = this.mermaidCode;
    if (!code?.trim()) return;
    try {
      await navigator.clipboard.writeText(code);
      this.mermaidCopySuccess = true;
      if (this.copySuccessTimer) clearTimeout(this.copySuccessTimer);
      this.copySuccessTimer = setTimeout(() => {
        this.mermaidCopySuccess = false;
        this.copySuccessTimer = null;
        this.cdr.markForCheck();
      }, 2000);
      this.cdr.markForCheck();
    } catch {
      this.message.error(this.translate.instant('AILY_CHAT.MERMAID_COPY_FAILED'));
    }
  }

  /** 下载为 arch.md 框架图文件（由模板直接调用或 nzOnConfirm 触发） */
  doDownloadArch(ev?: Event): void {
    ev?.stopPropagation();
    const code = this.mermaidCode;
    if (!code?.trim()) return;

    const content = `\`\`\`mermaid\n${code}\n\`\`\`\n`;

    const host = AilyHost.get();
    const projectPath = host?.project?.currentProjectPath || host?.project?.projectRootPath;
    const rootPath = host?.project?.projectRootPath;
    const isOrphan = !projectPath || (rootPath && projectPath === rootPath);

    if (projectPath && host?.fs && host?.path && !isOrphan) {
      const archPath = host.path.join(projectPath, 'arch.md');
      this.writeArchFile(host, archPath, content);
    } else if (isOrphan && rootPath && host?.fs && host?.path) {
      const sessionId = this.chatService.currentSessionId;
      if (sessionId) {
        const chatHistoryDir = host.path.join(rootPath, '.chat_history');
        const archPath = host.path.join(chatHistoryDir, `${sessionId}_arch.md`);
        this.writeArchFile(host, archPath, content);
      } else {
        this.downloadArchAsBlob(content);
      }
    } else {
      this.downloadArchAsBlob(content);
    }
  }

  private showDownloadSuccessIcon(): void {
    this.mermaidDownloadSuccess = true;
    if (this.downloadSuccessTimer) clearTimeout(this.downloadSuccessTimer);
    this.downloadSuccessTimer = setTimeout(() => {
      this.mermaidDownloadSuccess = false;
      this.downloadSuccessTimer = null;
      this.cdr.markForCheck();
    }, 2000);
    this.cdr.markForCheck();
  }

  private writeArchFile(host: { fs: { existsSync: (p: string) => boolean; mkdirSync: (p: string, o?: { recursive?: boolean }) => void; writeFileSync: (p: string, c: string) => void }; path: { dirname: (p: string) => string } }, archPath: string, content: string): void {
    try {
      const dir = host.path.dirname(archPath);
      if (!host.fs.existsSync(dir)) {
        host.fs.mkdirSync(dir, { recursive: true });
      }
      host.fs.writeFileSync(archPath, content);
      this.showDownloadSuccessIcon();
    } catch (err) {
      console.warn('Write arch.md failed:', err);
      this.message.error(this.translate.instant('AILY_CHAT.MERMAID_SAVE_FAILED'));
    }
  }

  private downloadArchAsBlob(content: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'arch.md';
    a.click();
    URL.revokeObjectURL(url);
    this.showDownloadSuccessIcon();
  }
}
