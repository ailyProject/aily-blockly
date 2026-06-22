import { p } from '../../trpc'

/**
 * 停止当前 sender 的 BLE 设备列表更新。
 */
export default p.mutation(({ ctx }) => ctx.bleBridge.stopDeviceListUpdates(ctx.event.sender))
