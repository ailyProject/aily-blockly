import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

import { resolveScopedProjectLockPath } from '../paths'
import { getProjectLockStatusByFile } from '../status'
import { writeProjectLockPayload } from './shared'

/**
 * 以指定 pid 申请当前项目的持久 scoped lock。
 * @param input - 项目路径、scope、owner、pid
 */
export const acquirePersistentProjectLock = async (input: {
	projectPath: string
	lockFileName: string
	owner: string
	pid: number
}) => {
	const status = await getProjectLockStatusByFile(input.projectPath, input.lockFileName)
	if (status.locked && !status.stale && status.pid === input.pid) {
		return {
			acquired: true,
			alreadyHeld: true,
			status
		}
	}

	await writeProjectLockPayload(input.projectPath, input.lockFileName, input.owner, input.pid)
	return {
		acquired: true,
		alreadyHeld: false,
		status: await getProjectLockStatusByFile(input.projectPath, input.lockFileName)
	}
}

/**
 * 释放当前项目的持久 scoped lock。
 * @param input - 项目路径、lock 文件名与持有 pid
 */
export const releasePersistentProjectLock = async (input: {
	projectPath: string
	lockFileName: string
	pid?: number
}) => {
	const lockFilePath = resolveScopedProjectLockPath(input.projectPath, input.lockFileName)
	if (!existsSync(lockFilePath)) {
		return { released: false }
	}

	const status = await getProjectLockStatusByFile(input.projectPath, input.lockFileName)
	if (input.pid !== undefined && status.pid !== undefined && status.pid !== input.pid) {
		return { released: false, status }
	}

	await rm(lockFilePath, { force: true }).catch(() => undefined)
	return { released: true }
}
