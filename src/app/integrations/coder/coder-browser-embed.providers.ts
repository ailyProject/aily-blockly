import { InjectionToken } from '@angular/core';

export interface CoderBrowserEmbedConfiguration {
  readonly editorURL: string;
  readonly bridgeModuleURL: string;
}

/** Supplied only by trusted application deployment, never a route/message. */
export const CODER_BROWSER_EMBED_CONFIGURATION = new InjectionToken<CoderBrowserEmbedConfiguration | null>(
  'CODER_BROWSER_EMBED_CONFIGURATION', { providedIn: 'root', factory: () => null });

export function captureCoderBrowserEmbedConfiguration(value: CoderBrowserEmbedConfiguration, parentOrigin: string): Readonly<CoderBrowserEmbedConfiguration> {
  const editor = new URL(value.editorURL), module = new URL(value.bridgeModuleURL);
  const secure = (url: URL) => url.protocol === 'https:' || url.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (Object.keys(value).sort().join(',') !== 'bridgeModuleURL,editorURL'
    || !secure(editor) || !secure(module) || editor.href !== value.editorURL || module.href !== value.bridgeModuleURL
    || editor.username || editor.password || editor.search || editor.hash
    || module.username || module.password || module.search || module.hash
    || editor.origin !== parentOrigin || editor.origin !== module.origin || /[%\\]/.test(editor.href + module.href)
    || !editor.pathname.endsWith('/') || module.href !== new URL('browser-project-port.mjs', editor).href) {
    throw new TypeError('Explicit canonical editor directory and same-base bridge URLs on the parent page origin are required.');
  }
  return Object.freeze({ editorURL: editor.href, bridgeModuleURL: module.href });
}
