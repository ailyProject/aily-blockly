import type {
	HardwareProbeRsDownloadOptions,
	HardwareProbeRsDownloadResult,
	HardwareProbeRsListResult,
	HardwareProbeRsProbe
} from './types'

const shortenSerial = (serial: string | null | undefined) => {
	if (!serial) return null
	return serial.length > 8 ? serial.slice(-8) : serial
}

/**
 * 规范化 probe-rs 设备列表结果。
 * @param {HardwareProbeRsListResult} result - 原始列表结果
 * @returns {HardwareProbeRsListResult}
 */
export const normalizeHardwareProbeRsListResult = (result: HardwareProbeRsListResult): HardwareProbeRsListResult => ({
	...result,
	probes: result.probes?.map(probe => ({
		...probe,
		shortSerial: probe.shortSerial || shortenSerial(probe.serial)
	}))
})

/**
 * 构建 probe 标识。
 * @param {{vidPid?: string, serial?: string | null}} probe - probe 信息
 * @returns {string | undefined}
 */
export const buildHardwareProbeTarget = (probe: { vidPid?: string; serial?: string | null }) =>
	probe.vidPid ? `${probe.vidPid}${probe.serial ? `:${probe.serial}` : ''}` : undefined

/**
 * 规范化 probe-rs 下载参数。
 * @param {HardwareProbeRsDownloadOptions} options - 原始下载参数
 * @returns {HardwareProbeRsDownloadOptions}
 */
export const normalizeHardwareProbeRsDownloadOptions = (
	options: HardwareProbeRsDownloadOptions
): HardwareProbeRsDownloadOptions => ({
	chip: options.chip || undefined,
	probe: options.probe || undefined,
	protocol: options.protocol || undefined,
	speed: options.speed || undefined,
	format: options.format || undefined,
	baseAddress: options.baseAddress || undefined,
	skipBytes: options.skipBytes || undefined,
	verify: options.verify ?? true,
	firmwarePath: options.firmwarePath
})

/**
 * 规范化 probe-rs 下载结果。
 * @param {HardwareProbeRsDownloadResult} result - 原始下载结果
 * @returns {HardwareProbeRsDownloadResult}
 */
export const normalizeHardwareProbeRsDownloadResult = (
	result: HardwareProbeRsDownloadResult
): HardwareProbeRsDownloadResult => ({
	...result,
	message: result.message || (result.success ? '下载成功' : result.error || '下载失败')
})
