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
import { XAilyCodeViewerComponent } from './x-aily-code-viewer/x-aily-code-viewer.component';
import { NzModalService } from 'ng-zorro-antd/modal';
import { MermaidComponent } from '../aily-mermaid-viewer/mermaid/mermaid.component';
import mermaid from 'mermaid';

/** 所有 aily-* 自定义代码块类型 */
const AILY_TYPES = [
  'aily-state', 'aily-button', 'aily-board', 'aily-library',
  'aily-think', 'aily-mermaid', 'aily-context', 'aily-blockly',
  'aily-error', 'aily-task-action',
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
    XAilyCodeViewerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isType('aily-state') && parsedData) {
      <x-aily-state-viewer [data]="parsedData" />
    }
    @if (isType('aily-button') && parsedArray) {
      <x-aily-button-viewer [data]="parsedArray" />
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
      <div class="aily-mermaid-clickable" (click)="openMermaidFullscreen()" title="点击全屏查看">
        <ngx-mermaid-code
          [children]="mermaidCode"
          [block]="true"
          [lang]="'mermaid'"
          [streamStatus]="streamStatus"
          placeholderText="正在生成图表…"
        />
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
    @if (isRegularCode) {
      <x-aily-code-viewer [children]="children" [block]="block" [lang]="lang" />
    }
  `,
  styles: [`
    :host { display: block; }
    .aily-mermaid-clickable {
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .aily-mermaid-clickable:hover {
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

  constructor(
    private cdr: ChangeDetectorRef,
    private modal: NzModalService,
  ) {}

  // ===== Getters =====
  isType(t: string): boolean { return this.block && this.lang === t; }

  get isRegularCode(): boolean {
    if (!this.block) return true;
    if (this.isMermaidStd) return false;
    return !AILY_TYPES.includes(this.lang as any);
  }

  get isMermaidStd(): boolean { return this.block && this.lang === 'mermaid'; }

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

  // ===== Lifecycle =====
  ngOnChanges(changes: SimpleChanges): void {
    this.parseContent();
  }

  ngOnDestroy(): void {}

  // ===== Parsing =====
  private parseContent(): void {
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
      // JSON 解析失败静默忽略
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

      const enhancedSvg = svg
        .replace('<svg', `<svg id="${diagramId}" data-mermaid-svg="true"`)
        .replace(/width="[^"]*"/, 'width="100%"')
        .replace(/height="[^"]*"/, 'height="auto"')
        .replace(/<svg([^>]*)>/, (_m: string, attrs: string) => `<svg${attrs} style="max-width: 100%; height: auto; display: block;">`);

      this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: { padding: '0' },
        nzContent: MermaidComponent,
        nzData: { svg: enhancedSvg },
        nzWidth: '90vw',
      });
    } catch (err) {
      console.warn('Mermaid fullscreen failed:', err);
    }
  }
}
