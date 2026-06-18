import type { SafeResourceUrl } from '@angular/platform-browser'

/**
 * 子工具目录条目
 */
export interface ChildToolListItem {
	/** 子工具唯一标识 */
	id: string
	/** 子工具显示标题 */
	title: string
	/** 子工具用途摘要 */
	summary: string
	/** 子工具启动路径 */
	launchPath: string
}

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
}
