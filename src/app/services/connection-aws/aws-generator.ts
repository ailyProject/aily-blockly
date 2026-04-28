/**
 * AWS (Aily Wiring Syntax) 生成器
 * 
 * 将 JSON 连线数据转换为 AWS 格式
 */

import { ConnectionType } from './aws-types';

// =====================================================
// 类型定义（兼容现有 JSON 结构）
// =====================================================

interface ConnectionEndpoint {
  ref: string;
  pinId: string;
  function: string;
}

interface ConnectionDef {
  id: string;
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
  type: string;
  label?: string;
  color?: string;
  bus?: number;
}

interface ComponentDef {
  refId: string;
  componentId: string;
  componentName: string;
  pinmapId?: string;
  configFile?: string;
  instance?: number;
}

interface ConnectionOutput {
  version?: string;
  description?: string;
  components: ComponentDef[];
  connections: ConnectionDef[];
}

// =====================================================
// 生成器主函数
// =====================================================

/**
 * 将 JSON 连线数据转换为 AWS 格式
 * 
 * @param data JSON 连线数据
 * @returns AWS 格式字符串
 */
export function generateAWS(data: ConnectionOutput): string {
  const lines: string[] = [];
  
  // 添加描述（如果有）
  if (data.description) {
    lines.push(`# ${data.description}`);
    lines.push('');
  }

  // =====================================================
  // 1. 生成 USE 语句
  // =====================================================
  lines.push('# === 组件声明 ===');
  
  for (const comp of data.components) {
    const pinmapId = comp.pinmapId || inferPinmapId(comp);
    const alias = comp.refId;
    const label = comp.componentName;
    
    // USE pinmapId AS alias "label"
    lines.push(`USE ${pinmapId} AS ${alias} "${label}"`);
  }
  
  lines.push('');

  // =====================================================
  // 2. 生成 CONNECT 语句（按类型分组）
  // =====================================================
  lines.push('# === 连线 ===');
  
  // 按类型分组连线
  const grouped = groupConnectionsByType(data.connections);
  
  // 定义类型输出顺序
  const typeOrder: ConnectionType[] = ['power', 'gnd', 'i2c', 'spi', 'uart', 'digital', 'gpio', 'analog', 'pwm', 'other'];
  
  for (const type of typeOrder) {
    const conns = grouped[type];
    if (!conns || conns.length === 0) continue;
    
    for (const conn of conns) {
      const note = conn.label ? ` "${conn.label}"` : '';
      const bus = conn.bus !== undefined ? `:${conn.bus}` : '';
      
      // CONNECT ref.func -> ref.func @type[:bus] ["note"]
      lines.push(
        `CONNECT ${conn.from.ref}.${conn.from.function} -> ` +
        `${conn.to.ref}.${conn.to.function} @${conn.type}${bus}${note}`
      );
    }
  }
  
  return lines.join('\n');
}

/**
 * 从组件定义推断 pinmapId
 * 
 * 当 pinmapId 不存在时，尝试从其他字段推断
 */
function inferPinmapId(comp: ComponentDef): string {
  // 如果有 configFile，尝试从中提取
  if (comp.configFile) {
    // "dht20_config.json" -> "unknown:dht20:default"
    const match = comp.configFile.match(/^(\w+)_config\.json$/);
    if (match) {
      return `unknown:${match[1]}:default`;
    }
  }
  
  // 使用 refId 作为 fallback
  return `unknown:${comp.refId}:default`;
}

/**
 * 按连接类型分组
 */
function groupConnectionsByType(
  connections: ConnectionDef[]
): Record<string, ConnectionDef[]> {
  const groups: Record<string, ConnectionDef[]> = {};
  
  for (const conn of connections) {
    const type = conn.type || 'other';
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(conn);
  }
  
  return groups;
}

// =====================================================
// Pinmap 摘要生成（精简格式）
// =====================================================

interface PinFunction {
  name: string;
  type: string;
}

interface PinDef {
  id: string;
  functions: PinFunction[];
}

interface PinSummary {
  componentId: string;
  componentName: string;
  pinCount: number;
  pins: Array<{
    id: string;
    functions: Array<{ name: string; type: string }>;
  }>;
}

/**
 * 生成精简的 Pinmap 摘要（AWS 风格）
 * 
 * @param summary PinSummary 对象
 * @param alias 组件别名
 * @param pinmapId pinmapId
 * @returns AWS 风格的摘要字符串
 */
export function generatePinmapSummary(
  summary: PinSummary, 
  alias: string,
  pinmapId: string
): string {
  const lines: string[] = [];
  
  // 组件头
  lines.push(`# COMPONENT: ${pinmapId} (${alias})`);
  
  // 引脚列表
  for (const pin of summary.pins) {
    if (pin.functions.length === 0) continue;
    
    // 找到主要功能名（优先级：功能名 > 数字引脚 > 第一个）
    const primaryFunc = findPrimaryFunction(pin.functions);
    
    // 生成功能列表
    const funcList = pin.functions
      .map(f => {
        if (f.name === primaryFunc.name) {
          return f.name;
        }
        // 如果类型不同于主功能，标注类型
        if (f.type !== primaryFunc.type) {
          return `${f.name}/${f.type}`;
        }
        return f.name;
      })
      .join(', ');
    
    lines.push(`${primaryFunc.name}: ${funcList}`);
  }
  
  return lines.join('\n');
}

/**
 * 查找主要功能（用于显示）
 */
function findPrimaryFunction(functions: PinFunction[]): PinFunction {
  // 优先级：power/gnd > i2c/spi/uart > digital > 其他
  const priorities = ['power', 'gnd', 'i2c', 'spi', 'uart', 'digital', 'gpio', 'analog', 'pwm'];
  
  for (const priority of priorities) {
    const found = functions.find(f => f.type === priority);
    if (found) return found;
  }
  
  return functions[0];
}

/**
 * 生成多个组件的 Pinmap 摘要
 */
export function generateMultiplePinmapSummaries(
  summaries: Array<{ summary: PinSummary; alias: string; pinmapId: string }>
): string {
  return summaries
    .map(s => generatePinmapSummary(s.summary, s.alias, s.pinmapId))
    .join('\n\n');
}
