import { withHardwareUploadSummary } from './shared'

/**
 * 构造“缺少串口”结果。
 * @param startedAt - 开始时间
 */
export const createMissingPortUploadResult = (startedAt: number) =>
	withHardwareUploadSummary({
		success: false,
		durationMs: Date.now() - startedAt,
		builtBeforeUpload: false,
		steps: [],
		logs: [],
		progressEvents: [],
		stdout: '',
		stderr: '',
		error: '未提供串口路径',
		errorCode: 'missing-port'
	})

/**
 * 构造构建失败导致未上传的结果。
 * @param startedAt - 开始时间
 * @param buildResult - 构建结果
 */
export const createBuildFailedUploadResult = (
	startedAt: number,
	buildResult: {
		logs: Array<{ step: string; stdout: string; stderr: string }>
		stdout: string
		stderr: string
		errorText?: string
	}
) =>
	withHardwareUploadSummary({
		success: false,
		durationMs: Date.now() - startedAt,
		builtBeforeUpload: true,
		steps: [],
		logs: buildResult.logs,
		progressEvents: [],
		stdout: buildResult.stdout,
		stderr: buildResult.stderr,
		error: buildResult.errorText || '构建失败，未执行上传',
		errorCode: 'build-failed'
	})

/**
 * 构造构建产物缺失结果。
 * @param input - 产物缺失所需上下文
 */
export const createMissingArtifactUploadResult = (input: {
	startedAt: number
	buildPath: string
	builtBeforeUpload: boolean
	buildStdout?: string
	buildStderr?: string
	buildLogs?: Array<{ step: string; stdout: string; stderr: string }>
}) =>
	withHardwareUploadSummary({
		success: false,
		durationMs: Date.now() - input.startedAt,
		builtBeforeUpload: input.builtBeforeUpload,
		steps: [],
		logs: input.buildLogs ?? [],
		progressEvents: [],
		stdout: input.buildStdout ?? '',
		stderr: input.buildStderr ?? '',
		error: `未找到构建输出目录: ${input.buildPath}`,
		errorCode: 'artifact-missing'
	})

/**
 * 构造当前 BLE 上传仍未迁移宿主时的结果。
 * @param input - BLE 准备上下文
 */
export const createBleNotReadyUploadResult = (input: {
	startedAt: number
	firmwarePath?: string
	buildPath: string
	message: string
	ready: boolean
	builtBeforeUpload: boolean
	buildStdout?: string
	buildStderr?: string
	buildLogs?: Array<{ step: string; stdout: string; stderr: string }>
}) =>
	withHardwareUploadSummary({
		success: false,
		durationMs: Date.now() - input.startedAt,
		builtBeforeUpload: input.builtBeforeUpload,
		steps: [],
		logs: input.buildLogs ?? [],
		progressEvents: [],
		stdout: input.buildStdout ?? '',
		stderr: input.buildStderr ?? '',
		artifactPath: input.firmwarePath,
		buildPath: input.buildPath,
		error: input.ready ? `${input.message}；BLE 传输宿主仍未迁移` : input.message,
		errorCode: input.ready ? 'not-ready' : 'artifact-missing'
	})
