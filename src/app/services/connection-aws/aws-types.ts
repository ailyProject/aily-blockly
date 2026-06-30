/**
 * AWS (Aily Wiring Syntax) 类型定义
 * 
 * AWS 是一种用于描述硬件连线的 DSL，旨在减少 LLM 通信的 token 消耗。
 * 文件扩展名: .aws
 */

// =====================================================
// 解析结果类型
// =====================================================

/** USE 语句解析结果 */
export interface ParsedUse {
  /** pinmapId 完整标识符，如 "lib-dht:dht20:asair" */
  pinmapId: string;
  /** 组件别名（用于 refId），如 "dht_indoor" */
  alias: string;
  /** 显示名称，如 "室内传感器" */
  label?: string;
  /** 源码行号（用于错误定位） */
  line: number;
}

/** ASSIGN 语句解析结果（引脚重映射） */
export interface ParsedAssign {
  /** 组件别名，如 "esp" */
  ref: string;
  /** 引脚名/编号，如 "D2" */
  pin: string;
  /** 分配的角色，如 "SDA" */
  role: string;
  /** 连接类型，如 "i2c" */
  type: string;
  /** 总线编号，如 1 表示 i2c:1 */
  bus?: number;
  /** 源码行号 */
  line: number;
}

/** 箭头方向类型 */
export type ArrowDirection = '->' | '<-' | '<->';

/** CONNECT 语句解析结果 */
export interface ParsedConnect {
  /** 源组件别名 */
  fromRef: string;
  /** 源引脚名/功能名 */
  fromPin: string;
  /** 目标组件别名 */
  toRef: string;
  /** 目标引脚名/功能名 */
  toPin: string;
  /** 连接类型: power, gnd, i2c, spi, uart, digital, gpio, analog, pwm */
  type: string;
  /** 总线编号（可选） */
  bus?: number;
  /** 连线备注 */
  note?: string;
  /** 箭头方向: -> 正向, <- 反向, <-> 双向 */
  arrow: ArrowDirection;
  /** 源码行号 */
  line: number;
}

/** AWS 完整解析结果 */
export interface ParsedAWS {
  /** USE 语句列表 */
  uses: ParsedUse[];
  /** ASSIGN 语句列表 */
  assigns: ParsedAssign[];
  /** CONNECT 语句列表 */
  connections: ParsedConnect[];
  /** 注释收集 */
  comments: string[];
  /** 解析警告（非致命） */
  warnings: ParsedWarning[];
  /** 解析错误（致命） */
  errors: ParsedError[];
}

// =====================================================
// 错误与警告类型
// =====================================================

/** 解析警告 */
export interface ParsedWarning {
  line: number;
  message: string;
  code: 'UNKNOWN_STATEMENT' | 'DUPLICATE_ALIAS' | 'UNUSED_ASSIGN';
}

/** 解析错误 */
export interface ParsedError {
  line: number;
  message: string;
  code: 
    | 'SYNTAX_ERROR' 
    | 'INVALID_PINMAP_ID' 
    | 'UNKNOWN_REF' 
    | 'UNKNOWN_PIN'
    | 'PIN_CONFLICT'
    | 'MISSING_USE';
  /** 错误相关的原始文本 */
  source?: string;
}

// =====================================================
// 连接类型
// =====================================================

/** 支持的连接类型 */
export type ConnectionType = 
  | 'power' 
  | 'gnd' 
  | 'i2c' 
  | 'spi' 
  | 'uart' 
  | 'digital' 
  | 'gpio'
  | 'analog' 
  | 'pwm'
  | 'other';

/** 连接类型颜色映射 */
export const CONNECTION_COLORS: Record<ConnectionType, string> = {
  power: '#EF4444',   // 红色
  gnd: '#000000',     // 黑色
  i2c: '#8B5CF6',     // 紫色
  spi: '#EC4899',     // 粉色
  uart: '#F59E0B',    // 橙色
  digital: '#3B82F6', // 蓝色
  gpio: '#3B82F6',    // 蓝色
  analog: '#10B981',  // 绿色
  pwm: '#06B6D4',     // 青色
  other: '#9CA3AF',   // 灰色
};

/** 检查是否为有效连接类型 */
export function isValidConnectionType(type: string): type is ConnectionType {
  return type in CONNECTION_COLORS;
}

// =====================================================
// 数据流向推断
// =====================================================

/** 动画模式 */
export type AnimationPattern =
  | 'flow-forward'       // 单向正向：粒子 from → to
  | 'flow-backward'      // 单向反向：粒子 to → from
  | 'flow-bidirectional' // 全双工：双向同时
  | 'flow-half-duplex'   // 半双工：交替往返
  | 'flow-static'        // 静态（电源/地线等）
  | 'none';              // 无动画

/** 数据流向信息（附加到每条连线） */
export interface DataFlowInfo {
  /** 数据方向: forward(from→to), backward(to→from), bidirectional */
  direction: 'forward' | 'backward' | 'bidirectional';
  /** 是否半双工 */
  half: boolean;
  /** 渲染动画模式 */
  animationPattern: AnimationPattern;
}

/**
 * 协议流向推断规则表
 * key = connectionType, value = 按引脚功能名匹配的规则数组
 * 匹配顺序：先匹配 pinPatterns（正则），无匹配则用 default
 */
export const PROTOCOL_FLOW_RULES: Record<string, {
  pinPatterns?: Array<{
    /** 匹配 fromPin 或 toPin 的正则（不区分大小写） */
    pattern: RegExp;
    /** 匹配哪端: 'from' | 'to' | 'either'（默认 either） */
    matchSide?: 'from' | 'to' | 'either';
    flow: DataFlowInfo;
  }>;
  default: DataFlowInfo;
}> = {
  power: {
    default: { direction: 'forward', half: false, animationPattern: 'flow-static' },
  },
  gnd: {
    default: { direction: 'forward', half: false, animationPattern: 'flow-static' },
  },
  i2c: {
    pinPatterns: [
      {
        pattern: /^SDA$/i,
        flow: { direction: 'bidirectional', half: true, animationPattern: 'flow-half-duplex' },
      },
      {
        pattern: /^SCL$/i,
        flow: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
      },
    ],
    default: { direction: 'bidirectional', half: true, animationPattern: 'flow-half-duplex' },
  },
  spi: {
    pinPatterns: [
      {
        pattern: /^MISO$/i,
        flow: { direction: 'backward', half: false, animationPattern: 'flow-backward' },
      },
      {
        pattern: /^(MOSI|SCK|SCLK|CS|SS|CE)$/i,
        flow: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
      },
    ],
    default: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
  },
  uart: {
    pinPatterns: [
      {
        pattern: /^TX$/i,
        matchSide: 'from',
        flow: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
      },
      {
        pattern: /^RX$/i,
        matchSide: 'from',
        flow: { direction: 'backward', half: false, animationPattern: 'flow-backward' },
      },
    ],
    default: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
  },
  digital: {
    pinPatterns: [
      {
        pattern: /^(IN|BTN|BUTTON|IRQ|INT|ALERT|READY|BUSY|DETECT)$/i,
        matchSide: 'to',
        flow: { direction: 'backward', half: false, animationPattern: 'flow-backward' },
      },
      {
        pattern: /^(OUT|LED|EN|ENABLE|RST|RESET|TRIG|TRIGGER)$/i,
        matchSide: 'to',
        flow: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
      },
      {
        pattern: /^(DATA|IO|SIG|SIGNAL|DQ|DOUT)$/i,
        flow: { direction: 'bidirectional', half: true, animationPattern: 'flow-half-duplex' },
      },
    ],
    default: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
  },
  gpio: {
    pinPatterns: [
      {
        pattern: /^(IN|BTN|BUTTON|IRQ|INT|DETECT)$/i,
        matchSide: 'to',
        flow: { direction: 'backward', half: false, animationPattern: 'flow-backward' },
      },
      {
        pattern: /^(DATA|IO|SIG|DQ)$/i,
        flow: { direction: 'bidirectional', half: true, animationPattern: 'flow-half-duplex' },
      },
    ],
    default: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
  },
  analog: {
    default: { direction: 'backward', half: false, animationPattern: 'flow-backward' },
  },
  pwm: {
    default: { direction: 'forward', half: false, animationPattern: 'flow-forward' },
  },
  other: {
    default: { direction: 'forward', half: false, animationPattern: 'none' },
  },
};

/**
 * 根据连接类型、引脚功能名和箭头方向推断数据流向
 */
export function inferDataFlow(
  type: string,
  fromPin: string,
  toPin: string,
  arrow: ArrowDirection = '->',
): DataFlowInfo {
  // 显式箭头优先
  if (arrow === '<->') {
    // 判断是否半双工：类型后缀 +half 由调用者处理，这里默认按协议判断
    const rules = PROTOCOL_FLOW_RULES[type];
    const defaultFlow = rules?.default || PROTOCOL_FLOW_RULES['other'].default;
    return { direction: 'bidirectional', half: defaultFlow.half, animationPattern: defaultFlow.half ? 'flow-half-duplex' : 'flow-bidirectional' };
  }
  if (arrow === '<-') {
    return { direction: 'backward', half: false, animationPattern: 'flow-backward' };
  }

  // -> 箭头：按规则表推断
  const rules = PROTOCOL_FLOW_RULES[type];
  if (!rules) {
    return PROTOCOL_FLOW_RULES['other'].default;
  }

  if (rules.pinPatterns) {
    for (const rule of rules.pinPatterns) {
      const side = rule.matchSide || 'either';
      const matchFrom = (side === 'from' || side === 'either') && rule.pattern.test(fromPin);
      const matchTo = (side === 'to' || side === 'either') && rule.pattern.test(toPin);
      if (matchFrom || matchTo) {
        return { ...rule.flow };
      }
    }
  }

  return { ...rules.default };
}

// =====================================================
// 转换结果类型
// =====================================================

/** 引脚解析结果 */
export interface ResolvedPin {
  /** 内部 pinId，如 "pin_5" */
  pinId: string;
  /** 使用的功能名，如 "SDA" */
  functionName: string;
}

/** AWS 转 JSON 的结果 */
export interface AWSToJSONResult {
  success: boolean;
  /** 转换后的 JSON 数据（成功时） */
  data?: {
    version: string;
    description: string;
    components: Array<{
      refId: string;
      componentId: string;
      componentName: string;
      pinmapId: string;
      instance: number;
    }>;
    connections: Array<{
      id: string;
      from: { ref: string; pinId: string; function: string };
      to: { ref: string; pinId: string; function: string };
      type: string;
      label: string;
      color: string;
      bus?: number;
      /** 数据方向 */
      direction?: 'forward' | 'backward' | 'bidirectional';
      /** 是否半双工 */
      half?: boolean;
      /** 渲染动画模式 */
      animationPattern?: AnimationPattern;
    }>;
  };
  /** 错误列表（失败时） */
  errors?: ParsedError[];
  /** 警告列表 */
  warnings?: ParsedWarning[];
}

// =====================================================
// AWS 语法常量
// =====================================================

/** AWS 文件扩展名 */
export const AWS_FILE_EXTENSION = '.aws';

/** AWS 文件名 */
export const AWS_FILENAME = 'connection.aws';

/** JSON 编译产物文件名 */
export const JSON_FILENAME = 'connection_output.json';

/** AWS 语法参考（用于错误提示） */
export const AWS_SYNTAX_REFERENCE = `
## AWS (Aily Wiring Syntax) 语法参考

### 预定义别名
- \`board\` - 开发板（自动可用，无需声明）

### USE - 声明外部组件
\`\`\`
USE <pinmapId> AS <别名> "显示名"
\`\`\`
例: \`USE lib-dht:dht20:asair AS dht "温湿度传感器"\`

### CONNECT - 创建连线
\`\`\`
CONNECT <组件.引脚> -> <组件.引脚> @<类型>          # 正向（默认）
CONNECT <组件.引脚> <- <组件.引脚> @<类型>          # 反向
CONNECT <组件.引脚> <-> <组件.引脚> @<类型>         # 双向
CONNECT <组件.引脚> -> <组件.引脚> @<类型>:<总线号> "备注"
\`\`\`
类型: power, gnd, i2c, spi, uart, digital, gpio, analog, pwm

**箭头说明：**
- \`->\` 正向数据/电流流动（默认，大多数情况用这个）
- \`<-\` 反向（如传感器数据回传到开发板）
- \`<->\` 双向（如 I2C SDA 半双工、1-Wire DATA）

**自动推断：** 使用 \`->\` 时系统会根据协议类型和引脚名自动推断流向。
例如 I2C 的 SDA 自动识别为半双工，SPI 的 MISO 自动识别为反向。
仅在自动推断不准确时才需要用 \`<-\` 或 \`<->\` 显式覆盖。

例:
\`CONNECT board.SDA -> dht.SDA @i2c\`        (自动推断为半双工)
\`CONNECT board.D2 -> dht.SDA @i2c:1 "自定义I2C"\`

### ASSIGN - 引脚重映射（可选）
\`\`\`
ASSIGN <组件.引脚> AS <角色> @<类型>:<总线号>
\`\`\`
例: \`ASSIGN board.D2 AS SDA @i2c:1\`

### 注释
\`\`\`
# 这是注释
\`\`\`

### 完整示例
\`\`\`aws
# ESP32S3 + DHT20 连接方案
# 注意: board 是预定义别名，无需 USE 声明
USE lib-dht:dht20:asair AS dht "DHT20"

CONNECT board.3V3 -> dht.VCC @power
CONNECT board.GND -> dht.GND @gnd
CONNECT board.SDA -> dht.SDA @i2c
CONNECT board.SCL -> dht.SCL @i2c
\`\`\`
`.trim();
