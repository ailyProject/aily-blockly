/**
 * Flash FS 资源浏览条目。
 */
export interface FfsExplorerEntry {
	/** 当前条目名称。 */
	name: string
	/** 当前条目完整路径。 */
	fullPath: string
	/** 当前条目类型。 */
	type: 'file' | 'dir'
	/** 当前条目大小展示文本。 */
	sizeText: string
	/** 当前条目原始字节大小。 */
	size: number
	/** 当前条目预览模式。 */
	previewMode: 'text' | 'image' | 'audio' | null
}

/**
 * Flash FS 面包屑条目。
 */
export interface FfsExplorerBreadcrumb {
	/** 展示名称。 */
	name: string
	/** 跳转目标路径。 */
	path: string
}
