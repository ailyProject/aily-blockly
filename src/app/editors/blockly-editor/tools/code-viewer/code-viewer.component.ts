import { ChangeDetectorRef, Component, NgZone, OnDestroy, effect } from '@angular/core';
import { ToolContainerComponent } from '../../../../components/tool-container/tool-container.component';
import { UiService } from '../../../../services/ui.service';
import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { NzCodeEditorModule } from 'ng-zorro-antd/code-editor';
import { FormsModule } from '@angular/forms';
import { BlocklyService } from '../../services/blockly.service';
import { Subject, combineLatest } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { BlockCodeMapping } from '../../components/blockly/generators/arduino/arduino';
import { ThemeService } from '../../../../services/theme.service';
import { CodeViewerIpcService, CodeViewerIpcState } from '../../services/code-viewer-ipc.service';

@Component({
  selector: 'app-code-viewer',
  imports: [
    NzCodeEditorModule,
    ToolContainerComponent,
    SubWindowComponent,
    CommonModule,
    FormsModule
  ],
  templateUrl: './code-viewer.component.html',
  styleUrl: './code-viewer.component.scss',
})
export class CodeViewerComponent implements OnDestroy {
  code = '';

  currentUrl;

  windowInfo = '代码查看';

  options: any = {
    language: 'cpp',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true,
    readOnly: true
  }

  // Monaco 编辑器实例
  private editorInstance: any = null;
  private monacoInstance: any = null;
  private oldDecorations: string[] = [];
  private destroy$ = new Subject<void>();
  private currentBlockCodeMap = new Map<string, BlockCodeMapping>();
  private currentSelectedBlockId: string | null = null;
  private ipcStateCleanup: (() => void) | null = null;

  constructor(
    private blocklyService: BlocklyService,
    private uiService: UiService,
    private router: Router,
    private themeService: ThemeService,
    private codeViewerIpcService: CodeViewerIpcService,
    private ngZone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {
    // 监听主题变化，动态切换 Monaco 主题
    effect(() => {
      const monacoTheme = this.themeService.getMonacoTheme();
      this.options = { ...this.options, theme: monacoTheme };
    });
  }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit(): void {
    if (this.codeViewerIpcService.isAvailable) {
      this.initElectronStateSync();
      return;
    }

    this.initAngularStateSync();
  }

  private initElectronStateSync(): void {
    this.ipcStateCleanup = this.codeViewerIpcService.onState((state) => {
      this.ngZone.run(() => this.applyIpcState(state));
    });

    this.codeViewerIpcService.getState().then((state) => {
      if (!state) return;
      this.ngZone.run(() => this.applyIpcState(state));
    });
  }

  private initAngularStateSync(): void {
    this.blocklyService.codeSubject
      .pipe(takeUntil(this.destroy$))
      .subscribe((code) => {
        setTimeout(() => {
          this.code = code;
          this.cdr.markForCheck();
        }, 100);
      });

    // 监听选中块 + 代码映射变化，实时高亮
    combineLatest([
      this.blocklyService.selectedBlockSubject,
      this.blocklyService.blockCodeMapSubject
    ])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([blockId, codeMap]) => {
        this.currentSelectedBlockId = blockId;
        this.currentBlockCodeMap = codeMap;
        this.updateHighlight();
      });
  }

  ngOnDestroy(): void {
    if (this.ipcStateCleanup) {
      this.ipcStateCleanup();
      this.ipcStateCleanup = null;
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  private applyIpcState(state: CodeViewerIpcState): void {
    if (typeof state.code === 'string') {
      this.code = state.code;
    }

    if (state.blockCodeMap) {
      this.currentBlockCodeMap = this.codeViewerIpcService.toMap(state.blockCodeMap);
    }

    if ('selectedBlockId' in state) {
      this.currentSelectedBlockId = state.selectedBlockId ?? null;
    }

    this.updateHighlight();
    this.cdr.markForCheck();
  }

  private updateHighlight(): void {
    if (this.currentSelectedBlockId && this.currentBlockCodeMap.has(this.currentSelectedBlockId)) {
      this.highlightBlock(this.currentBlockCodeMap.get(this.currentSelectedBlockId)!);
    } else {
      this.clearHighlight();
    }
  }

  /**
   * Monaco 编辑器初始化回调，获取编辑器实例
   */
  onEditorInitialized(editor: any): void {
    this.editorInstance = editor;
    this.monacoInstance = (window as any).monaco;
    this.updateHighlight();
  }

  /**
   * 高亮指定 block 对应的代码行（支持列级精度）
   */
  private highlightBlock(mapping: BlockCodeMapping): void {
    if (!this.editorInstance || !this.monacoInstance) return;

    const monaco = this.monacoInstance;
    const decorations = mapping.lineRanges.map(range => {
      const hasColumns = range.startColumn !== undefined && range.endColumn !== undefined;
      return {
        range: hasColumns
          ? new monaco.Range(range.startLine, range.startColumn, range.endLine, range.endColumn)
          : new monaco.Range(range.startLine, 1, range.endLine, 1),
        options: {
          isWholeLine: !hasColumns,
          className: hasColumns ? 'block-highlight-inline' : 'block-highlight-line',
          overviewRuler: {
            color: '#FFD54F88',
            position: monaco.editor.OverviewRulerLane.Full
          },
          minimap: {
            color: '#FFD54F88',
            position: monaco.editor.MinimapPosition.Inline
          }
        }
      };
    });

    this.oldDecorations = this.editorInstance.deltaDecorations(
      this.oldDecorations,
      decorations
    );

    // 滚动到第一个高亮区域
    if (mapping.lineRanges.length > 0) {
      this.editorInstance.revealLineInCenter(mapping.lineRanges[0].startLine);
    }
  }

  /**
   * 清除所有高亮
   */
  private clearHighlight(): void {
    if (!this.editorInstance) return;
    this.oldDecorations = this.editorInstance.deltaDecorations(
      this.oldDecorations,
      []
    );
  }

  close() {
    this.uiService.closeTool('code-viewer');
  }
}
