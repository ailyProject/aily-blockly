import { mkdir, open, rm, writeFile } from 'node:fs/promises'

import { resolveProjectLockDir, resolveScopedProjectLockPath } from '../paths'
import { getProjectLockStatusByFile } from '../status'

const describeProjectLockHolder = (status: Awaited<ReturnType<typeof getProjectLockStatusByFile>>) => {
	const reason = status.owner ? `${status.owner}${status.createdAt ? ` @ ${status.createdAt}` : ''}` : 'unknown holder'
	const staleText = status.stale ? ' (stale lock detected)' : ''
	return `${reason}${staleText}`
}

const openProjectLockHandle = async (lockRootPath: string, lockFileName: string) =>
	open(resolveScopedProjectLockPath(lockRootPath, lockFileName), 'wx').catch(async () => {
		const status = await getProjectLockStatusByFile(lockRootPath, lockFileName)
		if (status.locked && status.stale) {
			await rm(resolveScopedProjectLockPath(lockRootPath, lockFileName), { force: true }).catch(() => undefined)
			return open(resolveScopedProjectLockPath(lockRootPath, lockFileName), 'wx')
		}

		throw new Error(`Project mutation is locked by ${describeProjectLockHolder(status)}`)
	})

/**
 * 写入项目级 lock 文件 payload。
 * @param lockRootPath - lock 根目录
 * @param lockFileName - lock 文件名
 * @param owner - lock 持有者标识
 * @param pid - 持有者进程号
 */
export const writeProjectLockPayload = async (
	lockRootPath: string,
	lockFileName: string,
	owner: string,
	pid: number
) => {
	const lockDir = resolveProjectLockDir(lockRootPath)
	await mkdir(lockDir, { recursive: true })
	const lockFilePath = resolveScopedProjectLockPath(lockRootPath, lockFileName)
	const handle = await openProjectLockHandle(lockRootPath, lockFileName)
	try {
		await writeFile(
			lockFilePath,
			JSON.stringify(
				{
					owner,
					createdAt: new Date().toISOString(),
					pid
				},
				null,
				2
			) + '\n',
			'utf8'
		)
	} finally {
		await handle.close().catch(() => undefined)
	}
}
