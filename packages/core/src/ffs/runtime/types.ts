/**
 * Flash FS 支持的可靠波特率档位。
 */
export type FfsSupportedBaudrate =
	/** ESP ROM 默认握手波特率。 */
	| 115200
	/** 较低风险的高速串口档位。 */
	| 230400
	/** CH340 等常见桥接芯片的上限档位。 */
	| 460800
	/** 当前工具默认的高速烧录档位。 */
	| 921600
	/** 原生 USB 或高性能桥接芯片常用档位。 */
	| 1500000
	/** 当前仓库可接受的最高标准档位。 */
	| 2000000

/**
 * USB 串口桥接芯片信息。
 */
export interface FfsBridgeProductInfo {
	/** 芯片名称。 */
	name: string
	/** 持续传输下的最高可靠波特率。 */
	maxBaudrate: number
}

/**
 * USB 厂商下的桥接芯片集合。
 */
export interface FfsBridgeVendorInfo {
	/** 厂商名称。 */
	vendorName: string
	/** 当前厂商下的产品映射。 */
	products: Record<number, FfsBridgeProductInfo>
}

/**
 * 串口桥接芯片识别结果。
 */
export interface FfsBridgeLookupResult {
	/** 厂商名称。 */
	vendorName: string
	/** 产品名称。 */
	productName?: string
	/** 当前产品的最高可靠波特率。 */
	maxBaudrate?: number
}

/**
 * FFS 波特率解析结果。
 */
export interface FfsResolvedBaudrate {
	/** 最终应使用的波特率。 */
	baud: number
	/** 是否因为桥接芯片限制而自动降速。 */
	capped: boolean
	/** 用户原始请求的波特率。 */
	requested: number
	/** 探测到的桥接芯片信息。 */
	bridge?: FfsBridgeLookupResult
	/** 探测到的 USB Vendor ID。 */
	vid?: number
	/** 探测到的 USB Product ID。 */
	pid?: number
}
