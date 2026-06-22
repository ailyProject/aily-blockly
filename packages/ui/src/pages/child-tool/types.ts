import type { SafeResourceUrl } from '@angular/platform-browser'
import type { ChildToolHostInfo, ChildToolItem } from 'shared'

export type ChildToolListItem = ChildToolItem
export type ChildToolPageHostInfo = ChildToolHostInfo

/**
 * 子工具页面展示状态
 */
export interface ChildToolPageState {
	/** 当前匹配到的子工具 */
	tool: ChildToolListItem | null
	/** 当前实际加载的原始 URL */
	url: string | null
	/** 当前 URL 对应的源 */
	origin: string | null
	/** 可绑定到 iframe 的安全资源 URL */
	frameUrl: SafeResourceUrl | null
	/** 当前真实宿主信息 */
	hostInfo?: ChildToolPageHostInfo | null
	/** 当前页面是否在使用真实宿主 */
	usingHost?: boolean
}
