import path from 'node:path'

import { findHardwareUploadArtifact } from '../buildPath'
import { parseHardwareUploadCommandArgs } from './parse'

/**
 * 将上传参数模板解析成可执行命令。
 * @param input - 上传命令解析输入
 */
export const resolveHardwareUploadCommand = async (input: {
	uploadParam: string
	buildPath: string
	toolsPath: string
	sdkPath: string
	baudRate: string
	toolDependencies: Record<string, string>
	serialPort: string
	pnum?: string
	skipToolResolve?: boolean
}) => {
	let resolved = input.uploadParam.replace(/\$\{baud\}/g, input.baudRate).replace(/\$\{serial\}/g, input.serialPort)
	if (input.pnum) resolved = resolved.replace(/\$\{pnum\}/g, input.pnum)
	resolved = resolved.replace(/\$\{boot_app0\}/g, path.join(input.sdkPath, 'tools', 'partitions', 'boot_app0.bin'))
	resolved = resolved.replace(/\$\{bootloader\}/g, findHardwareUploadArtifact(input.buildPath, '*.bootloader.bin'))
	resolved = resolved.replace(/\$\{partitions\}/g, findHardwareUploadArtifact(input.buildPath, '*.partitions.bin'))

	const args = parseHardwareUploadCommandArgs(resolved)
	const toolName = args[0] || ''
	let command = toolName
	if (!input.skipToolResolve) {
		const version =
			input.toolDependencies[toolName] ||
			Object.entries(input.toolDependencies).find(([name]) => name.includes(toolName))?.[1] ||
			''
		const fileName = `${toolName}${process.platform === 'win32' ? '.exe' : ''}`
		command = findHardwareUploadArtifact(input.toolsPath, fileName, version) || toolName
	}

	const resolvedArgs = await Promise.all(
		args.slice(1).map(async item => {
			const match = item.match(/\$\{'(.+?)'\}/)
			if (!match) return item
			const fileName = match[1]
			const extension = path.extname(fileName).toLowerCase()
			const basePath = ['.bin', '.elf', '.hex', '.eep', '.img', '.uf2'].includes(extension)
				? input.buildPath
				: input.toolsPath
			const filePath =
				findHardwareUploadArtifact(basePath, fileName) ||
				findHardwareUploadArtifact(path.join(input.sdkPath, 'tools'), fileName) ||
				fileName
			return item.replace(match[0], filePath).replace(/^"(.*)"$/s, '$1')
		})
	)

	return {
		command,
		args: resolvedArgs
	}
}
