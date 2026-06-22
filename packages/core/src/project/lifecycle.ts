import { existsSync } from 'node:fs'
import path from 'node:path'

import { resolveProjectTempDocumentPath } from './documentPaths'
import { resolveProjectEditorRoute } from './editorEntry'
import { getProjectBlocklyLibraryStatus } from './libraryStatus'
import { getProjectMutationLockStatus, getProjectOpenSessionLockStatus } from './lock'
import { getDeclaredDependencies, getSelectedBoardPackage } from './packageJson'
import { getDeclaredBlocklyLibraryDependencies } from './packageRules'
import { readProjectDocument } from './readDocument'
import { readProjectPackageJson } from './readPackageJson'

import type { ProjectLifecycleStatus } from './types'

/**
 * 读取当前项目生命周期状态摘要。
 * @param projectPath - 当前项目目录
 */
export const getProjectLifecycleStatus = async (projectPath: string): Promise<ProjectLifecycleStatus> => {
	const [packageJson, documentSnapshot, libraryStatus] = await Promise.all([
		readProjectPackageJson(projectPath),
		readProjectDocument(projectPath),
		getProjectBlocklyLibraryStatus(projectPath)
	])
	const [lockStatus, openSessionLockStatus] = await Promise.all([
		getProjectMutationLockStatus(projectPath),
		getProjectOpenSessionLockStatus(projectPath)
	])
	const declaredDependencies = getDeclaredDependencies(packageJson ?? {})
	const declaredBlocklyLibraryDependencies = getDeclaredBlocklyLibraryDependencies(packageJson)
	const boardPackageName = getSelectedBoardPackage(packageJson) ?? undefined
	const boardPackageVersion = boardPackageName ? declaredDependencies.all[boardPackageName] || undefined : undefined
	const declaredLibraryDependencies = [...declaredBlocklyLibraryDependencies.entries()]
		.map(([name, version]) => `${name}@${version}`)
		.sort((left, right) => left.localeCompare(right))
	const declaredLibraryCount = declaredBlocklyLibraryDependencies.size
	const dependencySignature = JSON.stringify({
		board: boardPackageName ? `${boardPackageName}@${boardPackageVersion || ''}` : '',
		libs: declaredLibraryDependencies
	})
	const boardPackageReady = boardPackageName
		? ['package.json', 'board.json'].every(fileName =>
				existsSync(path.join(projectPath, 'node_modules', ...boardPackageName.split('/'), fileName))
			)
		: undefined

	return {
		projectPath,
		hasPackageJson: packageJson !== null,
		hasProjectDocument: documentSnapshot.exists,
		hasTempDocument: existsSync(resolveProjectTempDocumentPath(projectPath)),
		hasMutationLock: lockStatus.locked,
		...(lockStatus.stale ? { mutationLockStale: true } : {}),
		...(lockStatus.owner ? { mutationLockOwner: lockStatus.owner } : {}),
		...(typeof lockStatus.pid === 'number' ? { mutationLockPid: lockStatus.pid } : {}),
		hasOpenSessionLock: openSessionLockStatus.locked,
		...(openSessionLockStatus.stale ? { openSessionLockStale: true } : {}),
		...(openSessionLockStatus.owner ? { openSessionLockOwner: openSessionLockStatus.owner } : {}),
		...(typeof openSessionLockStatus.pid === 'number' ? { openSessionLockPid: openSessionLockStatus.pid } : {}),
		recoveredFromTemp: documentSnapshot.recoveredFromTemp === true,
		...(documentSnapshot.sourceFilePath ? { sourceFilePath: documentSnapshot.sourceFilePath } : {}),
		...(documentSnapshot.parseError ? { parseError: documentSnapshot.parseError } : {}),
		editorRoute: resolveProjectEditorRoute(projectPath),
		...(boardPackageName ? { boardPackageName } : {}),
		...(boardPackageVersion ? { boardPackageVersion } : {}),
		...(boardPackageReady !== undefined ? { boardPackageReady } : {}),
		declaredLibraryDependencies,
		dependencySignature,
		declaredLibraryCount,
		readyLibraryCount: libraryStatus.readyLibraryPackages.length,
		missingLibraryCount: libraryStatus.missingLibraries.length,
		...(typeof packageJson?.codeHash === 'string' ? { codeHash: packageJson.codeHash } : {}),
		...(packageJson?.buildInfo ? { buildInfo: packageJson.buildInfo } : {})
	}
}
