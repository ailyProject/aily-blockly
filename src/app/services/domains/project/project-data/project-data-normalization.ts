import { publishProjectText, ProjectFilePublicationPort, ProjectFileWriteResult } from '@core/platform/public-api';
import { ensureExternalProjectDataDocument, ProjectDataImportStore } from './project-data-legacy-import';
import { materializeGenericProjectDataValues } from './project-data-generic-values';
import { AilyDataRef } from './project-data.types';

export interface ProjectDataNormalizationStore extends ProjectDataImportStore {
  resolve<T>(ref: AilyDataRef): Promise<T>;
}

/** Prepare and validate before publication. Never changes the active runtime or workspace. */
export async function normalizeProjectDataDocument(
  input: { projectPath: string; document: unknown; originalContent?: string; materialize: boolean; sourceChanged?: boolean },
  store: ProjectDataNormalizationStore, assertCurrent: () => void,
  files: ProjectFilePublicationPort = window['fs'],
) {
  assertCurrent();
  // Snapshot options now; ensureExternalProjectDataDocument clones the document before awaiting.
  const { projectPath, originalContent, materialize, sourceChanged = false } = input;
  const document = input.document;
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const value = await operation();
    assertCurrent();
    return value;
  };
  const migration = await ensureExternalProjectDataDocument(document, {
    put: request => checked(() => store.put(request)),
    flushPending: () => checked(() => store.flushPending()),
    collectReferences: value => { assertCurrent(); return store.collectReferences(value); },
    validateReferences: refs => checked(() => store.validateReferences(refs)),
  });
  assertCurrent();
  // A resource/codec failure must not leave a newly committed but unloadable ABI.
  const restored = materialize ? await materializeGenericProjectDataValues(migration.document, {
    resolve: <T>(ref: AilyDataRef) => checked(() => store.resolve<T>(ref)),
  }) : migration.document;
  assertCurrent();
  let publication: ProjectFileWriteResult | undefined;
  // Candidate field edits also need publication, even when the schema/payloads are already normalized.
  const changed = sourceChanged || migration.documentChanged;
  if (originalContent !== undefined) {
    // Even an unchanged document must still match the bytes read for this load.
    // Exact no-op publication takes the lock/CAS path without rewriting the file.
    publication = await publishProjectText(projectPath, 'project.abi', changed ? JSON.stringify(migration.document) : originalContent,
      originalContent, assertCurrent, files, changed ? { backup: 'project-data' } : {});
  }
  // A confirmed old-context commit stays committed, but its load result is not reusable.
  assertCurrent();
  return { document: restored, migration, publication };
}
