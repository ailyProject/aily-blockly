import { spawn } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { path7za } from '7zip-bin'
import extractZip from 'extract-zip'

/**
 * 解压 7z 归档。
 * @param archivePath - 归档路径
 * @param outputPath - 输出目录
 */
export const extract7zArchive = (archivePath: string, outputPath: string) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn(path7za, ['x', archivePath, `-o${outputPath}`, '-y'], {
			stdio: ['ignore', 'pipe', 'pipe']
		})

		let stderr = ''
		child.stderr?.on('data', chunk => {
			stderr += chunk.toString()
		})
		child.on('error', reject)
		child.on('close', exitCode => {
			if (exitCode === 0) {
				resolve()
				return
			}

			reject(new Error(stderr.trim() || `7z 解压失败，退出码: ${exitCode ?? 1}`))
		})
	})

/**
 * 解析解压出的项目根目录。
 * @param extractPath - 解压目录
 */
export const resolveExtractedProjectRoot = async (extractPath: string) => {
	const entryNames = await readdir(extractPath)
	if (entryNames.length !== 1) return extractPath

	const candidatePath = path.join(extractPath, entryNames[0])
	const candidateStat = await stat(candidatePath)
	return candidateStat.isDirectory() ? candidatePath : extractPath
}

/**
 * 把下载到的归档写入临时目录并完成解压。
 * @param input - 归档写入与解压输入
 */
export const extractCloudArchivePayload = async (input: {
	tempRoot: string
	archiveFilename: string
	archiveBuffer: Buffer
}) => {
	const archivePath = path.join(input.tempRoot, input.archiveFilename)
	const extractPath = path.join(input.tempRoot, 'extracted')
	await mkdir(extractPath, { recursive: true })
	await writeFile(archivePath, input.archiveBuffer)

	if (input.archiveFilename.toLowerCase().endsWith('.zip')) {
		await extractZip(archivePath, { dir: extractPath })
	} else {
		await extract7zArchive(archivePath, extractPath)
	}

	return resolveExtractedProjectRoot(extractPath)
}
