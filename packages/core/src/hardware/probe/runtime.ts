import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import {
	normalizeHardwareProbeRsDownloadOptions,
	normalizeHardwareProbeRsDownloadResult,
	normalizeHardwareProbeRsListResult
} from './normalize'

import type {
	HardwareProbeRsDownloadOptions,
	HardwareProbeRsDownloadResult,
	HardwareProbeRsListResult,
	HardwareProbeRsProbe
} from './types'

/**
 * 解析 probe-rs 二进制路径。
 * @returns {string}
 */
export const resolveHardwareProbeRsPath = () => {
	const childPath = process.env['AILY_CHILD_PATH'] || path.join(process.cwd(), 'child')
	const ext = process.platform === 'win32' ? '.exe' : ''
	return path.join(childPath, 'probe-rs', `probe-rs${ext}`)
}

/**
 * 检查 probe-rs 二进制是否可用。
 * @returns {boolean}
 */
export const hasHardwareProbeRsBinary = () => existsSync(resolveHardwareProbeRsPath())

const runHardwareProbeRs = (args: Array<string>) =>
	new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		execFile(resolveHardwareProbeRsPath(), args, { encoding: 'utf-8', timeout: 120_000 }, (error, stdout, stderr) => {
			if (error) {
				reject({ message: stderr.trim() || error.message, stdout: stdout.trim() })
				return
			}

			resolve({ stdout: stdout.trim(), stderr: stderr.trim() })
		})
	})

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
 * @returns {Promise<HardwareProbeRsListResult>}
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

/**
 * 使用 probe-rs 下载固件。
 * @param {HardwareProbeRsDownloadOptions} options - 下载参数
 * @returns {Promise<HardwareProbeRsDownloadResult>}
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
