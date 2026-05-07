import { Component, model, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ElectronService } from 'src/app/services/electron.service';

import { NgxMonacoEsmLoader } from 'src/app/utils/ngx-monaco-esm-loader';
import {
  NGX_MONACO_EDITOR_CONFIG,
  NGX_MONACO_LOADER_PROVIDER,
  NgxMonacoEditorComponent,
  NgxMonacoEditorConfig,
} from '@jean-merelis/ngx-monaco-editor';

@Component({
  selector: 'app-monaco-editor-pro',
  standalone: true,
  imports: [CommonModule, TranslateModule, NgxMonacoEditorComponent],
  templateUrl: './monaco-editor-pro.component.html',
  styleUrl: './monaco-editor-pro.component.scss',
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
export class MonacoEditorProComponent {
  private readonly ngxEditor = viewChild(NgxMonacoEditorComponent);

  /** 与 ngx-monaco-editor 双向绑定的文档内容 */
  readonly editorValue = model("import numpy as np\nprint('Hello world!')");

  readonly editorLanguage = signal('python');
  readonly editorTheme = signal('vs-dark');

  readonly editorHostStyle = signal({
    width: '100%',
    height: '100%',
    border: 'none',
  });

  readonly editorExtraOptions = signal({
    padding: { top: 4 },
  });

  /** 与业务状态对齐的占位字段（测试打开文件时会更新） */
  currentFile = '';
  isModified = false;

  constructor(
    private readonly translate: TranslateService,
    private readonly electronService: ElectronService,
  ) {}

  async onTestOpenFile(): Promise<void> {
    const w = window as any;
    const looksLikeElectron =
      this.electronService.isElectron ||
      (typeof w.electronAPI?.versions === 'function' && typeof w.electronAPI.versions() === 'object');

    if (!looksLikeElectron) {
      console.warn(this.translate.instant('MONACO_EDITOR_PRO.ELECTRON_REQUIRED'));
      return;
    }

    const host = await this.waitForHostFileApis();
    if (!host) {
      console.error(
        'MonacoEditorPro: Electron 已就绪，但未找到 disk API；请确认 preload 与 ElectronService.init 执行正常。',
      );
      return;
    }

    const dlg = await host.dialog.selectFiles({
      properties: ['openFile'],
      title: this.translate.instant('MONACO_EDITOR_PRO.TEST_OPEN_FILE'),
    });

    if (dlg?.canceled || !dlg.filePaths?.length) {
      return;
    }

    await this.openFile(dlg.filePaths[0], host.readFile);
  }

  private async waitForHostFileApis(maxMs = 4000): Promise<{
    dialog: { selectFiles: (opts: unknown) => Promise<{ canceled?: boolean; filePaths?: string[] }> };
    readFile: (path: string) => Promise<unknown>;
  } | null> {
    const w = window as any;
    const deadline = Date.now() + maxMs;

    while (Date.now() < deadline) {
      const dialog = w['dialog'] ?? w.electronAPI?.dialog;
      const fsApi = w['fs'] ?? w.electronAPI?.fs;
      const selectFiles = dialog?.selectFiles;
      const hasRead =
        typeof fsApi?.readFile === 'function' || typeof fsApi?.readFileSync === 'function';

      if (typeof selectFiles === 'function' && hasRead && fsApi) {
        const readFile =
          typeof fsApi.readFile === 'function'
            ? (path: string) => fsApi.readFile(path, 'utf8')
            : (path: string) => Promise.resolve(fsApi.readFileSync(path, 'utf8'));
        return { dialog, readFile };
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    return null;
  }

  private async readFileContent(
    filePath: string,
    readFileImpl: (path: string) => Promise<unknown>,
  ): Promise<{ success: boolean; content?: string; error?: string }> {
    try {
      const raw = await readFileImpl(filePath);
      if (raw != null && typeof raw === 'object' && 'success' in raw) {
        return raw as { success: boolean; content?: string; error?: string };
      }
      if (typeof raw === 'string') {
        return { success: true, content: raw };
      }
      return { success: true, content: raw != null ? String(raw) : '' };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

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
      rs: 'rust',
      go: 'go',
    };
    return map[ext] ?? 'plaintext';
  }

  async openFile(filePath: string, readFileImpl?: (path: string) => Promise<unknown>): Promise<void> {
    let rf = readFileImpl;
    if (!rf) {
      const host = await this.waitForHostFileApis();
      if (!host) {
        console.error(this.translate.instant('MONACO_EDITOR_PRO.READ_FAILED'));
        return;
      }
      rf = host.readFile;
    }

    const result = await this.readFileContent(filePath, rf);
    if (!result.success || result.content === undefined) {
      console.error('🚀 ~ openFile ~', result.error ?? this.translate.instant('MONACO_EDITOR_PRO.READ_FAILED'));
      return;
    }

    this.currentFile = filePath;
    this.isModified = false;

    const language = this.getLanguageFromPath(filePath);
    this.editorLanguage.set(language);
    this.editorValue.set(result.content);

    queueMicrotask(() => this.ngxEditor()?.focus());
  }
}
