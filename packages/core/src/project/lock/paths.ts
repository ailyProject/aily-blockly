import path from 'node:path'

const PROJECT_LOCK_DIR = ['.aily', 'locks']
export const PROJECT_MUTATION_LOCK_FILE = 'project-mutation.lock.json'
export const PROJECT_OPEN_SESSION_LOCK_FILE = 'project-open-session.lock.json'

/**
 * 解析当前项目的 lock 目录。
 * @param projectPath - 当前项目目录
 */
export const resolveProjectLockDir = (projectPath: string) => path.join(projectPath, ...PROJECT_LOCK_DIR)

/**
 * 解析当前项目的 mutation lock 文件路径。
 * @param projectPath - 当前项目目录
 */
export const resolveProjectMutationLockPath = (projectPath: string) =>
	path.join(resolveProjectLockDir(projectPath), PROJECT_MUTATION_LOCK_FILE)

/**
 * 解析当前项目的打开会话锁路径。
 * @param projectPath - 当前项目目录
 */
export const resolveProjectOpenSessionLockPath = (projectPath: string) =>
	path.join(resolveProjectLockDir(projectPath), PROJECT_OPEN_SESSION_LOCK_FILE)

/**
 * 解析任意 scoped lock 文件路径。
 * @param rootPath - lock 根目录
 * @param lockFileName - lock 文件名
 */
export const resolveScopedProjectLockPath = (rootPath: string, lockFileName: string) =>
	path.join(resolveProjectLockDir(rootPath), lockFileName)
