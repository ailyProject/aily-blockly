import { allocSpiffs, assertSpiffs } from './shared'

import type { FfsSpiffsClient } from '../../filesystem/types'
import type { SpiffsRuntimeModule } from './init'

/**
 * 创建 SPIFFS 镜像与容量绑定。
 * @param module - 已初始化的 SPIFFS 运行时模块
 */
export const createSpiffsImageBindings = (
	module: SpiffsRuntimeModule
): Pick<FfsSpiffsClient, 'format' | 'toImage' | 'getUsage'> => ({
	async format() {
		assertSpiffs(module.exports.spiffsjs_format(), 'format SPIFFS')
	},
	async toImage() {
		const size = module.exports.spiffsjs_storage_size()
		const ptr = allocSpiffs(module.exports, size)
		try {
			assertSpiffs(module.exports.spiffsjs_export_image(ptr, size), 'export SPIFFS image')
			return module.heap.slice(ptr, ptr + size)
		} finally {
			if (ptr) module.exports.free(ptr)
		}
	},
	async getUsage() {
		const ptr = allocSpiffs(module.exports, 12)
		try {
			assertSpiffs(module.exports.spiffsjs_get_usage(ptr), 'get SPIFFS usage')
			const view = new DataView(module.heap.buffer, ptr, 12)
			return {
				capacityBytes: view.getUint32(0, true),
				usedBytes: view.getUint32(4, true),
				freeBytes: view.getUint32(8, true)
			}
		} finally {
			module.exports.free(ptr)
		}
	}
})
