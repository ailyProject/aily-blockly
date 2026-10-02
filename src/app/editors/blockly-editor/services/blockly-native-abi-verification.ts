import type * as Blockly from 'blockly';
import type { NativeCandidateRequest, NativeCandidateResult } from './blockly-native-candidate-protocol';
import { createAbsReadbackVerifier } from '../../../integrations/blockly/abs/abs-readback';
import { normalizeAbsSerializedWorkspace } from '../../../integrations/blockly/abs/abs-serialized-workspace';
import { orderAbsNativeFields } from '../../../integrations/blockly/abs/abs-native-field-order';
import { withNativeStateLoading } from './blockly-native-state-loading';
import { prepareNativeProjectDataFields } from '@domain/project/project-data/public-api';
import type { PreparedDataReader } from '@domain/project/project-data/public-api';
import { NativeUiTasks, nativeUiSemanticSnapshot } from './blockly-native-ui-tasks';
import { captureArduinoGeneratedArtifacts } from './generated-code-artifacts';
import { verifyNativeModelRegistrations } from './blockly-native-model-effects';
import { captureGeneratorProjectEffects } from './generator-project-effects';
import { retainAbsRootLayout } from '../../../integrations/blockly/abs/abs-program-state';
import type { NativeCandidateProgress } from './blockly-native-progress';
import { layoutAbsNewRoots } from '../../../integrations/blockly/abs/abs-new-root-layout';
import { withNativeFieldDependencies } from './blockly-native-field-dependencies';

/** Complete merged state, including dormant shadows and metadata, not the scratch tree. */
export async function verifyNativeAbi(native: typeof Blockly, workspace: Blockly.Workspace,
  request: NonNullable<NativeCandidateRequest['verify']>, generator: Blockly.Generator | undefined,
  assertClean: () => void, readPrepared: PreparedDataReader, uiTasks = new NativeUiTasks(), progress: NativeCandidateProgress = () => {}): Promise<NativeCandidateResult> {
  const expected = structuredClone(request.state);
  const verify = createAbsReadbackVerifier(expected, { fieldDefinition: (_type, name, id) => request.contracts.fields[id]?.[name] });
  // Variable identities are explicit inputs; other serializers still need ownership.
  if (Object.keys(expected).some(key => !['blocks', 'variables', '$ailyProjectData'].includes(key))) throw new Error('Native ABI model/resource ownership is not prepared.');
  if (!generator) throw new Error('Native ABI verification requires the actual project generator.');
  const detached = structuredClone(expected);
  progress('load');
  orderAbsNativeFields(detached, request.contracts);
  withNativeFieldDependencies(native, workspace, () => withNativeStateLoading(native, workspace, detached,
    () => native.serialization.workspaces.load(detached, workspace)), uiTasks);
  assertClean();
  const capture = () => uiTasks.withoutScheduling(() => {
    const state = normalizeAbsSerializedWorkspace(native.serialization.workspaces.save(workspace));
    // Candidate graphics may settle their own layout. Only program semantics
    // are validated here; the host retains the latest editor layout at apply.
    // Normalize only this detached readback, never restore live positions here.
    retainAbsRootLayout(state, expected);
    assertClean();
    verify(state);
    return state;
  });
  capture();
  progress('resources');
  await prepareNativeProjectDataFields(workspace, readPrepared, assertClean);
  capture(); // Preparation cannot change serialized fields, blocks or models.
  // Match host placement BEFORE deferred callbacks. Never restore live positions
  // after UI settlement: that could hide a callback changing generation order.
  // Coordinates remain editor-owned; only the detached readback is normalized.
  if (request.newRootIds?.length) {
    const roots = new Set(expected.blocks.blocks.map(block => block.id));
    if (new Set(request.newRootIds).size !== request.newRootIds.length || request.newRootIds.some(id => !roots.has(id))) {
      throw new Error('Native new-root placement requires unique final root identities.');
    }
    layoutAbsNewRoots(structuredClone(expected), request.newRootIds, workspace as Blockly.WorkspaceSvg, assertClean, native);
    capture(); // Moving a block must not change fields, connections or models.
  }
  const deferredUi = uiTasks.hasPending;
  progress('ui');
  if (request.uiPhase !== 'before-ui') uiTasks.drain(() => nativeUiSemanticSnapshot(native, workspace));
  let generatedState: ReturnType<typeof capture> | undefined;
  const generate = () => uiTasks.withoutScheduling(() => {
    progress('generate');
    const code = generator.workspaceToCode(workspace);
    if (typeof code !== 'string') throw new Error('Native generator did not complete synchronously.');
    const artifacts = captureArduinoGeneratedArtifacts(generator);
    const projectMacros = captureGeneratorProjectEffects(generator, workspace);
    assertClean(); generatedState = capture(); return { code, artifacts, deferredUi: deferredUi || uiTasks.hasPending, projectMacros };
  });
  const generationEvidence = verifyNativeModelRegistrations(window, generator, request.modelDeclarations ?? [], generate);
  progress('ui');
  const settlesAfterGeneration = request.uiPhase !== 'before-ui' && uiTasks.hasPending;
  if (request.uiPhase !== 'before-ui') uiTasks.drain(() => nativeUiSemanticSnapshot(native, workspace));
  assertClean();
  progress('readback');
  // Generation already captured a complete verified state. Only intervening
  // callbacks require another capture; retain the independent second read to
  // detect serializer/getter side effects even when no callbacks were queued.
  const state = settlesAfterGeneration ? capture() : generatedState!;
  // Serialization/getters must not hide a deferred synchronous change on the first read.
  capture();
  return { state, structures: [], generationEvidence };
}
