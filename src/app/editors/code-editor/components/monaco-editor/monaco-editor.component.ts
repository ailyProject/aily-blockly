import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as monaco from 'monaco-editor';
import type { IDisposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle';

import {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
  registerFileSystemOverlay
} from '@codingame/monaco-vscode-files-service-override';
import { ensureMonacoVsCodeApiInitialized } from 'src/app/utils/monaco-vscode-bootstrap';

@Component({
  selector: 'app-monaco-editor',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './monaco-editor.component.html',
  styleUrl: './monaco-editor.component.scss'
})
export class MonacoEditorComponent implements OnChanges, OnDestroy {
  @ViewChild('monacoEditorContainer', { static: true })
  editorContainer!: ElementRef<HTMLDivElement>;

  @Input({ required: true }) code!: string;
  /** 本地绝对路径（与 Electron fs 一致），用于 file:// URI 与 VSCode 服务链路上的模型解析 */
  @Input({ required: true }) filePath!: string;

  /**
   * 为 true 时以只读方式打开当前文件（预览），适合单次浏览、双击再「固定」等与标签联动的交互。
   */
  @Input() preview = false;

  @Output() codeChange = new EventEmitter<string>();
  @Output() openFileRequest = new EventEmitter<{ filePath: string; position: monaco.Position }>();

  editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;

  /** 由 monaco.editor.createModel 管理，避免 createModelReference 内 writeFile 触发 getExtUri */
  private textModel: monaco.editor.ITextModel | null = null;
  private overlayDisposable: IDisposable | null = null;
  private contentListener: monaco.IDisposable | null = null;
  private layoutObserver: ResizeObserver | null = null;
  private suppressContentEmit = false;
  private currentUri: monaco.Uri | null = null;
  private initializing = false;

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    if (!this.editorContainer?.nativeElement || !this.filePath) {
      return;
    }
    await ensureMonacoVsCodeApiInitialized();

    const pathChanged = !!changes['filePath'];
    const codeChanged = !!changes['code'];
    const previewChanged = !!changes['preview'];

    if (pathChanged || (codeChanged && !this.textModel)) {
      await this.openOrReplaceDocument();
    } else if (codeChanged && this.textModel) {
      const incoming = this.code ?? '';
      if (this.textModel.getValue() !== incoming) {
        this.suppressContentEmit = true;
        this.textModel.setValue(incoming);
        this.suppressContentEmit = false;
      }
    }

    if (previewChanged || pathChanged) {
      this.editorInstance?.updateOptions({ readOnly: this.preview });
    }
  }

  ngOnDestroy(): void {
    this.teardownOverlayAndModel(false);
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    if (this.editorInstance) {
      this.editorInstance.dispose();
      this.editorInstance = null;
    }
  }

  getViewState(): monaco.editor.ICodeEditorViewState | null {
    return this.editorInstance?.saveViewState() ?? null;
  }

  async restoreViewStateSafely(viewState: monaco.editor.ICodeEditorViewState | undefined): Promise<boolean> {
    if (!this.editorInstance || !viewState) {
      return false;
    }
    this.editorInstance.restoreViewState(viewState);
    this.editorInstance.focus();
    return true;
  }

  disposeModel(path: string): void {
    if (!path || !this.currentUri || this.normalizeFsPath(path) !== this.normalizeFsPath(this.currentUri.fsPath)) {
      return;
    }
    this.teardownOverlayAndModel(false);
    if (this.editorInstance) {
      this.editorInstance.setModel(null);
    }
  }

  /** 语言 id，供外部兜底使用 */
  getLanguageIdForCurrentFile(): string {
    return this.textModel?.getLanguageId() ?? resolveLanguageId(this.filePath);
  }

  private normalizeFsPath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  private async openOrReplaceDocument(): Promise<void> {
    if (this.initializing) {
      return;
    }
    this.initializing = true;
    try {
      this.teardownOverlayAndModel(true);

      const uri = monaco.Uri.file(this.filePath);
      this.currentUri = uri;

      const fs = new RegisteredFileSystemProvider(false);
      fs.registerFile(new RegisteredMemoryFile(uri, this.code ?? ''));
      this.overlayDisposable = registerFileSystemOverlay(1, fs);

      const languageId = resolveLanguageId(this.filePath);
      this.textModel = monaco.editor.createModel(this.code ?? '', languageId, uri);

      const textModel = this.textModel;

      if (!this.editorInstance) {
        this.editorInstance = monaco.editor.create(this.editorContainer.nativeElement, {
          model: textModel,
          automaticLayout: false,
          readOnly: this.preview,
          theme: 'vs-dark',
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          wordWrap: 'on'
        });
        this.contentListener = textModel.onDidChangeContent(() => {
          if (this.suppressContentEmit) {
            return;
          }
          this.codeChange.emit(textModel.getValue());
        });
        this.setupLayoutObserver();
      } else {
        this.editorInstance.setModel(textModel);
        this.editorInstance.updateOptions({ readOnly: this.preview });
        this.contentListener?.dispose();
        this.contentListener = textModel.onDidChangeContent(() => {
          if (this.suppressContentEmit) {
            return;
          }
          this.codeChange.emit(textModel.getValue());
        });
      }
    } finally {
      this.initializing = false;
    }
  }

  private setupLayoutObserver(): void {
    const el = this.editorContainer.nativeElement;
    this.layoutObserver = new ResizeObserver(() => {
      this.editorInstance?.layout();
    });
    this.layoutObserver.observe(el);
    queueMicrotask(() => this.editorInstance?.layout());
  }

  private teardownOverlayAndModel(disposeEditorListener: boolean): void {
    if (disposeEditorListener) {
      this.contentListener?.dispose();
      this.contentListener = null;
    }
    if (this.textModel) {
      this.textModel.dispose();
      this.textModel = null;
    }
    this.overlayDisposable?.dispose();
    this.overlayDisposable = null;
    this.currentUri = null;
  }
}

/**
 * 决定当前文件的 monaco 语言 id：
 *  1. 先用 monaco 已注册语言（含 public/vscode/extensions 通过 manifest 贡献的扩展名/文件名规则）做匹配；
 *  2. 命中失败再回落到内建简表，覆盖 monaco 标准库尚未识别的扩展名（如 .ino → cpp）。
 */
function resolveLanguageId(path: string): string {
  if (!path) {
    return 'plaintext';
  }
  const fileName = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const lowerName = fileName.toLowerCase();
  const ext = lowerName.includes('.') ? lowerName.slice(lowerName.lastIndexOf('.')) : '';

  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((name) => name.toLowerCase() === lowerName)) {
      return language.id;
    }
    if (ext && language.extensions?.some((e) => e.toLowerCase() === ext)) {
      return language.id;
    }
  }

  /** 兜底：覆盖一些 monaco 内置 language 未涵盖的别名/扩展名 */
  const fallback: Record<string, string> = {
    '.mjs': 'javascript',
    '.cjs': 'javascript',
    '.jsx': 'javascriptreact',
    '.tsx': 'typescriptreact',
    '.ino': 'cpp',
    '.toml': 'ini'
  };
  return fallback[ext] ?? 'plaintext';
}
