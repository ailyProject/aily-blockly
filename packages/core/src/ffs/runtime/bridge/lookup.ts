import { listHardwareRawSerialPorts } from '../../../hardware/ports'
import { USB_BRIDGE_CAPABILITIES } from './catalog'
import { parseFfsUsbId } from './parse'

import type { FfsBridgeLookupResult } from '../types'

/**
 * 根据 VID/PID 查找 USB 串口桥接芯片信息。
 * @param vid - USB Vendor ID
 * @param pid - USB Product ID
 */
export const getFfsUsbBridgeInfo = (vid: number, pid: number): FfsBridgeLookupResult | undefined => {
	const vendor = USB_BRIDGE_CAPABILITIES[vid]
	if (!vendor) return undefined

	const product = vendor.products[pid]
	if (!product) return { vendorName: vendor.vendorName }

	return {
		vendorName: vendor.vendorName,
		productName: product.name,
		maxBaudrate: product.maxBaudrate
	}
}

/**
 * 通过串口路径查找 USB 串口桥接芯片信息。
 * @param portPath - 串口路径
 */
export const lookupFfsBridgeByPath = async (portPath: string) => {
	const ports = await listHardwareRawSerialPorts()
	const entry = ports.find(item => item.path === portPath)
	if (!entry) return {}

	const vid = parseFfsUsbId(entry.vendorId)
	const pid = parseFfsUsbId(entry.productId)
	if (vid === undefined || pid === undefined) return { vid, pid }

	return {
		vid,
		pid,
		bridge: getFfsUsbBridgeInfo(vid, pid)
	}
}
