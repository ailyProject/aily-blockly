import type { AbsNativeBinding } from './abs-native-binding';
import { AbsSyncError, type AbsAbiBlock, type AbsProjectionContracts, type AbsSyntaxNode } from './abs-state';
import { indexAbsAbi } from './abs-abi-index';

/** Pure new-owner default merge. Existing ABI topology never enters this function. */
export function adoptAbsNativeDefaults(binding: AbsNativeBinding | undefined, node: AbsSyntaxNode,
  block: AbsAbiBlock, context: { ids: Set<string>; contracts: AbsProjectionContracts; added: string[]; defaultIds: Set<string> }): Set<string> {
  const { ids, contracts, added, defaultIds } = context;
  const adopted = new Set<string>();
  const seen = new Set<string>();
  for (const effect of binding?.defaults ?? []) {
    if (effect.owner !== node.start) continue;
    const owner = binding!.instances.find(instance => instance.start === node.start);
    if (!owner || !Object.hasOwn(owner.shape.inputs, effect.input) || seen.has(effect.input)
      || (effect.fallback ? !node.inputs[effect.input] || !effect.state.shadow || !!effect.state.block : Object.hasOwn(node.inputs, effect.input))) {
      throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Default input is not uniquely owned and omitted.', node);
    }
    const tree = indexAbsAbi({ blocks: { blocks: [effect.state.block, effect.state.shadow].filter((item): item is AbsAbiBlock => !!item) } });
    const instances = new Map(effect.instances.map(instance => [instance.id, instance]));
    if (!tree.size || tree.size !== instances.size || instances.size !== effect.instances.length) {
      throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Default subtree requires complete instance evidence.', node);
    }
    for (const [id, child] of tree) {
      const instance = instances.get(id);
      if (ids.has(id) || !instance || instance.type !== child.type) {
        throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Default subtree has conflicting identity.', node, [id]);
      }
      ids.add(id); added.push(id); defaultIds.add(id);
      Object.defineProperty(contracts.fields, id, { value: structuredClone(instance.shape.fields), enumerable: true, configurable: true, writable: true });
      if (instance.shape.argumentOrder) Object.defineProperty(contracts.syntax ??= Object.create(null), id,
        { value: structuredClone(instance.shape.argumentOrder), enumerable: true, configurable: true, writable: true });
    }
    Object.defineProperty(block.inputs ??= Object.create(null), effect.input,
      { value: structuredClone(effect.state), enumerable: true, configurable: true, writable: true });
    seen.add(effect.input);
    if (!effect.fallback) adopted.add(effect.input);
  }
  return adopted;
}
