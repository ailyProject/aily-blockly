import type * as Blockly from 'blockly';
import type { NativeCandidateRequest, NativeCandidateResult } from './blockly-native-candidate-protocol';
import { assertAbsReadback } from '../../../integrations/blockly/abs/abs-readback';
import { normalizeAbsSerializedWorkspace } from '../../../integrations/blockly/abs/abs-serialized-workspace';
import { orderAbsNativeFields } from '../../../integrations/blockly/abs/abs-native-field-order';
import { withNativeStateLoading } from './blockly-native-state-loading';
import { prepareNativeProjectDataFields } from '@domain/project/project-data/public-api';
import type { PreparedDataReader } from '@domain/project/project-data/public-api';
import { NativeUiTasks, nativeUiSemanticSnapshot } from './blockly-native-ui-tasks';
import { captureArduinoGeneratedArtifacts } from './generated-code-artifacts';
import { verifyNativeModelRegistrations } from './blockly-native-model-effects';

/** Complete merged state, including dormant shadows and metadata, not the scratch tree. */
export async function verifyNativeAbi(native: typeof Blockly, workspace: Blockly.Workspace,
  request: NonNullable<NativeCandidateRequest['verify']>, generator: Blockly.Generator | undefined,
  assertClean: () => void, readPrepared: PreparedDataReader, uiTasks = new NativeUiTasks()): Promise<NativeCandidateResult> {
  const expected = structuredClone(request.state);
  // Variable identities are explicit inputs; other serializers still need ownership.
  if (Object.keys(expected).some(key => !['blocks', 'variables', '$ailyProjectData'].includes(key))) throw new Error('Native ABI model/resource ownership is not prepared.');
  if (!generator) throw new Error('Native ABI verification requires the actual project generator.');
  const detached = structuredClone(expected);
  orderAbsNativeFields(detached, request.contracts);
  withNativeStateLoading(native, workspace, detached, () => native.serialization.workspaces.load(detached, workspace));
  assertClean();
  const capture = () => uiTasks.withoutScheduling(() => {
    const state = normalizeAbsSerializedWorkspace(native.serialization.workspaces.save(workspace));
    assertClean();
    assertAbsReadback(expected, state, { fieldDefinition: (_type, name, id) => request.contracts.fields[id]?.[name] });
    return state;
  });
  capture();
  await prepareNativeProjectDataFields(workspace, readPrepared, assertClean);
  capture(); // Preparation cannot change serialized fields, blocks or models.
  const deferredUi = uiTasks.hasPending;
  if (request.uiPhase !== 'before-ui') uiTasks.drain(() => nativeUiSemanticSnapshot(native, workspace));
  const generate = () => uiTasks.withoutScheduling(() => {
    const code = generator.workspaceToCode(workspace);
    if (typeof code !== 'string') throw new Error('Native generator did not complete synchronously.');
    const artifacts = captureArduinoGeneratedArtifacts(generator);
    assertClean(); capture(); return { code, artifacts, deferredUi };
  });
  const generationEvidence = verifyNativeModelRegistrations(window, generator, request.modelDeclarations ?? [], generate);
  assertClean();
  const state = capture();
  // Serialization/getters must not hide a deferred synchronous change on the first read.
  capture();
  return { state, structures: [], generationEvidence };
}
