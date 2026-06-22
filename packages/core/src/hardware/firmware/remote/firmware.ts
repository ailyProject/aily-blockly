import { AILY_FIRMWARE_INFO_PATH } from 'shared'

import { normalizeHardwareFirmwareUrlProtocol, resolveHardwareApiBase } from './shared'

import type { HardwareFirmwareInfo, HardwareFirmwareRequest } from '../types'

/**
 * 获取固件信息。
 * @param input - 固件请求参数
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
				const resourceUrl = normalizeHardwareFirmwareUrlProtocol(firmware['resource_url'])
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
