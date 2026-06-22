import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { TerminalUploadTargetOption } from '../../types'

/**
 * 执行当前项目构建。
 * @param core - core 服务句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param projectPath - 当前项目目录
 * @param code - 当前共享源码
 */
export const runTerminalProjectBuild = (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	code?: string
) =>
	core.build.runProjectBuild.mutate({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code: code?.trim() ? code : undefined
	})

/**
 * 执行当前项目串口上传。
 * @param core - core 服务句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param projectPath - 当前项目目录
 * @param serialPort - 串口路径
 * @param code - 当前共享源码
 */
export const runTerminalProjectUpload = (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	target: TerminalUploadTargetOption,
	code?: string
) =>
	core.hardware.runUpload.mutate({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code: code?.trim() ? code : undefined,
		portType: target.portType,
		serialPort: target.name,
		probeSerial: target.probeSerial,
		probeVidPid: target.probeVidPid,
		rebuildBeforeUpload: true
	})

/**
 * 取消当前 core build。
 * @param core - core 服务句柄
 */
export const cancelTerminalProjectBuild = (core: Core) => core.build.cancelProjectBuild.mutate()

/**
 * 取消当前 core upload。
 * @param core - core 服务句柄
 */
export const cancelTerminalProjectUpload = (core: Core) => core.hardware.cancelUpload.mutate()
