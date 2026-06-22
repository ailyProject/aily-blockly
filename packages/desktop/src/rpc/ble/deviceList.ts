import { observable } from '@trpc/server/observable'

import { p } from '../../trpc'

/**
 * 订阅当前 sender 的 BLE 设备列表更新。
 */
export default p.subscription(({ ctx }) =>
	observable(subscriber => {
		const unsubscribe = ctx.bleBridge.subscribeDeviceList(ctx.event.sender, devices => {
			subscriber.next(devices)
		})
		return () => {
			unsubscribe()
		}
	})
)
