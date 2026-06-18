/**
 * 串口监视器页面快照
 */
export interface SerialMonitorSnapshot {
	/** 当前串口波特率 */
	baudRate: string
	/** 连接参数中的波特率 */
	connectBaudRate: number
	/** 当前是否自动滚动 */
	autoScroll: boolean
	/** 当前是否启用十六进制输入 */
	hexInput: boolean
	/** 预览写回后的串口端口 */
	previewPort: string
	/** 快捷发送条目数量 */
	quickSendCount: number
	/** 当前工具栏应用数量 */
	toolbarAppCount: number
	/** 当前可见工具栏应用数量 */
	visibleToolbarAppCount: number
	/** 默认布局工具栏应用数量 */
	defaultToolbarAppCount: number
	/** 合并排序后的工具栏应用数量 */
	mergedToolbarOrderCount: number
	/** toggle 动作后的工具栏应用数量 */
	toggledToolbarAppCount: number
	/** reset 动作后的工具栏应用数量 */
	resetToolbarAppCount: number
	/** desktop 串口列表数量 */
	serialPortCount: number
	/** desktop 当前宿主平台 */
	serialPlatform: string
	/** desktop 串口宿主是否可用 */
	desktopSerialAvailable: boolean
}
