/**
 * 在应用启动阶段完成 monaco-vscode-api 与服务覆盖的初始化。
 * 必须在页面内第一次调用 monaco.editor.create 之前执行（含 Blockly 等处的 Monaco）。
 */
import {
  IEditorOverrideServices,
  IStorageService,
  SyncDescriptor,
  initialize
} from '@codingame/monaco-vscode-api';
import { registerAssets } from '@codingame/monaco-vscode-api/assets';
import getBaseServiceOverride from '@codingame/monaco-vscode-base-service-override';
import getConfigurationServiceOverride, {
  initUserConfiguration
} from '@codingame/monaco-vscode-configuration-service-override';
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override';
import getLayoutServiceOverride from '@codingame/monaco-vscode-layout-service-override';
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override';
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override';
import getOutlineServiceOverride from '@codingame/monaco-vscode-outline-service-override';
import getStorageServiceOverride, {
  BrowserStorageService as InjectedBrowserStorageService,
  type DatabaseFactories
} from '@codingame/monaco-vscode-storage-service-override';
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override';
import getBannerServiceOverride from '@codingame/monaco-vscode-view-banner-service-override';
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override';

import { MonacoVSCodeCSSLoader } from './monaco-vscode-css-loader';

import '@codingame/monaco-vscode-javascript-default-extension'

/**
 * Angular esbuild 通过 `new URL('xxx.js', import.meta.url)` 触发资源跟踪并输出 chunk，
 * 因此需要从源码处直接引用 worker / wasm 文件。下面这些 URL 在打包后仍可被 fetch。
 */
const editorWorkerUrl = new URL(
  '../../../node_modules/@codingame/monaco-vscode-api/workers/editor.worker.js',
  import.meta.url
);

const extensionHostWorkerUrl = new URL(
  '../../../node_modules/@codingame/monaco-vscode-api/workers/extensionHost.worker.js',
  import.meta.url
);

const textmateWorkerUrl = new URL(
  // eslint-disable-next-line max-len
  '../../../node_modules/@codingame/monaco-vscode-textmate-service-override/vscode/src/vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain.js',
  import.meta.url
);

/**
 * onig.wasm 由 textmate worker 加载，使用与 monaco-vscode-textmate-service-override
 * 同源的 release 目录。new URL(...) 让 esbuild 把它纳入产物，避免 dev 下 404。
 */
const onigWasmUrl = new URL(
  '../../../node_modules/@codingame/monaco-vscode-textmate-service-override/external/vscode-oniguruma/release/onig.wasm',
  import.meta.url
);

/**
 * 不能与 ng-zorro code-editor 中 Window.MonacoEnvironment 做 merge，故仅运行时赋值不做 global 扩充。
 * 需要根据 worker label 路由到不同 worker 文件，否则 textmate / 扩展宿主会 fallback 到 editor.worker。
 */
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

  win.MonacoEnvironment = {
    ...win.MonacoEnvironment,
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'TextMateWorker':
          return new Worker(textmateWorkerUrl, { type: 'module', name: label });
        case 'WorkerExtensionHost':
        case 'extensionHost':
          return new Worker(extensionHostWorkerUrl, { type: 'module', name: label });
        default:
          return new Worker(editorWorkerUrl, { type: 'module', name: label });
      }
    }
  };
}

/**
 * 官方 storage override 使用 SyncDescriptor(..., true)（延迟实例化），InstantiationService 会用 Proxy
 * 包装服务；在 GlobalIdleValue 完成前访问 getNumber 等非事件方法会得到 undefined，进而报错「不是函数」。
 * 此处改为非延迟实例化（与 standalone 默认 InMemoryStorageService 注册方式一致）。
 */
function getEagerStorageServiceOverride(params?: {
  fallbackOverride?: Record<string, unknown>;
  databaseFactories?: DatabaseFactories;
}): IEditorOverrideServices {
  const base = getStorageServiceOverride(params);
  return {
    ...base,
    [IStorageService.toString()]: new SyncDescriptor(
      InjectedBrowserStorageService,
      [params?.fallbackOverride, params?.databaseFactories],
      false
    )
  };
}

let bootstrapPromise: Promise<void> | undefined;

export async function ensureMonacoVsCodeApiInitialized(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      attachMonacoWorkers();

      /**
       * 把 textmate worker / onig.wasm 等运行期资源映射到 esbuild 输出的 URL。
       * `FileAccess.asBrowserUri('vs/...')` 会优先查 registerAssets 注册的映射，
       * 没有命中时才回落到 globalThis.location.href，避免 onig.wasm 走 404。
       */
      registerAssets({
        // eslint-disable-next-line max-len
        'vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain.js':
          textmateWorkerUrl.href
      });

      /**
       * `threadedBackgroundTokenizerFactory.js` 通过 `new URL('../../../external/vscode-oniguruma/release/onig.wasm', import.meta.url)` 解析 wasm，
       * 在 Angular esbuild 下该路径不会被自动复制；这里做 fetch 透明改写，命中失败时回落到我们打包好的 wasm。
       */
      installOnigWasmFallback(onigWasmUrl.href);

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
            'editor.unicodeHighlight.invisibleCharacters': false,
            'workbench.colorTheme': 'Default Dark+'
          },
          null,
          2
        )
      );

      const commonServices: IEditorOverrideServices = {
        // ...getBaseServiceOverride(),
        // ...getLayoutServiceOverride(),
        ...getDialogsServiceOverride(),
        ...getConfigurationServiceOverride(),
        ...getTextmateServiceOverride(),
        ...getThemeServiceOverride(),
        ...getLanguagesServiceOverride(),
        ...getOutlineServiceOverride(),
        ...getBannerServiceOverride(),
        ...getTitleBarServiceOverride(),
        // ...getEagerStorageServiceOverride({
        //   fallbackOverride: {
        //     'workbench.activity.showAccounts': false
        //   }
        // })
      };

      await initialize(commonServices);
    })();
  }
  await bootstrapPromise;
}

/**
 * 拦截 fetch 请求，把 worker 内 `new URL('../../../external/vscode-oniguruma/release/onig.wasm', import.meta.url)`
 * 等错误的 wasm 路径透明改写到我们已经发布的真实 URL，避免 404。
 *
 * 仅劫持后缀为 `onig.wasm` 且与原 URL 不可达的请求；其余 fetch 完全透传。
 */
function installOnigWasmFallback(targetUrl: string): void {
  const originalFetch = window.fetch?.bind(window);
  const win = window as Window & { __onigWasmFallbackInstalled?: boolean };
  if (!originalFetch || win.__onigWasmFallbackInstalled) {
    return;
  }
  win.__onigWasmFallbackInstalled = true;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const isOnigWasm = typeof requestUrl === 'string' && /onig\.wasm(?:\?.*)?$/.test(requestUrl);

    if (!isOnigWasm) {
      return originalFetch(input as Request, init);
    }
    try {
      const response = await originalFetch(input as Request, init);
      if (response.ok) {
        return response;
      }
    } catch {
      // 直接 fallback 到我们打包好的 wasm
    }
    return originalFetch(targetUrl, init);
  };
}
