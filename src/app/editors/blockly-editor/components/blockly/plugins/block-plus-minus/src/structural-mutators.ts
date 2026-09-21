import * as Blockly from 'blockly/core';

export interface StructuralMutationRecipe {
  count: string;
  initial: number;
  start: number;
  repeated: readonly { prefix: string; kind: 'valueInput' | 'statementInput' }[];
  replace?: boolean;
  optional?: { key: string; input: string; default: boolean };
  serialization: 'sparse' | 'all' | 'always';
}
const entries = new Map<string, { registration: unknown; mixin: object; descriptors: PropertyDescriptorMap; recipe: StructuralMutationRecipe }>();
const extensions = () => (Blockly.Extensions as any).TEST_ONLY?.allExtensions;

/** Owned by the bundled mutator, shared by every library using that registration.
 * Never execute a library init/serializer to discover a shape or instantiate probe blocks.
 */
export function registerStructuralMutator(name: string, mixin: object, helper: () => void, recipe: StructuralMutationRecipe): void {
  Blockly.Extensions.registerMutator(name, mixin, helper);
  entries.set(name, { registration: extensions()?.[name], mixin,
    descriptors: Object.getOwnPropertyDescriptors(mixin), recipe: JSON.parse(JSON.stringify(recipe)) });
}

export function captureStructuralMutators() {
  const registry = extensions(), apply = Blockly.Extensions.apply;
  const used = new Set<string>();
  const intact = (name: string) => {
    const entry = entries.get(name);
    return !!entry && registry === extensions() && typeof entry.registration === 'function'
      && registry?.[name] === entry.registration && apply === Blockly.Extensions.apply
      && Reflect.ownKeys(entry.mixin).length === Reflect.ownKeys(entry.descriptors).length
      && Object.keys(entry.descriptors).every(key => {
        const a = entry.descriptors[key], b = Object.getOwnPropertyDescriptor(entry.mixin, key);
        return b && a.value === b.value && a.get === b.get && a.set === b.set;
      });
  };
  return {
    get(name: string): StructuralMutationRecipe | undefined {
      if (!intact(name)) return undefined;
      used.add(name); return JSON.parse(JSON.stringify(entries.get(name)!.recipe));
    },
    assertCurrent() {
      if ([...used].some(name => !intact(name))) throw new Error('Structural mutator registration changed during preparation.');
    },
  };
}
