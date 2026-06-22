import { DEFAULT_FFS_FLASH_BAUD, SUPPORTED_FFS_BAUDRATES } from './catalog'
import { lookupFfsBridgeByPath } from './lookup'

import type { FfsBridgeLookupResult, FfsResolvedBaudrate } from '../types'

/**
 * 根据桥接芯片能力对请求波特率做钳制。
 * @param requestedBaud - 用户请求的波特率
 * @param bridge - 已识别的桥接芯片
 */
export const capFfsBaudrate = (
	requestedBaud: number,
	bridge?: FfsBridgeLookupResult
): Pick<FfsResolvedBaudrate, 'baud' | 'capped' | 'requested' | 'bridge'> => {
	const requested = requestedBaud || DEFAULT_FFS_FLASH_BAUD
	const maxBaudrate = bridge?.maxBaudrate
	if (maxBaudrate && requested > maxBaudrate) {
		const baud = SUPPORTED_FFS_BAUDRATES.filter(rate => rate <= maxBaudrate).pop() ?? DEFAULT_FFS_FLASH_BAUD
		return { baud, capped: true, requested, bridge }
	}

	return { baud: requested, capped: false, requested, bridge }
}

/**
 * 一步完成串口桥接芯片探测与波特率解析。
 * @param portPath - 串口路径
 * @param requestedBaud - 用户请求的波特率
 */
export const resolveFfsBaudrate = async (portPath: string, requestedBaud: number): Promise<FfsResolvedBaudrate> => {
	const { bridge, vid, pid } = await lookupFfsBridgeByPath(portPath)
	return {
		...capFfsBaudrate(requestedBaud, bridge),
		vid,
		pid
	}
}
