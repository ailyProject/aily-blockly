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
  // 存储当前高亮的 block ID，用于在代码更新后恢复高亮
  private currentHighlightedBlockId: string | null = null;
  // 存储当前高亮的位置信息
  private currentHighlightPosition: { startLine: number; endLine: number } | null = null;

  // 添加文本行与ID的映射表
  private lineIdMap: Map<string, number[]> = new Map(); // id -> 行号数组
  private idLineMap: Map<number, string> = new Map(); // 行号 -> id
  private textData: Array<{ text: string, id: string }> = []; // 存储文本和ID的原始数据

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
    this.blocklyService.codeSubject.subscribe((codeData) => {
      setTimeout(() => {
        if (this.editorInstance) {
          this.editorInstance.setValue(codeData.text); // 先清空内容
          // 如果没有设置文本映射，则使用传统方式
          if (this.textData.length === 0) {
            // this.editorInstance.setValue(this.code);
            console.log(codeData.data);
            this.setTextWithIds(codeData.data);

            // 如果之前有高亮的 block，在代码更新后恢复高亮
            // if (this.currentHighlightedBlockId) {
            //   setTimeout(() => {
            //     this.restoreCurrentHighlight();
            //   }, 50);
            // }
          }
          // 如果已经设置了文本映射，则不覆盖编辑器内容
        }
      }, 100);
    });

    // 订阅 block 点击事件
    this.blocklyService.blockClickSubject.subscribe((block) => {
      if (block && block.id) {
        console.log('收到 block 点击事件:', block.type, block.id);
        this.highlightById(block.id);
      } else {
        this.clearHighlight();
      }
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
          return './assets/monaco-editor/worker-loader.js';
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
   * @param clearPrevious 是否清除之前的高亮（默认为 true）
   */
  highlightLines(startLine: number, endLine: number, className?: string, clearPrevious: boolean = true): void {
    if (!this.editorInstance) {
      console.warn('编辑器实例未就绪');
      return;
    }

    const editor = this.editorInstance;

    // 创建装饰器配置
    const decorations = [{
      range: new monacoEditor.Range(startLine, 1, endLine, 1),
      options: {
        isWholeLine: true,
        className: className || 'highlighted-line',
        glyphMarginClassName: 'highlighted-glyph'
      }
    }];

    // 直接替换装饰器，避免闪烁
    if (clearPrevious) {
      // 用新装饰器替换所有旧装饰器
      this.decorationIds = editor.deltaDecorations(this.decorationIds, decorations);
    } else {
      // 添加到现有装饰器
      this.decorationIds = editor.deltaDecorations([], decorations);
    }

    // 存储当前高亮位置
    this.currentHighlightPosition = { startLine, endLine };
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
    // 清除当前高亮的 block ID 和位置信息
    this.currentHighlightedBlockId = null;
    this.currentHighlightPosition = null;
  }

  /**
   * 设置文本内容和ID映射
   * @param textWithIds 包含文本和ID的数组，格式：[{text: 'code content', id: 'unique_id'}, ...]
   */
  setTextWithIds(textWithIds: Array<{ text: string, id: string }>): void {
    // 清除之前的映射
    this.clearAllMappings();

    textWithIds.forEach((lineData, index) => {
      if (this.lineIdMap.has(lineData.id)) {
        this.lineIdMap.get(lineData.id).push(index); // 追加行号
      } else {
        this.lineIdMap.set(lineData.id, [index]); // 初始化映射
      }
    });

    // // 合并所有文本内容
    // const fullText = textWithIds.map(item => item.text).join('\n');

    // // 更新编辑器内容
    // if (this.editorInstance) {
    //   this.editorInstance.setValue(fullText);
    // }

    // 计算每个文本块对应的行号
    // let currentLine = 1;
    // textWithIds.forEach(item => {
    //   const lines = item.text.split('\n');
    //   const startLine = currentLine;
    //   const endLine = currentLine + lines.length - 1;

    //   // 创建行号数组
    //   const lineNumbers: number[] = [];
    //   for (let i = startLine; i <= endLine; i++) {
    //     lineNumbers.push(i);
    //   }

    //   // 设置映射关系
    //   this.setLineMapping(item.id, lineNumbers);

    //   // 更新当前行位置（+1是因为join时会添加换行符）
    //   currentLine = endLine + 1;
    // });

    console.log('文本与ID映射设置完成:', this.lineIdMap);
  }

  /**
   * 设置行与ID的映射关系
   * @param id 标识符
   * @param lineNumbers 对应的行号数组
   */
  private setLineMapping(id: string, lineNumbers: number[]): void {
    // 清除该ID之前的映射
    if (this.lineIdMap.has(id)) {
      const oldLines = this.lineIdMap.get(id)!;
      oldLines.forEach(line => this.idLineMap.delete(line));
    }

    // 设置新的映射
    this.lineIdMap.set(id, lineNumbers);
    lineNumbers.forEach(line => this.idLineMap.set(line, id));
  }

  /**
   * 根据ID获取对应的行号
   * @param id 标识符
   * @returns 行号数组
   */
  getLinesByMapping(id: string): number[] {
    return this.lineIdMap.get(id) || [];
  }

  /**
   * 根据行号获取对应的ID
   * @param lineNumber 行号
   * @returns 对应的ID
   */
  getIdByLine(lineNumber: number): string | undefined {
    return this.idLineMap.get(lineNumber);
  }

  /**
   * 根据ID高亮对应的行
   * @param id 标识符
   * @param className 可选的CSS类名
   */
  highlightById(id: string, className?: string): void {
    const lines = this.getLinesByMapping(id);
    if (lines.length > 0) {
      console.log(`根据ID ${id} 高亮行:`, lines);
      this.highlightMultipleLines(lines, className);

      // 滚动到第一行
      if (this.editorInstance) {
        this.editorInstance.revealLine(lines[0]);
      }

      // 更新当前高亮的ID
      this.currentHighlightedBlockId = id;
    } else {
      console.warn(`未找到ID ${id} 对应的行`);
    }
  }

  /**
   * 根据多个ID高亮对应的行
   * @param ids ID数组
   * @param className 可选的CSS类名
   */
  highlightByIds(ids: string[], className?: string): void {
    const allLines: number[] = [];

    ids.forEach(id => {
      const lines = this.getLinesByMapping(id);
      allLines.push(...lines);
    });

    if (allLines.length > 0) {
      // 去重并排序
      const uniqueLines = [...new Set(allLines)].sort((a, b) => a - b);
      console.log(`根据IDs ${ids.join(', ')} 高亮行:`, uniqueLines);

      this.highlightMultipleLines(uniqueLines, className);

      // 滚动到第一行
      if (this.editorInstance && uniqueLines.length > 0) {
        this.editorInstance.revealLine(uniqueLines[0]);
      }
    }
  }

  /**
   * 清除所有映射关系
   */
  private clearAllMappings(): void {
    this.lineIdMap.clear();
    this.idLineMap.clear();
    this.textData = [];
    this.clearHighlight();
  }

  // /**
  //  * 根据 block ID 高亮对应的代码
  //  * @param blockId Blockly block 的 ID
  //  * @param updateCurrentBlockId 是否更新当前高亮的 block ID（默认为 true）
  //  */
  // highlightBlockCode(blockId: string, updateCurrentBlockId: boolean = true): void {
  //   if (!this.editorInstance) {
  //     console.warn('Monaco Editor 实例未就绪');
  //     return;
  //   }

  //   const blockPosition = this.blocklyService.getBlockLinePosition(blockId);
  //   if (blockPosition) {
  //     console.log(`高亮 block ${blockId} 对应的代码行:`, blockPosition);

  //     // 滚动到第一个匹配的行
  //     this.editorInstance.revealLine(blockPosition.startLine);

  //     // 高亮所有匹配的行或段落
  //     if (blockPosition.segments && blockPosition.segments.length > 0) {
  //       // 如果有分段信息，高亮每个段落
  //       this.highlightMultipleSegments(blockPosition.segments);
  //     } else if (blockPosition.matchingLines && blockPosition.matchingLines.length > 0) {
  //       // 如果有匹配行信息，高亮所有匹配的行
  //       this.highlightMultipleLines(blockPosition.matchingLines);
  //     } else {
  //       // fallback 到传统的起始-结束行高亮
  //       this.highlightLines(blockPosition.startLine, blockPosition.endLine);
  //     }

  //     // 更新当前高亮的 block ID
  //     if (updateCurrentBlockId) {
  //       this.currentHighlightedBlockId = blockId;
  //     }
  //   } else {
  //     console.warn(`未找到 block ${blockId} 对应的代码位置`);
  //   }
  // }

  /**
   * 高亮多个分散的代码行
   * @param lines 要高亮的行号数组
   * @param className 可选的CSS类名
   */
  private highlightMultipleLines(lines: number[], className?: string): void {
    if (!this.editorInstance || lines.length === 0) return;

    const editor = this.editorInstance;
    const decorations: any[] = [];

    lines.forEach(lineNumber => {
      decorations.push({
        range: new monacoEditor.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          className: className || 'highlighted-block',
          glyphMarginClassName: 'highlighted-glyph'
        }
      });
    });

    // 清除之前的高亮并应用新的
    this.decorationIds = editor.deltaDecorations(this.decorationIds, decorations);
  }

  // /**
  //  * 强制恢复当前的高亮（用于代码更新后）
  //  */
  // private restoreCurrentHighlight(): void {
  //   if (this.currentHighlightedBlockId && this.editorInstance) {
  //     // 重新获取 block 位置（因为代码可能已更新）
  //     const blockPosition = this.blocklyService.getBlockLinePosition(this.currentHighlightedBlockId);
  //     if (blockPosition) {
  //       console.log(`恢复高亮 block ${this.currentHighlightedBlockId}:`, blockPosition);

  //       // 使用相同的逻辑恢复高亮
  //       if (blockPosition.segments && blockPosition.segments.length > 0) {
  //         this.highlightMultipleSegments(blockPosition.segments);
  //       } else if (blockPosition.matchingLines && blockPosition.matchingLines.length > 0) {
  //         this.highlightMultipleLines(blockPosition.matchingLines);
  //       } else {
  //         this.highlightLines(blockPosition.startLine, blockPosition.endLine, 'highlighted-block', true);
  //       }
  //     }
  //   }
  // }

  close() {
    this.uiService.closeTool('code-viewer');
  }

}
