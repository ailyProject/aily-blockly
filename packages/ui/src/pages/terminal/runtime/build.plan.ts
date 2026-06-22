import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { TerminalUploadTargetOption } from '../types'

/**
 * 读取当前项目构建计划。
 * @param core - core 服务句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param projectPath - 当前项目目录
 * @param code - 当前共享源码
 */
export const planTerminalProjectBuild = (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	code?: string
) =>
	core.build.planProjectBuild.query({
		projectPath,
		appDataPath: runtimeInfo.appDataPath,
		childPath: runtimeInfo.childPath ?? '',
		code: code?.trim() ? code : undefined
	})

/**
 * 读取当前项目上传执行准备结果。
 * @param core - core 服务句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param projectPath - 当前项目目录
 * @param serialPort - 串口路径
 * @param code - 当前共享源码
 */
export const planTerminalProjectUpload = (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo,
	projectPath: string,
	target: TerminalUploadTargetOption,
	code?: string
) =>
	core.hardware.prepareUploadExecution.mutate({
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
