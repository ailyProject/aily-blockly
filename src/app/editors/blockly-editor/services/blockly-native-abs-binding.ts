import type * as Blockly from 'blockly';
import { readAbsSyntax } from '../../../integrations/blockly/abs/abs-syntax';
import { bindAbsSyntax, type AbsSyntaxOptions } from '../../../integrations/blockly/abs/abs-syntax-binding';
import { nativeAbsArgumentOrder } from '../../../integrations/blockly/abs/abs-native-arguments';
import { parseBlockDefinition } from '../../../integrations/blockly/abs/block-definition.model';
import { normalizeAbsSerializedField, resolveAbsFieldValue } from '../../../integrations/blockly/abs/abs-field-values';
import { AbsSyncError, type AbsSyntaxNode } from '../../../integrations/blockly/abs/abs-state';
import { serializeAbsFailure } from '../../../integrations/blockly/abs/abs-diagnostics';
import { captureAbsFieldContract } from '../../../integrations/blockly/abs/abs-runtime-field-contract';
import type { NativeCandidateWorkspace } from './blockly-native-candidate-workspace';
import type { AbsNativeBlock, AbsNativeDefault } from '../../../integrations/blockly/abs/abs-native-binding';
import { captureNativeBlock } from './blockly-native-instance';
import type { NativeCandidateRequest, NativeCandidateResult } from './blockly-native-candidate-protocol';
import { indexAbsAbi } from '../../../integrations/blockly/abs/abs-abi-index';
import { normalizeAbsSerializedWorkspace } from '../../../integrations/blockly/abs/abs-serialized-workspace';
import { absJson } from '../../../integrations/blockly/abs/abs-json';
import { prepareAbsStructuralSyntax } from '../../../integrations/blockly/abs/abs-structural-syntax';
import { captureStructuralMutators } from '../components/blockly/plugins/block-plus-minus/src/structural-mutators';
import { prepareNativeModels } from './blockly-native-model-preparation';
import { nativeFieldDependencies } from './blockly-native-field-dependencies';
import { inactiveAbsSyntax } from '../../../integrations/blockly/abs/abs-native-preservation';
import { NativeFieldConfiguration } from './blockly-native-field-configuration';

/** Native binding has no library/shape templates. Only the shared grammar knows ABS spelling. */
export function bindNativeAbs(source: string, execution: NativeCandidateWorkspace, declarations: Map<string, Record<string, any>>,
  identities?: NativeCandidateRequest['identities'], hydrate: <T>(value: T) => T = value => value,
  hostCalls: NonNullable<NativeCandidateRequest['hostCalls']> = [],
  modelPreparation?: { generator: Blockly.Generator; requestId: string; retainedCalls?: number[]; retainedIds?: string[] }): () => NativeCandidateResult {
  // Parse the complete document before executing any block callback.
  const raw = readAbsSyntax(source);
  const structural = captureStructuralMutators();
  const blocks = new Map<AbsSyntaxNode, Blockly.Block>();
  const assigned = identities && new Map(identities.map(item => [item.start, item.id]));
  const hosted = new Map(hostCalls.map(call => [call.start, call]));
  const consumed = new Set<number>();
  const fallbacks: AbsNativeDefault[] = [];
  const pending = new Map<Blockly.Block, AbsSyntaxNode>();
  let bindingReferences = false;
  const conflicts: AbsSyncError[] = [];
  const configured = new Map<Blockly.Block, NativeFieldConfiguration>();
  const capture = (block: Blockly.Block, seed: AbsNativeBlock['seed']) => captureNativeBlock(execution, declarations, block, seed);
  // Replay owns these detached declarations and registration is already closed.
  // Reuse only their parsed syntax within this binding, not live field contracts,
  // native structure, generator effects or another candidate's results.
  const metadata = new Map<string, ReturnType<typeof parseBlockDefinition>>();
  const declared = (type: string) => {
    if (!metadata.has(type)) metadata.set(type, parseBlockDefinition(declarations.get(type), ''));
    return metadata.get(type);
  };
  const options: AbsSyntaxOptions = {
    prepareExtraState: node => {
      const host = hosted.get(node.start);
      if (host) return host.extraState;
      const definition = declarations.get(node.type);
      const recipe = typeof definition?.['mutator'] === 'string' ? structural.get(definition['mutator']) : undefined;
      return prepareAbsStructuralSyntax(node, recipe, declared(node.type)?.argsOrder);
    },
    argumentOrder: type => declared(type)?.argsOrder,
    fieldDefinition: (type, name) => declared(type)?.fieldDefinitions?.get(name),
  };
  const create = (node: AbsSyntaxNode) => {
    consumed.add(node.start);
    const id = assigned ? assigned.get(node.start) : `abs-candidate-${node.start}`;
    if (!id) throw new Error('Native candidate identity is missing for an ABS call.');
    const block = execution.create({ id, type: node.type, fields: [],
      ...(Object.hasOwn(node, 'extraState') ? { extraState: hydrate(node.extraState) } : {}) }, node.start);
    blocks.set(node, block);
    // Shape binding does not apply @disabled. The existing ABI/map merge validates and
    // preserves its original reason set; final ABI verification checks the real state.
    return block;
  };
  const applyField = (block: Blockly.Block, name: string, token: AbsSyntaxNode['fields'][string], replaced = false) => {
    const field = block.getField(name);
    if (!field) throw new Error(`Native field is unavailable: ${name}.`);
    // saveState on an unconfigured FieldVariable creates a default model. Resolve
    // the requested symbol first; do not create then adopt/delete an incidental model.
    const definition = captureAbsFieldContract(field, field instanceof execution.native.FieldVariable ? undefined : field.saveState());
    const hydrated = hydrate(token.value);
    const resolvedToken = absJson(hydrated) === absJson(token.value) ? token
      : { raw: JSON.stringify(hydrated), value: hydrated, quoted: typeof hydrated === 'string' };
    const value = normalizeAbsSerializedField(definition.symbol ? execution.models.resolve(token, definition) : resolveAbsFieldValue(resolvedToken, definition), definition);
    execution.field(block, name, value, replaced);
  };
  const fieldFailure = (error: unknown, block: Blockly.Block, node: AbsSyntaxNode, name: string,
    token: AbsSyntaxNode['fields'][string], replaced: boolean, deferOptions = !bindingReferences) => {
    const dependencies = nativeFieldDependencies(execution.workspace);
    if (dependencies && deferOptions && error instanceof AbsSyncError && error.code === 'ABS_FIELD_OPTION_INVALID') {
      dependencies.defer(block, name, () => setField(block, node, name, token, replaced)); return;
    }
    if (modelPreparation && !bindingReferences && error instanceof AbsSyncError && error.code === 'ABS_SYMBOL_MISSING') {
      pending.set(block, node); return;
    }
    const failure = serializeAbsFailure(error);
    const located = new AbsSyncError(failure.code, failure.message, node.fieldRanges[name] ?? { start: node.start, end: node.end }, [],
      { ...failure.diagnostic, blockType: block.type, field: name });
    if (!bindingReferences && failure.code === 'ABS_SYMBOL_TYPE_MISMATCH') { conflicts.push(located); return; }
    throw located;
  };
  const setField = (block: Blockly.Block, node: AbsSyntaxNode, name: string, token: AbsSyntaxNode['fields'][string], replaced = false) => {
    try { applyField(block, name, token, replaced); }
    catch (error) { fieldFailure(error, block, node, name, token, replaced); }
  };
  const configureFields = (block: Blockly.Block, node: AbsSyntaxNode, complete = false, deferOptions = !bindingReferences) => {
    let fields = configured.get(block);
    if (!fields) configured.set(block, fields = new NativeFieldConfiguration(block));
    const failures = new Map<string, AbsSyncError>();
    const deferred = fields.restore(node.fields, () => {
      const trace = execution.observer.readNativeBlockStructure(block);
      return trace && nativeAbsArgumentOrder(execution.observer.readNativeBlockJson(block) ?? declarations.get(node.type) ?? { type: node.type }, trace)
        ?.filter(argument => argument.kind === 'field').map(argument => argument.name);
    }, (name, token, replaced) => {
      try { applyField(block, name, token, replaced); failures.delete(name); }
      catch (error) {
        // These may become valid after later selectors or model declarations.
        if (error instanceof AbsSyncError && (error.code === 'ABS_FIELD_OPTION_INVALID' || error.code === 'ABS_SYMBOL_MISSING')) {
          failures.set(name, error); throw error;
        }
        fieldFailure(error, block, node, name, token, replaced);
      }
    },
      error => error instanceof AbsSyncError && (error.code === 'ABS_FIELD_OPTION_INVALID' || error.code === 'ABS_SYMBOL_MISSING'));
    const missingModel = deferred.find(name => failures.get(name)?.code === 'ABS_SYMBOL_MISSING');
    if (complete) {
      // A real unresolved model selector may create/replace the other fields.
      // Resume this same instance worklist after registration, not a lone setter.
      if (missingModel && modelPreparation && !bindingReferences) { pending.set(block, node); return { deferred, missingModel }; }
      // Report the actual missing model before secondary not-yet-created fields.
      if (missingModel) fieldFailure(failures.get(missingModel)!, block, node, missingModel,
        node.fields[missingModel], fields.hasApplied(missingModel), deferOptions);
      for (const name of deferred) {
        const error = failures.get(name);
        if (error) fieldFailure(error, block, node, name, node.fields[name], fields.hasApplied(name), deferOptions);
        else setField(block, node, name, node.fields[name], fields.hasApplied(name));
      }
    }
    return { deferred, missingModel };
  };
  const materialize = (node: AbsSyntaxNode): Blockly.Block => {
    const existing = blocks.get(node);
    if (existing) return existing;
    // The shared value-input fallback produces literal/variable blocks, never guessed slot names.
    const block = create(node);
    configureFields(block, node, true);
    return block;
  };
  const syntax = bindAbsSyntax(raw, options, node => {
    const host = hosted.get(node.start);
    if (host) {
      if (host.type !== node.type || assigned && !assigned.has(node.start)) throw new Error('Host binding does not match this ABS call.');
      consumed.add(node.start);
      return { argumentOrder: () => host.argumentOrder, input: (_name, child) => {
        // Literal shorthand has no createBinding callback, so materialize it once.
        if (child && !hosted.has(child.start)) materialize(child);
      } };
    }
    const block = create(node);
    return {
      argumentOrder: () => {
        const trace = execution.observer.readNativeBlockStructure(block);
        execution.assertClean();
        return trace && nativeAbsArgumentOrder(execution.observer.readNativeBlockJson(block) ?? declarations.get(node.type) ?? { type: node.type }, trace);
      },
      field: () => configureFields(block, node),
      fieldsComplete: () => configureFields(block, node, true),
      // Cross-boundary edges are checked by loading the complete merged ABI, not
      // by creating a surrogate model block inside the discovery workspace.
      input: (name, child) => {
        if (child && hosted.has(child.start)) return;
        try {
          execution.connect(block, name, child ? materialize(child) : null, snapshot => {
            fallbacks.push({ owner: node.start, input: name, state: { shadow: snapshot.state }, instances: snapshot.instances, fallback: true });
          });
        } catch (error) {
          const failure = serializeAbsFailure(error), location = child ?? node;
          throw new AbsSyncError(failure.code, failure.message, failure.range ?? { start: location.start, end: location.end }, [], failure.diagnostic);
        }
      },
    };
  });
  // Collect known type conflicts across the candidate before invoking generators.
  // The disposable workspace is discarded; no invalid reference is serialized/applied.
  if (conflicts.length) {
    const first = conflicts[0];
    const distinct = [...new Map(conflicts.map(error => [JSON.stringify(error.diagnostic), error.diagnostic!])).values()];
    throw new AbsSyncError(first.code, first.message, first.range, [], { ...first.diagnostic, conflicts: distinct });
  }
  bindingReferences = true;
  const resolvePending = () => {
    for (const [block, node] of pending) {
      if (configureFields(block, node).missingModel) continue;
      pending.delete(block);
      configureFields(block, node, true, true);
    }
    const dependencies = nativeFieldDependencies(execution.workspace);
    if (!pending.size) dependencies?.settle(false);
    return new Set([...pending.keys(), ...dependencies?.blocks ?? []]);
  };
  const modelDeclarations = modelPreparation ? prepareNativeModels(execution, modelPreparation.generator, blocks,
    resolvePending, modelPreparation.requestId, { ...modelPreparation, inactiveNodes: inactiveAbsSyntax(syntax) }) : [];
  for (const [block, node] of pending) configureFields(block, node, true);
  if (assigned && assigned.size !== consumed.size || hostCalls.some(call => !consumed.has(call.start))) throw new Error('Native candidate identities or host bindings contain unused calls.');
  structural.assertCurrent();
  return () => {
    // The response and its binding share this first complete readback. No callback
    // intervenes between them. Still independently read again after all contract
    // getters, so their mutations cannot be accepted as the candidate baseline.
    const result = execution.result();
    const state = normalizeAbsSerializedWorkspace(result.state);
    const saved = indexAbsAbi(state);
    const hidden = execution.shadows.verify(state, execution.workspace.getAllBlocks(false));
    const captureInput = (input: AbsNativeDefault['state']) => [...indexAbsAbi({ blocks: {
      blocks: [input.block, input.shadow].filter((item): item is AbsNativeBlock['seed'] => !!item),
    } }).values()].map(entry => {
      const block = execution.workspace.getBlockById(entry.id);
      const instance = block ? capture(block, entry) : hidden.get(entry.id);
      if (!instance) throw new Error('Native default lost instance evidence.');
      return instance;
    });
    const instances = [...blocks].map(([node, block]) => ({ ...capture(block, saved.get(block.id)!), start: node.start }));
    // A later field callback can replace the fallback after explicit connection.
    // Current native connection state supersedes the earlier retired snapshot.
    for (const [node, block] of blocks) for (const [input, child] of Object.entries(node.inputs)) {
      const shadow = saved.get(block.id)!.inputs?.[input]?.shadow;
      if (!child || !shadow) continue;
      const effect: AbsNativeDefault = { owner: node.start, input, state: { shadow }, instances: captureInput({ shadow }), fallback: true };
      const previous = fallbacks.findIndex(item => item.owner === node.start && item.input === input);
      if (previous < 0) fallbacks.push(effect); else fallbacks[previous] = effect;
    }
    const defaults = [...fallbacks, ...execution.defaultInputs().map(({ owner, input }) => {
      const state = structuredClone(saved.get(instances.find(instance => instance.start === owner)!.id)!.inputs![input]);
      return { owner, input, state, instances: captureInput(state) };
    })];
    execution.assertClean();
    structural.assertCurrent();
    // Contract getters must not change what was just checked.
    if (absJson(normalizeAbsSerializedWorkspace(execution.result().state)) !== absJson(state)) throw new Error('Native contract getters changed candidate state.');
    return { ...result, binding: { source, syntax, instances, ...(modelDeclarations.length ? { modelDeclarations } : {}), ...(hostCalls.length ? { hostCalls: structuredClone(hostCalls) } : {}),
      ...(execution.creations.entries.length ? { creations: structuredClone(execution.creations.entries) } : {}),
      ...(defaults.length ? { defaults } : {}) } };
  };
}
