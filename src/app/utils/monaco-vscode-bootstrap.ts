/**
 * 在应用启动阶段完成 monaco-vscode-api 与服务覆盖的初始化。
 * 必须在页面内第一次调用 monaco.editor.create 之前执行（含 Blockly 等处的 Monaco）。
 */
import { initialize } from '@codingame/monaco-vscode-api';
import getBaseServiceOverride from '@codingame/monaco-vscode-base-service-override';
import getHostServiceOverride from '@codingame/monaco-vscode-host-service-override';
import getFilesServiceOverride from '@codingame/monaco-vscode-files-service-override';
import getConfigurationServiceOverride, {
  initUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';

import { MonacoVSCodeCSSLoader } from './monaco-vscode-css-loader';

/** 不能与 ng-zorro code-editor 中 Window.MonacoEnvironment 做 merge，故仅运行时赋值不做 global 扩充 */
function attachMonacoWorkers(): void {
  const win = window as Window & {
    MonacoEnvironment?: {
      getWorker?: (workerId: string, label: string) => Worker;
      getWorkerUrl?: (moduleId: string, label: string) => string;
    };
  };
  if (win.MonacoEnvironment?.getWorker != null) {
    return;
  }
  /** 相对本文件上到项目根的 node_modules，供 dev/build 打包器解析 worker 资源 */
  const workerHref = new URL(
    '../../../node_modules/@codingame/monaco-vscode-api/workers/editor.worker.js',
    import.meta.url
  );

  win.MonacoEnvironment = {
    ...win.MonacoEnvironment,
    getWorker(_workerId: string, _label: string) {
      return new Worker(workerHref, { type: 'module' });
    }
  };
}

let bootstrapPromise: Promise<void> | undefined;

export async function ensureMonacoVsCodeApiInitialized(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      attachMonacoWorkers();
      await MonacoVSCodeCSSLoader.loadAllMonacoCSS();
      /**
       * 在服务注册前写入默认 User/settings.json（initFile → 与 FileService 共用的 in-memory provider）。
       * initialize() 之后的 updateUserConfiguration / writeFile 会走 toFileStat，曾在运行时触发 null.getExtUri。
       */
      await initUserConfiguration(
        JSON.stringify(
          {
            'editor.wordWrap': 'on',
            'editor.minimap.enabled': true,
            'editor.unicodeHighlight.invisibleCharacters': false
          },
          null,
          2
        )
      );
      await initialize({
        ...getBaseServiceOverride(),
        ...getHostServiceOverride(),
        ...getFilesServiceOverride(),
        ...getConfigurationServiceOverride(),
        ...getThemeServiceOverride(),
        ...getLanguagesServiceOverride(),
        ...getTextmateServiceOverride()
      });
    })();
  }
  await bootstrapPromise;
}
