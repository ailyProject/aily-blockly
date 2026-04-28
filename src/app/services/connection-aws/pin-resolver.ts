/**
 * AWS 引脚解析器
 * 
 * 将功能名/引脚名解析为内部 pinId
 */

import { ResolvedPin, ParsedAssign, ParsedError } from './aws-types';

// =====================================================
// 类型定义（兼容 connection-graph.service.ts）
// =====================================================

interface PinFunction {
  name: string;
  type: string;
  visible?: boolean;
  disabled?: boolean;
}

interface ConfigPin {
  id: string;
  functions: PinFunction[];
  visible?: boolean;
  disabled?: boolean;
}

interface ComponentConfig {
  id: string;
  name: string;
  pins: ConfigPin[];
}

// =====================================================
// 引脚解析器
// =====================================================

/**
 * 将功能名/引脚名解析为内部 pinId
 * 
 * @param config 组件配置
 * @param pinOrFunc 引脚名（"D2"）或功能名（"SDA"）
 * @param assigns ASSIGN 映射（可选）
 * @param connectionType 连接类型（用于推断功能）
 * @returns 解析后的引脚信息，或 null（如果找不到）
 */
export function resolvePin(
  config: ComponentConfig,
  pinOrFunc: string,
  assigns?: Map<string, ParsedAssign>,
  connectionType?: string
): ResolvedPin | null {
  const searchName = pinOrFunc.toUpperCase();

  // 1. 先检查是否有 ASSIGN 重映射
  if (assigns) {
    const assignKey = `${config.id}.${pinOrFunc}`.toLowerCase();
    for (const [key, assign] of assigns) {
      if (key.toLowerCase() === assignKey) {
        // 找到被分配了角色的引脚
        for (const pin of config.pins) {
          if (pin.visible === false || pin.disabled) continue;
          const fn = pin.functions.find(f => 
            f.name.trim().toUpperCase() === pinOrFunc.toUpperCase()
          );
          if (fn) {
            return { pinId: pin.id, functionName: assign.role };
          }
        }
      }
    }
  }

  // 2. 精确匹配功能名（SDA、SCL、VCC、GND、3V3、5V 等）
  for (const pin of config.pins) {
    if (pin.visible === false || pin.disabled) continue;
    
    for (const fn of pin.functions) {
      if (fn.visible === false || fn.disabled) continue;
      
      // trim() 处理 pinmap 中可能存在的尾随空格
      if (fn.name.trim().toUpperCase() === searchName) {
        return { pinId: pin.id, functionName: fn.name.trim() };
      }
    }
  }

  // 3. 匹配引脚编号（D0、D1、GPIO1 等）
  // 这些通常是 digital 或 gpio 类型的功能
  for (const pin of config.pins) {
    if (pin.visible === false || pin.disabled) continue;
    
    for (const fn of pin.functions) {
      if (fn.visible === false || fn.disabled) continue;
      
      const fnName = fn.name.trim();
      if (fnName.toUpperCase() === searchName && 
          ['digital', 'gpio', 'analog'].includes(fn.type)) {
        // 如果有连接类型，尝试推断更具体的功能
        if (connectionType) {
          const specificFn = pin.functions.find(f => 
            f.type === connectionType && !f.disabled && f.visible !== false
          );
          if (specificFn) {
            return { pinId: pin.id, functionName: specificFn.name.trim() };
          }
        }
        return { pinId: pin.id, functionName: fnName };
      }
    }
  }

  // 4. 尝试模糊匹配（去掉前缀/后缀）
  // 例如 "pin_3v3" 匹配 "3V3"，"GPIO5" 匹配 "D5"
  for (const pin of config.pins) {
    if (pin.visible === false || pin.disabled) continue;
    
    for (const fn of pin.functions) {
      if (fn.visible === false || fn.disabled) continue;
      
      const fnName = fn.name.trim();
      const fnNameUpper = fnName.toUpperCase();
      
      // 移除常见前缀进行匹配
      if (fnNameUpper.endsWith(searchName) || searchName.endsWith(fnNameUpper)) {
        return { pinId: pin.id, functionName: fnName };
      }
    }
  }

  return null;
}

/**
 * 批量解析连线中的引脚
 * 
 * @param connections 解析后的连线列表
 * @param configs 组件配置映射（alias -> config）
 * @param assigns ASSIGN 映射
 * @returns 解析结果和错误列表
 */
export function resolveAllPins(
  connections: Array<{
    fromRef: string;
    fromPin: string;
    toRef: string;
    toPin: string;
    type: string;
    line: number;
  }>,
  configs: Map<string, ComponentConfig>,
  assigns?: Map<string, ParsedAssign>
): {
  resolved: Array<{
    from: ResolvedPin;
    to: ResolvedPin;
    type: string;
    line: number;
  }>;
  errors: ParsedError[];
} {
  const resolved: Array<{
    from: ResolvedPin;
    to: ResolvedPin;
    type: string;
    line: number;
  }> = [];
  const errors: ParsedError[] = [];

  for (const conn of connections) {
    // 获取组件配置
    const fromConfig = configs.get(conn.fromRef);
    const toConfig = configs.get(conn.toRef);

    if (!fromConfig) {
      errors.push({
        line: conn.line,
        message: `找不到组件 "${conn.fromRef}" 的配置`,
        code: 'UNKNOWN_REF',
        source: `${conn.fromRef}.${conn.fromPin}`,
      });
      continue;
    }

    if (!toConfig) {
      errors.push({
        line: conn.line,
        message: `找不到组件 "${conn.toRef}" 的配置`,
        code: 'UNKNOWN_REF',
        source: `${conn.toRef}.${conn.toPin}`,
      });
      continue;
    }

    // 解析源引脚
    const fromResolved = resolvePin(fromConfig, conn.fromPin, assigns, conn.type);
    if (!fromResolved) {
      errors.push({
        line: conn.line,
        message: `在组件 "${conn.fromRef}" (${fromConfig.name}) 中找不到引脚 "${conn.fromPin}"`,
        code: 'UNKNOWN_PIN',
        source: `${conn.fromRef}.${conn.fromPin}`,
      });
      continue;
    }

    // 解析目标引脚
    const toResolved = resolvePin(toConfig, conn.toPin, assigns, conn.type);
    if (!toResolved) {
      errors.push({
        line: conn.line,
        message: `在组件 "${conn.toRef}" (${toConfig.name}) 中找不到引脚 "${conn.toPin}"`,
        code: 'UNKNOWN_PIN',
        source: `${conn.toRef}.${conn.toPin}`,
      });
      continue;
    }

    resolved.push({
      from: fromResolved,
      to: toResolved,
      type: conn.type,
      line: conn.line,
    });
  }

  return { resolved, errors };
}

/**
 * 检测引脚冲突（同一引脚被多次使用）
 * 
 * @param resolved 已解析的连线列表
 * @returns 冲突错误列表
 */
export function detectPinConflicts(
  resolved: Array<{
    from: ResolvedPin;
    to: ResolvedPin;
    type: string;
    line: number;
    fromRef: string;
    toRef: string;
  }>
): ParsedError[] {
  const errors: ParsedError[] = [];
  const pinUsage = new Map<string, number[]>(); // "ref.pinId" -> line numbers

  for (const conn of resolved) {
    // 记录源引脚使用
    const fromKey = `${conn.fromRef}.${conn.from.pinId}`;
    if (!pinUsage.has(fromKey)) {
      pinUsage.set(fromKey, []);
    }
    pinUsage.get(fromKey)!.push(conn.line);

    // 记录目标引脚使用
    const toKey = `${conn.toRef}.${conn.to.pinId}`;
    if (!pinUsage.has(toKey)) {
      pinUsage.set(toKey, []);
    }
    pinUsage.get(toKey)!.push(conn.line);
  }

  // 检查冲突（排除总线类型如 I2C、SPI 允许多连接）
  const busTypes = new Set(['i2c', 'spi']);
  
  for (const [pinKey, lines] of pinUsage) {
    if (lines.length > 1) {
      // 检查是否都是总线类型
      const connTypes = resolved
        .filter(c => 
          `${c.fromRef}.${c.from.pinId}` === pinKey ||
          `${c.toRef}.${c.to.pinId}` === pinKey
        )
        .map(c => c.type);
      
      const allBus = connTypes.every(t => busTypes.has(t));
      
      if (!allBus) {
        errors.push({
          line: lines[0],
          message: `引脚 ${pinKey} 被多条连线使用（行 ${lines.join(', ')}），可能存在冲突`,
          code: 'PIN_CONFLICT',
          source: pinKey,
        });
      }
    }
  }

  return errors;
}
