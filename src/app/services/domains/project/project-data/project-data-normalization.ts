import { publishProjectText, ProjectFilePublicationPort, ProjectFileWriteResult } from '@core/platform/public-api';
import { ensureExternalProjectDataDocument, ProjectDataImportStore } from './project-data-legacy-import';
import { materializeGenericProjectDataValues } from './project-data-generic-values';
import { AilyDataRef } from './project-data.types';
import { migrateLegacyShadowIdentities, ProjectBlockIdentityError } from '../legacy-shadow-identities';
import { ProjectBlockFieldUpdates, updateProjectBlockFields } from '../project-block-field-updates';

export interface ProjectDataNormalizationStore extends ProjectDataImportStore {
  resolve<T>(ref: AilyDataRef): Promise<T>;
}

/** Prepare and validate before publication. Never changes the active runtime or workspace. */
export async function normalizeProjectDataDocument(
  input: { projectPath: string; document: unknown; originalContent?: string; materialize: boolean; fieldUpdates?: ProjectBlockFieldUpdates },
  store: ProjectDataNormalizationStore, assertCurrent: () => void,
  files: ProjectFilePublicationPort = window['fs'],
) {
  assertCurrent();
  // Snapshot options now; ensureExternalProjectDataDocument clones the document before awaiting.
  const { projectPath, originalContent, materialize, fieldUpdates } = input;
  const identities = migrateLegacyShadowIdentities(input.document);
  for (const change of identities.changes) if (fieldUpdates && Object.hasOwn(fieldUpdates, change.oldId)) {
    throw new ProjectBlockIdentityError('BLOCKLY_IDENTITY_REFERENCE_AMBIGUOUS', 'A field update targets a duplicated legacy identity.', { blockId: change.oldId });
  }
  const updated = fieldUpdates === undefined ? { document: identities.document, changed: false }
    : updateProjectBlockFields(identities.document, fieldUpdates);
  const document = updated.document;
  const check = () => {
    assertCurrent();
    if (!identities.changes.length) return;
    if (originalContent !== undefined && files.projectShadowIdentityMigrationVersion !== 1) {
      throw new ProjectBlockIdentityError('PROJECT_FILE_HOST_UNAVAILABLE', 'Legacy shadow migration requires the updated Electron host. Fully restart Electron.');
    }
    // Early guard avoids resource I/O. The host repeats this under the shared
    // publication lock, closing races with ABS initialization in another process.
    const io = files as ProjectFilePublicationPort & { existsSync(path: string): boolean };
    if (typeof io.existsSync !== 'function') throw new ProjectBlockIdentityError('PROJECT_FILE_HOST_UNAVAILABLE', 'Identity migration requires filesystem inspection.');
    for (const name of ['project.abs', 'project.abs.map.json', '.aily/abs-sync']) {
      if (io.existsSync(`${projectPath}/${name}`)) throw new ProjectBlockIdentityError('BLOCKLY_IDENTITY_MIGRATION_BLOCKED',
        `Existing ABS identity context (${name}); preserve drafts and use explicit recovery before migrating legacy shadow IDs.`, { path: name });
    }
  };
  check();
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    const value = await operation();
    check();
    return value;
  };
  const migration = await ensureExternalProjectDataDocument(document, {
    put: request => checked(() => store.put(request)),
    flushPending: () => checked(() => store.flushPending()),
    collectReferences: value => { check(); return store.collectReferences(value); },
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
  const changed = updated.changed || migration.documentChanged || identities.changes.length > 0;
  if (originalContent !== undefined) {
    // Even an unchanged document must still match the bytes read for this load.
    // Exact no-op publication takes the lock/CAS path without rewriting the file.
    publication = await publishProjectText(projectPath, 'project.abi', changed ? JSON.stringify(migration.document) : originalContent,
      originalContent, check, files, changed ? { backup: 'project-data', ...(identities.changes.length ? { migrateLegacyShadowIds: true as const } : {}) } : {});
  }
  // A confirmed old-context commit stays committed, but its load result is not reusable.
  assertCurrent();
  return { document: restored, migration, publication, identityMigration: identities.changes };
}
