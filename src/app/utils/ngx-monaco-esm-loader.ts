/**
 * 供 @jean-merelis/ngx-monaco-editor 使用的 ESM 加载器：
 * - 避免 DefaultMonacoLoader（AMD / vs/loader.js）在 Electron（nodeIntegration）下与 Node require 冲突
 * - 使用官方 monaco-editor（monaco-editor-vs 包）的 ESM 入口
 */
import type { MonacoAPI, MonacoLoader } from '@jean-merelis/ngx-monaco-editor';

const vsRoot = new URL('../../../node_modules/monaco-editor-vs/esm/vs', import.meta.url);

const g = globalThis as typeof globalThis & {
  MonacoEnvironment?: {
    globalAPI?: boolean;
    getWorker: (moduleId: string, label: string) => Worker;
  };
};

g.MonacoEnvironment = {
  globalAPI: true,
  getWorker(_moduleId: string, label: string) {
    switch (label) {
      case 'json':
        return new Worker(new URL('./language/json/json.worker.js', vsRoot), { type: 'module' });
      case 'css':
      case 'scss':
      case 'less':
        return new Worker(new URL('./language/css/css.worker.js', vsRoot), { type: 'module' });
      case 'html':
      case 'handlebars':
      case 'razor':
        return new Worker(new URL('./language/html/html.worker.js', vsRoot), { type: 'module' });
      case 'typescript':
      case 'javascript':
        return new Worker(new URL('./language/typescript/ts.worker.js', vsRoot), { type: 'module' });
      default:
        return new Worker(new URL('./editor/editor.worker.js', vsRoot), { type: 'module' });
    }
  },
};

export class NgxMonacoEsmLoader implements MonacoLoader {
  private monacoPromise?: Promise<MonacoAPI>;

  monacoLoaded(): Promise<MonacoAPI> {
    if (!this.monacoPromise) {
      this.monacoPromise = import('monaco-editor-vs/esm/vs/editor/editor.main.js').then(
        (m) => m as unknown as MonacoAPI,
      );
    }
    return this.monacoPromise;
  }
}
