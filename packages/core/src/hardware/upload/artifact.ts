import path from 'node:path'

import { listHardwareUploadArtifacts } from './buildPath'

const ARTIFACT_EXTENSIONS = new Set(['.bin', '.hex', '.uf2', '.elf', '.img'])
const EXCLUDED_BIN_PATTERN = /(bootloader|partition|boot_app0|ota_data|spiffs|littlefs|filesystem|fatfs)/i

const isArtifactFile = (filePath: string) => ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase())

const isPreferredApplicationBin = (filePath: string) =>
	path.extname(filePath).toLowerCase() === '.bin' && !EXCLUDED_BIN_PATTERN.test(path.basename(filePath))

/**
 * 从上传命令参数和构建目录中推断最可能的实际上传产物。
 * @param buildPath - 构建输出目录
 * @param args - 已解析的上传命令参数
 */
export const resolveHardwareUploadArtifactPath = (buildPath: string, args: Array<string>) => {
	const normalizedBuildPath = path.resolve(buildPath)
	const artifactArg = args.find(arg => {
		if (!arg) return false
		const normalizedArg = path.resolve(arg)
		return normalizedArg.startsWith(normalizedBuildPath) && isArtifactFile(normalizedArg)
	})
	if (artifactArg) return artifactArg

	const artifacts = listHardwareUploadArtifacts(buildPath).filter(isArtifactFile)
	const preferredBin = artifacts.find(isPreferredApplicationBin)
	if (preferredBin) return preferredBin

	const preferredOther = artifacts.find(filePath =>
		['.uf2', '.hex', '.img', '.elf'].includes(path.extname(filePath).toLowerCase())
	)
	return preferredOther || artifacts[0] || ''
}
