import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import {
	PROJECT_MUTATION_LOCK_FILE,
	PROJECT_OPEN_SESSION_LOCK_FILE,
	resolveProjectMutationLockPath,
	resolveScopedProjectLockPath
} from './paths'

import type { ProjectMutationLockStatus, ProjectOpenSessionLockStatus } from '../types'

const isProjectMutationLockPidAlive = (pid: number | undefined) => {
	if (!Number.isFinite(pid) || !pid || pid <= 0) return false

	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

const readProjectLockStatus = async (projectPath: string, lockFilePath: string): Promise<ProjectMutationLockStatus> => {
	if (!existsSync(lockFilePath)) {
		return {
			projectPath,
			lockFilePath,
			locked: false
		}
	}

	try {
		const raw = JSON.parse(await readFile(lockFilePath, 'utf8')) as { owner?: string; createdAt?: string; pid?: number }
		const pid = typeof raw.pid === 'number' ? raw.pid : undefined
		const stale = pid !== undefined ? !isProjectMutationLockPidAlive(pid) : false
		return {
			projectPath,
			lockFilePath,
			locked: true,
			...(stale ? { stale } : {}),
			...(raw.owner ? { owner: raw.owner } : {}),
			...(pid !== undefined ? { pid } : {}),
			...(raw.createdAt ? { createdAt: raw.createdAt } : {})
		}
	} catch {
		return {
			projectPath,
			lockFilePath,
			locked: true
		}
	}
}

/**
 * 读取当前项目 mutation lock 状态。
 * @param projectPath - 当前项目目录
 */
export const getProjectMutationLockStatus = (projectPath: string): Promise<ProjectMutationLockStatus> =>
	readProjectLockStatus(projectPath, resolveProjectMutationLockPath(projectPath))

/**
 * 读取当前项目任意 scoped lock 状态。
 * @param projectPath - 当前项目目录
 * @param lockFileName - lock 文件名
 */
export const getScopedProjectLockStatus = (
	projectPath: string,
	lockFileName: string
): Promise<ProjectMutationLockStatus> =>
	readProjectLockStatus(projectPath, resolveScopedProjectLockPath(projectPath, lockFileName))

/**
 * 读取当前项目打开会话锁状态。
 * @param projectPath - 当前项目目录
 */
export const getProjectOpenSessionLockStatus = (projectPath: string): Promise<ProjectOpenSessionLockStatus> =>
	getScopedProjectLockStatus(projectPath, PROJECT_OPEN_SESSION_LOCK_FILE)

/**
 * 根据 lock 文件名读取统一状态。
 * @param projectPath - 当前项目目录
 * @param lockFileName - lock 文件名
 */
export const getProjectLockStatusByFile = (projectPath: string, lockFileName: string) =>
	lockFileName === PROJECT_MUTATION_LOCK_FILE
		? getProjectMutationLockStatus(projectPath)
		: getScopedProjectLockStatus(projectPath, lockFileName)
