import { rm } from 'node:fs/promises'

import { resolveScopedProjectLockPath } from '../paths'
import { writeProjectLockPayload } from './shared'

/**
 * 在指定目录下持有 scoped mutation lock 执行关键操作。
 * @param directoryPath - lock 作用目录
 * @param scope - lock scope 名称
 * @param owner - lock 持有者标识
 * @param action - 需要保护的关键操作
 */
export const withProjectDirectoryMutationLock = async <T>(
	directoryPath: string,
	scope: string,
	owner: string,
	action: () => Promise<T>
): Promise<T> => {
	const lockFileName = `${scope}.lock.json`
	await writeProjectLockPayload(directoryPath, lockFileName, owner, process.pid)
	try {
		return await action()
	} finally {
		await rm(resolveScopedProjectLockPath(directoryPath, lockFileName), { force: true }).catch(() => undefined)
	}
}

/**
 * 在当前项目目录持有 mutation lock 执行关键操作。
 * @param projectPath - 当前项目目录
 * @param owner - lock 持有者标识
 * @param action - 需要保护的关键操作
 */
export const withProjectMutationLock = async <T>(
	projectPath: string,
	owner: string,
	action: () => Promise<T>
): Promise<T> => withProjectDirectoryMutationLock(projectPath, 'project-mutation', owner, action)
