import { buildFfsMountPlan, listMountedFfsFiles, readMountedFfsUsage } from '..'
import { createFatfsClient, createLittlefsClient, createSpiffsClient } from './clients'

import type { FfsMountedFilesystem, FfsPartitionInfo } from '..'
import type { FfsRuntimeClient } from './filesystem.types'

/**
 * 挂载分区镜像并返回统一文件系统会话。
 * @param options - 挂载输入
 */
export const mountFfsFilesystem = async (options: {
	partition: FfsPartitionInfo
	image: Uint8Array
}): Promise<FfsMountedFilesystem<FfsRuntimeClient>> => {
	if (!options.partition.filesystemType) {
		throw new Error('请选择 SPIFFS / LittleFS / FATFS 文件系统分区')
	}

	const plan = buildFfsMountPlan(options.partition.filesystemType, options.image)
	let lastError: unknown = null

	for (const attempt of plan.attempts) {
		try {
			const client = await createRuntimeClient({
				type: plan.type,
				image: plan.blankImage ? undefined : options.image,
				blockSize: attempt.blockSize,
				blockCount: attempt.blockCount,
				pageSize: attempt.pageSize
			})
			const filesystem: FfsMountedFilesystem<FfsRuntimeClient> = {
				type: plan.type,
				partition: options.partition,
				client,
				image: options.image,
				blockSize: attempt.blockSize,
				files: [],
				usage: null
			}

			filesystem.files = await listMountedFfsFiles(filesystem)
			filesystem.usage = await readMountedFfsUsage(filesystem)
			return filesystem
		} catch (error) {
			lastError = error
		}
	}

	throw lastError ?? new Error(`Unable to mount ${plan.type} filesystem`)
}

const createRuntimeClient = (options: {
	type: FfsPartitionInfo['filesystemType']
	image?: Uint8Array
	blockSize: number
	blockCount: number
	pageSize?: number
}) => {
	if (options.type === 'spiffs') {
		return createSpiffsClient({
			image: options.image,
			pageSize: options.pageSize ?? 256,
			blockSize: options.blockSize,
			blockCount: options.blockCount
		})
	}

	if (options.type === 'littlefs') {
		return createLittlefsClient({
			image: options.image,
			blockSize: options.blockSize,
			blockCount: options.blockCount
		})
	}

	return createFatfsClient({
		image: options.image,
		blockSize: options.blockSize,
		blockCount: options.blockCount
	})
}
