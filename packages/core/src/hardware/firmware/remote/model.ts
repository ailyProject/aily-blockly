import { AILY_MODEL_DETAIL_PATH } from 'shared'

import { resolveHardwareApiBase } from './shared'

import type {
	HardwareModelDetailInfo,
	HardwareModelFileRequest,
	HardwareModelSnapshot,
	HardwareXiaoType
} from '../types'

/**
 * 获取模型文件元数据。
 * @param input - 模型文件请求参数
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
 * @param xiaoType - XIAO 设备类型
 */
export const getHardwareModelAddress = (xiaoType: HardwareXiaoType) => (xiaoType === 2 ? 0x500000 : 0x400000)

/**
 * 判断是否需要更新固件。
 * @param currentVersion - 当前版本
 * @param latestVersion - 最新版本
 */
export const needHardwareFirmwareUpdate = (currentVersion: string | undefined, latestVersion: string) =>
	!currentVersion || currentVersion !== latestVersion
