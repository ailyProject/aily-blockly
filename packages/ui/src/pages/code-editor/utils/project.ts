import {
	setCurrentProjectEditorRoute,
	setCurrentProjectPath,
	setCurrentProjectSourceCode
} from '@/runtime/project-session'

import { refreshCodeEditorPlan, refreshCodeEditorUploadPlan } from './build/actions'
import { syncCodeEditorProjectSource } from './session'

import type { Core } from '@/utils/core'
import type { CodeEditorSignals } from '../types'

/**
 * 更新当前项目路径输入，并在可用时同步工程源码。
 * @param core - core 句柄
 * @param signals - 页面信号集合
 * @param event - 输入事件
 */
export const updateCodeEditorProjectPath = async (core: Core, signals: CodeEditorSignals, event: Event) => {
	const projectPath = (event.target as HTMLInputElement).value
	await setCodeEditorProjectPath(core, signals, projectPath)
}

/**
 * 直接设置当前项目路径，并在可用时同步工程源码。
 * @param core - core 句柄
 * @param signals - 页面信号集合
 * @param projectPath - 当前项目路径
 */
export const setCodeEditorProjectPath = async (core: Core, signals: CodeEditorSignals, projectPath: string) => {
	signals.projectPath.set(projectPath)
	setCurrentProjectPath(projectPath)
	setCurrentProjectEditorRoute('code-editor')
	if (projectPath.trim()) {
		await syncCodeEditorProjectSource(core, signals, projectPath)
	}
}

/**
 * 更新编辑器源码草稿，并把当前来源切为手工编辑。
 * @param signals - 页面信号集合
 * @param value - 当前源码文本
 */
export const updateCodeEditorSourceCode = (signals: CodeEditorSignals, value: string) => {
	signals.sourceCode.set(value)
	setCurrentProjectSourceCode(value)
	signals.state.update(current =>
		current
			? {
					...current,
					sourceCode: value,
					sourceFilePath: undefined,
					sourceKind: 'manual'
				}
			: current
	)
}

/**
 * 更新串口输入框，并刷新上传计划预览。
 * @param core - core 句柄
 * @param signals - 页面信号集合
 * @param event - 输入事件
 */
export const updateCodeEditorSerialPort = (core: Core, signals: CodeEditorSignals, event: Event) => {
	signals.serialPort.set((event.target as HTMLInputElement).value)
	void refreshCodeEditorUploadPlan({
		core,
		signals
	})
}

/**
 * 直接设置串口输入值，并刷新上传计划预览。
 * @param core - core 句柄
 * @param signals - 页面信号集合
 * @param serialPort - 当前串口值
 */
export const updateCodeEditorSerialPortValue = (core: Core, signals: CodeEditorSignals, serialPort: string) => {
	signals.serialPort.set(serialPort)
	void refreshCodeEditorUploadPlan({
		core,
		signals
	})
}

/**
 * 从最近项目列表切换当前工程，并同步刷新构建计划。
 * @param core - core 句柄
 * @param signals - 页面信号集合
 * @param projectPath - 目标项目路径
 */
export const chooseCodeEditorProject = async (core: Core, signals: CodeEditorSignals, projectPath: string) => {
	await setCodeEditorProjectPath(core, signals, projectPath)
	void refreshCodeEditorPlan({
		core,
		signals
	})
}

/**
 * 重新加载当前项目的源码快照与构建计划。
 * @param core - core 句柄
 * @param signals - 页面信号集合
 */
export const reloadCodeEditorProjectState = async (core: Core, signals: CodeEditorSignals) => {
	const projectPath = signals.projectPath().trim()
	if (!projectPath) return

	signals.projectReloadBusy.set(true)
	try {
		await syncCodeEditorProjectSource(core, signals, projectPath)
		await refreshCodeEditorPlan({
			core,
			signals
		})
		signals.projectReloadMessage.set(null)
	} finally {
		signals.projectReloadBusy.set(false)
	}
}
