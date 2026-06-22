import { normalizeHardwareProbeRsListResult } from '../normalize'
import { hasHardwareProbeRsBinary, runHardwareProbeRs } from './shared'

import type { HardwareProbeRsListResult, HardwareProbeRsProbe } from '../types'

const parseHardwareProbeList = (output: string): Array<HardwareProbeRsProbe> =>
	output
		.split(/\r?\n/)
		.filter(line => /^\s*\[\d+\]/.test(line))
		.map(line => {
			const match = line.match(
				/\[(\d+)\]:\s+(.*?)\s+--\s+([0-9a-fA-F]{4}:[0-9a-fA-F]{4})(?:(?:-\d+)?:(\S+))?\s+\(([^)]+)\)/
			)
			if (!match) return { index: null, raw: line.trim() }

			return {
				index: Number.parseInt(match[1], 10),
				name: match[2].trim(),
				vidPid: match[3],
				serial: match[4] || null,
				shortSerial: match[4] ? match[4].slice(0, 12) : null,
				type: match[5]
			}
		})

/**
 * 获取 probe-rs 设备列表。
 */
export const listHardwareProbeRs = async (): Promise<HardwareProbeRsListResult> => {
	if (!hasHardwareProbeRsBinary()) {
		return { success: false, error: 'probe-rs binary is unavailable' }
	}

	try {
		const { stdout, stderr } = await runHardwareProbeRs(['list'])
		const probes = parseHardwareProbeList(stdout || stderr)
		return normalizeHardwareProbeRsListResult({ success: true, count: probes.length, probes })
	} catch (error) {
		return normalizeHardwareProbeRsListResult({
			success: false,
			error: (error as { message?: string }).message || 'probe-rs list failed'
		})
	}
}
