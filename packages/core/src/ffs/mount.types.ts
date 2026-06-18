import type { FfsFilesystemType } from './types'

/**
 * 文件系统挂载尝试参数。
 */
export interface FfsMountAttempt {
	/** 本次尝试的块大小。 */
	blockSize: number
	/** 由镜像大小推导出的块数量。 */
	blockCount: number
	/** SPIFFS 场景下的页大小。 */
	pageSize?: number
	/** 当前尝试的语义说明。 */
	reason: string
}

/**
 * 文件系统挂载计划。
 */
export interface FfsMountPlan {
	/** 目标文件系统类型。 */
	type: FfsFilesystemType
	/** 当前镜像是否为空白镜像。 */
	blankImage: boolean
	/** 底层客户端应使用的根路径。 */
	clientRootPath: string
	/** 当前建议的挂载尝试列表。 */
	attempts: Array<FfsMountAttempt>
}
