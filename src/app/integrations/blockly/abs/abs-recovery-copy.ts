import { ProjectDataStore, type ProjectSaveOutcome, type PutProjectDataRequest } from '@domain/project/public-api';
import { prepareBlocklySave, commitPreparedBlocklySave } from '../../../editors/blockly-editor/services/prepared-project-save';
import type { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly-project-model';
import type { ProjectRecoveryFiles } from '@shared/public-api';

export interface AbsRecoveryCopyCapture {
  sourceProject: string;
  documentText: string;
  abiShapeText: string;
  sourceFiles: ProjectRecoveryFiles;
}

/** Persist observed native state, not a claim that a quarantined generator or
 * its old contracts are valid. A new target runtime establishes its own ABS. */
export async function publishAbsRecoveryCopy(target: string, capture: AbsRecoveryCopyCapture,
  assertCurrent: () => void): Promise<ProjectSaveOutcome> {
  assertCurrent();
  const data = new ProjectDataStore(); data.configure(target);
  const runtime = { put: <T>(request: PutProjectDataRequest<T>) => data.put(request),
    flushPending: () => data.flushPending(), getStore: () => data };
  const prepared = await prepareBlocklySave(JSON.parse(capture.documentText) as BlocklyProjectDocument,
    () => JSON.parse(capture.abiShapeText), assertCurrent, runtime);
  const fs = window['fs'], abi = `${target}/project.abi`;
  const expected = fs.existsSync(abi) ? fs.readFileSync(abi, 'utf8') : null;
  assertCurrent();
  // The original files remain untouched. One bounded explicit recovery record
  // preserves their raw text without making an old map authoritative here.
  fs.writeFileSync(`${target}/recovery-source-${crypto.randomUUID()}.json`, JSON.stringify({
    version: 1, sourceProject: capture.sourceProject, ...capture.sourceFiles,
  }), { flag: 'wx' });
  await commitPreparedBlocklySave(target, prepared, expected, fs, assertCurrent);
  return { projectSaved: true, generatedCodePublished: false, partial: true,
    projectionPending: true, code: 'PROJECT_RECOVERY_RUNTIME_REQUIRED',
    error: 'Recovery snapshot saved independently. Load the target runtime before creating its ABS baseline or generating current code.' };
}
