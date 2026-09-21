import { readAbsSyntax } from './abs-syntax';
import { walkAbsRawSyntax, type AbsSyntaxOptions } from './abs-syntax-binding';
import { AbsSyncError } from './abs-state';
import type { AbsVariableCreation } from './abs-variable-intents';
import { absModelRecovery } from './abs-model-guidance';

/** Legacy explicit intents are restricted to attested function definitions.
 * Consumer constraints and ordinary library blocks never authorize allocation. */
export function assertAbsProcedureModelIntents(source: string, requested: readonly AbsVariableCreation[] | undefined,
  syntax: AbsSyntaxOptions, definition: (type: string) => { nameField?: string; modelType?: string } | undefined): void {
  if (!requested?.length) return;
  const owned = new Set<string>();
  const key = (name: string, type = '') => JSON.stringify([name, type]);
  for (const { node, disabled } of walkAbsRawSyntax(readAbsSyntax(source))) {
    const contract = !disabled && definition(node.type);
    if (!contract) continue;
    const extra: any = Object.hasOwn(node, 'extraState') ? node.extraState : syntax.prepareExtraState?.(node);
    if (contract.nameField) {
      const order = syntax.argumentOrder?.(node.type, extra)?.filter(arg => arg.kind !== 'statementInput');
      const position = order?.findIndex(arg => arg.name === contract.nameField) ?? -1;
      const token = (node.parameters.find(arg => arg.name === contract.nameField)
        ?? node.parameters.filter(arg => !arg.name)[position])?.token;
      if (token && !token.reference && typeof token.value === 'string') owned.add(key(token.value, contract.modelType));
    }
    if (Array.isArray(extra?.params)) for (const param of extra.params) {
      if (typeof param?.name === 'string') owned.add(key(param.name));
    }
  }
  for (const model of requested) if (!owned.has(key(model.name, model.type))) {
    throw new AbsSyncError('ABS_MODEL_INTENT_UNOWNED', 'Direct model allocation requires a supported function/parameter declaration in this candidate.', undefined, [], {
      modelName: model.name, reason: 'unowned-model-intent', hint: absModelRecovery('missing'),
    });
  }
}
