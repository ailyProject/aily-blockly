import { formatFfsBytes } from './format'

import type {
	FfsFilesystemLabelInput,
	FfsFilesystemType,
	FfsPartitionCategory,
	FfsPartitionCollectionSummary,
	FfsPartitionInfo,
	FfsPartitionSummary
} from './types'

/**
 * 将文件系统类型转换为展示标签。
 * @param type - 文件系统类型
 */
export const getFfsFilesystemLabel = (type: FfsFilesystemLabelInput) => {
	if (type === 'spiffs') return 'SPIFFS'
	if (type === 'littlefs') return 'LittleFS'
	if (type === 'fatfs') return 'FATFS'
	return 'NORMAL'
}

/**
 * 解析分区的渲染分类。
 * @param partition - 分区信息
 */
export const getFfsPartitionCategory = (partition: FfsPartitionInfo): FfsPartitionCategory => {
	if (partition.filesystemType) return partition.filesystemType

	const subtypeName = partition.subtypeName.toLowerCase()
	const typeName = partition.typeName.toLowerCase()
	if (typeName === 'app' || subtypeName.startsWith('ota_') || subtypeName === 'factory' || subtypeName === 'test') {
		return 'app'
	}

	if (subtypeName === 'nvs' || subtypeName === 'nvs_keys') return 'nvs'
	if (subtypeName === 'ota') return 'otadata'
	if (subtypeName === 'phy') return 'phy'
	if (subtypeName === 'coredump') return 'coredump'
	if (subtypeName === 'bootloader') return 'bootloader'
	return 'normal'
}

/**
 * 计算分区占总大小的百分比。
 * @param partition - 分区信息
 * @param totalSize - 全部分区总大小
 */
export const calculateFfsPartitionHeight = (partition: FfsPartitionInfo, totalSize: number) =>
	totalSize > 0 ? (partition.size / totalSize) * 100 : 0

/**
 * 汇总分区集合的统计与渲染信息。
 * @param partitions - 分区列表
 */
export const summarizeFfsPartitions = (partitions: Array<FfsPartitionInfo>): FfsPartitionCollectionSummary => {
	const totalSize = partitions.reduce((sum, partition) => sum + partition.size, 0)
	const filesystemPartitions = partitions.filter(partition => partition.filesystemType !== null)
	const appSize = partitions
		.filter(partition => partition.typeName === 'app')
		.reduce((sum, partition) => sum + partition.size, 0)
	const filesystemSize = filesystemPartitions.reduce((sum, partition) => sum + partition.size, 0)
	const filesystemTypes = Array.from(
		new Set(filesystemPartitions.map(partition => getFfsFilesystemLabel(partition.filesystemType)))
	)

	const partitionSummaries: Array<FfsPartitionSummary> = partitions.map(partition => ({
		partition,
		category: getFfsPartitionCategory(partition),
		heightPercent: calculateFfsPartitionHeight(partition, totalSize)
	}))

	return {
		totalSize,
		totalSizeText: formatFfsBytes(totalSize),
		appSize,
		appSizeText: formatFfsBytes(appSize),
		filesystemSize,
		filesystemSizeText: formatFfsBytes(filesystemSize),
		filesystemTypes,
		filesystemPartitions,
		partitions: partitionSummaries
	}
}
