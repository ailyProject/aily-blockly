import { acquirePersistentProjectLock, releasePersistentProjectLock } from './acquire'
import { PROJECT_OPEN_SESSION_LOCK_FILE } from './paths'
import { getProjectOpenSessionLockStatus } from './status'

/**
 * 以指定 pid 申请当前项目的打开会话锁。
 * @param input - 项目路径与宿主 pid
 */
export const acquireProjectOpenSessionLock = async (input: { projectPath: string; owner: string; pid: number }) =>
	acquirePersistentProjectLock({
		projectPath: input.projectPath,
		lockFileName: PROJECT_OPEN_SESSION_LOCK_FILE,
		owner: input.owner,
		pid: input.pid
	})

/**
 * 释放当前项目的打开会话锁。
 * @param input - 项目路径与宿主 pid
 */
export const releaseProjectOpenSessionLock = (input: { projectPath: string; pid?: number }) =>
	releasePersistentProjectLock({
		projectPath: input.projectPath,
		lockFileName: PROJECT_OPEN_SESSION_LOCK_FILE,
		pid: input.pid
	})

export { getProjectOpenSessionLockStatus }
