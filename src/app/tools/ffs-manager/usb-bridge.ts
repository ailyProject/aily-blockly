/**
 * USB 串口桥接芯片 -> 最高可靠波特率 映射，复刻 ESPConnect 的自适应策略。
 *
 * 用法：
 *   const result = await resolveDesiredBaud(portPath, userBaud);
 *   if (result.capped) toast('已自动降速至 ' + result.baud);
 *   await esp.connect({ portPath, baudRate: result.baud });
 *
 * 详见 src/app/tools/ffs-manager/baudrate-strategy.md。
 */

export const SUPPORTED_BAUDRATES = [115200, 230400, 460800, 921600, 1_500_000, 2_000_000] as const;
export const DEFAULT_ROM_BAUD = 115200;
export const DEFAULT_FLASH_BAUD = 921600;

export interface BridgeProductInfo {
  name: string;
  /** 该芯片在持续传输下不丢字节的最高波特率（bps） */
  maxBaudrate: number;
}

export interface BridgeVendorInfo {
  vendorName: string;
  products: Record<number, BridgeProductInfo>;
}

export const USB_BRIDGE_CAPABILITIES: Record<number, BridgeVendorInfo> = {
  0x1a86: {
    vendorName: 'QinHeng Electronics',
    products: {
      0x7522: { name: 'CH340', maxBaudrate: 460_800 },
      0x7523: { name: 'CH340', maxBaudrate: 460_800 },
      0x7584: { name: 'CH340', maxBaudrate: 460_800 },
      0x5523: { name: 'CH341', maxBaudrate: 2_000_000 },
      0x55d3: { name: 'CH343', maxBaudrate: 6_000_000 },
      0x55d4: { name: 'CH9102', maxBaudrate: 6_000_000 },
      0x55d8: { name: 'CH9101', maxBaudrate: 3_000_000 },
    },
  },
  0x10c4: {
    vendorName: 'Silicon Labs',
    products: {
      0xea60: { name: 'CP2102(n)', maxBaudrate: 3_000_000 },
      0xea70: { name: 'CP2105', maxBaudrate: 2_000_000 },
      0xea71: { name: 'CP2108', maxBaudrate: 2_000_000 },
    },
  },
  0x0403: {
    vendorName: 'FTDI',
    products: {
      0x6001: { name: 'FT232R', maxBaudrate: 3_000_000 },
      0x6010: { name: 'FT2232', maxBaudrate: 3_000_000 },
      0x6011: { name: 'FT4232', maxBaudrate: 3_000_000 },
      0x6014: { name: 'FT232H', maxBaudrate: 12_000_000 },
      0x6015: { name: 'FT230X', maxBaudrate: 3_000_000 },
    },
  },
  0x303a: {
    vendorName: 'Espressif Systems',
    products: {
      0x0002: { name: 'ESP32-S2 Native USB', maxBaudrate: 2_000_000 },
      0x1000: { name: 'ESP32 Native USB', maxBaudrate: 2_000_000 },
      0x1001: { name: 'ESP32 Native USB', maxBaudrate: 2_000_000 },
      0x1002: { name: 'ESP32 Native USB', maxBaudrate: 2_000_000 },
      0x4002: { name: 'ESP32 Native USB (CDC)', maxBaudrate: 2_000_000 },
    },
  },
};

export interface BridgeLookupResult {
  vendorName: string;
  productName?: string;
  maxBaudrate?: number;
}

export function getUsbDeviceInfo(vid: number, pid: number): BridgeLookupResult | undefined {
  const vendor = USB_BRIDGE_CAPABILITIES[vid];
  if (!vendor) return undefined;
  const product = vendor.products[pid];
  if (!product) {
    return { vendorName: vendor.vendorName };
  }
  return {
    vendorName: vendor.vendorName,
    productName: product.name,
    maxBaudrate: product.maxBaudrate,
  };
}

export interface ResolvedBaud {
  /** 实际应使用的波特率 */
  baud: number;
  /** 是否因芯片能力限制而被钳制 */
  capped: boolean;
  /** 用户请求的原始波特率 */
  requested: number;
  /** 探测到的桥接芯片信息（如果有） */
  bridge?: BridgeLookupResult;
}

/** 把 hex 字符串（"1A86" / "0x1A86"）或十进制数字字符串解析为 number。 */
function parseUsbId(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return undefined;
  // node-serialport 在 Windows/macOS 上返回大写 hex 字符串，不带 0x。
  const cleaned = text.replace(/^0x/i, '');
  const value = parseInt(cleaned, 16);
  return Number.isFinite(value) ? value : undefined;
}

declare const window: any;

/**
 * 通过串口路径查询 VID/PID。优先使用 Electron 的 SerialPort.list()，
 * 浏览器环境下退化为读取 Web Serial port.getInfo()（需要预先传入 portObject）。
 */
export async function lookupBridgeByPath(
  portPath: string,
  portObject?: { getInfo?: () => { usbVendorId?: number; usbProductId?: number } } | null,
): Promise<{ vid?: number; pid?: number; bridge?: BridgeLookupResult }> {
  // 1) Web Serial 直接走 getInfo()
  if (portObject && typeof portObject.getInfo === 'function') {
    try {
      const info = portObject.getInfo();
      if (typeof info?.usbVendorId === 'number' && typeof info?.usbProductId === 'number') {
        return {
          vid: info.usbVendorId,
          pid: info.usbProductId,
          bridge: getUsbDeviceInfo(info.usbVendorId, info.usbProductId),
        };
      }
    } catch {
      // ignore, 下面继续尝试 Node 路径
    }
  }

  // 2) Electron / Node SerialPort.list()
  const list = typeof window !== 'undefined' ? window?.electronAPI?.SerialPort?.list : undefined;
  if (typeof list !== 'function' || !portPath) {
    return {};
  }
  try {
    const ports: Array<Record<string, unknown>> = await list();
    const entry = ports?.find(p => (p as any)?.path === portPath);
    if (!entry) return {};
    const vid = parseUsbId(entry['vendorId']);
    const pid = parseUsbId(entry['productId']);
    if (vid === undefined || pid === undefined) {
      return { vid, pid };
    }
    return { vid, pid, bridge: getUsbDeviceInfo(vid, pid) };
  } catch (err) {
    console.warn('[usb-bridge] 查询串口列表失败:', err);
    return {};
  }
}

/**
 * 根据桥接芯片能力把用户期望的波特率钳制到上限。
 * - 不识别的芯片不做任何修改，尊重用户选择。
 * - 钳制时落到 SUPPORTED_BAUDRATES 中 ≤ 上限的最高档位。
 */
export function capBaudrate(userBaud: number, bridge?: BridgeLookupResult): ResolvedBaud {
  const requested = userBaud || DEFAULT_FLASH_BAUD;
  if (bridge?.maxBaudrate && requested > bridge.maxBaudrate) {
    const capped =
      [...SUPPORTED_BAUDRATES].filter(rate => rate <= bridge.maxBaudrate!).pop() ?? DEFAULT_FLASH_BAUD;
    return { baud: capped, capped: true, requested, bridge };
  }
  return { baud: requested, capped: false, requested, bridge };
}

/**
 * 一步到位：根据串口路径解析 VID/PID 并钳制波特率。
 */
export async function resolveDesiredBaud(
  portPath: string,
  userBaud: number,
  portObject?: { getInfo?: () => { usbVendorId?: number; usbProductId?: number } } | null,
): Promise<ResolvedBaud> {
  const { bridge } = await lookupBridgeByPath(portPath, portObject);
  return capBaudrate(userBaud, bridge);
}
