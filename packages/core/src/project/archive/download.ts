import path from 'node:path'
import { AILY_CLOUD_PROJECTS_PATH } from 'shared'

import { createCloudHeaders, resolveCloudApiBase } from '../../cloud/request'

import type { ProjectImportCloudArchiveInput } from './types'

/**
 * 解析归档文件名。
 * @param response - 下载响应
 */
export const parseArchiveFilename = (response: Response) => {
	const disposition = response.headers.get('content-disposition') ?? ''
	const filenameMatch = disposition.match(/filename="?([^"]+)"?/i)
	if (filenameMatch?.[1]) return filenameMatch[1]

	const urlPath = new URL(response.url).pathname
	const basename = path.basename(urlPath)
	return basename.includes('.') ? basename : 'project.7z'
}

/**
 * 解析云项目归档下载地址。
 * @param input - 云项目导入输入
 */
export const resolveCloudArchiveDownloadUrl = (input: ProjectImportCloudArchiveInput) => {
	if (input.archiveUrl?.trim()) {
		return input.archiveUrl.trim()
	}

	if (input.projectId?.trim()) {
		return `${resolveCloudApiBase()}${AILY_CLOUD_PROJECTS_PATH}/${input.projectId.trim()}/download`
	}

	throw new Error('缺少 archiveUrl 或 projectId，无法导入云项目')
}

/**
 * 下载云项目归档响应。
 * @param input - 云项目导入输入
 */
export const downloadCloudArchiveResponse = async (input: ProjectImportCloudArchiveInput) => {
	const archiveUrl = resolveCloudArchiveDownloadUrl(input)
	const response = await fetch(archiveUrl, {
		headers: createCloudHeaders(input.authToken)
	})
	if (!response.ok) {
		throw new Error(`下载云项目失败: ${response.status}`)
	}

	return {
		archiveUrl,
		response
	}
}
