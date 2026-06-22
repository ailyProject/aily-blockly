import { resolveHardwareUploadCommand } from './command'

import type { HardwareRunUploadInput, HardwareUploadCommandStep, HardwareUploadContext } from './types'

const normalizeDebuggerChip = (pnum: string | undefined) =>
	pnum?.startsWith('GENERIC_') ? `STM32${pnum.replace('GENERIC_', '').slice(0, -2)}` : pnum

/**
 * 基于当前上传上下文生成最终执行步骤。
 * @param input - 上传步骤解析输入
 */
export const createHardwareUploadStep = async (input: {
	context: HardwareUploadContext
	portType?: HardwareRunUploadInput['portType']
	serialPort: string
	pnum?: string
	probeSerial?: string
	probeVidPid?: string
}) => {
	const normalizedPnum = normalizeDebuggerChip(input.pnum || input.context.debuggerPnum)
	const resolved = await resolveHardwareUploadCommand({
		uploadParam: input.context.uploadParam,
		buildPath: input.context.buildPath,
		toolsPath: input.context.toolsPath,
		sdkPath: input.context.sdkPath,
		baudRate: input.context.baudRate,
		toolDependencies: input.context.toolDependencies,
		serialPort: input.serialPort,
		pnum: normalizedPnum,
		skipToolResolve: input.context.uploadParamSource === 'preprocess'
	}).catch(async error => {
		if (input.context.uploadParamSource !== 'preprocess' || !input.context.fallbackUploadParam) throw error
		input.context.uploadParam = input.context.fallbackUploadParam
		input.context.uploadParamSource = 'fallback'
		return resolveHardwareUploadCommand({
			uploadParam: input.context.uploadParam,
			buildPath: input.context.buildPath,
			toolsPath: input.context.toolsPath,
			sdkPath: input.context.sdkPath,
			baudRate: input.context.baudRate,
			toolDependencies: input.context.toolDependencies,
			serialPort: input.serialPort,
			pnum: normalizedPnum
		})
	})

	return {
		label: input.portType === 'debugger' ? 'upload:debugger' : 'upload:serial',
		command: resolved.command,
		args: input.probeVidPid
			? [
					...resolved.args,
					'--probe',
					input.probeSerial ? `${input.probeVidPid}:${input.probeSerial}` : input.probeVidPid
				]
			: resolved.args,
		cwd: input.context.buildPath
	} satisfies HardwareUploadCommandStep
}

/**
 * 预览当前输入会生成的上传步骤。
 * @param input - 上传输入
 * @param context - 已解析的上传上下文
 */
export const planHardwareUpload = (input: HardwareRunUploadInput, context: HardwareUploadContext) =>
	createHardwareUploadStep({
		context,
		portType: input.portType,
		serialPort: input.portType === 'debugger' ? '' : input.serialPort || '',
		pnum: input.pnum,
		probeSerial: input.probeSerial,
		probeVidPid: input.probeVidPid
	})
