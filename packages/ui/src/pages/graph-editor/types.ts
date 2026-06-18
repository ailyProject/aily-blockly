import type { SafeResourceUrl } from '@angular/platform-browser'

/**
 * 连线图页面展示状态
 */
export interface GraphEditorState {
	/** 当前连线图标题 */
	title: string
	/** 当前实际加载的 URL */
	url: string
	/** 当前 URL 对应的源 */
	origin: string
	/** 可绑定到 iframe 的安全资源 URL */
	frameUrl: SafeResourceUrl
	/** 连线图 JSON 文件路径 */
	jsonPath: string
	/** 连线图 AWS 文件路径 */
	awsPath: string
}
