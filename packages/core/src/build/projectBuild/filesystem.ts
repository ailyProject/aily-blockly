import { cp, lstat, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { ProjectBuildLibraryBinding, ProjectBuildPaths } from './types'

const ensureDirectory = (targetPath: string) => mkdir(targetPath, { recursive: true })

const copyEntry = async (sourcePath: string, targetPath: string) => {
	const stat = await lstat(sourcePath)
	if (stat.isDirectory()) {
		await ensureDirectory(targetPath)
		const entryNames = await readdir(sourcePath)
		for (const entryName of entryNames) {
			await copyEntry(path.join(sourcePath, entryName), path.join(targetPath, entryName))
		}
		return
	}

	try {
		await unlink(targetPath)
	} catch {}

	try {
		await cp(sourcePath, targetPath, { recursive: false, force: true })
	} catch {
		await ensureDirectory(path.dirname(targetPath))
		await cp(sourcePath, targetPath, { recursive: false, force: true })
	}
}

const mirrorLibrary = async (binding: ProjectBuildLibraryBinding) => {
	await rm(binding.targetPath, { recursive: true, force: true }).catch(() => undefined)
	await copyEntry(binding.sourcePath, binding.targetPath)
}

const syncCompilerTools = async (paths: ProjectBuildPaths) => {
	const compilerDirName = path.basename(paths.compilerPath)
	const targetPath = path.join(paths.toolsRootPath, compilerDirName)
	await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
	await cp(paths.compilerPath, targetPath, { recursive: true, force: true })
}

/**
 * 为项目构建准备 sketch、库目录和工具目录。
 * @param paths - 构建关键路径
 * @param libraries - 需要镜像的库目录
 * @param input - 本次构建输入
 */
export const prepareProjectBuildFilesystem = async (
	paths: ProjectBuildPaths,
	libraries: Array<ProjectBuildLibraryBinding>,
	sourceCode: string
) => {
	await Promise.all([
		ensureDirectory(paths.tempPath),
		ensureDirectory(paths.sketchPath),
		ensureDirectory(paths.librariesPath),
		ensureDirectory(paths.toolsRootPath)
	])
	await writeFile(paths.sketchFilePath, sourceCode, 'utf8')
	for (const library of libraries) {
		await mirrorLibrary(library)
	}
	await syncCompilerTools(paths)
}
