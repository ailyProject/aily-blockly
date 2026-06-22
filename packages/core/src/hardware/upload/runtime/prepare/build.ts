import { existsSync } from 'node:fs'

import { runProjectBuild } from '../../../../build'
import { resolveHardwareUploadContext } from '../../context'
import { createPreparedUploadExecution } from './shared'

import type { HardwareRunUploadInput } from '../../types'

/**
 * 准备上传前的构建结果与构建目录。
 * @param input - 上传输入
 */
export const prepareHardwareUploadBuildContext = async (input: HardwareRunUploadInput) => {
	const buildResult = input.rebuildBeforeUpload
		? await runProjectBuild({
				projectPath: input.projectPath,
				appDataPath: input.appDataPath,
				childPath: input.childPath,
				code: input.code
			})
		: null
	if (buildResult && !buildResult.success) {
		return {
			buildResult,
			context: null,
			prepared: createPreparedUploadExecution({
				status: 'build-failed',
				ready: false,
				portType: input.portType,
				buildPath: buildResult.plan.paths.compilerRootPath,
				builtBeforeUpload: true,
				message: buildResult.errorText || '构建失败，未执行上传',
				buildLogs: buildResult.logs,
				buildStdout: buildResult.stdout,
				buildStderr: buildResult.stderr
			})
		}
	}

	const context = resolveHardwareUploadContext(input)
	if (!existsSync(context.buildPath)) {
		return {
			buildResult,
			context,
			prepared: createPreparedUploadExecution({
				status: 'missing-artifact',
				ready: false,
				portType: input.portType,
				buildPath: context.buildPath,
				builtBeforeUpload: Boolean(buildResult),
				message: `未找到构建输出目录: ${context.buildPath}`,
				buildLogs: buildResult?.logs,
				buildStdout: buildResult?.stdout,
				buildStderr: buildResult?.stderr
			})
		}
	}

	return {
		buildResult,
		context,
		prepared: null
	}
}
