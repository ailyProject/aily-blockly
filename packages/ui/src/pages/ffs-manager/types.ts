import type { Core } from '@/utils/core'
import type { WritableSignal } from '@angular/core'
import type { FfsPartitionInfo } from '@core'

/**
 * Flash FS 页面串口摘要
 */
export interface FfsManagerSerialSummary {
	/** 当前串口端口 */
	port: string
	/** 当前串口波特率 */
	baudRate: string
}

/**
 * Flash FS 页面连接参数摘要
 */
export interface FfsManagerConnectSummary {
	/** 准备连接的串口路径 */
	path: string
	/** 准备连接的波特率 */
	baudRate: number
}

/**
 * Flash FS 页面波特率解析摘要
 */
export interface FfsManagerBaudSummary {
	/** 用户原始请求的波特率 */
	requestedBaudRate: number
	/** 当前最终应使用的波特率 */
	resolvedBaudRate: number
	/** 当前是否发生自动降速 */
	capped: boolean
	/** 探测到的桥接芯片显示名 */
	bridgeName: string
}

/**
 * Flash FS 页面空白挂载预览摘要
 */
export interface FfsManagerPreviewSummary {
	/** 当前预览对应的分区定义 */
	partition: FfsPartitionInfo
	/** 当前预览的文件系统类型 */
	type: string
	/** 当前预览分区标签 */
	partitionLabel: string
	/** 当前挂载推断出的块大小 */
	blockSize: number | null
	/** 当前挂载后文件数量 */
	fileCount: number
	/** 当前容量总字节数 */
	capacityBytes: number | null
	/** 当前已使用字节数 */
	usedBytes: number | null
	/** 当前挂载尝试次数 */
	attemptCount: number
	/** 当前挂载尝试说明 */
	attemptReasons: Array<string>
	/** 当前文件列表 */
	files: Array<FfsExplorerEntry>
}

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

/**
 * Flash FS 页面展示状态
 */
export interface FfsManagerState {
	/** 当前串口摘要 */
	serial: FfsManagerSerialSummary
	/** 当前准备连接参数 */
	connect: FfsManagerConnectSummary
	/** 当前波特率解析摘要 */
	baud: FfsManagerBaudSummary
	/** 当前宿主可见串口数量 */
	serialPortCount: number
	/** 当前空白挂载预览摘要 */
	preview: FfsManagerPreviewSummary
}

/**
 * FFS 页面交互所需的上下文。
 */
export interface FfsManagerHandlerContext {
	core: Core
	state: WritableSignal<FfsManagerState | null>
	imageBytes: WritableSignal<Uint8Array | null>
	imageName: WritableSignal<string | null>
	previewText: WritableSignal<string | null>
	previewFilePath: WritableSignal<string | null>
	actionMessage: WritableSignal<string | null>
	previewBusy: WritableSignal<boolean>
	currentPath: WritableSignal<string>
}
