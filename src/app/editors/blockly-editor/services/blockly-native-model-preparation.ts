import type * as Blockly from 'blockly';
import { AbsSyncError, type AbsSyntaxNode } from '../../../integrations/blockly/abs/abs-state';
import type { AbsNativeModelDeclaration } from '../../../integrations/blockly/abs/abs-native-model-declarations';
import type { NativeCandidateWorkspace } from './blockly-native-candidate-workspace';
import { withNativeModelRegistrations } from './blockly-native-model-effects';
import { nativeLoopVariable } from './blockly-native-loop-model';

/** A bounded dependency worklist, not speculative full code generation. Invoke real
 * generators only for configured subtrees, before binding unresolved references.
 * No fake dropdown value, empty consumer code or missing-reference-created model.
 * The final fresh realm must reproduce each registration with the complete ABI. */
export function prepareNativeModels(execution: NativeCandidateWorkspace, generator: Blockly.Generator,
  blocks: ReadonlyMap<AbsSyntaxNode, Blockly.Block>, resolveReferences: () => ReadonlySet<Blockly.Block>, requestId: string): AbsNativeModelDeclaration[] {
  const nodes = new Map([...blocks].map(([node, block]) => [block, node]));
  const disabled = (block: Blockly.Block): boolean => {
    for (let current: Blockly.Block | null = block; current; current = current.getParent()) if (nodes.get(current)?.disabled) return true;
    return false;
  };
  const declarations = new Map<string, AbsNativeModelDeclaration>();
  // Only the explicit counter declaration may seed a missing loop model. A
  // later ordinary initializer can own that same model; shared loop counters
  // reuse the first identity instead of inventing duplicate variable models.
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
    if (!declarations.has(effect.name.toLowerCase())) declarations.set(effect.name.toLowerCase(), { ...effect, kind: 'loop' });
    if (declarations.size > 128) throw new Error('Native model preparation exceeds declaration limits.');
  }
  let unresolved = resolveReferences();
  const effects = () => [...declarations.values()].sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  // Without the library registration protocol only core lexical declarations
  // are preparable. Do not speculatively execute unrelated generators.
  if (typeof window['registerVariableToBlockly'] !== 'function') return effects();
  const ready = (block: Blockly.Block) => !unresolved.has(block)
    && block.inputList.every(input => !input.connection?.targetBlock()?.getDescendants(false).some(child => unresolved.has(child)));
  withNativeModelRegistrations(window, generator, (block, name, type) => {
    const node = nodes.get(block);
    if (!node || disabled(block)) throw new AbsSyncError('ABS_MODEL_DECLARATION_UNOWNED', 'Only an active ABS initializer may prepare a model.');
    const effect = execution.models.declare(node.start, block.type, name, type, requestId);
    const key = effect.name.toLowerCase(), previous = declarations.get(key);
    if (previous && previous.kind !== 'loop' && (previous.start !== effect.start || previous.type !== effect.type)) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_CONFLICT', `Multiple initializers declare ${JSON.stringify(name)}. Keep one declaration per object.`, node);
    }
    declarations.set(key, effect); // Repeated registration by the same native producer is idempotent.
    if (declarations.size > 128) throw new Error('Native model preparation exceeds declaration limits.');
  }, () => {
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
  });
  return effects();
}
