import { readAbsSyntax } from './abs-syntax';
import { walkAbsRawSyntax, type AbsRawNode, type AbsSyntaxOptions, type AbsArgumentDefinition } from './abs-syntax-binding';
import { indexAbsAbi } from './abs-abi-index';
import { AbsSyncError, type AbsAbiWorkspace } from './abs-state';
import type { CustomFunctionKind } from '../../../editors/blockly-editor/services/blockly-custom-function-contract';

type Describe = (type: string) => { protocol: { kind: CustomFunctionKind }; base: { argumentOrder?: readonly AbsArgumentDefinition[] } } | undefined;

/** Syntax only for an already attested typed-function protocol. Does not allocate
 * models, infer IDs, execute callbacks or grant an unknown mutator permission. */
export function customFunctionSyntax(source: string, workspace: AbsAbiWorkspace, describe: Describe): AbsSyntaxOptions {
  const signatures = new Map<string, unknown>();
  const states = new Map<number, unknown>();
  const fail = (node: AbsRawNode, message: string): never => { throw new AbsSyncError('ABS_CUSTOM_FUNCTION_INVALID', message, node); };
  const token = (node: AbsRawNode, name: string) => {
    const descriptor = describe(node.type);
    const order = descriptor?.protocol.kind === 'definition' ? descriptor.base.argumentOrder : [{ name: 'FUNC_NAME', kind: 'field' }];
    const position = order?.filter(arg => arg.kind !== 'statementInput').findIndex(arg => arg.name === name) ?? -1;
    return (node.parameters.find(item => item.name === name) ?? node.parameters.filter(item => !item.name)[position])?.token?.value;
  };
  for (const block of indexAbsAbi(workspace).values()) if (describe(block.type)?.protocol.kind === 'definition') {
    signatures.set(String(block.fields?.['FUNC_NAME']), (block.extraState as any)?.params ?? []);
  }
  const calls = [...walkAbsRawSyntax(readAbsSyntax(source))].map(item => item.node);
  const declared = new Set<string>();
  for (const node of calls) if (describe(node.type)?.protocol.kind === 'definition') {
    const name = token(node, 'FUNC_NAME');
    if (typeof name !== 'string' || declared.has(name)) fail(node, 'Function definition requires a unique name.');
    declared.add(name as string);
    let state = node.extraState as any;
    if (!Object.hasOwn(node, 'extraState')) {
      const tail = node.parameters.filter(item => !item.name).slice(2);
      // A non-void positional signature optionally ends with its return value.
      if (tail.length % 2 && token(node, 'RETURN_TYPE') !== 'void') tail.pop();
      if (tail.length % 2 || tail.length > 256) fail(node, 'Function parameters require at most 128 type/name pairs.');
      const params = [];
      for (let i = 0; i < tail.length; i += 2) {
        if (!tail[i].token || !tail[i + 1].token) fail(node, 'Function parameter type/name must be field values.');
        params.push({ type: tail[i].token!.value, name: tail[i + 1].token!.value });
      }
      // Named derived fields without state are deliberately not guessed into a signature.
      // Existing explicit @extra and its conflict checks remain authoritative.
      state = { params };
      states.set(node.start, state);
    }
    signatures.set(name as string, state?.params ?? []);
  }
  for (const node of calls) {
    const kind = describe(node.type)?.protocol.kind;
    if (!kind || kind === 'definition' || Object.hasOwn(node, 'extraState')) continue;
    const name = token(node, 'FUNC_NAME');
    if (typeof name === 'string' && signatures.has(name)) states.set(node.start, { params: signatures.get(name) });
  }
  return {
    prepareExtraState: node => states.get(node.start),
    argumentOrder: (type, extra: any, fields) => {
      const descriptor = describe(type); if (!descriptor) return undefined;
      const params = extra?.params ?? [];
      if (!Array.isArray(params) || params.length > 128) throw new AbsSyncError('ABS_CUSTOM_FUNCTION_INVALID', 'Invalid function parameters.');
      if (descriptor.protocol.kind !== 'definition') return [{ name: 'FUNC_NAME', kind: 'field' },
        ...params.map((_, i): AbsArgumentDefinition => ({ name: `INPUT${i}`, kind: 'valueInput' }))];
      const order = [...descriptor.base.argumentOrder!];
      params.forEach((_, i) => order.push({ name: `PARAM_TYPE${i}`, kind: 'field' }, { name: `PARAM_NAME${i}`, kind: 'field' }));
      if ((fields?.['RETURN_TYPE'] ?? extra?.returnType ?? 'void') !== 'void') order.push({ name: 'RETURN', kind: 'valueInput' });
      return order;
    },
  };
}
