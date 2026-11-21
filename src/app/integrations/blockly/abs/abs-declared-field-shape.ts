import { parseBlockDefinition } from './block-definition.model';

type Literal = string | number | boolean;
type DeclaredArgument = { type: 'input_value' | 'input_statement'; name: string;
  default?: { type: string; fields: Record<string, Literal> } };
interface DeclaredRule { field: string; values: string[]; args: DeclaredArgument[] }

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_]\w{0,127}$/.test(value);
const literal = (value: unknown): value is Literal => typeof value === 'string' && value.length <= 256
  || typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean';

/** Bounded library metadata for discovery only. Native validation still owns
 * the runtime shape, the default blocks and all publication decisions. */
export function readDeclaredAbsFieldShape(definition: Record<string, unknown> | undefined): DeclaredRule[] | undefined {
  const value = definition?.['ailyFieldShape'];
  if (!Array.isArray(value) || !value.length || value.length > 16) return undefined;
  const base = parseBlockDefinition(definition, '');
  if (!base) return undefined;
  const names = new Set(base.argsOrder.map(arg => arg.name));
  const rules: DeclaredRule[] = [];
  for (const entry of value) {
    if (!record(entry) || !identifier(entry['field'])) return undefined;
    const { field, values, args } = entry;
    const selector = base.fieldDefinitions?.get(field);
    if (selector?.type !== 'field_dropdown' || !Array.isArray(selector.options)
      || !Array.isArray(values) || !values.length || values.length > 32 || new Set(values).size !== values.length
      || !values.every(v => typeof v === 'string' && v.length <= 256 && selector.options!.some(option => Array.isArray(option) && option[1] === v))
      || !Array.isArray(args) || !args.length || args.length > 16) return undefined;
    const declaredArgs: DeclaredArgument[] = [];
    for (const arg of args) {
      if (!record(arg) || !identifier(arg['name']) || names.has(arg['name'])
        || (arg['type'] !== 'input_value' && arg['type'] !== 'input_statement')) return undefined;
      const { type, name } = arg;
      const block = arg['default'];
      if (block !== undefined && (type !== 'input_value' || !record(block) || !identifier(block['type']) || !record(block['fields'])
        || Object.keys(block['fields']).length > 16 || !Object.entries(block['fields']).every(([key, value]) => identifier(key) && literal(value)))) return undefined;
      names.add(name);
      declaredArgs.push({ type, name, ...(block === undefined ? {} : { default: {
        type: (block as { type: string }).type, fields: { ...(block as { fields: Record<string, Literal> }).fields },
      } }) });
    }
    rules.push({ field, values: [...values], args: declaredArgs });
  }
  return rules;
}
