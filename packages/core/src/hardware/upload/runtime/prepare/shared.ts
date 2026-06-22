import type { HardwarePreparedUploadExecution, HardwareRunUploadInput } from '../../types'

/**
 * 构造统一的上传准备结果。
 * @param input - 当前准备态摘要
 */
export const createPreparedUploadExecution = (input: {
	status: HardwarePreparedUploadExecution['status']
	ready: boolean
	portType?: HardwareRunUploadInput['portType']
	buildPath?: string
	builtBeforeUpload: boolean
	message: string
	buildLogs?: HardwarePreparedUploadExecution['buildLogs']
	buildStdout?: string
	buildStderr?: string
	port?: string
	artifactPath?: string
	step?: HardwarePreparedUploadExecution['step']
}): HardwarePreparedUploadExecution => ({
	status: input.status,
	ready: input.ready,
	portType: input.portType,
	buildPath: input.buildPath || '',
	builtBeforeUpload: input.builtBeforeUpload,
	message: input.message,
	buildLogs: input.buildLogs ?? [],
	buildStdout: input.buildStdout ?? '',
	buildStderr: input.buildStderr ?? '',
	...(input.port ? { port: input.port } : {}),
	...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
	...(input.step ? { step: input.step } : {})
})
