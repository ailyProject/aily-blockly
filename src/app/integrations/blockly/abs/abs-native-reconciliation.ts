import type { NativeCandidateRequest, NativeCandidateResult } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { absJson } from './abs-json';
import { indexAbsAbi } from './abs-abi-index';
import { AbsProjection, AbsSyncError } from './abs-state';
import { AbsReconcileOptions, reconcileAbsDraft } from './abs-reconciler';
import { prepareAbsReconciledResources } from './abs-prepared-reconciliation';
import { assertAbsReadback } from './abs-readback';
import { assertAbsDeclaredBlockShape } from './abs-declarative-contracts';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { readAbsSyntax } from './abs-syntax';
import { prepareAbsVariableCreations } from './abs-variable-intents';
import { captureAbsNativeValues } from './abs-native-resources';
import { prepareAbsNativeModelInputs } from './abs-native-model-inputs';
import { absDeclarationRequestId } from './abs-declaration-intents';
import { walkAbsRawSyntax } from './abs-syntax-binding';
import { absSyntaxOptions } from './abs-syntax-contracts';
import { retireEmptyProjectModels } from './abs-empty-project-models';

export type AbsNativeExecutor = (request: Omit<NativeCandidateRequest, 'steps'>) => Promise<NativeCandidateResult>;

/** No alternate save path: native execution only supplies this transaction's detached draft. */
export async function prepareAbsNativeReconciliation(baseline: AbsProjection, source: string,
  options: AbsReconcileOptions, execute: AbsNativeExecutor, assertCurrent: () => void) {
  const syntax = readAbsSyntax(source); // Reject a malformed document before replaying any library.
  baseline = structuredClone(baseline);
  const parseOptions = absSyntaxOptions(baseline.workspace, baseline.contracts, options);
  const hostCalls: NonNullable<NativeCandidateRequest['hostCalls']> = [];
  for (const { node } of walkAbsRawSyntax(syntax)) if (options.prepareBlock && options.hostPrepared?.(node.type)) {
    const fields = Object.fromEntries(node.parameters.filter(parameter => parameter.name && parameter.token)
      .map(parameter => [parameter.name!, parameter.token!.value]));
    const extraState = Object.hasOwn(node, 'extraState') ? node.extraState : parseOptions.prepareExtraState?.(node);
    const initialOrder = parseOptions.argumentOrder?.(node.type, extraState, fields)?.filter(arg => arg.kind !== 'statementInput');
    node.parameters.filter(parameter => !parameter.name).forEach((parameter, index) => {
      const argument = initialOrder?.[index];
      if (argument?.kind === 'field' && parameter.token) fields[argument.name] = parameter.token.value;
    });
    const argumentOrder = parseOptions.argumentOrder?.(node.type, extraState, fields);
    hostCalls.push({ start: node.start, type: node.type, ...(argumentOrder ? { argumentOrder } : {}),
      ...(extraState === undefined ? {} : { extraState }) });
  }
  const modelState = structuredClone(baseline.workspace);
  if (source !== baseline.abs) retireEmptyProjectModels(baseline, modelState, source);
  const modelRequestId = await absDeclarationRequestId(baseline.map.generation, source);
  assertCurrent();
  prepareAbsVariableCreations(modelState, options.variableCreation);
  // These tentative inputs only unblock shape binding. Scope/identity/model
  // decisions remain with reconcileAbsDraft and replace this table below.
  if (options.declaration) {
    prepareAbsNativeModelInputs(syntax, modelState, options, modelRequestId);
  }
  const values = await captureAbsNativeValues(syntax, assertCurrent);
  const run = async (request: Omit<NativeCandidateRequest, 'steps'>) => {
    assertCurrent();
    const result = await execute(request);
    assertCurrent();
    return result;
  };
  const bind = async (identities?: NativeCandidateRequest['identities'], variables = modelState['variables'], creations?: NativeCandidateRequest['creations']) => {
    const result = await run({ blocks: [], abs: source, modelRequestId, values, ...(hostCalls.length ? { hostCalls } : {}),
      ...(variables === undefined ? {} : { variables: variables as NativeCandidateRequest['variables'] }), ...(identities ? { identities } : {}),
      ...(creations ? { creations } : {}) });
    if (!result.binding || result.binding.source !== source) throw new AbsSyncError('ABS_NATIVE_BINDING_STALE', 'Native executor did not bind the requested source.');
    if (absJson(result.binding.hostCalls ?? []) !== absJson(hostCalls)) throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Native executor changed host preparation coverage.');
    return result.binding;
  };
  const provisional = await bind();
  // Reuse the sole identity matcher, including ambiguity and protected-block policies.
  // The provisional tree is never externalized, loaded, persisted or used as a receipt.
  const planned = await reconcileAbsDraft(baseline, source, { ...options, nativeBinding: provisional });
  assertCurrent();
  const identities = new Map(planned.identities.map(item => [item.start, item.id]));
  const binding = await bind(planned.identities, planned.workspace['variables'], provisional.creations ?? []);
  if (absJson(binding.syntax) !== absJson(provisional.syntax)
    || binding.instances.length + hostCalls.length !== identities.size
    || binding.instances.some(item => identities.get(item.start) !== item.id)) {
    throw new AbsSyncError('ABS_NATIVE_BINDING_CHANGED', 'Native binding changed when replayed with reconciled identities.');
  }
  if (absJson(binding.creations ?? []) !== absJson(provisional.creations ?? [])
    || absJson(binding.defaults ?? []) !== absJson(provisional.defaults ?? [])
    || absJson(binding.modelDeclarations ?? []) !== absJson(provisional.modelDeclarations ?? [])) {
    throw new AbsSyncError('ABS_NATIVE_BINDING_CHANGED', 'Native default ownership, identity or content changed during replay.');
  }
  const draft = await reconcileAbsDraft(baseline, source, { ...options, nativeBinding: binding,
    newId: node => identities.get(node.start)! });
  assertCurrent();
  if (absJson(draft.identities) !== absJson(planned.identities)) throw new AbsSyncError('ABS_NATIVE_BINDING_CHANGED', 'Native identity assignment changed.');
  if (absJson(draft.workspace['variables'] ?? []) !== absJson(planned.workspace['variables'] ?? [])) {
    throw new AbsSyncError('ABS_NATIVE_BINDING_CHANGED', 'Native declaration model planning changed.');
  }
  const blocks = indexAbsAbi(draft.workspace);
  const instances = new Map(binding.instances.map(instance => [instance.id, instance] as const));
  const added = new Set(draft.added);
  if (instances.size !== binding.instances.length) throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Duplicate native instance identity.');
  for (const effect of binding.defaults ?? []) for (const instance of effect.instances) {
    // Existing owners keep ABI authority; only newly adopted defaults enter the draft.
    if (!added.has(instance.id)) continue;
    if (instances.has(instance.id)) throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Default identity conflicts with an ABS call.');
    instances.set(instance.id, { ...instance, start: effect.owner });
  }
  for (const [id, instance] of instances) {
    const block = blocks.get(id);
    if (!block || block.type !== instance.type) throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Native instance is not present in the reconciled workspace.');
  }
  const candidate = await prepareAbsReconciledResources(source, draft, assertCurrent);
  const materialized = await candidate.materialize();
  assertCurrent();
  const hydrated = indexAbsAbi(materialized);
  for (const [id, instance] of instances) assertAbsDeclaredBlockShape(hydrated.get(id)!, instance.shape);
  // Check the metadata/shadow merge, native loading and actual generator effects in
  // the disposable realm before the active workspace may execute any callbacks.
  const preparedModels = (binding.modelDeclarations ?? []).filter(effect =>
    !(modelState['variables'] as Array<{ id: string }> | undefined)?.some(model => model.id === effect.id));
  const verified = await run({ blocks: [], values: await captureAbsNativeValues(materialized, assertCurrent),
    verify: { state: materialized, contracts: candidate.contracts,
      ...(binding.modelDeclarations?.length ? { modelDeclarations: binding.modelDeclarations.map(effect => ({ ...effect, ownerId: identities.get(effect.start)! })) } : {}) } });
  assertAbsReadback(materialized, normalizeAbsSerializedWorkspace(verified.state), {
    fieldDefinition: (_type, name, id) => candidate.contracts.fields[id]?.[name],
  });
  return { candidate, materialized, instances, preparedModels };
}
