/**
 * AWS (Aily Wiring Syntax) 转换器
 * 
 * 将 AWS 转换为 JSON 格式（用于 iframe 渲染）
 */

import { parseAWS, hasErrors } from './aws-parser';
import { resolvePin } from './pin-resolver';
import {
  ParsedAWS,
  ParsedError,
  ParsedWarning,
  AWSToJSONResult,
  CONNECTION_COLORS,
  ConnectionType,
  AWS_SYNTAX_REFERENCE,
} from './aws-types';

// =====================================================
// 类型定义
// =====================================================

interface ComponentConfig {
  id: string;
  name: string;
  pins: Array<{
    id: string;
    functions: Array<{ name: string; type: string; visible?: boolean; disabled?: boolean }>;
    visible?: boolean;
    disabled?: boolean;
  }>;
}

interface LoadPinmapResult {
  config: ComponentConfig | null;
  error?: string;
}

/** 组件加载器接口 */
export interface ComponentLoader {
  /** 通过 pinmapId 获取组件配置 */
  loadConfig(pinmapId: string): Promise<LoadPinmapResult>;
  /** 获取开发板配置 */
  getBoardConfig(): ComponentConfig | null;
}

// =====================================================
// 转换器类
// =====================================================

export class AWSConverter {
  private loader: ComponentLoader;

  constructor(loader: ComponentLoader) {
    this.loader = loader;
  }

  /**
   * 将 AWS 转换为 JSON
   * 
   * @param aws AWS 源码
   * @returns 转换结果
   */
  async convert(aws: string): Promise<AWSToJSONResult> {
    // 1. 解析 AWS
    const parsed = parseAWS(aws);
    
    // 如果有解析错误，直接返回
    if (hasErrors(parsed)) {
      return {
        success: false,
        errors: parsed.errors,
        warnings: parsed.warnings,
      };
    }

    // 2. 加载所有组件配置
    const configMap = new Map<string, ComponentConfig>();
    const loadErrors: ParsedError[] = [];

    for (const use of parsed.uses) {
      const result = await this.loader.loadConfig(use.pinmapId);
      
      if (!result.config) {
        loadErrors.push({
          line: use.line,
          message: result.error || `无法加载组件配置: ${use.pinmapId}`,
          code: 'INVALID_PINMAP_ID',
          source: use.pinmapId,
        });
        continue;
      }
      
      configMap.set(use.alias, result.config);
    }

    if (loadErrors.length > 0) {
      return {
        success: false,
        errors: loadErrors,
        warnings: parsed.warnings,
      };
    }

    // 3. 构建 ASSIGN 映射
    const assignMap = new Map<string, { role: string; type: string; bus?: number }>();
    for (const assign of parsed.assigns) {
      const key = `${assign.ref}.${assign.pin}`.toLowerCase();
      assignMap.set(key, {
        role: assign.role,
        type: assign.type,
        bus: assign.bus,
      });
    }

    // 4. 解析连线中的引脚
    const connections: Array<{
      id: string;
      from: { ref: string; pinId: string; function: string };
      to: { ref: string; pinId: string; function: string };
      type: string;
      label: string;
      color: string;
      bus?: number;
    }> = [];
    const resolveErrors: ParsedError[] = [];

    let connIndex = 1;
    for (const conn of parsed.connections) {
      const fromConfig = configMap.get(conn.fromRef);
      const toConfig = configMap.get(conn.toRef);

      if (!fromConfig) {
        resolveErrors.push({
          line: conn.line,
          message: `找不到组件 "${conn.fromRef}" 的配置`,
          code: 'UNKNOWN_REF',
          source: `${conn.fromRef}.${conn.fromPin}`,
        });
        continue;
      }

      if (!toConfig) {
        resolveErrors.push({
          line: conn.line,
          message: `找不到组件 "${conn.toRef}" 的配置`,
          code: 'UNKNOWN_REF',
          source: `${conn.toRef}.${conn.toPin}`,
        });
        continue;
      }

      // 解析源引脚
      const fromResolved = resolvePin(fromConfig, conn.fromPin);
      if (!fromResolved) {
        resolveErrors.push({
          line: conn.line,
          message: `在组件 "${conn.fromRef}" (${fromConfig.name}) 中找不到引脚 "${conn.fromPin}"`,
          code: 'UNKNOWN_PIN',
          source: `${conn.fromRef}.${conn.fromPin}`,
        });
        continue;
      }

      // 解析目标引脚
      const toResolved = resolvePin(toConfig, conn.toPin);
      if (!toResolved) {
        resolveErrors.push({
          line: conn.line,
          message: `在组件 "${conn.toRef}" (${toConfig.name}) 中找不到引脚 "${conn.toPin}"`,
          code: 'UNKNOWN_PIN',
          source: `${conn.toRef}.${conn.toPin}`,
        });
        continue;
      }

      // 生成连线
      const connType = conn.type as ConnectionType;
      const label = conn.note || `${conn.type.toUpperCase()}: ${conn.fromPin} → ${conn.toPin}`;
      const color = CONNECTION_COLORS[connType] || CONNECTION_COLORS.other;

      connections.push({
        id: `conn_${connIndex++}`,
        from: {
          ref: conn.fromRef,
          pinId: fromResolved.pinId,
          function: fromResolved.functionName,
        },
        to: {
          ref: conn.toRef,
          pinId: toResolved.pinId,
          function: toResolved.functionName,
        },
        type: conn.type,
        label,
        color,
        bus: conn.bus,
      });
    }

    if (resolveErrors.length > 0) {
      return {
        success: false,
        errors: resolveErrors,
        warnings: parsed.warnings,
      };
    }

    // 5. 构建组件列表
    const components = parsed.uses.map((use, index) => {
      const config = configMap.get(use.alias)!;
      
      // 计算实例编号（同一 pinmapId 的多个实例）
      const sameTypeCount = parsed.uses
        .slice(0, index)
        .filter(u => u.pinmapId === use.pinmapId)
        .length;

      return {
        refId: use.alias,
        componentId: config.id,
        componentName: use.label || config.name,
        pinmapId: use.pinmapId,
        instance: sameTypeCount,
      };
    });

    // 6. 生成描述
    const description = parsed.comments.length > 0
      ? parsed.comments[0]
      : `${components.map(c => c.componentName).join(' + ')} 连接方案`;

    return {
      success: true,
      data: {
        version: '1.0.0',
        description,
        components,
        connections,
      },
      warnings: parsed.warnings,
    };
  }
}

// =====================================================
// 便捷函数
// =====================================================

/**
 * 将 AWS 转换为 JSON（需要提供组件加载器）
 */
export async function convertAWSToJSON(
  aws: string,
  loader: ComponentLoader
): Promise<AWSToJSONResult> {
  const converter = new AWSConverter(loader);
  return converter.convert(aws);
}

/**
 * 获取完整的 AWS 语法参考（用于错误提示）
 */
export function getAWSSyntaxReference(): string {
  return AWS_SYNTAX_REFERENCE;
}
