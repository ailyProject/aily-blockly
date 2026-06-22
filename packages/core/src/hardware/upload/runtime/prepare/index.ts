import { prepareHardwareUploadBuildContext } from './build'
import { prepareBleHardwareUploadExecution, prepareReadyHardwareUploadExecution } from './ready'

import type { HardwarePreparedUploadExecution, HardwareRunUploadInput } from '../../types'

/**
 * 为上传链路准备构建结果、端口和最终命令，但不直接执行命令。
 * @param input - 上传输入
 */
export const prepareHardwareUploadExecution = async (
	input: HardwareRunUploadInput
): Promise<HardwarePreparedUploadExecution> => {
	if (input.portType !== 'debugger' && input.portType !== 'ble' && !input.serialPort) {
		return {
			status: 'missing-port',
			ready: false,
			portType: input.portType,
			buildPath: '',
			builtBeforeUpload: false,
			message: '未提供串口路径',
			buildLogs: [],
			buildStdout: '',
			buildStderr: ''
		}
	}

	const buildContext = await prepareHardwareUploadBuildContext(input)
	if (buildContext.prepared) return buildContext.prepared

	if (input.portType === 'ble') {
		return prepareBleHardwareUploadExecution({
			runtimeInput: input,
			context: buildContext.context!,
			buildResult: buildContext.buildResult
		})
	}

	return prepareReadyHardwareUploadExecution({
		runtimeInput: input,
		context: buildContext.context!,
		buildResult: buildContext.buildResult
	})
}
