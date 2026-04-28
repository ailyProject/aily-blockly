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
CONNECT <组件.引脚> -> <组件.引脚> @<类型>
CONNECT <组件.引脚> -> <组件.引脚> @<类型>:<总线号> "备注"
\`\`\`
类型: power, gnd, i2c, spi, uart, digital, gpio, analog, pwm
例: \`CONNECT board.SDA -> dht.SDA @i2c\`
例: \`CONNECT board.D2 -> dht.SDA @i2c:1 "自定义I2C"\`

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
