/**
 * 注册位于 `public/vscode/extensions/` 下的内置 VSCode 扩展，
 * 让 monaco 编辑器获得对应文件类型的语法/语言/主题/片段支持。
 *
 * 必须在 `@codingame/monaco-vscode-api` 的 `initialize()` 之前调用：
 * 此时 `servicesInitialized` 仍为 false，扩展会被缓存到 `builtinExtensions`，
 * 由 `ExtensionsServiceOverride` 在启动期间统一扫描并触发 grammars/languages 等扩展点。
 */
import {
  ExtensionHostKind,
  registerExtension,
  type IExtensionContributions,
  type IExtensionManifest,
  type RegisterLocalExtensionResult
} from '@codingame/monaco-vscode-api/extensions';

/**
 * 库自带的类型声明只暴露了 `(path, url) => IDisposable`，
 * 但运行时实现支持第三个 `metadataOrMimeType` 参数。这里用本地类型补齐。
 */
type RegisterFileUrlFn = (path: string, url: string, mimeType?: string) => unknown;

/** 内置扩展所在的 web 根路径（angular.json 已将 `public/` 映射到根） */
const PUBLIC_EXTENSIONS_BASE = 'vscode/extensions';

/**
 * 内置扩展清单。仅注册与"语法高亮 + 语言基础"相关的轻量扩展，
 * 避免引入 markdown-language-features 等需要 Node 运行时的重量级包。
 */
const BUILTIN_EXTENSION_FOLDERS = [
  'theme-defaults',
  'json',
  'javascript',
  'cpp',
  'markdown-basics'
] as const;

interface ExtensionFileEntry {
  /** 扩展内的相对路径（不带前导 `./`） */
  path: string;
  /** 实际可下载的 URL */
  url: string;
  /** MIME 类型，影响浏览器解码 */
  mimeType?: string;
}

let registrationPromise: Promise<void> | undefined;

/**
 * 注册全部内置扩展（幂等）。
 */
export function registerPublicVscodeSyntaxExtensions(): Promise<void> {
  if (!registrationPromise) {
    registrationPromise = (async () => {
      await Promise.all(
        BUILTIN_EXTENSION_FOLDERS.map((folder) => registerOneExtension(folder).catch((err) => {
          console.warn(`[vscode-extensions] register "${folder}" failed:`, err);
        }))
      );
    })();
  }
  return registrationPromise;
}

async function registerOneExtension(folder: string): Promise<void> {
  const baseUrl = buildBaseUrl(folder);
  const manifestUrl = `${baseUrl}package.json`;

  const manifest = await fetchJson<IExtensionManifest>(manifestUrl);
  if (manifest == null) {
    return;
  }

  /**
   * `LocalWebWorker` 让扩展贡献的 grammars/languages/themes 进入工作区，
   * 同时不需要本地 Node 进程；适合纯前端运行的语法扩展。
   */
  const handle = registerExtension(
    manifest,
    ExtensionHostKind.LocalWebWorker,
    { system: true }
  ) as RegisterLocalExtensionResult;

  const registerFileUrl = handle.registerFileUrl as unknown as RegisterFileUrlFn | undefined;
  if (typeof registerFileUrl !== 'function') {
    console.warn(`[vscode-extensions] extension "${folder}" host kind missing registerFileUrl`);
    return;
  }

  const files = collectExtensionFiles(manifest, baseUrl);
  /**
   * `registerFileUrl(path, url, mimeType)` 会把扩展内 `extension://<id>/<path>`
   * 的访问重定向到 `url`，TextMate/语言服务读取语法/配置/片段时即可命中。
   *
   * 注意：必须在 monaco-vscode-api 的 `initialize()` 之前完成路径注册，
   * 否则启动阶段 ExtensionsServiceOverride 扫描扩展时找不到资源。
   */
  for (const file of files) {
    try {
      registerFileUrl(file.path, file.url, file.mimeType);
    } catch (err) {
      console.warn(`[vscode-extensions] register file "${file.path}" failed:`, err);
    }
  }
  /**
   * 不调用 `whenReady()`：在 `initialize()` 之前其内部依赖 `waitServicesReady()`，
   * 等待会变成死锁。注册流程本身是同步的，到这里已完成。
   */
}

function buildBaseUrl(folder: string): string {
  /**
   * 用 `import.meta.url` 而非裸字符串，可在子路径部署、Electron file:// 协议下都正确解析。
   * 末尾保留 `/` 方便后续按相对路径拼接扩展资源。
   */
  const url = new URL(`/${PUBLIC_EXTENSIONS_BASE}/${folder}/`, document.baseURI);
  return url.toString();
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn(`[vscode-extensions] fetch ${url} failed: ${response.status}`);
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    console.warn(`[vscode-extensions] fetch ${url} threw:`, err);
    return null;
  }
}

function collectExtensionFiles(manifest: IExtensionManifest, baseUrl: string): ExtensionFileEntry[] {
  const entries: ExtensionFileEntry[] = [];
  const seen = new Set<string>();
  const push = (rawPath: string | undefined, mimeType?: string): void => {
    if (!rawPath) {
      return;
    }
    const normalized = stripLeadingDot(rawPath);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    entries.push({
      path: normalized,
      url: `${baseUrl}${normalized}`,
      mimeType
    });
  };

  /** package.nls.json 用于 `%key%` 占位符的本地化解析 */
  push('package.nls.json', 'application/json');

  const contributes: IExtensionContributions | undefined = manifest.contributes;
  if (!contributes) {
    return entries;
  }

  for (const language of contributes.languages ?? []) {
    push(language.configuration, 'application/json');
  }
  for (const grammar of contributes.grammars ?? []) {
    /** TextMate 语法文件可能是 plist(xml) 或 json，按扩展名区分 */
    const isPlist = grammar.path.endsWith('.tmLanguage') || grammar.path.endsWith('.plist');
    push(grammar.path, isPlist ? 'application/xml' : 'application/json');
  }
  for (const theme of contributes.themes ?? []) {
    push(theme.path, 'application/json');
  }
  for (const iconTheme of contributes.iconThemes ?? []) {
    push(iconTheme.path, 'application/json');
  }
  for (const productIconTheme of contributes.productIconThemes ?? []) {
    push(productIconTheme.path, 'application/json');
  }
  for (const snippet of contributes.snippets ?? []) {
    push(snippet.path, 'application/json');
  }

  if (manifest.icon) {
    push(manifest.icon, guessImageMime(manifest.icon));
  }

  return entries;
}

function stripLeadingDot(p: string): string {
  return p.replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function guessImageMime(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'svg':
      return 'image/svg+xml';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    default:
      return undefined;
  }
}
