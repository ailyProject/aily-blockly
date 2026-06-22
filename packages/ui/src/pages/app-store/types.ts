/**
 * App Store 页面应用条目。
 */
export interface AppStorePageAppItem {
	/** 应用唯一标识。 */
	id: string
	/** 当前是否可见。 */
	visible: boolean
	/** 当前是否已固定到工具栏。 */
	pinned: boolean
	/** 当前是否锁定。 */
	lock: boolean
	/** 当前是否仅开发模式显示。 */
	devOnly: boolean
}

/**
 * App Store 页面状态。
 */
export interface AppStorePageState {
	/** 当前工具栏应用总数。 */
	toolbarCount: number
	/** 当前可见工具栏应用数。 */
	visibleToolbarCount: number
	/** 当前 pinned 工具栏顺序。 */
	pinnedIds: Array<string>
	/** 当前目录中可选应用条目。 */
	apps: Array<AppStorePageAppItem>
}
