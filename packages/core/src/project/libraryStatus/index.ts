import path from 'node:path'
import { AILY_BLOCKLY_USED_LIBRARIES_FIELD } from 'shared'

import { getMissingProjectLibraries } from '../../metadata'
import { getSelectedBoardPackage } from '../packageJson'
import { getDeclaredBlocklyLibraryDependencies } from '../packageRules'
import { readProjectDocument } from '../readDocument'
import { readProjectPackageJson } from '../readPackageJson'
import { getReadyProjectBlocklyLibraryPackages } from './ready'

import type { ProjectBlocklyLibraryStatus } from '../types'

const resolveDeclaredBlocklyLibraryLocalPath = (projectPath: string, version: string) => {
	if (!version.startsWith('file:')) return undefined
	const filePath = version.slice(5)
	if (!filePath) return undefined
	return path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath)
}

/**
 * 读取当前项目的 Blockly 库状态摘要。
 * @param projectPath - 当前项目目录
 */
export const getProjectBlocklyLibraryStatus = async (projectPath: string): Promise<ProjectBlocklyLibraryStatus> => {
	const [packageJson, documentSnapshot] = await Promise.all([
		readProjectPackageJson(projectPath),
		readProjectDocument(projectPath)
	])
	const declaredDependencies = getDeclaredBlocklyLibraryDependencies(packageJson)
	const boardPackageName = getSelectedBoardPackage(packageJson) ?? undefined
	const boardId = boardPackageName?.replace(/^@aily-project\/board-/, '') || undefined
	const declaredLibraries = [...declaredDependencies.entries()].map(([name, version]) => ({
		name,
		version,
		...(resolveDeclaredBlocklyLibraryLocalPath(projectPath, version)
			? { localPath: resolveDeclaredBlocklyLibraryLocalPath(projectPath, version) }
			: {}),
		ready: false
	}))
	const readyLibraryPackages = getReadyProjectBlocklyLibraryPackages(
		projectPath,
		declaredLibraries.map(item => item.name)
	)
	const readyLibrarySet = new Set(readyLibraryPackages)
	const missingLibraries =
		packageJson && documentSnapshot.exists
			? getMissingProjectLibraries(
					projectPath,
					packageJson,
					packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD],
					documentSnapshot.document,
					readyLibraryPackages
				)
			: []

	return {
		projectPath,
		...(boardPackageName ? { boardPackageName } : {}),
		...(boardId ? { boardId } : {}),
		manifestField: AILY_BLOCKLY_USED_LIBRARIES_FIELD,
		hasPackageJson: packageJson !== null,
		hasProjectDocument: documentSnapshot.exists,
		declaredLibraries: declaredLibraries.map(item => ({
			...item,
			ready: readyLibrarySet.has(item.name)
		})),
		readyLibraryPackages,
		missingLibraries
	}
}

export * from './ready'
