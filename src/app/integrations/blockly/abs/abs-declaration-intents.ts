import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import type { VariableDeclarationContract } from '../../../editors/blockly-editor/services/blockly-variable-declaration-contract';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import { AbsAbiBlock, AbsAbiWorkspace, AbsSyntaxNode, AbsSyncError } from './abs-state';
import { hashAbsText, indexAbsSyntax } from './abs-identity-map';
import { prepareAbsVariableCreations, AbsVariableCreation } from './abs-variable-intents';
import { absModelRecovery, availableAbsModelName } from './abs-model-guidance';

/** The static planner and native bootstrap must derive model IDs from the same document identity. */
export async function absDeclarationRequestId(generation: string, source: string): Promise<string> {
  return (await hashAbsText(generation + '\n' + source)).slice('sha256:'.length);
}

/** Shape and generator effect are separate proofs; neither is inferred from a field name. */
export function captureAbsVariableDeclarations(snapshot: DeclarativeBlockSnapshot, shape: (type: string) => AbsBlockShapeContract | undefined) {
  return (type: string): VariableDeclarationContract | undefined => {
    snapshot.assertCurrent();
    const effect = snapshot.variableDeclarations?.get(type);
    if (!effect) return undefined;
    const block = shape(type), owner = shape(effect.owner.type);
    if (!block || block.output || !block.previous || !block.next || Object.keys(block.fields).length !== 2
      || block.fields[effect.nameField]?.type !== 'field_input' || block.fields['TYPE']?.type !== 'field_dropdown'
      || Object.keys(block.inputs).length !== 1 || block.inputs['VALUE'] !== 'value'
      || !owner || owner.output || owner.previous || owner.next || owner.inputs[effect.owner.input] !== 'statement') return undefined;
    return effect;
  };
}

/** Plan all declarations before resolving any reference. No native objects, I/O or generator execution. */
export function prepareAbsDeclarationIntents(
  roots: AbsSyntaxNode[], workspace: AbsAbiWorkspace, previous: (node: AbsSyntaxNode) => AbsAbiBlock | undefined,
  describe: (type: string) => VariableDeclarationContract | undefined, requestId: string,
): void {
  const entries = indexAbsSyntax(roots), byPath = new Map(entries.map(entry => [entry.path, entry]));
  const declarations = new Set<string>(), additions: AbsVariableCreation[] = [];
  const variables: any[] = Array.isArray(workspace['variables']) ? workspace['variables'] : [];
  for (const entry of entries) {
    const node = entry.node, effect = describe(node.type);
    if (!effect) continue;
    const fail = (code: string, message: string): never => { throw new AbsSyncError(code, message, node); };
    let head = entry;
    while (head.slot === '@next' && head.parent) head = byPath.get(head.parent)!;
    const owner = head.parent ? byPath.get(head.parent) : undefined;
    const before = previous(node), token = node.fields[effect.nameField];
    const name = token?.value ?? before?.fields?.[effect.nameField];
    if (token?.reference || typeof name !== 'string' || !before && !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(name)) {
      fail('ABS_DECLARATION_INVALID', 'A new ordinary declaration requires an explicit identifier name as text.');
    }
    if (before && name !== before.fields?.[effect.nameField]) {
      fail('ABS_DECLARATION_RENAME_REQUIRES_HOST', 'Changing a declaration name requires an explicit model rename, not another model.');
    }
    // Only direct statements in the proven global owner are covered, including its next chain.
    if (!owner || owner.parent !== null || owner.node.type !== effect.owner.type || head.slot !== effect.owner.input) {
      // Preserve previously supported non-global declarations, but do not silently prepare a new scope.
      if (before) continue;
      fail('ABS_DECLARATION_SCOPE_UNSUPPORTED', `Place the declaration directly in ${effect.owner.type}'s ${effect.owner.input} body.`);
    }
    if (node.disabled || owner.node.disabled) continue;
    const key = (name as string).toLowerCase();
    if (declarations.has(key)) fail('ABS_DECLARATION_DUPLICATE', `Duplicate storage declaration ${JSON.stringify(name)}.`);
    declarations.add(key);
    const models = variables.filter(model => typeof model.name === 'string' && model.name.toLowerCase() === key);
    if (models.length) {
      if (models.length !== 1 || models[0].name !== name || (models[0].type ?? '') !== effect.nativeType) {
        const reason = models.some(model => (model.type ?? '') !== effect.nativeType) ? 'type-conflict' : 'identity-conflict';
        throw new AbsSyncError('ABS_DECLARATION_MODEL_CONFLICT', `Declaration ${JSON.stringify(name)} conflicts with an existing native model.`, node, [], {
          blockType: node.type, modelName: name as string, expectedTypes: [effect.nativeType], actualTypes: models.map(model => model.type ?? ''),
          reason, hint: absModelRecovery(reason), availableName: availableAbsModelName(name as string, variables.map(model => model.name)),
        });
      }
      continue; // Reuse existing identity, including an agreeing explicit transition intent.
    }
    if (before) throw new AbsSyncError('ABS_DECLARATION_MODEL_MISSING', 'An existing declaration lost its native model.', node, [], {
      blockType: node.type, modelName: name as string, expectedTypes: [effect.nativeType], reason: 'missing', hint: absModelRecovery('missing'),
    });
    additions.push({ name: name as string, type: effect.nativeType });
  }
  if (additions.length) prepareAbsVariableCreations(workspace, { requestId, variables: additions });
}
