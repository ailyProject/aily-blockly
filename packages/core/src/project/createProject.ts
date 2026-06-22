import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { withProjectDirectoryMutationLock } from './lock'

import type { ProjectCreateInput, ProjectCreateResult, ProjectPackageJson } from './types'

const normalizeProjectName = (name: string) => name.trim().replace(/\s+/g, '_')

const resolveBoardPackageName = (boardName: string) =>
	boardName.startsWith('@aily-project/board-') ? boardName : `@aily-project/board-${boardName}`

const resolveBoardTemplatePath = (appDataPath: string, boardPackageName: string) =>
	path.join(appDataPath, 'node_modules', boardPackageName, 'template')

const loadExistingPackageJson = async (packageJsonPath: string): Promise<ProjectPackageJson | undefined> => {
	if (!existsSync(packageJsonPath)) return undefined

	try {
		return JSON.parse(await readFile(packageJsonPath, 'utf8')) as ProjectPackageJson
	} catch {
		return undefined
	}
}

const createDefaultProjectPackageJson = (input: ProjectCreateInput, boardPackageName: string): ProjectPackageJson => ({
	name: normalizeProjectName(input.name),
	nickname: input.nickname?.trim() || input.boardDisplayName || input.name.trim(),
	description: input.description?.trim() || '',
	version: '0.0.0',
	devmode: input.devmode || 'arduino',
	dependencies: {
		[boardPackageName]: input.boardVersion?.trim() || 'latest'
	}
})

/**
 * 创建一个新的空白项目，优先复用已安装开发板模板。
 * @param input - 项目创建输入
 */
export const createProject = async (input: ProjectCreateInput): Promise<ProjectCreateResult> => {
	const projectDirName = path.basename(input.projectPath)
	return withProjectDirectoryMutationLock(
		path.dirname(input.projectPath),
		`create-${projectDirName}`,
		'create-project',
		async () => {
			const boardPackageName = resolveBoardPackageName(input.boardName)
			const packageJsonPath = path.join(input.projectPath, 'package.json')
			const boardTemplatePath = resolveBoardTemplatePath(input.appDataPath, boardPackageName)

			await stat(input.projectPath)
				.then(() => {
					throw new Error(`目标项目目录已存在: ${input.projectPath}`)
				})
				.catch(error => {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
				})

			await mkdir(input.projectPath, { recursive: true })

			try {
				let usedBoardTemplate = false
				if (existsSync(boardTemplatePath)) {
					await cp(boardTemplatePath, input.projectPath, { recursive: true, force: true })
					usedBoardTemplate = true
				}

				const existingPackageJson = await loadExistingPackageJson(packageJsonPath)
				const nextPackageJson: ProjectPackageJson = {
					...createDefaultProjectPackageJson(input, boardPackageName),
					...(existingPackageJson ?? {}),
					name: normalizeProjectName(input.name),
					nickname:
						input.nickname?.trim() || existingPackageJson?.nickname || input.boardDisplayName || input.name.trim(),
					description: input.description?.trim() || existingPackageJson?.description || '',
					devmode: input.devmode || existingPackageJson?.devmode || 'arduino',
					dependencies: {
						...(existingPackageJson?.dependencies ?? {}),
						[boardPackageName]:
							input.boardVersion?.trim() || existingPackageJson?.dependencies?.[boardPackageName] || 'latest'
					}
				}

				await writeFile(packageJsonPath, JSON.stringify(nextPackageJson, null, 2) + '\n', 'utf8')

				return {
					projectPath: input.projectPath,
					packageJsonPath,
					usedBoardTemplate,
					boardPackageName
				}
			} catch (error) {
				await rm(input.projectPath, { recursive: true, force: true }).catch(() => undefined)
				throw error
			}
		}
	)
}
