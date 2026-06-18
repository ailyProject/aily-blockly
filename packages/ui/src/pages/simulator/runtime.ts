import { boardIndex, libraryIndex } from '@/workspace'

import type { Core } from '@/core-service'
import type { SimulatorState } from './types'

/**
 * 加载仿真器页面状态。
 * @param {Core} core - core 服务句柄
 * @returns {Promise<SimulatorState>}
 */
export const loadSimulatorState = async (core: Core): Promise<SimulatorState> => {
	const [compatResults, interfaces] = await Promise.all([
		core.hardware.searchCompat.query({
			boards: boardIndex,
			libraries: libraryIndex,
			query: { query: 'rfid', type: 'libraries', maxResults: 4 }
		}),
		core.hardware.getBoardCategories.query({ boards: boardIndex, dimension: 'interfaces' })
	])

	return {
		matchCount: compatResults.length,
		boardNames: compatResults.map(item => item.displayName),
		interfaceNames: interfaces.categories.map(item => item.name)
	}
}
