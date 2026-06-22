import { p } from '../../trpc'

/**
 * 开始当前 sender 的 BLE 设备列表更新。
 */
export default p.mutation(({ ctx }) => ctx.bleBridge.startDeviceListUpdates(ctx.event.sender))
