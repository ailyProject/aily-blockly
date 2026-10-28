import { ProjectDataStore, type ProjectSaveOutcome, type AilyDataRef, type PutProjectDataRequest } from '@domain/project/public-api';
import { prepareBlocklySave } from '../../../editors/blockly-editor/services/prepared-project-save';
import { writePreparedArduinoGeneratedArtifacts } from '../../../editors/blockly-editor/services/generated-code-artifacts';
import { publishGeneratorMacros } from '../../../editors/blockly-editor/services/prepared-generator-config';
import type { PreparedBlocklyCode } from '../../../editors/blockly-editor/services/prepared-project-code';
import type { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly.service';
import { AbsBaselineStore, absBaselineKey } from './abs-baseline-store';
import { openAbsHostStorage } from './abs-host-storage';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { prepareAbsProjectData } from './abs-project-data';
import { composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { AbsSyncError, type AbsProjectionContracts } from './abs-state';

export interface AbsSaveAsCapture {
  documentText: string;
  abiShapeText: string;
  contractsText: string;
  generated: PreparedBlocklyCode | null;
}

/** The destination owns all writes, including resource externalization and a fresh baseline. */
export async function publishAbsSaveAs(targetPath: string, capture: AbsSaveAsCapture,
  assertCurrent: () => void): Promise<ProjectSaveOutcome> {
  assertCurrent();
  const document = JSON.parse(capture.documentText) as BlocklyProjectDocument;
  const data = new ProjectDataStore(); data.configure(targetPath);
  const runtime = { put: <T>(request: PutProjectDataRequest<T>) => data.put(request), flushPending: () => data.flushPending(),
    getStore: () => data, resolve: <T>(ref: AilyDataRef) => data.resolve<T>(ref), prepareValue: async value => {
      const result = await data.validateReferences(data.collectReferences(value));
      assertCurrent();
      if (!result.valid) throw new AbsSyncError('ABS_RESOURCE_MISSING', 'Save As resources are incomplete in the destination.');
    } };
  const prepared = await prepareBlocklySave(document, () => JSON.parse(capture.abiShapeText), assertCurrent, runtime);
  const compact = await prepareAbsProjectData(document, assertCurrent, runtime);
  const contracts = JSON.parse(capture.contractsText) as AbsProjectionContracts;
  const generation = crypto.randomUUID(), scope = { projectKey: targetPath, pageId: document.activePageId };
  const projection = await createAbsProjection(composeBlocklyPage(compact.document, scope.pageId), {
    document: compact.document, contracts, generation, baselineRef: absBaselineKey(generation), scope,
    savedAbiHash: await hashAbsText(absJson(JSON.parse(prepared.abiText))),
  });
  const port = await openAbsHostStorage(targetPath, assertCurrent), store = new AbsBaselineStore(port, scope);
  const expected = await store.captureDisk(), pointer = await port.read('committed.json');
  await store.stage({ projection, mode: 'import', inputAbs: expected.abs ?? projection.abs,
    inputMap: expected.map, abi: prepared.abiText, expected }, pointer === null ? null : await hashAbsText(pointer));
  let publication;
  try {
    publication = await store.commit(generation, assertCurrent, async (text, hash, storage) => {
      assertCurrent();
      if (text !== prepared.abiText || !await storage.replace('project.abi', hash, text)) {
        throw new AbsSyncError('ABS_ABI_COMMIT_CONFLICT', 'Destination ABI changed during Save As.');
      }
    });
  } catch (error) {
    throw Object.assign(new AbsSyncError('ABS_SAVE_AS_UNCERTAIN', `Retain destination ${targetPath}; publication acknowledgement is unknown: ${String(error)}`),
      { uncertain: true, projectSaved: false, project: targetPath });
  }
  if (publication.status !== 'COMMITTED') throw Object.assign(
    new AbsSyncError('ABS_SAVE_AS_INCOMPLETE', `Retain destination ${targetPath}; its generation requires recovery.`),
    { uncertain: true, projectSaved: publication.abiSaved, project: targetPath, publication });
  const generated = capture.generated;
  try {
    if (!generated || generated.code === null) throw new Error(generated?.error || 'Project snapshot saved; generated code is not available yet.');
    if (generated?.error) throw new Error(generated.error);
    if (generated?.code !== null && generated?.code !== undefined) {
      assertCurrent(); await publishGeneratorMacros(targetPath, generated.projectMacros, assertCurrent);
      await writePreparedArduinoGeneratedArtifacts(targetPath, generated.artifacts,
        generated.artifacts === null ? undefined : generated.code);
    }
    return { projectSaved: true, generatedCodePublished: true, partial: false };
  } catch (error) {
    return { projectSaved: true, generatedCodePublished: false, partial: true,
      code: (error as any)?.code ?? 'PROJECT_DERIVED_OUTPUT_PENDING',
      error: error instanceof Error ? error.message : String(error) };
  }
}
