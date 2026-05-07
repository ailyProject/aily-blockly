import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  model,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type * as monaco from 'monaco-editor';

import { NgxMonacoEsmLoader } from 'src/app/utils/ngx-monaco-esm-loader';
import {
  NGX_MONACO_EDITOR_CONFIG,
  NGX_MONACO_LOADER_PROVIDER,
  NgxMonacoEditorComponent,
  NgxMonacoEditorConfig,
} from '@jean-merelis/ngx-monaco-editor';

@Component({
  selector: 'app-monaco-editor',
  standalone: true,
  imports: [CommonModule, NgxMonacoEditorComponent],
  templateUrl: './monaco-editor.component.html',
  styleUrl: './monaco-editor.component.scss',
  providers: [
    { provide: NGX_MONACO_LOADER_PROVIDER, useFactory: () => new NgxMonacoEsmLoader() },
    {
      provide: NGX_MONACO_EDITOR_CONFIG,
      useValue: {
        runInsideNgZone: false,
        defaultOptions: {
          automaticLayout: true,
          fontSize: 14,
          minimap: { enabled: true },
          wordWrap: 'on',
          lineNumbers: 'on',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          readOnly: false,
          cursorStyle: 'line',
          formatOnPaste: true,
          formatOnType: true,
        },
      } satisfies NgxMonacoEditorConfig,
    },
  ],
})
export class MonacoEditorComponent implements OnChanges, OnDestroy {
  private readonly ngxEditor = viewChild(NgxMonacoEditorComponent);

  @Input({ required: true }) code!: string;
  /** 本地绝对路径，用于语法高亮后缀推断（与 Electron fs 路径一致） */
  @Input({ required: true }) filePath!: string;
  /** 预览 / 只读模式 */
  @Input() preview = false;

  @Output() codeChange = new EventEmitter<string>();
  @Output() openFileRequest = new EventEmitter<{ filePath: string; position: monaco.Position }>();

  /** 与 ngx-monaco-editor 同步的文档内容 */
  readonly editorValue = model('');
  readonly editorLanguage = signal('plaintext');
  readonly editorTheme = signal('vs-dark');
  readonly editorHostStyle = signal({
    width: '100%',
    height: '100%',
    border: 'none',
  });
  readonly editorExtraOptions = signal<{ padding: { top: number }; readOnly?: boolean }>({
    padding: { top: 4 },
  });

  get editorInstance(): monaco.editor.IStandaloneCodeEditor | null {
    const ngx = this.ngxEditor() as unknown as { editor?: monaco.editor.IStandaloneCodeEditor };
    return ngx?.editor ?? null;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['code']) {
      const nv = changes['code'].currentValue ?? '';
      if (nv !== this.editorValue()) {
        this.editorValue.set(nv);
      }
    }
    if (changes['filePath']) {
      this.editorLanguage.set(this.getLanguageFromPath(changes['filePath'].currentValue ?? ''));
    }
    if (changes['preview']) {
      const ro = !!changes['preview'].currentValue;
      this.editorExtraOptions.set({
        padding: { top: 4 },
        ...(ro ? { readOnly: true } : {}),
      });
    }
  }

  ngOnDestroy(): void {
    // 子组件 ngx-monaco-editor 会在自身销毁时 dispose 编辑器实例
  }

  onValueChangeFromNgx(value: string): void {
    this.editorValue.set(value);
    this.codeChange.emit(value);
  }

  getViewState(): monaco.editor.ICodeEditorViewState | null {
    return this.editorInstance?.saveViewState() ?? null;
  }

  async restoreViewStateSafely(
    viewState: monaco.editor.ICodeEditorViewState | undefined,
  ): Promise<boolean> {
    if (!this.editorInstance || !viewState) {
      return false;
    }
    this.editorInstance.restoreViewState(viewState);
    this.editorInstance.focus();
    return true;
  }

  /**
   * 旧版基于 URI 的多模型逻辑：当前由 ngx-monaco-editor 单一模型托管，
   * 关闭标签时由父组件更新 code/filePath；此处保留空实现以免调用方报错。
   */
  disposeModel(_path: string): void {}

  /** 语法 id，对齐 monaco-editor-pro 映射并补充 Arduino 等后缀 */
  private getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      js: 'javascript',
      jsx: 'javascript',
      mjs: 'javascript',
      cjs: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      py: 'python',
      json: 'json',
      html: 'html',
      htm: 'html',
      css: 'css',
      scss: 'scss',
      less: 'less',
      md: 'markdown',
      xml: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      sh: 'shell',
      cpp: 'cpp',
      cc: 'cpp',
      cxx: 'cpp',
      h: 'cpp',
      c: 'c',
      ino: 'cpp',
      rs: 'rust',
      go: 'go',
      toml: 'ini',
    };
    return map[ext] ?? 'plaintext';
  }
}
