import type { BlocklyProjectDocument } from './blockly.service';
import { ProjectFilePublicationPort, publishProjectText } from '@core/platform/public-api';
import {
  assertNoOversizedInlineValues, externalizeGenericProjectDataValues, projectDataRuntime,
} from '@domain/project/public-api';

/** Immutable strings: callers and library callbacks cannot mutate the retained save candidate. */
export interface PreparedBlocklySave { readonly abiText: string; readonly documentText: string }

export async function prepareBlocklySave(
  document: BlocklyProjectDocument, saveShape: (snapshot: BlocklyProjectDocument) => unknown,
  assertCurrent: () => void, runtime: typeof projectDataRuntime = projectDataRuntime,
): Promise<PreparedBlocklySave> {
  assertCurrent();
  const documentText = JSON.stringify(document);
  const candidate = saveShape(JSON.parse(documentText));
  const { document: abi } = await externalizeGenericProjectDataValues(candidate, {
    put: async request => {
      assertCurrent();
      const ref = await runtime.put(request);
      assertCurrent();
      return ref;
    },
  });
  assertCurrent();
  await runtime.flushPending();
  assertCurrent();
  assertNoOversizedInlineValues(abi);
  const store = runtime.getStore();
  const validation = await store.validateReferences(store.collectReferences(abi));
  assertCurrent();
  if (!validation.valid) throw new Error(`Project data validation failed: ${validation.issues.map(issue => issue.error).join('; ')}`);
  return Object.freeze({ documentText, abiText: JSON.stringify(abi) });
}

/** The host owns temporary files, the project lock, byte CAS and the commit acknowledgement. */
export function commitPreparedBlocklySave(
  path: string, prepared: PreparedBlocklySave, expectedAbi: string | null,
  files: ProjectFilePublicationPort, assertCurrent: () => void,
) {
  return publishProjectText(path, 'project.abi', prepared.abiText, expectedAbi, assertCurrent, files);
}
