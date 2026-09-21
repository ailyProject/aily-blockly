import type { BlocklyFieldShapeRule } from '../../../editors/blockly-editor/services/blockly-field-shape-contracts';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import { readAbsFieldToken, resolveAbsFieldValue } from './abs-field-values';
import { AbsSyncError } from './abs-state';

/** Resolve native dummy-input placement using the declaration, never a live inputList. */
export function resolveAbsFieldShapeAnchors(json: Record<string, any>, base: AbsBlockShapeContract, rules: readonly BlocklyFieldShapeRule[]): BlocklyFieldShapeRule[] | undefined {
  const args = Object.keys(json).filter(key => /^args\d+$/.test(key)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))).flatMap(key => json[key]);
  const result: BlocklyFieldShapeRule[] = [], names = new Set([...Object.keys(base.fields), ...Object.keys(base.inputs)]);
  for (const { afterInput, ...rule } of rules) {
    const field = base.fields[rule.field];
    if (field?.type !== 'field_dropdown' || !field.options || rule.values.some(value => !field.options!.some(option => option[1] === value))) return undefined;
    for (const arg of rule.args) { if (names.has(arg.name)) return undefined; names.add(arg.name); }
    if (afterInput !== undefined) {
      const index = args.findIndex(arg => arg?.name === afterInput && arg.type === 'input_dummy');
      const previous = args.slice(0, index).filter(arg => base.argumentOrder!.some(item => item.name === arg?.name)).at(-1);
      if (index < 0 || !previous || args.filter(arg => arg?.name === afterInput).length !== 1) return undefined;
      rule.after = previous.name;
    }
    if (rule.after !== undefined && base.argumentOrder!.findIndex(arg => arg.name === rule.after) < base.argumentOrder!.findIndex(arg => arg.name === rule.field)) return undefined;
    result.push(rule);
  }
  return result;
}

/** Merge proven declaration fragments; argument placement is part of the mechanism, not guessed. */
export function prepareAbsFieldShape(base: AbsBlockShapeContract, rules: readonly BlocklyFieldShapeRule[],
  values: Readonly<Record<string, unknown>> = {},
  extraState?: unknown,
): AbsBlockShapeContract {
  const fail = (message: string): never => { throw new AbsSyncError('ABS_RUNTIME_SHAPE_UNSUPPORTED', message); };
  const attributes: string[] = [];
  const nativeAttributes = rules.flatMap(rule => rule.mutationAttribute ? [rule.mutationAttribute] : []);
  const namespaces = [...new Set(rules.filter(rule => rule.mutationAttribute).map(rule => rule.mutationNamespace ?? ''))];
  if (namespaces.length > 1) fail('Cannot combine different native XML serializers.');
  const nativePrefix = '<mutation' + (namespaces[0] ? ` xmlns="${namespaces[0]}"` : '');
  // Only these proven, redundant booleans may be re-derived after a field edit.
  // Opaque mutation data must never be discarded by a field-shape adapter.
  const nativePattern = new RegExp('^' + nativePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + nativeAttributes.map(name => ` ${name}="(?:true|false)"`).join('') + '></mutation>$');
  if (extraState != null && (!nativeAttributes.length || typeof extraState !== 'string' || !nativePattern.test(extraState))) {
    fail('Unverified field-dependent extraState.');
  }
  const argumentOrder = [...base.argumentOrder!];
  const result: AbsBlockShapeContract = { ...base, inputs: { ...base.inputs }, argumentOrder, fieldShape: rules };
  for (const rule of rules) {
    const field = base.fields[rule.field];
    if (field?.type !== 'field_dropdown' || !field.options
      || rule.values.some(value => !field.options!.some(option => option[1] === value))) fail('Shape selector is not a proven dropdown.');
    const value = Object.hasOwn(values, rule.field) ? values[rule.field] : base.defaults[rule.field];
    const selected = resolveAbsFieldValue(readAbsFieldToken(JSON.stringify(value)), field);
    const active = rule.values.includes(selected as string);
    if (rule.mutationAttribute) attributes.push(` ${rule.mutationAttribute}="${active}"`);
    if (!active) continue;
    const order = rule.args.map(arg => ({ name: arg.name, kind: arg.type === 'input_value' ? 'valueInput' as const : 'statementInput' as const }));
    if (order.some(arg => argumentOrder.some(previous => previous.name === arg.name))) fail('Conditional argument collides with its base declaration.');
    // Anchors validate native shape, not ABS positions. Keep the declared prefix
    // intact, then append active dynamic arguments in their attested rule order.
    argumentOrder.push(...order);
    for (const arg of rule.args) result.inputs[arg.name] = arg.type === 'input_value' ? 'value' : 'statement';
  }
  if (attributes.length) result.extraState = nativePrefix + attributes.join('') + '></mutation>';
  return result;
}
