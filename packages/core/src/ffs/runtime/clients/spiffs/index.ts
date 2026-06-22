import { createSpiffsFileBindings } from './files'
import { createSpiffsImageBindings } from './image'
import { initializeSpiffsModule } from './init'

import type { FfsSpiffsClient } from '../../filesystem/types'

/**
 * 创建 SPIFFS 客户端。
 * @param options - 初始化参数
 */
export const createSpiffsClient = async (options: {
	image?: Uint8Array
	pageSize: number
	blockSize: number
	blockCount: number
	fdCount?: number
	cachePages?: number
}) => {
	const module = await initializeSpiffsModule(options)
	const fileBindings = createSpiffsFileBindings(module)
	const imageBindings = createSpiffsImageBindings(module)

	return {
		...fileBindings,
		...imageBindings
	} satisfies FfsSpiffsClient
}
