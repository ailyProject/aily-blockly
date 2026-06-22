import type { UploadErrorCode, UploadProgressEvent, UploadProgressPhase, UploadResultSummary } from 'shared'
import type { ProjectBuildLog } from '../../build'

/**
 * BLE OTA 更新类型。
 */
export type HardwareBleUploadUpdateType =
	/** 固件主程序更新。 */
	| 'flash'
	/** 文件系统镜像更新。 */
	| 'filesystem'

/**
 * BLE OTA 命令字。
 */
export type HardwareBleUploadCommandId =
	/** 开始烧录固件。 */
	| 0x0001
	/** 停止并校验。 */
	| 0x0002
	/** ACK 帧。 */
	| 0x0003
	/** 开始烧录文件系统。 */
	| 0x0004

/**
 * BLE OTA ACK 状态码。
 */
export type HardwareBleUploadAckStatus =
	/** ACK 成功。 */
	| 0x0000
	/** CRC 校验失败。 */
	| 0x0001
	/** sector 索引错误。 */
	| 0x0002
	/** 签名错误。 */
	| 0x0003
	/** 启动失败。 */
	| 0x0005

/**
 * BLE OTA 数据分片。
 */
export interface HardwareBleUploadPacket {
	/** 所属扇区索引。 */
	sectorIndex: number
	/** 当前分片序号；最后一片固定为 0xff。 */
	sequence: number
	/** 当前分片是否为本扇区最后一片。 */
	isLast: boolean
	/** 当前分片完整字节内容。 */
	bytes: Uint8Array
}

/**
 * BLE 上传准备状态。
 */
export interface HardwareBleUploadPreparation {
	/** 当前是否已经找到可上传固件。 */
	ready: boolean
	/** 推荐更新类型。 */
	updateType: 'flash' | 'filesystem'
	/** 当前固件文件路径。 */
	firmwarePath?: string
	/** 预估数据包数量。 */
	packetCount?: number
	/** 推荐包大小。 */
	packetSize?: number
	/** 面向 UI 的说明文字。 */
	message: string
}

/**
 * BLE 上传准备输入。
 */
export interface HardwarePrepareBleUploadInput {
	/** 当前项目目录。 */
	projectPath: string
	/** Electron userData 路径。 */
	appDataPath: string
	/** child 目录路径。 */
	childPath: string
	/** 本次需要参与构建的源码。 */
	code?: string
	/** 是否先执行构建。 */
	rebuildBeforeUpload?: boolean
	/** 目标更新类型。 */
	updateType?: 'flash' | 'filesystem'
	/** 目标包大小。 */
	packetSize?: number
}

/**
 * BLE 上传计划中的分片载荷。
 */
export interface HardwareBleUploadPacketPayload {
	/** 所属扇区索引。 */
	sectorIndex: number
	/** 分片序号。 */
	sequence: number
	/** 是否为本扇区最后一片。 */
	isLast: boolean
	/** Base64 编码后的分片字节。 */
	bytesBase64: string
}

/**
 * BLE 上传执行计划。
 */
export interface HardwareBleUploadExecutionPlan {
	/** 当前是否已经准备完成。 */
	ready: boolean
	/** 当前构建输出目录。 */
	buildPath?: string
	/** 当前固件路径。 */
	artifactPath?: string
	/** 是否在准备前执行了构建。 */
	builtBeforeUpload: boolean
	/** 目标更新类型。 */
	updateType: 'flash' | 'filesystem'
	/** 最终使用的包大小。 */
	packetSize: number
	/** 原始固件总字节数。 */
	totalBytes: number
	/** 分片总数。 */
	packetCount: number
	/** Base64 编码后的开始命令帧。 */
	startCommandBase64?: string
	/** Base64 编码后的停止命令帧。 */
	stopCommandBase64?: string
	/** 分片列表。 */
	packets: Array<HardwareBleUploadPacketPayload>
	/** 面向 UI 的说明。 */
	message: string
}

/**
 * 上传计划中的命令步骤。
 */
export interface HardwareUploadCommandStep {
	/** 当前步骤标签。 */
	label: string
	/** 可执行程序路径或命令名。 */
	command: string
	/** 命令参数列表。 */
	args: Array<string>
	/** 命令工作目录。 */
	cwd: string
}

/**
 * 上传解析上下文。
 */
export interface HardwareUploadContext {
	/** 当前项目目录。 */
	projectPath: string
	/** 当前 build 输出目录。 */
	buildPath: string
	/** 当前 tools 根目录。 */
	toolsPath: string
	/** 当前 SDK 目录。 */
	sdkPath: string
	/** 当前开发板包名。 */
	boardPackageName: string
	/** 当前开发板 core 名称。 */
	coreName: string
	/** 当前默认波特率。 */
	baudRate: string
	/** debugger 上传默认使用的板卡型号。 */
	debuggerPnum?: string
	/** 当前上传参数。 */
	uploadParam: string
	/** 当前回退上传参数。 */
	fallbackUploadParam: string
	/** 当前上传参数来源。 */
	uploadParamSource: 'preprocess' | 'fallback'
	/** toolName -> version 的映射。 */
	toolDependencies: Record<string, string>
}

/**
 * 上传执行日志。
 */
export interface HardwareUploadLog {
	/** 当前日志步骤。 */
	step: string
	/** 标准输出全文。 */
	stdout: string
	/** 标准错误全文。 */
	stderr: string
}

/**
 * 上传进度阶段。
 */
export type HardwareUploadPhase = UploadProgressPhase

/**
 * 上传结构化进度事件。
 */
export type HardwareUploadProgressEvent = UploadProgressEvent

/**
 * 上传端口类型
 */
export type HardwareUploadPortType =
	/** 普通串口上传 */
	| 'serial'
	/** BLE OTA 上传 */
	| 'ble'
	/** debugger 上传 */
	| 'debugger'
	/** 其它未知类型 */
	| (string & {})

/**
 * 上传输入。
 */
export interface HardwareRunUploadInput {
	/** 当前项目目录。 */
	projectPath: string
	/** Electron userData 路径。 */
	appDataPath: string
	/** child 目录路径。 */
	childPath: string
	/** 本次需要参与构建的源码。 */
	code?: string
	/** 当前上传端口类型。 */
	portType?: HardwareUploadPortType
	/** 当前串口路径。 */
	serialPort?: string
	/** probe 序列号。 */
	probeSerial?: string
	/** probe 的 vid:pid。 */
	probeVidPid?: string
	/** debugger 上传时的芯片型号。 */
	pnum?: string
	/** 是否先执行构建。 */
	rebuildBeforeUpload?: boolean
	/** 是否执行 1200bps touch。 */
	use1200bpsTouch?: boolean
	/** 是否等待上传端口重新枚举。 */
	waitForUpload?: boolean
}

/**
 * 上传执行准备状态。
 */
export type HardwareUploadPreparationStatus =
	/** 已准备好可执行命令。 */
	| 'ready'
	/** 缺少必要串口。 */
	| 'missing-port'
	/** 预构建失败。 */
	| 'build-failed'
	/** 缺少构建产物。 */
	| 'missing-artifact'
	/** BLE 产物存在但当前宿主链路仍未接好。 */
	| 'ble-not-ready'

/**
 * 上传执行准备结果。
 */
export interface HardwarePreparedUploadExecution {
	/** 当前准备状态。 */
	status: HardwareUploadPreparationStatus
	/** 当前是否已具备执行命令的条件。 */
	ready: boolean
	/** 当前上传通道。 */
	portType?: HardwareRunUploadInput['portType']
	/** 当前构建输出目录。 */
	buildPath: string
	/** 是否在上传前执行了构建。 */
	builtBeforeUpload: boolean
	/** 最终解析出的上传端口。 */
	port?: string
	/** 当前识别出的核心产物路径。 */
	artifactPath?: string
	/** 已准备好的上传命令步骤。 */
	step?: HardwareUploadCommandStep
	/** 面向上层展示的说明文案。 */
	message: string
	/** 预构建阶段的步骤日志。 */
	buildLogs: Array<ProjectBuildLog>
	/** 预构建阶段的标准输出。 */
	buildStdout: string
	/** 预构建阶段的标准错误。 */
	buildStderr: string
}

/**
 * 上传执行结果。
 */
export interface HardwareRunUploadResult {
	/** 当前上传是否成功。 */
	success: boolean
	/** 总耗时。 */
	durationMs: number
	/** 本次识别出的核心产物路径。 */
	artifactPath?: string
	/** 最终使用的端口。 */
	port?: string
	/** 最终构建输出目录。 */
	buildPath?: string
	/** 是否在上传前执行了构建。 */
	builtBeforeUpload: boolean
	/** 上传命令步骤。 */
	steps: Array<HardwareUploadCommandStep>
	/** 上传日志。 */
	logs: Array<HardwareUploadLog>
	/** 结构化上传进度轨迹。 */
	progressEvents: Array<HardwareUploadProgressEvent>
	/** 合并后的标准输出。 */
	stdout: string
	/** 合并后的标准错误。 */
	stderr: string
	/** 错误文本。 */
	error?: string
	/** 结构化错误码。 */
	errorCode?: UploadErrorCode
	/** 已统一规整的上传摘要。 */
	summary?: UploadResultSummary
}

/**
 * 上传反馈结果
 */
export interface HardwareUploadFeedback {
	/** 当前步骤是否成功 */
	success?: boolean
	/** 上传结果载荷 */
	data?: {
		/** 上传动作返回结果 */
		result?: {
			/** 当前状态 */
			state?: string
			/** 当前文本 */
			text?: string
			/** 保留其它字段 */
			[key: string]: unknown
		}
		/** 顶层 success */
		success?: boolean
		/** 保留其它字段 */
		[key: string]: unknown
	}
	/** 错误文本 */
	error?: string
}

/**
 * 上传错误摘要
 */
export interface HardwareUploadErrorSummary {
	/** 错误状态 */
	state: string
	/** 错误文本 */
	text: string
}

/**
 * SoftDevice 烧录结果
 */
export interface HardwareSoftdeviceFlashResult {
	/** 当前是否成功 */
	success: boolean
	/** 面向用户的消息 */
	message: string
}
