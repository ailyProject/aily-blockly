import type { AbsFieldDefinition } from './abs-field-values';

/**
 * 块参数定义（来自 block.json 的 args）
 */
export interface BlockArgDefinition {
  type: string;           // field_dropdown, field_input, input_value, input_statement 等
  name: string;           // 参数名称
  check?: string | string[];  // 类型检查
  options?: any[];        // 下拉选项（仅 field_dropdown）
  text?: string;          // 默认文本（field_input）
  value?: any;            // 默认值
}

/**
 * 解析后的块元信息
 */
export interface BlockMeta {
  type: string;                       // 块类型名
  fieldNames: string[];               // 字段名列表（按顺序）
  fieldDefinitions?: Map<string, AbsFieldDefinition>;
  fieldTypes: Map<string, string>;    // 字段名到类型的映射（field_dropdown, field_variable 等）
  valueInputNames: string[];          // 值输入名列表（按顺序）
  statementInputNames: string[];      // 语句输入名列表
  argsOrder: Array<{ name: string; kind: 'field' | 'valueInput' | 'statementInput' }>; // 所有参数的原始顺序
  hasOutput: boolean;                 // 是否有输出（值块）
  outputType?: string | string[];     // 输出类型
  hasPrevious: boolean;               // 是否有上连接点
  hasNext: boolean;                   // 是否有下连接点
  isRootBlock: boolean;               // 是否为根块（无上下连接）
  library: string;                    // 所属库名
  mutator?: string;                   // mutator 类型（如 function_params_mutator）
  // 原始定义（用于调试）
  raw?: any;
}


/** One parser for synchronous and asynchronous library discovery. */
export function parseBlockDefinition(def: any, library: string): BlockMeta | null {
  if (!def || typeof def.type !== 'string') return null;
  const meta: BlockMeta = {
    type: def.type, fieldNames: [], fieldTypes: new Map(), fieldDefinitions: new Map(),
    valueInputNames: [], statementInputNames: [], argsOrder: [],
    hasOutput: 'output' in def, outputType: def.output,
    hasPrevious: 'previousStatement' in def, hasNext: 'nextStatement' in def,
    isRootBlock: !('output' in def) && !('previousStatement' in def) && !('nextStatement' in def),
    library, mutator: def.mutator,
  };
  const argKeys = Object.keys(def).filter(key => /^args\d+$/.test(key))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  for (const key of argKeys) {
    if (!Array.isArray(def[key])) continue;
    for (const arg of def[key]) {
      if (!arg || typeof arg.name !== 'string' || typeof arg.type !== 'string') continue;
      if (arg.type.startsWith('field_')) {
        meta.fieldNames.push(arg.name);
        meta.fieldTypes.set(arg.name, arg.type);
        meta.fieldDefinitions.set(arg.name, {
          type: arg.type,
          ...(Array.isArray(arg.options) ? { options: arg.options } : {}),
          ...(typeof arg.min === 'number' ? { min: arg.min } : {}),
          ...(typeof arg.max === 'number' ? { max: arg.max } : {}),
          ...(typeof arg.precision === 'number' ? { precision: arg.precision } : {}),
          ...(['string', 'number', 'boolean', 'json'].includes(arg.valueType) ? { valueType: arg.valueType } : {}),
          ...(arg.type === 'field_variable' ? { symbol: {
            kind: 'variable' as const, storage: 'variable-state' as const,
            ...(Array.isArray(arg.variableTypes) ? { allowedTypes: arg.variableTypes } : {}),
          } } : {}),
        });
        meta.argsOrder.push({ name: arg.name, kind: 'field' });
      } else if (arg.type === 'input_value' || arg.type === 'input_statement') {
        const kind = arg.type === 'input_value' ? 'valueInput' : 'statementInput';
        (kind === 'valueInput' ? meta.valueInputNames : meta.statementInputNames).push(arg.name);
        meta.argsOrder.push({ name: arg.name, kind });
      }
    }
  }
  return meta;
}
