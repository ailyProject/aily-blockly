import { config } from '@/workspace/config'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { TerminalUploadTargetOption } from '../types'

const TERMINAL_UPLOAD_TARGET_STORAGE_KEY = 'aily.terminal.uploadTargetId'

const createDebuggerTargetId = (probeVidPid: string, probeSerial?: string) =>
	`probe:${probeVidPid}${probeSerial ? `:${probeSerial}` : ''}`

const createSerialUploadTarget = (port: { name?: string; text?: string }) =>
	({
		id: port.name || '',
		portType: 'serial',
		label: port.text || port.name || '',
		name: port.name || undefined
	}) satisfies TerminalUploadTargetOption

const createDebuggerUploadTarget = (probe: {
	name?: string
	vidPid?: string
	shortSerial?: string | null
	serial?: string | null
}) =>
	({
		id: createDebuggerTargetId(probe.vidPid || '', probe.serial || undefined),
		portType: 'debugger',
		label: [probe.name || 'Probe', probe.vidPid || '', probe.shortSerial || probe.serial || '']
			.filter(Boolean)
			.join(' · '),
		probeSerial: probe.serial || undefined,
		probeVidPid: probe.vidPid || undefined
	}) satisfies TerminalUploadTargetOption

const readStoredTerminalUploadTargetId = () => {
	if (typeof localStorage === 'undefined') return ''
	try {
		return String(localStorage.getItem(TERMINAL_UPLOAD_TARGET_STORAGE_KEY) || '')
	} catch {
		return ''
	}
}

const writeStoredTerminalUploadTargetId = (targetId: string) => {
	if (typeof localStorage === 'undefined') return
	try {
		if (targetId.trim()) {
			localStorage.setItem(TERMINAL_UPLOAD_TARGET_STORAGE_KEY, targetId.trim())
			return
		}
		localStorage.removeItem(TERMINAL_UPLOAD_TARGET_STORAGE_KEY)
	} catch {
		return
	}
}

const resolveInitialUploadTargetId = (
	targets: Array<TerminalUploadTargetOption>,
	input: {
		storedPort: string
		storedTargetId?: string
	}
) => {
	const storedTargetId = input.storedTargetId?.trim() || ''
	if (storedTargetId && targets.some(target => target.id === storedTargetId)) {
		return storedTargetId
	}

	const storedPort = input.storedPort.trim()
	if (storedPort.trim() && targets.some(target => target.id === storedPort.trim())) {
		return storedPort
	}

	return targets.find(target => target.portType === 'serial')?.id || targets[0]?.id || ''
}

/**
 * 解析当前 terminal 页面要使用的默认串口。
 * @param core - core 服务句柄
 * @param runtimeInfo - desktop 运行时信息
 */
export const loadTerminalSelectedUploadTargetId = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo | null,
	targets: Array<TerminalUploadTargetOption>
) => {
	const storedTargetId = readStoredTerminalUploadTargetId()
	if (runtimeInfo?.appDataPath) {
		const stored = await core.config.getStored.query({
			appDataPath: runtimeInfo.appDataPath,
			fallbackLanguage: config.lang
		})
		return resolveInitialUploadTargetId(targets, {
			storedPort: stored.serialMonitor.port || '',
			storedTargetId
		})
	}

	const summary = await core.config.get.query({
		config,
		fallbackLanguage: config.lang
	})
	return resolveInitialUploadTargetId(targets, {
		storedPort: summary.serialMonitor.port || '',
		storedTargetId
	})
}

/**
 * 读取当前可见上传目标列表。
 * @param core - core 服务句柄
 */
export const loadTerminalUploadTargets = async (core: Core) => {
	const [serialPorts, probes] = await Promise.all([
		core.hardware.listSerialPorts.query(),
		core.hardware.listProbes.query()
	])

	const serialTargets = serialPorts.ports
		.filter(port => port.name)
		.map(port => createSerialUploadTarget(port))
		.filter(target => target.id)

	const debuggerTargets = (probes.probes ?? [])
		.filter(probe => probe.vidPid)
		.map(probe => createDebuggerUploadTarget(probe))
		.filter(target => target.id && target.probeVidPid)

	return [...serialTargets, ...debuggerTargets]
}

/**
 * 将 terminal 选择的串口写回真实配置。
 * @param core - core 服务句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param target - 目标上传项
 */
export const saveTerminalSelectedUploadTargetId = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo | null,
	target: TerminalUploadTargetOption | undefined
) => {
	writeStoredTerminalUploadTargetId(target?.id || '')

	if (!runtimeInfo?.appDataPath || !target || target.portType !== 'serial' || !target.name) return

	await core.config.updateStored.mutate({
		appDataPath: runtimeInfo.appDataPath,
		fallbackLanguage: config.lang,
		serialMonitor: {
			port: target.name
		}
	})
}
