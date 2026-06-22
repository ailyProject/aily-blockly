import type { WritableSignal } from '@angular/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { BleDeviceItem, UploadChannel, UploadErrorCode, UploadRecoveryActions, UploadStatus } from 'shared'

/**
 * code editor 页面展示的 BLE 上传计划。
 */
export interface CodeEditorBleUploadPlanView {
	/** 当前计划是否就绪。 */
	ready: boolean
	/** 固件产物路径。 */
	artifactPath?: string
	/** 原始固件总字节数。 */
	totalBytes: number
	/** 当前包大小是否来自运行时探测。 */
	packetSizeProbed: boolean
	/** 当前包大小。 */
	packetSize: number
	/** 分片数量。 */
	packetCount: number
	/** Base64 编码后的开始命令帧。 */
	startCommandBase64?: string
	/** Base64 编码后的停止命令帧。 */
	stopCommandBase64?: string
	/** 分片载荷列表。 */
	packets: Array<{
		sectorIndex: number
		sequence: number
		isLast: boolean
		bytesBase64: string
	}>
	/** 面向用户的说明。 */
	message: string
}

/**
 * code editor 中当前已选择的 BLE 设备。
 */
export type CodeEditorBleDeviceView = BleDeviceItem

/**
 * code editor 中当前可见的 BLE 设备项。
 */
export type CodeEditorBleDeviceListItem = BleDeviceItem

/**
 * code editor 页面里的 BLE OTA 实时进度。
 */
export interface CodeEditorBleUploadProgressView {
	/** 当前阶段。 */
	phase: 'starting' | 'sending' | 'stopping' | 'done' | 'error'
	/** 当前进度百分比。 */
	progress: number
	/** 当前阶段文案。 */
	text: string
	/** 已确认完成的分片数。 */
	acknowledgedPackets?: number
	/** 总分片数。 */
	totalPackets?: number
}

/**
 * 代码编辑器页面里的构建计划摘要。
 */
export interface CodeEditorBuildPlanSummary {
	/** 选中的开发板包名。 */
	boardPackageName: string
	/** 编译器使用的 board 类型。 */
	boardType: string
	/** 本次会镜像的库数量。 */
	libraryCount: number
	/** 本次会传递的工具版本数量。 */
	toolVersionCount: number
	/** 本次会传递的宏定义数量。 */
	macroCount: number
}

/**
 * 代码编辑器页面展示的命令步骤日志。
 */
export interface CodeEditorCommandLogView {
	/** 当前日志属于哪个步骤。 */
	step: string
	/** 当前步骤标准输出。 */
	stdout: string
	/** 当前步骤标准错误。 */
	stderr: string
}

/**
 * 代码编辑器页面展示的构建结果。
 */
export interface CodeEditorBuildResultView {
	/** 构建是否成功。 */
	success: boolean
	/** 本次构建耗时。 */
	durationMs: number
	/** 编译进程退出码。 */
	exitCode: number
	/** 合并后的标准输出。 */
	stdout: string
	/** 合并后的标准错误。 */
	stderr: string
	/** 提炼后的错误摘要。 */
	errorText: string
	/** 分步骤日志。 */
	logs: Array<CodeEditorCommandLogView>
}

/**
 * 代码编辑器页的最近项目项。
 */
export interface CodeEditorProjectItem {
	/** 项目主名称。 */
	name: string
	/** 项目展示昵称。 */
	nickname?: string
	/** 项目根目录。 */
	path: string
}

/**
 * 代码编辑器页面初始状态。
 */
export interface CodeEditorState {
	/** 最近项目列表。 */
	recentProjects: Array<CodeEditorProjectItem>
	/** 默认选中的项目路径。 */
	defaultProjectPath: string
	/** 默认填充的示例源码。 */
	sourceCode: string
	/** 当前源码实际来自的文件路径。 */
	sourceFilePath?: string
	/** 当前源码来源类型。 */
	sourceKind?: 'build-cache' | 'arduino-entry' | 'cpp-entry' | 'python-entry' | 'manual'
	/** 默认串口路径。 */
	defaultSerialPort: string
}

/**
 * 代码编辑器页面展示的上传结果。
 */
export interface CodeEditorUploadResultView {
	/** 统一上传通道。 */
	channel: UploadChannel
	/** 统一上传状态。 */
	status: UploadStatus
	/** 统一错误码。 */
	errorCode?: UploadErrorCode
	/** 统一上传摘要文案。 */
	message: string
	/** 上传是否成功。 */
	success: boolean
	/** 本次上传耗时。 */
	durationMs: number
	/** 最终使用的端口。 */
	port?: string
	/** BLE 准备得到的固件路径。 */
	artifactPath?: string
	/** 结构化上传进度数量。 */
	progressEventCount: number
	/** 最新阶段摘要。 */
	latestProgressText?: string
	/** 合并后的标准输出。 */
	stdout: string
	/** 合并后的标准错误。 */
	stderr: string
	/** 分步骤日志。 */
	logs: Array<CodeEditorCommandLogView>
	/** 当前错误文本。 */
	error?: string
	/** 统一状态展示文案。 */
	statusText?: string
	/** 面向用户的恢复建议。 */
	recoveryHint?: string
	/** 结构化恢复动作建议。 */
	recoveryActions?: UploadRecoveryActions
}

/**
 * 代码编辑器页面展示的上传计划。
 */
export interface CodeEditorUploadPlanView {
	/** 当前步骤标签。 */
	label: string
	/** 可执行命令预览。 */
	commandPreview: string
}

/**
 * Code Editor 页面信号集合。
 */
export interface CodeEditorSignals {
	state: WritableSignal<CodeEditorState | null>
	runtimeInfo: WritableSignal<DesktopHostRuntimeInfo | null>
	projectPath: WritableSignal<string>
	sourceCode: WritableSignal<string>
	serialPort: WritableSignal<string>
	buildPlan: WritableSignal<CodeEditorBuildPlanSummary | null>
	buildResult: WritableSignal<CodeEditorBuildResultView | null>
	uploadPlan: WritableSignal<CodeEditorUploadPlanView | null>
	bleUploadPlan: WritableSignal<CodeEditorBleUploadPlanView | null>
	uploadResult: WritableSignal<CodeEditorUploadResultView | null>
	bleDevice: WritableSignal<CodeEditorBleDeviceView | null>
	bleDevices: WritableSignal<Array<CodeEditorBleDeviceListItem>>
	bleUploadProgress: WritableSignal<CodeEditorBleUploadProgressView | null>
	bleBridgeAvailable: WritableSignal<boolean>
	buildError: WritableSignal<string | null>
	projectReloadMessage: WritableSignal<string | null>
	projectReloadBusy: WritableSignal<boolean>
	/** 当前是否存在等待当前动作结束后再处理的外部刷新原因。 */
	pendingExternalRefreshReason: WritableSignal<string | null>
	buildBusy: WritableSignal<boolean>
	uploadBusy: WritableSignal<boolean>
}
