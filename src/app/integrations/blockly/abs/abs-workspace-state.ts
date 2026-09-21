import type * as Blockly from 'blockly';
import { AbsAbiWorkspace, AbsProjectionContracts, AbsSyncError } from './abs-state';
import { absJson, indexAbsAbi } from './abs-identity-map';
import { captureAbsRuntimeContracts } from './abs-runtime-contracts';
import { captureAbsProcedureContracts } from './abs-runtime-procedures';
import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';
import { loadAbsWorkspaceInChunks } from './abs-chunk-loader';
import type { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly-project-model';
import { AbsBlockShapeContract, assertAbsDeclaredBlockShape } from './abs-declarative-contracts';
import type { DeclarativeBlockSnapshot } from '../../../editors/blockly-editor/services/blockly-declarative-block-catalog';
import { orderAbsNativeFields } from './abs-native-field-order';
import type { AbsNativeInstance } from './abs-native-binding';
import { withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { sameAbsProgram } from './abs-program-state';

export interface AbsWorkspaceLoadOptions { chunk?: boolean; onProgress?: (blocks: number, batches: number) => void }

/** Native serialization boundary; the retained candidate is never passed to library callbacks. */
export async function loadAbsWorkspaceState(
  state: AbsAbiWorkspace, workspace: Blockly.WorkspaceSvg, options: AbsWorkspaceLoadOptions, assertCurrent: () => void,
  contracts?: AbsProjectionContracts,
): Promise<void> {
  const runtime = window['Blockly'] as typeof Blockly;
  assertCurrent();
  const detached = JSON.parse(absJson(state));
  orderAbsNativeFields(detached, contracts);
  runtime.Events.disable();
  try {
    if (options.chunk) await loadAbsWorkspaceInChunks(detached, workspace, options.onProgress, assertCurrent);
    else {
      withNativeStateLoading(runtime, workspace, detached, () => runtime.serialization.workspaces.load(detached, workspace));
      workspace.render?.();
    }
  } finally { runtime.Events.enable(); }
  assertCurrent();
}

export function captureAbsWorkspaceState(workspace: Blockly.Workspace, assertCurrent: () => void, definitions?: DeclarativeBlockSnapshot) {
  assertCurrent();
  const runtime = window['Blockly'] as typeof Blockly;
  definitions?.customFunctions?.prepareSerialization(workspace);
  const state = normalizeAbsSerializedWorkspace(runtime.serialization.workspaces.save(workspace));
  const original = absJson(state);
  const fields = captureAbsRuntimeContracts(workspace, state, assertCurrent, definitions);
  fields.contracts.procedures = captureAbsProcedureContracts(workspace, state, assertCurrent, definitions);
  assertCurrent();
  if (absJson(normalizeAbsSerializedWorkspace(runtime.serialization.workspaces.save(workspace))) !== original) {
    throw new AbsSyncError('ABS_RUNTIME_CAPTURE_CHANGED', 'Runtime contract getters changed the workspace.');
  }
  return { state, ...fields };
}

/** Existing instance contracts or explicitly prepared new shapes.
 * No probe block, field-name whitelist, guessed variable reference or another block's dropdown options.
 */
export function assertAbsRuntimeShapeSupported(
  before: AbsAbiWorkspace, candidate: AbsAbiWorkspace, contracts: AbsProjectionContracts,
  blockContract?: (type: string, extraState?: unknown, fields?: Readonly<Record<string, unknown>>) => AbsBlockShapeContract | undefined,
  nativeInstances?: ReadonlyMap<string, AbsNativeInstance>,
): void {
  const previous = indexAbsAbi(before);
  const shapeFor = (block: AbsAbiWorkspace['blocks']['blocks'][number]) => {
    const instance = nativeInstances?.get(block.id);
    if (instance && instance.type !== block.type) throw new AbsSyncError('ABS_NATIVE_BINDING_INVALID', 'Prepared native identity changed type.', undefined, [block.id]);
    return instance?.shape ?? blockContract?.(block.type, block.extraState, block.fields);
  };
  // Check known declarative connections without constructing a block. Unknown
  // dynamic connections still have to survive complete native readback.
  const accepts = (child: AbsAbiWorkspace['blocks']['blocks'][number], kind: 'value' | 'statement') => {
    const shape = shapeFor(child);
    if (shape && !(kind === 'value' ? shape.output : shape.previous)) {
      throw new AbsSyncError('ABS_RUNTIME_SHAPE_UNSUPPORTED', 'Prepared block has an incompatible connection.', undefined, [child.id]);
    }
  };
  for (const [id, block] of indexAbsAbi(candidate)) {
    const shape = shapeFor(block);
    if (shape) {
      for (const [name, input] of Object.entries(block.inputs ?? {})) {
        if (shape.inputs[name]) for (const child of [input.block, input.shadow]) if (child) accepts(child, shape.inputs[name]);
      }
      if (block.next?.block) accepts(block.next.block, 'statement');
    }
    const original = previous.get(id);
    const fail = () => { throw new AbsSyncError('ABS_RUNTIME_SHAPE_UNSUPPORTED',
      `${block.type}: New or reshaped blocks require a prepared runtime contract before loading.`, undefined, [id]); };
    if (nativeInstances?.has(id) || shape?.procedure || shape?.mutation || shape?.fieldShape) {
      if (original && original.type !== block.type) fail();
      assertAbsDeclaredBlockShape(block, shape!);
      continue;
    }
    if (!original) {
      const contract = shape;
      if (!contract) fail();
      assertAbsDeclaredBlockShape(block, contract!);
      continue;
    }
    if (!original || original.type !== block.type || absJson(original.extraState ?? null) !== absJson(block.extraState ?? null)) fail();
    const oldFields = original.fields ?? {}, fields = block.fields ?? {};
    if (contracts.selectors?.[id]?.some(name => absJson(oldFields[name] ?? null) !== absJson(fields[name] ?? null))) fail();
    const knownOrder = contracts.syntax?.[id];
    if (knownOrder) {
      const knownInputs = new Set(knownOrder.filter(arg => arg.kind !== 'field').map(arg => arg.name));
      if (Object.keys(block.inputs ?? {}).some(name => !knownInputs.has(name))) fail();
    }
    if (absJson(Object.keys(oldFields).sort()) !== absJson(Object.keys(fields).sort())) fail();
    for (const [name, value] of Object.entries(fields)) {
      if (absJson(value) !== absJson(oldFields[name]) && !contracts.fields[id]?.[name]) fail();
    }
  }
}

/** Complete workspace readback does not prove that other pages or document metadata survived. */
export function assertAbsProjectEnvelope(before: BlocklyProjectDocument, after: BlocklyProjectDocument, pageId: string): void {
  const envelope = (document: BlocklyProjectDocument) => {
    const { variables, procedureBlocks, ...sharedMetadata } = document.sharedModel;
    return { ...document, sharedModel: sharedMetadata, pages: document.pages.map(page => {
      if (page.id !== pageId) return page;
      // Active content/shared models are checked by complete native readback. Viewport
      // layout is UI-owned and may settle during rendering; other page metadata is not.
      const { content, viewState, ...metadata } = page;
      return metadata;
    }) };
  };
  if (!sameAbsProgram(envelope(before), envelope(after))) {
    throw new AbsSyncError('ABS_PROJECT_ENVELOPE_CHANGED', 'Applying ABS changed another page or unrelated project metadata.');
  }
}
