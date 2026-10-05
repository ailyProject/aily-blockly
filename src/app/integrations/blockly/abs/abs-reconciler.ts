import { assertNoOversizedInlineValues, collectProjectDataPayloads } from '@domain/project/public-api';
import { AbsFieldDefinition, normalizeAbsSerializedField, resolveAbsFieldValue } from './abs-field-values';
import { serializeAbsFailure } from './abs-diagnostics';
import { absJson, indexAbsAbi, indexAbsSyntax } from './abs-identity-map';
import { assertAbsProtectedBlocks } from './abs-import-policy';
import { AbsSyntaxOptions, parseAbsSyntax } from './abs-syntax';
import { AbsAbiBlock, AbsAbiWorkspace, AbsProjection, AbsProjectionContracts, AbsSourceRange, AbsSyntaxNode, AbsSyncError, getAbsFieldDefinition } from './abs-state';
import { AbsSymbols } from './abs-symbols';
import { getAbsProcedureReferences } from './abs-procedures';
import type { AbsBlockShapeContract } from './abs-declarative-contracts';
import { AbsVariableCreationIntent, prepareAbsVariableCreations } from './abs-variable-intents';
import { absSyntaxOptions } from './abs-syntax-contracts';
import { prepareAbsStructuralSyntax } from './abs-structural-syntax';
import { absDeclarationRequestId, prepareAbsDeclarationIntents } from './abs-declaration-intents';
import type { VariableDeclarationContract } from '../../../editors/blockly-editor/services/blockly-variable-declaration-contract';
import type { AbsNativeBinding } from './abs-native-binding';
import { adoptAbsNativeDefaults } from './abs-native-defaults';
import { adoptAbsNativeModels } from './abs-native-model-declarations';
import type { AbsSourceEdits } from './abs-edit-provenance';
import { createAbsReconcileAnalysis, createAbsReconcileAnalysisFactory } from './abs-reconcile-analysis';
import { retireEmptyProjectModels } from './abs-empty-project-models';
import { copyAbsBlockForRebuild } from './abs-reconciled-block';

export interface AbsReconcileOptions extends AbsSyntaxOptions {
  /** Share declaration integrity checks only inside a pure synchronous traversal. */
  withSynchronousRead?: <T>(read: () => T) => T;
  /** Exact text-edit provenance, replayed against the immutable generation. */
  sourceEdits?: AbsSourceEdits;
  /** Pure definitions captured for this runtime session, never a global Blockly lookup. */
  fieldDefinition?: (blockType: string, fieldName: string, blockId?: string) => AbsFieldDefinition | undefined;
  newId?: (node: AbsSyntaxNode) => string;
  /** Internal native evidence for this exact source, never supplied by the Agent. */
  nativeBinding?: AbsNativeBinding;
  variableCreation?: AbsVariableCreationIntent;
  declaration?: (type: string) => VariableDeclarationContract | undefined;
  /** Host-owned prepared shape for new IDs, never inferred from another instance. */
  blockContract?: (type: string, extraState?: unknown, fields?: Readonly<Record<string, unknown>>) => AbsBlockShapeContract | undefined;
  /** Pure host adapter; may prepare only this detached block, never live state. */
  prepareBlock?: (block: AbsAbiBlock, previous: AbsAbiBlock | undefined, workspace: AbsAbiWorkspace, contracts: AbsProjectionContracts) => void;
  /** Exact captured adapter coverage. Absent means unknown; false skips only the
   * host adapter, never native execution or final ABI verification. */
  hostPrepared?: (type: string) => boolean;
}
export interface AbsReconcileResult {
  workspace: AbsAbiWorkspace;
  retained: string[];
  added: string[];
  removed: string[];
}

export interface AbsLiteralBinding extends AbsSourceRange { jsonPointer: string }
/** Unprepared payloads: may contain large inline values. Never load/save this draft directly. */
export interface AbsReconcileDraft extends AbsReconcileResult {
  /** Host-owned removal evidence, not a caller-supplied model deletion intent. */
  retiredModels?: string[];
  identities: Array<{ start: number; id: string }>;
  literals: AbsLiteralBinding[];
  /** Newly adopted native defaults have no source literals, including nested payloads. */
  implicitBlockIds?: string[];
  /** Known baseline protocols plus explicit field definitions used for this candidate; not complete runtime coverage. */
  contracts: AbsProjectionContracts;
}

/** Strict pure entrypoint. Only the resource coordinator may consume the unprepared draft. */
export async function reconcileAbs(
  baseline: AbsProjection, editedAbs: string, options: AbsReconcileOptions = {},
): Promise<AbsReconcileResult> {
  const { literals, implicitBlockIds, retiredModels, contracts, identities, ...result } = await reconcileAbsDraft(baseline, editedAbs, options);
  assertNoOversizedInlineValues(result.workspace);
  return result;
}

/**
 * Merge against a host-owned baseline. Retain proven identities; rebuild ordinary
 * unmatched calls atomically. Hidden-state policy and native validation stay separate.
 */
export async function reconcileAbsDraft(
  baseline: AbsProjection,
  editedAbs: string,
  options: AbsReconcileOptions = {},
): Promise<AbsReconcileDraft> {
  return createAbsReconciler(baseline, editedAbs).draft(options);
}

/** Fixed baseline/source, no trust flag or external cache. Native identity replay
 * may reuse only pure analysis; every pass rebuilds its own draft and contracts. */
export function createAbsReconciler(baseline: AbsProjection, source: string) {
  return reconciler(createAbsReconcileAnalysis(baseline, source), source);
}

/** Service-owned, pure cross-candidate reuse. Runtime callbacks and all mutable
 * drafts remain transaction-owned, regardless of a baseline-analysis cache hit. */
export function createAbsReconcilerFactory() {
  const analyze = createAbsReconcileAnalysisFactory();
  return (baseline: AbsProjection, source: string, scope: string) => reconciler(analyze(baseline, source, scope), source);
}

function reconciler(analysis: ReturnType<typeof createAbsReconcileAnalysis>, source: string) {
  return Object.freeze({ source, snapshot: analysis.snapshot,
    draft: (options: AbsReconcileOptions = {}) => reconcileDraft(analysis, source, options) });
}

async function reconcileDraft(
  analysis: ReturnType<typeof createAbsReconcileAnalysis>, editedAbs: string, options: AbsReconcileOptions,
): Promise<AbsReconcileDraft> {
  // Detach before awaiting; mutable caller state cannot race baseline validation.
  const baseline = analysis.snapshot();
  options = { ...options };
  const variableCreation = options.variableCreation ? JSON.parse(absJson(options.variableCreation)) : undefined;
  const nativeBinding = options.nativeBinding ? structuredClone(options.nativeBinding) : undefined;
  const sourceEdits = options.sourceEdits ? structuredClone(options.sourceEdits) : undefined;
  if (nativeBinding && nativeBinding.source !== editedAbs) throw new AbsSyncError('ABS_NATIVE_BINDING_STALE', 'Native binding belongs to different ABS bytes.');
  await analysis.validate();
  const readDefinitions = options.withSynchronousRead ?? (<T>(read: () => T) => read());
  const candidate: AbsAbiWorkspace = JSON.parse(absJson(baseline.workspace));
  const retiredModels = editedAbs !== baseline.abs ? retireEmptyProjectModels(baseline, candidate, editedAbs) : [];
  prepareAbsVariableCreations(candidate, variableCreation);
  if (editedAbs === baseline.abs && !sourceEdits) {
    return { workspace: candidate, literals: [], identities: [], contracts: baseline.contracts,
      added: [], removed: [], retained: [...indexAbsAbi(baseline.workspace).keys()] };
  }
  const syntax = absSyntaxOptions(baseline.workspace, baseline.contracts, {
    ...options,
    prepareExtraState: node => {
      const prepared = options.prepareExtraState?.(node);
      if (prepared !== undefined) return prepared;
      const shape = options.blockContract?.(node.type);
      return prepareAbsStructuralSyntax(node, shape?.mutation, shape?.argumentOrder);
    },
  });
  // Pure syntax adapters may return object-valued state. Own it before the
  // asynchronous matcher so callbacks cannot mutate cached evidence in flight.
  const edited = readDefinitions(() => nativeBinding?.syntax ?? structuredClone(parseAbsSyntax(editedAbs, syntax)));
  const newEntries = indexAbsSyntax(edited);
  const nativeInstances = new Map(nativeBinding?.instances.map(instance => [instance.start, instance]));
  const hostCalls = new Map(nativeBinding?.hostCalls?.map(call => [call.start, call]));
  if (nativeBinding && (nativeInstances.size !== nativeBinding.instances.length
    || hostCalls.size !== (nativeBinding.hostCalls?.length ?? 0)
    || nativeInstances.size + hostCalls.size !== newEntries.length
    || newEntries.some(({ node }) => {
      const hosted = hostCalls.get(node.start), native = nativeInstances.get(node.start);
      return hosted ? !!native || hosted.type !== node.type || !options.prepareBlock || !options.hostPrepared?.(node.type)
        : !native || native.type !== node.type;
    }))) throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Each call requires native evidence or a captured host preparation adapter.');
  const abiBlocks = indexAbsAbi(baseline.workspace);
  const { matches, originalIds, identity } = await analysis.match(edited, sourceEdits);

  const contracts = baseline.contracts;
  if (options.declaration) {
    const requestId = await absDeclarationRequestId(baseline.map.generation, editedAbs);
    readDefinitions(() => prepareAbsDeclarationIntents(edited, candidate, node => {
      const old = matches.get(node);
      return old ? abiBlocks.get(originalIds.get(old)!) : undefined;
    }, options.declaration!, requestId));
  }
  for (const effect of nativeBinding?.modelDeclarations ?? []) {
    const owner = newEntries.find(({ node }) => node.start === effect.start && node.type === effect.blockType && !node.disabled)?.node;
    if (!owner) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_UNOWNED', 'A model declaration has no matching active ABS producer.');
    }
    if (matches.has(owner) && !(candidate['variables'] as Array<{ id: string }> | undefined)?.some(model => model.id === effect.id)) {
      throw new AbsSyncError('ABS_MODEL_DECLARATION_RENAME_UNSUPPORTED', 'A retained initializer cannot implicitly introduce a replacement model. Preserve its name/type or use an explicit model operation.', owner);
    }
  }
  adoptAbsNativeModels(candidate, nativeBinding?.modelDeclarations);
  const symbols = new AbsSymbols(candidate, baseline.document, baseline.contracts);
  const ids = new Set(abiBlocks.keys());
  const added: string[] = [];
  const retained: string[] = [];
  const sources = new Map<string, AbsSyntaxNode>();
  const defaultIds = new Set<string>();
  const build = (node: AbsSyntaxNode, root: boolean): AbsAbiBlock => {
    const matched = matches.get(node);
    const previous = matched ? abiBlocks.get(originalIds.get(matched)!)! : undefined;
    const id = previous?.id ?? (options.newId ?? (() => crypto.randomUUID()))(node);
    if (!previous && (!id || ids.has(id))) throw new AbsSyncError('ABS_DUPLICATE_ID', 'New block ID is not unique.', node, [id]);
    ids.add(id);
    sources.set(id, node);
    (previous ? retained : added).push(id);
    const nativeInstance = nativeInstances.get(node.start);
    if (nativeBinding && !nativeInstance && !hostCalls.has(node.start)) throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Native instance does not match this call.', node);
    const prepareBlock = options.prepareBlock && options.hostPrepared?.(node.type) !== false ? options.prepareBlock : undefined;
    const block: AbsAbiBlock = previous
      ? prepareBlock ? JSON.parse(absJson(previous)) : copyAbsBlockForRebuild(previous)
      : { ...structuredClone(nativeInstance?.seed), type: node.type, id };
    if (node.disabled !== (matched?.disabled ?? false)) {
      throw new AbsSyncError('ABS_STATE_EDIT_REQUIRES_HOST', 'Change disabled state through an explicit host operation.', node, [id]);
    }
    const declaredShape = options.blockContract?.(node.type, node.extraState, Object.fromEntries(Object.entries(node.fields).map(([name, token]) => [name, token.value])));
    const preparedShape = nativeInstance?.shape ?? (!previous || declaredShape?.mutation || declaredShape?.fieldShape ? declaredShape : undefined);
    // Only a per-call native execution can remove fields after a configuration change.
    // Retained fields keep their opaque persisted state unless explicitly edited below.
    block.fields = { ...(preparedShape?.defaults ?? {}), ...Object.fromEntries(Object.entries(block.fields ?? {})
      .filter(([name]) => !nativeInstance || Object.hasOwn(nativeInstance.shape.fields, name))) };
    if (preparedShape) setJsonMember(contracts.fields, id, JSON.parse(absJson(preparedShape.fields)));
    if (preparedShape?.argumentOrder) setJsonMember(contracts.syntax ??= Object.create(null), id, preparedShape.argumentOrder);
    if (preparedShape?.fieldShape) setJsonMember(contracts.selectors ??= Object.create(null), id, [...new Set(preparedShape.fieldShape.map(rule => rule.field))]);
    if (nativeInstance && contracts.selectors) delete contracts.selectors[id];
    for (const [name, token] of Object.entries(node.fields)) {
      // Formatting or another field's edit cannot rewrite an unchanged persisted value.
      const originalToken = matched?.fields[name];
      try {
        const definition = preparedShape?.fields[name] ?? options.fieldDefinition?.(node.type, name, previous?.id)
          ?? (previous ? getAbsFieldDefinition(baseline.contracts, previous.id, name) : undefined);
        if (token.reference && definition?.symbol?.kind !== 'variable') throw new Error('$ references require a variable field.');
        if (definition) {
          if (!Object.hasOwn(contracts.fields, id)) setJsonMember(contracts.fields, id, {});
          setJsonMember(contracts.fields[id], name, JSON.parse(absJson(definition)));
        }
        if (originalToken && absJson(token.value) === absJson(originalToken.value)) continue;
        const value = definition?.symbol
          ? symbols.resolve(token, definition.symbol, previous?.fields?.[name])
          : resolveAbsFieldValue(token, definition);
        setJsonMember(block.fields, name, definition?.type === 'field_checkbox' ? normalizeAbsSerializedField(value, definition) : value);
      } catch (error) {
        const failure = serializeAbsFailure(error);
        throw new AbsSyncError(error instanceof AbsSyncError ? error.code : 'ABS_FIELD_INVALID',
          `${node.type}.${name}: ${failure.message}`, node.fieldRanges[name] ?? node, [id],
          { ...failure.diagnostic, blockType: node.type, field: name });
      }
    }
    if (Object.hasOwn(node, 'extraState')) block.extraState = node.extraState;
    // Native execution already verified the hydrated explicit extraState. Keep
    // its source envelope here; shape equality belongs after materialization.
    if (nativeInstance ? !Object.hasOwn(node, 'extraState') : preparedShape?.mutation || preparedShape?.fieldShape) {
      if (preparedShape.extraState === undefined) delete block.extraState;
      else block.extraState = preparedShape.extraState;
    }
    prepareBlock?.(block, previous, candidate, contracts);
    const defaultInputs = previous ? new Set<string>() : adoptAbsNativeDefaults(nativeBinding, node, block, { ids, contracts, added, defaultIds });
    const inputs = { ...block.inputs };
    for (const name of new Set([...Object.keys(inputs), ...Object.keys(node.inputs)])) {
      if (defaultInputs.has(name)) continue;
      const originalInput = Object.hasOwn(inputs, name) ? inputs[name] : undefined;
      const child = node.inputs[name];
      if (preparedShape && !Object.hasOwn(preparedShape.inputs, name) && !child) {
        // An explicit, proven shape change removes the slot itself, including its
        // dormant shadow. Ordinary disconnection must still preserve that shadow.
        delete inputs[name]; continue;
      }
      if (child) {
        const next = build(child, false);
        // A visible shadow stays a shadow only while its original identity remains.
        if (!originalInput?.block && originalInput?.shadow?.id === next.id) setJsonMember(inputs, name, { ...originalInput, shadow: next });
        else setJsonMember(inputs, name, { ...originalInput, block: next });
      } else if (originalInput?.block && originalInput.shadow) {
        const { block: removed, ...fallback } = originalInput;
        setJsonMember(inputs, name, fallback);
      } else if (originalInput?.shadow) {
        // Removing a visible shadow is not a reliable instruction to delete a
        // default connection: require a shape/state operation instead.
        throw new AbsSyncError('ABS_CONNECTION_EDIT_REQUIRES_HOST', 'Cannot silently remove a fallback shadow.', node, [id]);
      } else if (!originalInput || originalInput.block || !Object.hasOwn(node.inputs, name)) delete inputs[name];
    }
    if (Object.keys(inputs).length) block.inputs = inputs;
    else delete block.inputs;
    if (node.next) block.next = { ...block.next, block: build(node.next, false) };
    else delete block.next;
    if (!root) { delete block['x']; delete block['y']; }
    else if (!previous) { block['x'] = 30; block['y'] = 30 + added.length * 100; }
    if (!Object.keys(block.fields).length && !previous?.fields) delete block.fields;
    return block;
  };
  candidate.blocks.blocks = readDefinitions(() => edited.map(node => build(node, true)));
  assertAbsProtectedBlocks(baseline.workspace, candidate);
  getAbsProcedureReferences(candidate, baseline.contracts.procedures);
  const afterIds = indexAbsAbi(candidate);
  identity.assertReferencesPreserved(afterIds);
  // Use the same payload traversal as resource externalization: no second ABI graph walker.
  const literals: AbsLiteralBinding[] = [];
  for (const payload of collectProjectDataPayloads(candidate)) {
    const node = sources.get(payload.blockId ?? '');
    const range = payload.fieldName !== undefined ? node?.fieldRanges[payload.fieldName]
      : payload.key === 'extraState' ? node?.extraRange : undefined;
    if (range) literals.push({ ...range, jsonPointer: payload.jsonPointer });
  }
  return { workspace: candidate, literals, ...(retiredModels.length ? { retiredModels } : {}), ...(defaultIds.size ? { implicitBlockIds: [...defaultIds] } : {}), contracts, identities: [...sources].map(([id, node]) => ({ start: node.start, id })),
    added, retained, removed: [...abiBlocks.keys()].filter(id => !afterIds.has(id)) };
}

function setJsonMember(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
