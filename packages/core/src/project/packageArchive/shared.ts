import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'

const PROJECT_ARCHIVE_RETRY_LIMIT = 5
const PROJECT_ARCHIVE_RETRY_DELAY_MS = 300

const sleep = (timeout: number) => new Promise(resolve => setTimeout(resolve, timeout))

/**
 * 等待归档文件真正落盘并返回最终字节数。
 * @param archivePath - 目标归档路径
 */
export const ensurePackagedArchiveFile = async (archivePath: string) => {
	if (!existsSync(archivePath)) {
		throw new Error(`项目归档生成失败: ${archivePath}`)
	}

	let fileStat = await stat(archivePath)
	let retryCount = 0
	while (fileStat.size === 0 && retryCount < PROJECT_ARCHIVE_RETRY_LIMIT) {
		await sleep(PROJECT_ARCHIVE_RETRY_DELAY_MS)
		fileStat = await stat(archivePath)
		retryCount += 1
	}

	if (fileStat.size === 0) {
		throw new Error(`项目归档为空: ${archivePath}`)
	}

	return fileStat.size
}
