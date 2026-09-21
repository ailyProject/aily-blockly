import type * as Blockly from 'blockly';
import { AbsSyncError } from '../../../integrations/blockly/abs/abs-state';
import type { AbsNativeModelDeclaration } from '../../../integrations/blockly/abs/abs-native-model-declarations';
import { nativeLoopVariable } from './blockly-native-loop-model';

/** One synchronous capability boundary, independent of library names and generator
 * source text. Only a currently executing native block may call the registration
 * helper. Other workspace mutations remain subject to complete native readback. */
export function withNativeModelRegistrations<T>(realm: any, generator: Blockly.Generator,
  register: (block: Blockly.Block, name: string, type: string) => void, action: () => T,
  visit?: (block: Blockly.Block) => void): T {
  const original = realm.registerVariableToBlockly;
  const hasHelper = typeof original === 'function';
  let owner: Blockly.Block | undefined;
  let failure: unknown;
  const functions = new Map(Object.entries(generator.forBlock));
  const helper = (name: string, type: string = '') => {
    try {
      if (!owner) throw new AbsSyncError('ABS_MODEL_DECLARATION_UNOWNED', 'A native model registration has no executing initializer.');
      register(owner, name, type);
      // The model now exists with the transaction-owned identity. Run the original
      // helper too; custom helper side effects cannot be hidden by this adapter.
      return original(name, type);
    } catch (error) { failure = error; throw error; }
  };
  if (hasHelper) realm.registerVariableToBlockly = helper;
  const wrapped = new Map<string, Blockly.Generator['forBlock'][string]>();
  for (const [type, callback] of functions) {
    const scoped: Blockly.Generator['forBlock'][string] = function(block, current) {
      const previous = owner; owner = block;
      try { visit?.(block); return callback.call(this, block, current); } finally { owner = previous; }
    };
    wrapped.set(type, scoped); generator.forBlock[type] = scoped;
  }
  try {
    const result = action();
    if (failure) throw failure;
    if (realm.registerVariableToBlockly !== (hasHelper ? helper : original)) throw new Error('Native generator replaced the model registration boundary.');
    if (Object.keys(generator.forBlock).length !== wrapped.size || [...wrapped].some(([type, callback]) => generator.forBlock[type] !== callback)) {
      throw new Error('Native model preparation changed the generator registry.');
    }
    return result;
  } finally {
    if (hasHelper) realm.registerVariableToBlockly = original;
    for (const [type, callback] of functions) generator.forBlock[type] = callback;
  }
}

/** Verify actual complete generation reproduces every prepared producer effect.
 * The ABI already owns all identities; registration must not create more models. */
export function verifyNativeModelRegistrations<T>(realm: any, generator: Blockly.Generator,
  expected: Array<AbsNativeModelDeclaration & { ownerId: string }>, action: () => T): T {
  const seen = new Set<string>();
  const result = withNativeModelRegistrations(realm, generator, (block, name, type) => {
    const effect = expected.find(item => item.name.toLowerCase() === String(name).toLowerCase());
    if (!effect) return;
    if (effect.ownerId !== block.id || effect.blockType !== block.type || effect.name !== name || effect.type !== type) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_CHANGED', 'Complete generation changed native model declaration ownership or type.');
    }
    seen.add(effect.id);
  }, action, block => {
    const effect = expected.find(item => item.kind === 'loop' && item.ownerId === block.id);
    if (!effect) return;
    const variable = nativeLoopVariable(block)?.getVariable();
    if (effect.blockType !== block.type || !variable || variable.getId() !== effect.id
      || variable.name !== effect.name || variable.type !== effect.type) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_CHANGED', 'Complete generation changed the loop counter declaration.');
    }
    seen.add(effect.id);
  });
  if (expected.some(item => !seen.has(item.id))) {
    throw new AbsSyncError('ABS_MODEL_DECLARATION_CHANGED', 'Complete generation did not reproduce a prepared initializer. Keep its active, connected declaration in the candidate.');
  }
  return result;
}
