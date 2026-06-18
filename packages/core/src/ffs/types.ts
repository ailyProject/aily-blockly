/**
 * Flash FS 支持的文件系统类型。
 */
export type FfsFilesystemType =
	/** SPIFFS 分区。 */
	| 'spiffs'
	/** LittleFS 分区。 */
	| 'littlefs'
	/** FATFS 分区。 */
	| 'fatfs'

/**
 * Flash FS 文件条目类型。
 */
export type FfsFileEntryType =
	/** 普通文件。 */
	| 'file'
	/** 目录。 */
	| 'dir'

/**
 * Flash FS 中的标准化文件条目。
 */
export interface FfsFileEntry {
	/** 当前条目名称。 */
	name: string
	/** 当前条目的绝对路径。 */
	path: string
	/** 当前条目的类型。 */
	type: FfsFileEntryType
	/** 文件大小；目录固定为 0。 */
	size: number
	/** 人类可读的大小展示值。 */
	sizeText: string
}

/**
 * Flash FS 容量统计摘要。
 */
export interface FfsFilesystemUsage {
	/** 总容量字节数。 */
	capacityBytes: number
	/** 已使用字节数。 */
	usedBytes: number
	/** 剩余可用字节数。 */
	freeBytes: number
	/** 总容量展示值。 */
	capacityText: string
	/** 已使用容量展示值。 */
	usedText: string
	/** 剩余容量展示值。 */
	freeText: string
	/** 已使用容量百分比。 */
	usedPercent: number
}

/**
 * FFS 解析后的分区信息。
 */
export interface FfsPartitionInfo {
	/** 分区在当前表中的顺序索引。 */
	index: number
	/** 分区标签。 */
	label: string
	/** 原始分区类型值。 */
	type: number
	/** 原始分区子类型值。 */
	subtype: number
	/** 归一化后的分区类型名称。 */
	typeName: string
	/** 归一化后的分区子类型名称。 */
	subtypeName: string
	/** 分区起始偏移。 */
	offset: number
	/** 分区大小。 */
	size: number
	/** 原始分区标记位。 */
	flags: number
	/** 十六进制格式的偏移展示值。 */
	offsetHex: string
	/** 十六进制格式的大小展示值。 */
	sizeHex: string
	/** 人类可读的大小展示值。 */
	sizeText: string
	/** 根据类型、子类型和标签推断出的文件系统类型。 */
	filesystemType: FfsFilesystemType | null
}

/**
 * 已挂载的文件系统会话。
 */
export interface FfsMountedFilesystem<TClient = unknown> {
	/** 当前文件系统类型。 */
	type: FfsFilesystemType
	/** 当前挂载对应的分区。 */
	partition: FfsPartitionInfo
	/** 底层文件系统客户端。 */
	client: TClient
	/** 当前挂载对应的镜像副本。 */
	image: Uint8Array
	/** 当前挂载推断出的块大小。 */
	blockSize?: number
	/** 当前文件列表快照。 */
	files: Array<FfsFileEntry>
	/** 当前容量统计快照。 */
	usage: FfsFilesystemUsage | null
}
