import { Component, OnDestroy } from '@angular/core';
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

  constructor(
    private blocklyService: BlocklyService,
    private uiService: UiService,
    private router: Router,
  ) { }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit(): void {
    this.blocklyService.codeSubject
      .pipe(takeUntil(this.destroy$))
      .subscribe((code) => {
        setTimeout(() => {
          this.code = code;
        }, 100);
      });

    // 监听选中块 + 代码映射变化，实时高亮
    combineLatest([
      this.blocklyService.selectedBlockSubject,
      this.blocklyService.blockCodeMapSubject
    ])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([blockId, codeMap]) => {
        if (blockId && codeMap.has(blockId)) {
          const mapping = codeMap.get(blockId)!;
          this.highlightBlock(mapping);
        } else {
          this.clearHighlight();
        }
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Monaco 编辑器初始化回调，获取编辑器实例
   */
  onEditorInitialized(editor: any): void {
    this.editorInstance = editor;
    this.monacoInstance = (window as any).monaco;
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
