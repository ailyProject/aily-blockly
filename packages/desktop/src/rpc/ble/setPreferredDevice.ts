import { z } from 'zod'

import { p } from '../../trpc'

/**
 * 设置当前 sender 的首选 BLE 设备。
 */
export default p
	.input(
		z.object({
			deviceId: z.string()
		})
	)
	.mutation(({ ctx, input }) => ctx.bleBridge.setPreferredDevice(ctx.event.sender, input.deviceId))
