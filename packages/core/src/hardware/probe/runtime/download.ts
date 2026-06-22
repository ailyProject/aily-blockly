import path from 'node:path'

import { normalizeHardwareProbeRsDownloadOptions, normalizeHardwareProbeRsDownloadResult } from '../normalize'
import { hasHardwareProbeRsBinary, runHardwareProbeRs } from './shared'

import type { HardwareProbeRsDownloadOptions, HardwareProbeRsDownloadResult } from '../types'

/**
 * 使用 probe-rs 下载固件。
 * @param options - 下载参数
 */
export const downloadWithHardwareProbeRs = async (
	options: HardwareProbeRsDownloadOptions
): Promise<HardwareProbeRsDownloadResult> => {
	if (!hasHardwareProbeRsBinary()) {
		return { success: false, error: 'probe-rs binary is unavailable' }
	}

	const normalized = normalizeHardwareProbeRsDownloadOptions(options)
	const args = ['download', normalized.firmwarePath]
	if (normalized.chip) args.push('--chip', normalized.chip)
	if (normalized.probe) args.push('--probe', normalized.probe)
	if (normalized.protocol) args.push('--protocol', normalized.protocol)
	if (normalized.speed) args.push('--speed', String(normalized.speed))
	if (normalized.format) args.push('--format', normalized.format)
	if (normalized.baseAddress) args.push('--base-address', String(normalized.baseAddress))
	if (normalized.skipBytes) args.push('--skip', String(normalized.skipBytes))
	if (normalized.verify) args.push('--verify')

	try {
		const { stdout, stderr } = await runHardwareProbeRs(args)
		return normalizeHardwareProbeRsDownloadResult({
			success: true,
			firmware: path.resolve(normalized.firmwarePath),
			chip: normalized.chip || 'auto',
			message: stdout || stderr || '烧录完成'
		})
	} catch (error) {
		const detail = error as { message?: string; stdout?: string }
		return normalizeHardwareProbeRsDownloadResult({
			success: false,
			firmware: path.resolve(normalized.firmwarePath),
			chip: normalized.chip || 'auto',
			error: detail.message || 'probe-rs download failed',
			detail: detail.stdout || null
		})
	}
}
