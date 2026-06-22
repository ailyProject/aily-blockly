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

/**
 * 文件系统挂载尝试参数。
 */
export interface FfsMountAttempt {
	/** 本次尝试的块大小。 */
	blockSize: number
	/** 由镜像大小推导出的块数量。 */
	blockCount: number
	/** SPIFFS 场景下的页大小。 */
	pageSize?: number
	/** 当前尝试的语义说明。 */
	reason: string
}

/**
 * 文件系统挂载计划。
 */
export interface FfsMountPlan {
	/** 目标文件系统类型。 */
	type: FfsFilesystemType
	/** 当前镜像是否为空白镜像。 */
	blankImage: boolean
	/** 底层客户端应使用的根路径。 */
	clientRootPath: string
	/** 当前建议的挂载尝试列表。 */
	attempts: Array<FfsMountAttempt>
}

/**
 * 分区渲染分类。
 */
export type FfsPartitionCategory =
	/** SPIFFS 分区。 */
	| 'spiffs'
	/** LittleFS 分区。 */
	| 'littlefs'
	/** FATFS 分区。 */
	| 'fatfs'
	/** 应用固件分区。 */
	| 'app'
	/** 引导分区。 */
	| 'bootloader'
	/** NVS / NVS Keys 分区。 */
	| 'nvs'
	/** OTA 数据分区。 */
	| 'otadata'
	/** PHY 初始化数据分区。 */
	| 'phy'
	/** Core dump 分区。 */
	| 'coredump'
	/** 其它普通分区。 */
	| 'normal'

/**
 * 分区渲染摘要。
 */
export interface FfsPartitionSummary {
	/** 原始分区信息。 */
	partition: FfsPartitionInfo
	/** 当前分区渲染分类。 */
	category: FfsPartitionCategory
	/** 当前分区占总 flash 的百分比。 */
	heightPercent: number
}

/**
 * 分区集合统计摘要。
 */
export interface FfsPartitionCollectionSummary {
	/** 全部分区累计大小。 */
	totalSize: number
	/** 全部分区累计大小展示值。 */
	totalSizeText: string
	/** 应用分区累计大小。 */
	appSize: number
	/** 应用分区累计大小展示值。 */
	appSizeText: string
	/** 文件系统分区累计大小。 */
	filesystemSize: number
	/** 文件系统分区累计大小展示值。 */
	filesystemSizeText: string
	/** 当前识别出的文件系统类型标签。 */
	filesystemTypes: Array<string>
	/** 当前识别出的文件系统分区列表。 */
	filesystemPartitions: Array<FfsPartitionInfo>
	/** 每个分区的渲染摘要。 */
	partitions: Array<FfsPartitionSummary>
}

/**
 * 将文件系统类型转换为展示标签的输入类型。
 */
export type FfsFilesystemLabelInput = FfsFilesystemType | null | undefined
