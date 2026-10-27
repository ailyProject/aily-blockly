import type * as Blockly from 'blockly';
import { AbsSyncError, type AbsSyntaxNode } from '../../../integrations/blockly/abs/abs-state';
import type { AbsNativeModelDeclaration } from '../../../integrations/blockly/abs/abs-native-model-declarations';
import type { NativeCandidateWorkspace } from './blockly-native-candidate-workspace';
import { hasNativeModelRegistrationHelper, withNativeModelRegistrations } from './blockly-native-model-effects';
import { nativeLoopVariable } from './blockly-native-loop-model';
import { assertNativeBudget } from './blockly-native-budget';

/** A bounded dependency worklist, not speculative full code generation. Invoke real
 * generators only for configured subtrees, before binding unresolved references.
 * No fake dropdown value, empty consumer code or missing-reference-created model.
 * The final fresh realm must reproduce each registration with the complete ABI. */
export function prepareNativeModels(execution: NativeCandidateWorkspace, generator: Blockly.Generator,
  blocks: ReadonlyMap<AbsSyntaxNode, Blockly.Block>, resolveReferences: () => ReadonlySet<Blockly.Block>, requestId: string,
  retained: { retainedCalls?: number[]; retainedIds?: string[]; inactiveNodes?: ReadonlySet<AbsSyntaxNode> } = {}): AbsNativeModelDeclaration[] {
  const nodes = new Map([...blocks].map(([node, block]) => [block, node]));
  const disabled = (block: Blockly.Block): boolean => {
    const node = nodes.get(block);
    if (node && retained.inactiveNodes?.has(node)) return true;
    for (let current: Blockly.Block | null = block; current; current = current.getSurroundParent()) if (nodes.get(current)?.disabled) return true;
    return false;
  };
  const declarations = new Map<string, AbsNativeModelDeclaration>();
  const initializers = new Map<string, AbsNativeModelDeclaration>();
  const retainedCalls = new Set(retained.retainedCalls), retainedIds = new Set(retained.retainedIds);
  const retainedNames = new Set<string>();
  const unchanged = (effect: AbsNativeModelDeclaration) => retainedCalls.has(effect.start) && retainedIds.has(effect.id);
  // Only the explicit counter declaration may seed a missing loop model. A
  // later ordinary initializer can reuse that same model; the loop keeps its
  // producer because its source offset owns the deterministic model identity.
  for (const [node, block] of blocks) {
    const field = !disabled(block) && nativeLoopVariable(block), token = node.fields['VAR'];
    if (!field || !token) continue;
    try {
      execution.models.resolve(token, { type: 'field_variable', symbol: { kind: 'variable', storage: 'variable-state', allowedTypes: [''] } });
    } catch (error) {
      if (!(error instanceof AbsSyncError) || error.code !== 'ABS_SYMBOL_MISSING') throw error;
    }
    // Record ownership even when replay receives the already planned models.
    // Discovery and identity-bound replay must produce identical evidence.
    const effect = execution.models.declare(node.start, block.type, String(token.value), '', requestId);
    if (unchanged(effect)) continue;
    if (!declarations.has(effect.name.toLowerCase())) declarations.set(effect.name.toLowerCase(), { ...effect, kind: 'loop' });
    assertNativeBudget('declarations', declarations.size, 'model-preparation');
  }
  let unresolved = resolveReferences();
  const effects = () => [...declarations.values()].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  // Without the library registration protocol only core lexical declarations
  // are preparable. Do not speculatively execute unrelated generators.
  if (!hasNativeModelRegistrationHelper(window, generator)) return effects();
  // Once all references are bound there can be no unresolved descendant. Do not
  // repeatedly traverse complete input subtrees just to search an empty set.
  // With pending references, retain live topology reads: generators may change it.
  const ready = (block: Blockly.Block) => !unresolved.size || !unresolved.has(block)
    && block.inputList.every(input => !input.connection?.targetBlock()?.getDescendants(false).some(child => unresolved.has(child)));
  withNativeModelRegistrations(window, generator, (block, name, type) => {
    const node = nodes.get(block);
    if (!node || disabled(block)) throw new AbsSyncError('ABS_MODEL_DECLARATION_UNOWNED', `Only an active ABS initializer may prepare a model (${block.type}: ${!node ? 'missing-abs-owner' : 'disabled-initializer'}).`, node, [], { blockType: block.type, reason: !node ? 'missing-abs-owner' : 'disabled-initializer' });
    const effect = execution.models.declare(node.start, block.type, name, type, requestId);
    const key = effect.name.toLowerCase(), previous = declarations.get(key);
    const initializer = initializers.get(key);
    if (initializer && (initializer.start !== effect.start || initializer.type !== effect.type)) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_CONFLICT', `Multiple initializers declare ${JSON.stringify(name)}. Keep one declaration per object.`, node);
    }
    // Still execute and validate the real helper/type/identity, but do not turn
    // unchanged registrations of an existing model into new producer ownership.
    if (unchanged(effect) && (!previous || previous.kind === 'loop')) { retainedNames.add(key); return; }
    if (retainedNames.has(key) || unchanged(effect)) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_CONFLICT', `New initializer duplicates an existing declaration of ${JSON.stringify(name)}.`, node);
    }
    if (previous && previous.kind !== 'loop' && (previous.start !== effect.start || previous.type !== effect.type)) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_CONFLICT', `Multiple initializers declare ${JSON.stringify(name)}. Keep one declaration per object.`, node);
    }
    initializers.set(key, effect);
    // A loop-created identity must retain its original producer in the receipt.
    // Ordinary registration may reuse it, but cannot relabel its source offset.
    if (previous?.kind !== 'loop') declarations.set(key, effect);
    assertNativeBudget('declarations', declarations.size, 'model-preparation');
  }, () => {
    // Generators and init may scan the whole workspace, not just this worklist.
    // A preserved parent may be absent here, so native topology alone cannot
    // expose its children's inherited inactivity. Mask the same complete set
    // used for ownership/worklist admission, without persisting that inheritance.
    const reason = 'ABS_NATIVE_MODEL_PREPARATION';
    // Already-disabled blocks keep every original reason, including this one.
    const masked = [...blocks.values()].filter(block => disabled(block) && block.isEnabled());
    try {
      for (const block of masked) block.setDisabledReason(true, reason);
      generator.init(execution.workspace);
      const remaining = new Set([...blocks.values()].filter(block => !disabled(block)));
      while (remaining.size) {
        let progress = false;
        for (const block of remaining) {
          if (!ready(block)) continue;
          remaining.delete(block); progress = true;
          const callback = generator.forBlock[block.type];
          if (!callback) continue; // Complete generation checks generator coverage.
          callback.call(generator, block, generator);
          execution.assertClean(); execution.models.assertCurrent();
        }
        unresolved = resolveReferences();
        if (!progress) break; // Missing/cyclic dependencies remain errors, never guessed models.
      }
    } finally {
      for (const block of masked) block.setDisabledReason(false, reason);
    }
  });
  return effects();
}
