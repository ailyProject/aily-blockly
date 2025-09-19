import { Component, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { ToolContainerComponent } from '../../../../components/tool-container/tool-container.component';
import { UiService } from '../../../../services/ui.service';
import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BlocklyService } from '../../services/blockly.service';

// 导入monaco-editor
import * as monacoEditor from 'monaco-editor';

// 声明monaco全局变量
declare const monaco: any;

@Component({
  selector: 'app-code-viewer',
  imports: [
    ToolContainerComponent,
    SubWindowComponent,
    CommonModule,
    FormsModule
  ],
  templateUrl: './code-viewer.component.html',
  styleUrl: './code-viewer.component.scss',
})
export class CodeViewerComponent implements AfterViewInit, OnDestroy {
  @ViewChild('editorContainer', { static: false }) editorContainer?: ElementRef;
  
  code = '';
  currentUrl;
  windowInfo = '代码查看';
  
  // 存储高亮装饰器的ID
  private decorationIds: string[] = [];
  // 存储Monaco Editor实例
  private editorInstance: monacoEditor.editor.IStandaloneCodeEditor | null = null;

  constructor(
    private blocklyService: BlocklyService,
    private uiService: UiService,
    private router: Router,
  ) { }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit(): void {
    // 初始化Monaco Editor
    this.initializeMonacoEditor();

    // 订阅代码变化
    this.blocklyService.codeSubject.subscribe((code) => {
      setTimeout(() => {
        this.code = code;
        if (this.editorInstance) {
          this.editorInstance.setValue(code);
        }
      }, 100);
    });
  }

  ngOnDestroy(): void {
    // 清理Monaco Editor实例
    if (this.editorInstance) {
      this.editorInstance.dispose();
    }
  }

  /**
   * 初始化Monaco Editor
   */
  private initializeMonacoEditor(): void {
    if (!this.editorContainer) {
      console.error('编辑器容器未找到');
      return;
    }

    // 设置Monaco Editor的工作路径
    if (typeof window !== 'undefined') {
      (window as any).MonacoEnvironment = {
        getWorkerUrl: (moduleId: string, label: string) => {
          if (label === 'json') {
            return '/assets/vs/language/json/json.worker.js';
          }
          if (label === 'css' || label === 'scss' || label === 'less') {
            return '/assets/vs/language/css/css.worker.js';
          }
          if (label === 'html' || label === 'handlebars' || label === 'razor') {
            return '/assets/vs/language/html/html.worker.js';
          }
          if (label === 'typescript' || label === 'javascript') {
            return '/assets/vs/language/typescript/ts.worker.js';
          }
          return '/assets/vs/editor/editor.worker.js';
        }
      };
    }

    // 配置Monaco Editor选项
    const editorOptions: monacoEditor.editor.IStandaloneEditorConstructionOptions = {
      language: 'cpp',
      theme: 'vs-dark',
      lineNumbers: 'on',
      automaticLayout: true,
      readOnly: true,
      minimap: { enabled: false },
      scrollbar: {
        vertical: 'auto',
        horizontal: 'auto'
      },
      fontSize: 14,
      wordWrap: 'on',
      folding: true,
      renderLineHighlight: 'all',
      cursorStyle: 'line',
      scrollBeyondLastLine: false,
    };

    try {
      // 创建Monaco Editor实例
      this.editorInstance = monacoEditor.editor.create(
        this.editorContainer.nativeElement,
        editorOptions
      );

      // 设置初始代码
      if (this.code) {
        this.editorInstance.setValue(this.code);
      }

      // 监听编辑器尺寸变化
      window.addEventListener('resize', () => {
        if (this.editorInstance) {
          this.editorInstance.layout();
        }
      });

    } catch (error) {
      console.error('Monaco Editor初始化失败:', error);
    }
  }

  /**
   * 高亮指定行范围
   * @param startLine 起始行号（从1开始）
   * @param endLine 结束行号（从1开始）
   * @param className 可选的CSS类名
   */
  highlightLines(startLine: number, endLine: number, className?: string): void {
    if (!this.editorInstance) {
      console.warn('编辑器实例未就绪');
      return;
    }

    const editor = this.editorInstance;
    
    // 清除之前的高亮
    this.clearHighlight();

    // 创建装饰器配置
    const decorations = [{
      range: new monacoEditor.Range(startLine, 1, endLine, 1),
      options: {
        isWholeLine: true,
        className: className || 'highlighted-line',
        glyphMarginClassName: 'highlighted-glyph'
      }
    }];

    // 应用装饰器
    this.decorationIds = editor.deltaDecorations([], decorations);
  }

  /**
   * 高亮指定文本内容
   * @param searchText 要高亮的文本
   * @param className 可选的CSS类名
   */
  highlightText(searchText: string, className?: string): void {
    if (!this.editorInstance || !searchText) {
      console.warn('编辑器实例未就绪或搜索文本为空');
      return;
    }

    const editor = this.editorInstance;
    const model = editor.getModel();
    
    if (!model) return;

    // 清除之前的高亮
    this.clearHighlight();

    const decorations: monacoEditor.editor.IModelDeltaDecoration[] = [];
    const matches = model.findMatches(searchText, false, false, true, null, false);

    matches.forEach(match => {
      decorations.push({
        range: match.range,
        options: {
          className: className || 'highlighted-text',
          stickiness: monacoEditor.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
        }
      });
    });

    // 应用装饰器
    this.decorationIds = editor.deltaDecorations([], decorations);
  }

  /**
   * 高亮指定范围的字符
   * @param startLine 起始行号（从1开始）
   * @param startColumn 起始列号（从1开始）
   * @param endLine 结束行号（从1开始）
   * @param endColumn 结束列号（从1开始）
   * @param className 可选的CSS类名
   */
  highlightRange(startLine: number, startColumn: number, endLine: number, endColumn: number, className?: string): void {
    if (!this.editorInstance) {
      console.warn('编辑器实例未就绪');
      return;
    }

    const editor = this.editorInstance;
    
    // 清除之前的高亮
    this.clearHighlight();

    const decorations = [{
      range: new monacoEditor.Range(startLine, startColumn, endLine, endColumn),
      options: {
        className: className || 'highlighted-range',
        stickiness: monacoEditor.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    }];

    // 应用装饰器
    this.decorationIds = editor.deltaDecorations([], decorations);
  }

  /**
   * 清除所有高亮
   */
  clearHighlight(): void {
    if (this.editorInstance && this.decorationIds.length > 0) {
      this.decorationIds = this.editorInstance.deltaDecorations(this.decorationIds, []);
    }
  }

  /**
   * 滚动到指定行并高亮
   * @param lineNumber 行号（从1开始）
   */
  scrollToLineAndHighlight(lineNumber: number): void {
    if (!this.editorInstance) return;

    const editor = this.editorInstance;
    
    // 滚动到指定行
    editor.revealLine(lineNumber);
    
    // 高亮该行
    this.highlightLines(lineNumber, lineNumber);
  }

  close() {
    this.uiService.closeTool('code-viewer');
  }

  // 示例方法：演示不同的高亮效果
  
  /**
   * 示例：高亮第5-8行
   */
  exampleHighlightLines() {
    this.highlightLines(5, 8);
  }

  /**
   * 示例：高亮所有"void"关键字
   */
  exampleHighlightKeyword() {
    this.highlightText('void', 'highlighted-text');
  }

  /**
   * 示例：高亮错误行
   */
  exampleHighlightError(lineNumber: number) {
    this.highlightLines(lineNumber, lineNumber, 'highlighted-error');
  }

  /**
   * 示例：高亮警告
   */
  exampleHighlightWarning(startLine: number, startCol: number, endLine: number, endCol: number) {
    this.highlightRange(startLine, startCol, endLine, endCol, 'highlighted-warning');
  }

  /**
   * 示例：滚动到指定行并高亮
   */
  exampleScrollAndHighlight(lineNumber: number) {
    this.scrollToLineAndHighlight(lineNumber);
  }
}
