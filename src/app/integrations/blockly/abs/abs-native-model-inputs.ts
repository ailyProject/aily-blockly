import { bindAbsSyntax, walkAbsRawSyntax, type AbsRawNode } from './abs-syntax-binding';
import type { AbsAbiWorkspace } from './abs-state';
import type { AbsReconcileOptions } from './abs-reconciler';
import { prepareAbsVariableCreations, type AbsVariableCreation } from './abs-variable-intents';

/**
 * Bootstrap inputs, not declaration authority. A mixed native document may refer
 * to a declaration before we can bind its unknown blocks or match identities.
 * Only an attested declaration may supply a name; the ordinary reconciler still
 * decides scope, duplicates, retained identity and renames after native binding.
 * This table is discarded, never merged into the candidate to be committed.
 */
export function prepareAbsNativeModelInputs(raw: readonly AbsRawNode[], workspace: AbsAbiWorkspace,
  options: AbsReconcileOptions, requestId: string): void {
  if (!options.declaration) return;
  const names = new Set((workspace['variables'] as Array<{ name: string }> | undefined ?? [])
    .map(model => model.name.toLowerCase()));
  const additions: AbsVariableCreation[] = [];
  for (const { node, disabled } of walkAbsRawSyntax(raw)) {
    const effect = !disabled && options.declaration!(node.type);
    if (effect) {
      // Bind the proven declaration's call with the SAME positional/named rules.
      // Initializer expressions are opaque here: their native shapes may be the
      // reason the full document cannot use the static path in the first place.
      const call = { ...node, sections: [], parameters: node.parameters.map(parameter => parameter.child
        ? { ...parameter, child: { ...parameter.child, parameters: [], sections: [] } } : parameter) };
      const token = bindAbsSyntax([call], options)[0].fields[effect.nameField];
      if (token && !token.reference && typeof token.value === 'string' && !names.has(token.value.toLowerCase())) {
        names.add(token.value.toLowerCase());
        additions.push({ name: token.value, type: effect.nativeType });
      }
    }
  }
  if (additions.length) prepareAbsVariableCreations(workspace, { requestId, variables: additions });
}
