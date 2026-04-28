/**
 * AWS (Aily Wiring Syntax) 解析器
 * 
 * 将 AWS 文本解析为结构化数据
 */

import {
  ParsedAWS,
  ParsedUse,
  ParsedAssign,
  ParsedConnect,
  ParsedError,
  ParsedWarning,
  isValidConnectionType,
} from './aws-types';

// =====================================================
// 正则表达式定义
// =====================================================

// USE pinmapId [AS alias] ["label"]
// 例: USE lib-dht:dht20:asair AS dht "温湿度"
const USE_REGEX = /^USE\s+([\w\-:]+)(?:\s+AS\s+(\w+))?(?:\s+"([^"]*)")?$/i;

// ASSIGN ref.pin AS role @type[:bus]
// 例: ASSIGN esp.D2 AS SDA @i2c:1
const ASSIGN_REGEX = /^ASSIGN\s+(\w+)\.(\w+)\s+AS\s+(\w+)\s+@(\w+)(?::(\d+))?$/i;

// CONNECT ref1.pin -> ref2.pin @type[:bus] ["note"]
// 例: CONNECT esp.SDA -> dht.SDA @i2c "默认I2C"
const CONNECT_REGEX = /^CONNECT\s+(\w+)\.([\w\d]+)\s*->\s*(\w+)\.([\w\d]+)\s+@(\w+)(?::(\d+))?(?:\s+"([^"]*)")?$/i;

// =====================================================
// 解析器主函数
// =====================================================

/**
 * 解析 AWS 文本
 * 
 * @param aws AWS 源码字符串
 * @returns 解析结果
 */
export function parseAWS(aws: string): ParsedAWS {
  const result: ParsedAWS = {
    uses: [],
    assigns: [],
    connections: [],
    comments: [],
    warnings: [],
    errors: [],
  };

  // 记录已使用的别名（用于检测重复）
  const usedAliases = new Set<string>();

  const lines = aws.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const rawLine = lines[i];
    const line = rawLine.trim();

    // 跳过空行
    if (!line) continue;

    // 处理注释
    if (line.startsWith('#')) {
      result.comments.push(line.slice(1).trim());
      continue;
    }

    // 尝试匹配 USE
    const useMatch = line.match(USE_REGEX);
    if (useMatch) {
      const [, pinmapId, alias, label] = useMatch;
      const resolvedAlias = alias || generateDefaultAlias(pinmapId);
      
      // 检查别名重复
      if (usedAliases.has(resolvedAlias)) {
        result.warnings.push({
          line: lineNumber,
          message: `别名 "${resolvedAlias}" 已被使用，可能导致冲突`,
          code: 'DUPLICATE_ALIAS',
        });
      }
      usedAliases.add(resolvedAlias);

      result.uses.push({
        pinmapId,
        alias: resolvedAlias,
        label,
        line: lineNumber,
      });
      continue;
    }

    // 尝试匹配 ASSIGN
    const assignMatch = line.match(ASSIGN_REGEX);
    if (assignMatch) {
      const [, ref, pin, role, type, bus] = assignMatch;
      
      // 验证连接类型
      if (!isValidConnectionType(type)) {
        result.warnings.push({
          line: lineNumber,
          message: `未知的连接类型 "${type}"，将使用 "other"`,
          code: 'UNKNOWN_STATEMENT',
        });
      }

      result.assigns.push({
        ref,
        pin,
        role,
        type,
        bus: bus ? parseInt(bus, 10) : undefined,
        line: lineNumber,
      });
      continue;
    }

    // 尝试匹配 CONNECT
    const connectMatch = line.match(CONNECT_REGEX);
    if (connectMatch) {
      const [, fromRef, fromPin, toRef, toPin, type, bus, note] = connectMatch;
      
      // 验证连接类型
      if (!isValidConnectionType(type)) {
        result.warnings.push({
          line: lineNumber,
          message: `未知的连接类型 "${type}"，将使用 "other"`,
          code: 'UNKNOWN_STATEMENT',
        });
      }

      result.connections.push({
        fromRef,
        fromPin,
        toRef,
        toPin,
        type: isValidConnectionType(type) ? type : 'other',
        bus: bus ? parseInt(bus, 10) : undefined,
        note,
        line: lineNumber,
      });
      continue;
    }

    // 无法识别的语句
    result.warnings.push({
      line: lineNumber,
      message: `无法识别的语句: "${line}"`,
      code: 'UNKNOWN_STATEMENT',
    });
  }

  // 验证：检查 CONNECT 中引用的组件是否存在
  // "board" 是预定义的开发板别名，不需要 USE 声明
  const validRefs = new Set(['board', ...result.uses.map(u => u.alias)]);
  
  for (const conn of result.connections) {
    if (!validRefs.has(conn.fromRef)) {
      result.errors.push({
        line: conn.line,
        message: `连线引用了未声明的组件 "${conn.fromRef}"，请先使用 USE 声明`,
        code: 'UNKNOWN_REF',
        source: `${conn.fromRef}.${conn.fromPin}`,
      });
    }
    if (!validRefs.has(conn.toRef)) {
      result.errors.push({
        line: conn.line,
        message: `连线引用了未声明的组件 "${conn.toRef}"，请先使用 USE 声明`,
        code: 'UNKNOWN_REF',
        source: `${conn.toRef}.${conn.toPin}`,
      });
    }
  }

  // 验证：检查 ASSIGN 中引用的组件是否存在
  for (const assign of result.assigns) {
    if (!validRefs.has(assign.ref)) {
      result.errors.push({
        line: assign.line,
        message: `ASSIGN 引用了未声明的组件 "${assign.ref}"`,
        code: 'UNKNOWN_REF',
        source: `${assign.ref}.${assign.pin}`,
      });
    }
  }

  return result;
}

/**
 * 从 pinmapId 生成默认别名
 * 
 * @example
 * "lib-dht:dht20:asair" -> "dht20"
 * "board:xiao_esp32s3:default" -> "xiao_esp32s3"
 */
function generateDefaultAlias(pinmapId: string): string {
  const parts = pinmapId.split(':');
  if (parts.length >= 2) {
    return parts[1]; // 返回 modelId 部分
  }
  return parts[0];
}

// =====================================================
// 辅助函数
// =====================================================

/**
 * 检查解析结果是否有致命错误
 */
export function hasErrors(result: ParsedAWS): boolean {
  return result.errors.length > 0;
}

/**
 * 格式化错误信息
 */
export function formatErrors(result: ParsedAWS): string {
  if (result.errors.length === 0) return '';
  
  const lines = ['## AWS 解析错误\n'];
  
  for (const error of result.errors) {
    lines.push(`- **行 ${error.line}**: ${error.message}`);
    if (error.source) {
      lines.push(`  源码: \`${error.source}\``);
    }
  }
  
  return lines.join('\n');
}

/**
 * 格式化警告信息
 */
export function formatWarnings(result: ParsedAWS): string {
  if (result.warnings.length === 0) return '';
  
  const lines = ['## AWS 解析警告\n'];
  
  for (const warning of result.warnings) {
    lines.push(`- **行 ${warning.line}**: ${warning.message}`);
  }
  
  return lines.join('\n');
}
