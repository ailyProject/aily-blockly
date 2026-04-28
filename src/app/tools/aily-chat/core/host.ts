/**
 * Aily Host — 全局宿主 API 访问器
 *
 * 提供单例访问点，让工具文件和服务可以使用 `AilyHost.get().fs` 等
 * 替代 `window['fs']` 等直接全局调用。
 *
 * 在 Angular 环境中由 aily-chat 组件初始化时调用 AilyHost.init(adapter)。
 * 在 CLI / MCP 环境中由入口脚本初始化。
 */

import { IAilyHostAPI } from './host-api';

let _instance: IAilyHostAPI | null = null;

export const AilyHost = {
  /**
   * 初始化宿主 API 实例。应在应用启动时调用一次。
   */
  init(host: IAilyHostAPI): void {
    _instance = host;
  },

  /**
   * 获取宿主 API 实例。
   * 如未初始化，返回一个基于 window[] 的降级实现（兼容过渡期）。
   */
  get(): IAilyHostAPI {
    if (_instance) {
      return _instance;
    }
    // 降级：过渡期直接代理到 window[]，确保未初始化时不崩溃
    return _fallback;
  },

  /**
   * 是否已初始化
   */
  isInitialized(): boolean {
    return _instance !== null;
  },
};

/**
 * 降级实现 — 直接代理到 window['xxx']。
 * 仅在过渡期使用，最终目标是所有环境都通过 AilyHost.init() 显式初始化。
 */
const _fallback: IAilyHostAPI = {
  get fs() { return (window as any)['fs']; },
  get path() { return (window as any)['path']; },
  get terminal() { return (window as any)['terminal']; },
  get dialog() { return (window as any)['dialog']; },
  get platform() { return (window as any)['platform']; },
  get project() { return (window as any)['prjService']?.project ?? {}; },
  get auth() { return {} as any; },
  get config() { return {} as any; },
  get builder() { return {} as any; },
  get notification() { return {} as any; },
  get env() { return (window as any)['env']; },
  get shell() { return (window as any)['other']; },
  get editor() { return undefined; },
  get mcp() { return (window as any)['mcp']; },
};
