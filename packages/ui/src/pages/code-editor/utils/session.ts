import {
	getCurrentProjectPath,
	getCurrentProjectSourceCode,
	setCurrentProjectEditorRoute,
	setCurrentProjectPath,
	setCurrentProjectSourceCode
} from '@/runtime/project-session'
import { getPreferredBleDeviceId, hasBleChooserBridge, loadAuthorizedBleOtaDevices } from '@/utils/desktop'

import { loadCodeEditorProjectSource, loadCodeEditorState } from './build/runtime'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { CodeEditorSignals } from '../types'

/**
 * 初始化 code editor 页面基础状态。
 */
export const initializeCodeEditorPage = async (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	initialProjectPath: string | null
	signals: CodeEditorSignals
}) => {
	const state = await loadCodeEditorState(input.core)
	input.signals.state.set(state)
	const projectPath = input.initialProjectPath || getCurrentProjectPath() || state.defaultProjectPath || ''
	const sourceSnapshot = await loadCodeEditorProjectSource(input.core, projectPath)

	input.signals.projectPath.set(projectPath)
	setCurrentProjectPath(input.signals.projectPath())
	setCurrentProjectEditorRoute('code-editor')
	input.signals.sourceCode.set(getCurrentProjectSourceCode() || sourceSnapshot?.sourceCode || state.sourceCode)
	setCurrentProjectSourceCode(input.signals.sourceCode())
	input.signals.state.update(current =>
		current
			? {
					...current,
					sourceCode: sourceSnapshot?.sourceCode || current.sourceCode,
					sourceFilePath: sourceSnapshot?.filePath || current.sourceFilePath,
					sourceKind: sourceSnapshot?.sourceKind || current.sourceKind
				}
			: current
	)
	input.signals.serialPort.set(state.defaultSerialPort)
	input.signals.bleBridgeAvailable.set(hasBleChooserBridge(input.desktop))
	if (input.signals.bleBridgeAvailable()) {
		const authorizedBleDevices = await loadAuthorizedBleOtaDevices()
		input.signals.bleDevices.set(authorizedBleDevices)
		const preferredBleDeviceId = getPreferredBleDeviceId()
		const preferredBleDevice = authorizedBleDevices.find(device => device.deviceId === preferredBleDeviceId) ?? null
		input.signals.bleDevice.set(preferredBleDevice)
	}
}

/**
 * 切换当前 code editor 项目时，同步刷新共享源码快照。
 * @param core - core 服务句柄
 * @param signals - 页面信号集合
 * @param projectPath - 新项目路径
 */
export const syncCodeEditorProjectSource = async (core: Core, signals: CodeEditorSignals, projectPath: string) => {
	const sourceSnapshot = await loadCodeEditorProjectSource(core, projectPath)
	const nextSource = sourceSnapshot?.sourceCode || ''

	signals.sourceCode.set(nextSource)
	setCurrentProjectSourceCode(nextSource)
	signals.state.update(current =>
		current
			? {
					...current,
					sourceCode: nextSource,
					sourceFilePath: sourceSnapshot?.filePath,
					sourceKind: sourceSnapshot?.sourceKind
				}
			: current
	)
}

/**
 * 初始化 desktop runtime 信息。
 */
export const initializeCodeEditorDesktopRuntime = async (input: {
	desktop: NonNullable<Desktop> | null
	loadDesktopHostRuntimeInfo: (desktop: NonNullable<Desktop>) => Promise<DesktopHostRuntimeInfo>
	signals: CodeEditorSignals
}) => {
	if (!input.desktop) {
		input.signals.buildError.set('Desktop bridge is unavailable.')
		return
	}

	try {
		input.signals.runtimeInfo.set(await input.loadDesktopHostRuntimeInfo(input.desktop))
	} catch (error) {
		input.signals.buildError.set(error instanceof Error ? error.message : String(error))
	}
}
