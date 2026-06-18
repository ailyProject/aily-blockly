import { AILY_API_SERVER, AILY_FIRMWARE_INFO_PATH, AILY_MODEL_DETAIL_PATH, DEFAULT_REGION_KEY } from 'shared'

import { getCurrentApiServer } from '../../project'

import type {
	HardwareFirmwareInfo,
	HardwareFirmwareRequest,
	HardwareModelDetailInfo,
	HardwareModelFileRequest,
	HardwareModelSnapshot,
	HardwareXiaoType
} from './types'

const normalizeUrlProtocol = (url: string) => url.replace(/^http:/, 'https:')

const resolveHardwareApiBase = (config?: HardwareFirmwareRequest['config'] | HardwareModelFileRequest['config']) =>
	(getCurrentApiServer(config?.regions, config?.region, DEFAULT_REGION_KEY) || AILY_API_SERVER).replace(/\/$/, '')

/**
 * 获取固件信息。
 * @param {HardwareFirmwareRequest} input - 固件请求参数
 * @returns {Promise<HardwareFirmwareInfo | null>}
 */
export const getHardwareFirmwareInfo = async (input: HardwareFirmwareRequest): Promise<HardwareFirmwareInfo | null> => {
	try {
		const params = new URLSearchParams({
			firmwareType: input.firmwareType,
			version: input.version || '',
			appid: '131'
		})
		const response = await fetch(
			`${resolveHardwareApiBase(input.config)}${AILY_FIRMWARE_INFO_PATH}?${params.toString()}`
		)
		if (!response.ok) return null

		const payload = (await response.json()) as { status?: number | string; data?: Record<string, unknown> }
		if (payload.status !== 200 && payload.status !== '200') return null

		const firmware = { ...(payload.data || {}) } as Record<string, unknown>
		if (!firmware['fwv'] && typeof firmware['version'] === 'string') firmware['fwv'] = firmware['version']

		if (typeof firmware['resource_url'] === 'string' && firmware['resource_url'].length > 0) {
			try {
				const resourceUrl = normalizeUrlProtocol(firmware['resource_url'])
				const detailResponse = await fetch(`${resourceUrl}?timestamp=${Date.now()}`)
				if (detailResponse.ok) {
					const detail = (await detailResponse.json()) as { filename?: string }
					if (detail.filename) {
						const fileUrl = resourceUrl.split('/').slice(0, -1).join('/')
						firmware['file_url'] = `${fileUrl}/${detail.filename}`
						firmware['filename'] = detail.filename
					}
				}
			} catch {
				/* ignore */
			}
		}

		if (!firmware['file_url'] && typeof firmware['url'] === 'string') {
			firmware['file_url'] = firmware['url']
		}

		return firmware as HardwareFirmwareInfo
	} catch {
		return null
	}
}

/**
 * 获取模型文件元数据。
 * @param {HardwareModelFileRequest} input - 模型文件请求参数
 * @returns {Promise<{snapshot: HardwareModelSnapshot, detail: HardwareModelDetailInfo} | null>}
 */
export const getHardwareModelFile = async (
	input: HardwareModelFileRequest
): Promise<{ snapshot: HardwareModelSnapshot; detail: HardwareModelDetailInfo } | null> => {
	try {
		const params = new URLSearchParams({ model_id: input.modelId })
		const response = await fetch(
			`${resolveHardwareApiBase(input.config)}${AILY_MODEL_DETAIL_PATH}?${params.toString()}`
		)
		if (!response.ok) return null

		const payload = (await response.json()) as { status?: number | string; data?: Record<string, unknown> }
		if (payload.status !== 200 && payload.status !== '200') return null

		const detail = (payload.data || {}) as Record<string, unknown>
		const snapshot: HardwareModelSnapshot = {
			model_id: String(detail['model_id'] || detail['id'] || input.modelId),
			version: String(detail['version'] || detail['v'] || ''),
			arguments: {
				url: String(detail['file_url'] || detail['url'] || ''),
				icon: typeof detail['pic_url'] === 'string' ? detail['pic_url'] : undefined
			},
			checksum:
				typeof detail['checksum'] === 'string'
					? detail['checksum']
					: typeof detail['md5'] === 'string'
						? detail['md5']
						: undefined,
			model_format: String(detail['model_format'] || detail['format'] || ''),
			ai_framwork: String(detail['ai_framwork'] || detail['ai_framework'] || '')
		}

		return {
			snapshot,
			detail: detail as HardwareModelDetailInfo
		}
	} catch {
		return null
	}
}

/**
 * 获取模型烧录地址。
 * @param {HardwareXiaoType} xiaoType - XIAO 设备类型
 * @returns {number}
 */
export const getHardwareModelAddress = (xiaoType: HardwareXiaoType) => (xiaoType === 2 ? 0x500000 : 0x400000)

/**
 * 判断是否需要更新固件。
 * @param {string | undefined} currentVersion - 当前版本
 * @param {string} latestVersion - 最新版本
 * @returns {boolean}
 */
export const needHardwareFirmwareUpdate = (currentVersion: string | undefined, latestVersion: string) =>
	!currentVersion || currentVersion !== latestVersion
