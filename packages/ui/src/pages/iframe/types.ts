import type { SafeResourceUrl } from '@angular/platform-browser'

/**
 * Iframe 页面展示状态
 */
export interface IframePageState {
	/** 当前实际加载的标题 */
	title: string
	/** 当前实际加载的原始 URL */
	url: string
	/** 当前 URL 对应的源 */
	origin: string
	/** 可绑定到 iframe 的安全资源 URL */
	frameUrl: SafeResourceUrl
}
