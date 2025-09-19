import { Component, ViewChild } from '@angular/core';
import { ToolContainerComponent } from '../../../../components/tool-container/tool-container.component';
import { UiService } from '../../../../services/ui.service';
import { SubWindowComponent } from '../../../../components/sub-window/sub-window.component';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { NzCodeEditorModule, NzCodeEditorComponent } from 'ng-zorro-antd/code-editor';
import { FormsModule } from '@angular/forms';
import { BlocklyService } from '../../services/blockly.service';

// 声明monaco全局变量
declare const monaco: any;

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
export class CodeViewerComponent {
  @ViewChild(NzCodeEditorComponent, { static: false }) codeEditor?: NzCodeEditorComponent;
  
  code = '';
  currentUrl;
  windowInfo = '代码查看';
  
  // 存储高亮装饰器的ID
  private decorationIds: string[] = [];
  // 存储Monaco Editor实例
  private editorInstance: any;

  options: any = {
    language: 'cpp',
    theme: 'vs-dark',
    lineNumbers: 'on',
    automaticLayout: true,
    // 添加编辑器初始化回调
    onDidCreateEditor: (editor: any) => {
      this.editorInstance = editor;
    }
  }

  constructor(
    private blocklyService: BlocklyService,
    private uiService: UiService,
    private router: Router,
  ) { }

  ngOnInit() {
    this.currentUrl = this.router.url;
  }

  ngAfterViewInit(): void {
    this.blocklyService.codeSubject.subscribe((code) => {
      setTimeout(() => {
        this.code = code;
      }, 100);
    });
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
      range: new monaco.Range(startLine, 1, endLine, 1),
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

    const decorations: any[] = [];
    const matches = model.findMatches(searchText, false, false, true, null, false);

    matches.forEach(match => {
      decorations.push({
        range: match.range,
        options: {
          className: className || 'highlighted-text',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
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
      range: new monaco.Range(startLine, startColumn, endLine, endColumn),
      options: {
        className: className || 'highlighted-range',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
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
