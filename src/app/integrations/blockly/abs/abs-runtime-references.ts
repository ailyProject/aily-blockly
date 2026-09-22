import * as Blockly from 'blockly';
import { AbsAbiWorkspace, AbsSyncError } from './abs-state';
import { absJson, indexAbsAbi } from './abs-identity-map';
import { AbsPageReferenceContract } from './abs-project-references';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';
import { captureAbsProcedureContracts } from './abs-runtime-procedures';
import { getAbsProcedureReferences } from './abs-procedures';
import { AbsSymbols } from './abs-symbols';
import { captureBundledProcedureRegistration } from '../../../editors/blockly-editor/components/blockly/plugins/block-plus-minus/src/procedures.js';
import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { captureAbsCustomFunctions } from './abs-custom-functions';

const nativeFields = new Set<unknown>([Blockly.FieldTextInput, Blockly.FieldNumber, Blockly.FieldCheckbox,
  Blockly.FieldDropdown, Blockly.FieldVariable, Blockly.FieldLabelSerializable]);
const blockKeys = new Set(['type', 'id', 'x', 'y', 'fields', 'inputs', 'next', 'extraState', 'collapsed',
  'deletable', 'movable', 'editable', 'enabled', 'disabled', 'disabledReasons', 'inline', 'shadow', 'data', 'icons']);
const nativeGetVars = Blockly.Block.prototype.getVars;
const nativeGetVarModels = Blockly.Block.prototype.getVarModels;

/** Complete coverage only for verified native fields and explicit procedure protocols.
 * Unknown serializers/extra state, hidden shadows and custom model capabilities need host adapters.
 */
export function captureAbsPageReferenceContract(
  workspace: Blockly.Workspace, serialized: AbsAbiWorkspace, assertCurrent: () => void, definitions?: DeclarativeBlockSnapshot,
): AbsPageReferenceContract {
  assertCurrent();
  definitions?.customFunctions?.prepareSerialization(workspace);
  const save = () => {
    const value = Blockly.serialization.workspaces.save(workspace);
    return { ...value, blocks: value['blocks'] ?? { blocks: [] } } as AbsAbiWorkspace;
  };
  const original = save();
  const originalText = absJson(original);
  try {
    const actualStates = indexAbsAbi(original);
    const states = indexAbsAbi(serialized);
    const fail = (message: string, id?: string): never => {
      throw new AbsSyncError('ABS_REFERENCE_CONTRACT_UNAVAILABLE', message, undefined, id ? [id] : []);
    };
    for (const key of new Set([...Object.keys(serialized), ...Object.keys(original)])) {
      if (key !== 'blocks' && key !== 'variables') fail(`Workspace serializer ${key} needs a reference adapter.`);
    }
    const variables = (state: AbsAbiWorkspace) => ((state['variables'] ?? []) as any[])
      .map(model => ({ ...model, type: model.type ?? '' })).sort((a, b) => a.id.localeCompare(b.id));
    if (states.size !== actualStates.size || absJson(variables(serialized)) !== absJson(variables(original))) {
      throw new AbsSyncError('ABS_REFERENCE_CAPTURE_CHANGED', 'Project snapshot does not match actual blocks/models.');
    }
    if (Object.keys(serialized.blocks).some(key => key !== 'blocks' && key !== 'languageVersion')) fail('Uncovered block serializer extension.');
    for (const model of (serialized['variables'] ?? []) as any[]) {
      if (Object.keys(model).some(key => !['id', 'name', 'type'].includes(key))) fail('Variable model extensions need a reference adapter.');
    }
    const runtime = captureAbsRuntimeContracts(workspace, serialized, assertCurrent, definitions);
    const bundled = captureBundledProcedureRegistration(Blockly.Blocks);
    const procedures = captureAbsProcedureContracts(workspace, serialized, assertCurrent, definitions);
    const custom = definitions && captureAbsCustomFunctions(definitions);
    runtime.contracts.procedures = procedures;
    const procedureRefs = getAbsProcedureReferences(serialized, procedures);
    const variableRefs = new Map<string, string[]>();
    const definitionRefs = new Map<string, string>();
    for (const ref of procedureRefs) {
      if (ref.kind === 'procedure') definitionRefs.set(ref.blockId, ref.modelId);
      else variableRefs.set(ref.blockId, [...(variableRefs.get(ref.blockId) ?? []), ref.modelId]);
    }
    const symbols = new AbsSymbols(serialized, serialized, runtime.contracts);
    const blockTypes: Record<string, string> = Object.create(null);
    const blockStates: Record<string, string> = Object.create(null);
    for (const [id, state] of states) {
      const block = workspace.getBlockById(id);
      if (!block) {
        fail('Serialized state has no identical live instance (including dormant shadows).', id);
      }
      if (block!.type !== state.type || absJson(actualStates.get(id)) !== absJson(state)) {
        throw new AbsSyncError('ABS_REFERENCE_CAPTURE_CHANGED', 'Project snapshot does not match the actual instance state.', undefined, [id]);
      }
      if (Object.keys(state).some(key => !blockKeys.has(key))) fail('Uncovered block serializer extension.', id);
      for (const connection of [...Object.values(state.inputs ?? {}), state.next].filter(Boolean)) {
        if (Object.keys(connection!).some(key => key !== 'block' && key !== 'shadow')) fail('Uncovered connection state.', id);
      }
      const procedure = procedures[id];
      const customShape = custom?.existing(state);
      if ((!procedure || customShape) && (block!.getVars !== nativeGetVars || block!.getVarModels !== nativeGetVarModels)) {
        fail('Custom variable getters need a reference adapter, even when currently empty.', id);
      }
      const extra = state.extraState;
      if (extra != null && !customShape) {
        if (typeof extra !== 'object' || Array.isArray(extra)) fail('Opaque mutator state needs a reference adapter.', id);
        const allowed = procedure?.role === 'definition' ? ['params', 'hasStatements'] : procedure ? ['name', 'params'] : [];
        if (Object.keys(extra).some(key => !allowed.includes(key))) fail('Uncovered mutator state.', id);
        if (procedure?.role === 'definition') {
          if (Object.hasOwn(extra as object, 'hasStatements') && typeof (extra as any).hasStatements !== 'boolean') fail('Invalid procedure statement flag.', id);
          for (const param of (extra as any).params ?? []) {
            const adapted = bundled.get(state.type)?.role === 'definition';
            if (Object.keys(param).some(key => key !== 'name' && key !== 'id' && !(adapted && key === 'argId'))
              || adapted && (typeof param.argId !== 'string' || state.fields?.[param.argId] !== param.name)) {
              fail('Uncovered procedure parameter state.', id);
            }
          }
        }
      }
      if ((state['data'] != null && state['data'] !== '') || state['icons'] != null) {
        fail('Opaque block data/icons need a reference adapter.', id);
      }
      const referenced = new Set<string>();
      for (const [name, value] of Object.entries(state.fields ?? {})) {
        const field = block!.getField(name);
        const definition = runtime.contracts.fields[id]?.[name];
        if (!field || !nativeFields.has(field.constructor) || !definition || definition.type === 'field_custom') {
          fail(`Field ${name} needs a reference adapter.`, id);
        }
        if (definition!.symbol) {
          if (value && typeof value === 'object' && Object.keys(value).some(key => !['id', 'name', 'type'].includes(key))) {
            fail('Uncovered variable field extension state.', id);
          }
          referenced.add(symbols.project(value, definition!.symbol!).modelId);
        }
      }
      const fieldReferences = new Set(referenced);
      for (const owner of [id, definitionRefs.get(id)]) {
        for (const variableId of variableRefs.get(owner ?? '') ?? []) referenced.add(variableId);
      }
      const models = block!.getVarModels();
      const runtimeReferences = customShape ? fieldReferences : referenced;
      if (!Array.isArray(models) || absJson([...new Set(models.map(model => model.getId()))].sort()) !== absJson([...runtimeReferences].sort())) {
        fail('Block model references are not fully represented by the captured fields/procedure paths.', id);
      }
      const variables = block!.getVars();
      const expectedVariables = procedure && !customShape ? models.map(model => model.name) : [...runtimeReferences];
      if (!Array.isArray(variables) || absJson([...new Set(variables)].sort()) !== absJson([...new Set(expectedVariables)].sort())) {
        fail('Block declares additional variable references requiring an adapter.', id);
      }
      blockTypes[id] = state.type;
      blockStates[id] = absJson(state);
      assertCurrent();
      bundled.assertCurrent();
    }
    return { complete: true, blockTypes, blockStates, serializers: [], contracts: runtime.contracts };
  } finally {
    assertCurrent();
    let current: string;
    try { current = absJson(save()); }
    catch { throw new AbsSyncError('ABS_REFERENCE_CAPTURE_CHANGED', 'Cannot verify workspace after reference capture.'); }
    if (originalText !== current) throw new AbsSyncError('ABS_REFERENCE_CAPTURE_CHANGED', 'Workspace changed while collecting reference contracts.');
    assertCurrent();
  }
}
