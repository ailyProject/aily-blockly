# ESP 串口连接波特率自适应策略

本文档总结一种基于 USB VID/PID 的串口连接波特率自适应策略，便于在其他程序中复用。
核心思想：**通过 Web Serial（或等价 API）拿到端口的 USB VID/PID，查表得到桥接芯片型号及其 `maxBaudrate`，再决定是否把用户选择的高波特率钳制（cap）到芯片能可靠承受的上限。**

---

## 1. 设计目标

- ESP32 **原生 USB**（内置 USB-Serial/JTAG，VID `0x303a`）：直接以**高波特率**（默认 921600，可选 1.5/2 Mbps）通信，因为 USB-CDC 的“波特率”只是占位，实际走 USB 12 Mbps 总线。
- **CH340 转串口芯片**（VID `0x1a86`，PID `0x7522/0x7523/0x7584`）：硬件 PLL 在 >460800 bps 时丢字节，必须**自动降速到 460800**。
- 其他桥接芯片（CH343/CH9102、CP2102(n)、FTDI 系列等）：按各自能力表上限，不强制降速。
- 用户仍可在 UI 中手动选择波特率；策略只在“用户选的值 > 芯片上限”时介入。

---

## 2. 桥接芯片能力表

按 `VID -> { PID -> { name, maxBaudrate } }` 维护一张静态映射：

| VID | 厂商 | PID | 芯片 | maxBaudrate (bps) |
|---|---|---|---|---|
| `0x1a86` | QinHeng (WCH) | `0x7522` | CH340 | **460 800** |
| `0x1a86` | QinHeng (WCH) | `0x7523` | CH340 | **460 800** |
| `0x1a86` | QinHeng (WCH) | `0x7584` | CH340 | **460 800** |
| `0x1a86` | QinHeng (WCH) | `0x5523` | CH341 | 2 000 000 |
| `0x1a86` | QinHeng (WCH) | `0x55d3` | CH343 | 6 000 000 |
| `0x1a86` | QinHeng (WCH) | `0x55d4` | CH9102 | 6 000 000 |
| `0x1a86` | QinHeng (WCH) | `0x55d8` | CH9101 | 3 000 000 |
| `0x10c4` | Silicon Labs | `0xea60` | CP2102(n) | 3 000 000 |
| `0x10c4` | Silicon Labs | `0xea70` | CP2105 | 2 000 000 |
| `0x10c4` | Silicon Labs | `0xea71` | CP2108 | 2 000 000 |
| `0x0403` | FTDI | `0x6001` | FT232R | 3 000 000 |
| `0x0403` | FTDI | `0x6010` | FT2232 | 3 000 000 |
| `0x0403` | FTDI | `0x6011` | FT4232 | 3 000 000 |
| `0x0403` | FTDI | `0x6014` | FT232H | 12 000 000 |
| `0x0403` | FTDI | `0x6015` | FT230X | 3 000 000 |
| `0x303a` | Espressif | `0x0002` | ESP32-S2 Native USB | 2 000 000 |
| `0x303a` | Espressif | `0x1000` | ESP32 Native USB | 2 000 000 |
| `0x303a` | Espressif | `0x1001` | ESP32 Native USB | 2 000 000 |
| `0x303a` | Espressif | `0x1002` | ESP32 Native USB | 2 000 000 |
| `0x303a` | Espressif | `0x4002` | ESP32 Native USB (CDC) | 2 000 000 |

支持的波特率档位：

```
SUPPORTED_BAUDRATES = [115200, 230400, 460800, 921600, 1_500_000, 2_000_000]
DEFAULT_ROM_BAUD    = 115200      // 与 ROM bootloader 握手用
DEFAULT_FLASH_BAUD  = 921600      // 握手后烧录/通信默认值
MONITOR_BAUD        = 115200      // 串口监视器默认值
```

---

## 3. 核心算法

### 3.1 查表

```ts
function getUsbDeviceInfo(vid: number, pid: number) {
  const vendor = USB_BRIDGE_CAPABILITIES[vid];
  if (!vendor) return undefined;
  const product = vendor.products[pid];
  if (!product) return { vendorName: vendor.vendorName, product: undefined };
  return {
    vendorName: vendor.vendorName,
    productName: product.name,
    maxBaudrate: product.maxBaudrate,
  };
}
```

### 3.2 连接时钳制波特率

```ts
// 1) 取得端口 VID/PID
const info   = port.getInfo();                       // Web Serial 标准 API
const bridge = (typeof info.usbVendorId  === 'number'
             && typeof info.usbProductId === 'number')
  ? getUsbDeviceInfo(info.usbVendorId, info.usbProductId)
  : undefined;

// 2) 用户期望波特率
let desiredBaud = selectedBaud || DEFAULT_FLASH_BAUD;

// 3) 仅对 CH340 做强制降速
if (bridge
    && bridge.productName === 'CH340'
    && typeof bridge.maxBaudrate === 'number'
    && desiredBaud > bridge.maxBaudrate) {
  desiredBaud =
    SUPPORTED_BAUDRATES.filter(rate => rate <= bridge.maxBaudrate).pop()
    ?? DEFAULT_FLASH_BAUD;             // 结果即 460800
  notifyUser(`Detected CH340 bridge; lowering baud to ${desiredBaud} bps.`);
}
```

> **泛化版**（推荐用于新项目）：把判断条件改为对所有已知桥接芯片生效，而不只 CH340：
>
> ```ts
> if (bridge?.maxBaudrate && desiredBaud > bridge.maxBaudrate) {
>   desiredBaud = SUPPORTED_BAUDRATES
>     .filter(r => r <= bridge.maxBaudrate).pop() ?? DEFAULT_FLASH_BAUD;
> }
> ```

### 3.3 两阶段连接

```text
1. 以 DEFAULT_ROM_BAUD (115200) 打开串口，与 ROM bootloader 握手 (esptool sync)
2. 握手成功后调用 loader.setBaudrate(desiredBaud) 切换到目标速率
3. 后续 flash/read/monitor 都在 desiredBaud 下进行
```

伪代码：

```ts
transport.baudrate = DEFAULT_ROM_BAUD;
await transport.open();
await transport.flushInput();
const esp = await loader.connectAndHandshake();   // 115200
await loader.setBaudrate(desiredBaud);            // -> 921600 / 460800 / ...
transport.baudrate = desiredBaud;
```

---

## 4. 设备分类决策表

| 设备类型 | 典型 VID:PID | 查表结果 productName | 是否降速 | 实际连接波特率 |
|---|---|---|---|---|
| ESP32 原生 USB | `0x303a:0x1001` 等 | `ESP32 Native USB` | 否 | 用户选定值（默认 921600） |
| CH340 / CH340G | `0x1a86:0x7523` 等 | `CH340` | **是 → 460800** | 460 800 |
| CH343 / CH9102 | `0x1a86:0x55d3/0x55d4` | `CH343` / `CH9102` | 否 | 用户选定值 |
| CP2102(n) | `0x10c4:0xea60` | `CP2102(n)` | 否 | 用户选定值 |
| FTDI 系列 | `0x0403:0x6001` 等 | `FT232R` 等 | 否 | 用户选定值 |
| 未知芯片 | — | `undefined` | 否（保留用户选择） | 用户选定值 |

---

## 5. 兼容性注意事项

1. **`getInfo()` 返回值可能缺字段**：必须先 `typeof === 'number'` 校验，否则在某些平台/驱动下 `usbProductId` 可能为 `undefined`。
2. **原生 USB (`0x303a:0x1001`) 切换波特率后需 `sleep(300)`**：否则紧接着的命令会报错。该延时应包在 `setBaudrate` 之后：

   ```ts
   await loader.setBaudrate(desiredBaud);
   await sleep(300);   // 仅 Native USB 必需，统一加上也无副作用
   ```

3. **UI 反馈**：降速后应同步更新 UI 上的 `selectedBaud` 显示并提示用户（Toast + 日志），避免界面显示与实际不一致；如果你的 UI 有 baud watcher，需要在写回时临时挂起 watcher，防止递归触发重连。
4. **手动覆盖**：策略只在“用户值 > 上限”时下调；用户主动选 115200 等更低值时不应抬升。
5. **串口监视器**：监视模式建议固定使用 `MONITOR_BAUD = 115200`（与 ESP-IDF/Arduino 默认串口输出一致），与烧录波特率解耦。

---

## 6. 最小可移植实现（TypeScript）

```ts
// usb-bridge.ts
export const SUPPORTED_BAUDRATES = [115200, 230400, 460800, 921600, 1_500_000, 2_000_000] as const;
export const DEFAULT_ROM_BAUD   = 115200;
export const DEFAULT_FLASH_BAUD = 921600;

export interface BridgeInfo { name: string; maxBaudrate: number; }
export interface VendorInfo { vendorName: string; products: Record<number, BridgeInfo>; }

export const USB_BRIDGE_CAPABILITIES: Record<number, VendorInfo> = {
  0x1a86: { vendorName: 'QinHeng Electronics', products: {
    0x7522: { name: 'CH340',  maxBaudrate:   460_800 },
    0x7523: { name: 'CH340',  maxBaudrate:   460_800 },
    0x7584: { name: 'CH340',  maxBaudrate:   460_800 },
    0x5523: { name: 'CH341',  maxBaudrate: 2_000_000 },
    0x55d3: { name: 'CH343',  maxBaudrate: 6_000_000 },
    0x55d4: { name: 'CH9102', maxBaudrate: 6_000_000 },
    0x55d8: { name: 'CH9101', maxBaudrate: 3_000_000 },
  }},
  0x10c4: { vendorName: 'Silicon Labs', products: {
    0xea60: { name: 'CP2102(n)', maxBaudrate: 3_000_000 },
    0xea70: { name: 'CP2105',    maxBaudrate: 2_000_000 },
    0xea71: { name: 'CP2108',    maxBaudrate: 2_000_000 },
  }},
  0x0403: { vendorName: 'FTDI', products: {
    0x6001: { name: 'FT232R', maxBaudrate:  3_000_000 },
    0x6010: { name: 'FT2232', maxBaudrate:  3_000_000 },
    0x6011: { name: 'FT4232', maxBaudrate:  3_000_000 },
    0x6014: { name: 'FT232H', maxBaudrate: 12_000_000 },
    0x6015: { name: 'FT230X', maxBaudrate:  3_000_000 },
  }},
  0x303a: { vendorName: 'Espressif Systems', products: {
    0x0002: { name: 'ESP32-S2 Native USB',     maxBaudrate: 2_000_000 },
    0x1000: { name: 'ESP32 Native USB',        maxBaudrate: 2_000_000 },
    0x1001: { name: 'ESP32 Native USB',        maxBaudrate: 2_000_000 },
    0x1002: { name: 'ESP32 Native USB',        maxBaudrate: 2_000_000 },
    0x4002: { name: 'ESP32 Native USB (CDC)',  maxBaudrate: 2_000_000 },
  }},
};

export function getUsbDeviceInfo(vid: number, pid: number) {
  const vendor = USB_BRIDGE_CAPABILITIES[vid];
  if (!vendor) return undefined;
  const product = vendor.products[pid];
  if (!product) return { vendorName: vendor.vendorName, productName: undefined, maxBaudrate: undefined };
  return { vendorName: vendor.vendorName, productName: product.name, maxBaudrate: product.maxBaudrate };
}

/** 根据端口信息把目标波特率钳制到芯片可承受上限。 */
export function resolveDesiredBaud(
  portInfo: { usbVendorId?: number; usbProductId?: number } | null | undefined,
  userBaud = DEFAULT_FLASH_BAUD,
): { baud: number; capped: boolean; bridge?: ReturnType<typeof getUsbDeviceInfo> } {
  const bridge =
    portInfo && typeof portInfo.usbVendorId === 'number' && typeof portInfo.usbProductId === 'number'
      ? getUsbDeviceInfo(portInfo.usbVendorId, portInfo.usbProductId)
      : undefined;

  if (bridge?.maxBaudrate && userBaud > bridge.maxBaudrate) {
    const capped =
      SUPPORTED_BAUDRATES.filter(r => r <= bridge.maxBaudrate!).pop() ?? DEFAULT_FLASH_BAUD;
    return { baud: capped, capped: true, bridge };
  }
  return { baud: userBaud, capped: false, bridge };
}
```

调用方：

```ts
const info = port.getInfo();
const { baud: desiredBaud, capped } = resolveDesiredBaud(info, selectedBaud);
if (capped) notifyUser(`Bridge capped baudrate to ${desiredBaud} bps`);

transport.baudrate = DEFAULT_ROM_BAUD;
await transport.open();
await loader.connectAndHandshake();
await loader.setBaudrate(desiredBaud);
await sleep(300);            // Native USB 兼容
transport.baudrate = desiredBaud;
```

---

## 7. 参考来源

本文档源自 ESPConnect 项目实现：

- `src/constants/usb.ts` — 桥接芯片能力表与 `getUsbDeviceInfo()`
- `src/App.vue` — 连接与波特率切换逻辑（CH340 钳制 + 两阶段连接 + Native USB sleep 兼容）
