import type { WorkspaceChildToolItem } from '@/workspace'
import type { SafeResourceUrl } from '@angular/platform-browser'

/**
 * 子工具页面展示状态
 */
export interface ChildToolPageState {
	/** 当前匹配到的子工具 */
	tool: WorkspaceChildToolItem | null
	/** 当前实际加载的原始 URL */
	url: string | null
	/** 当前 URL 对应的源 */
	origin: string | null
	/** 可绑定到 iframe 的安全资源 URL */
	frameUrl: SafeResourceUrl | null
}
