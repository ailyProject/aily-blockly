import type { FfsFilesystemType, FfsPartitionInfo } from './types'

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
