import { publishProjectText, ProjectFilePublicationPort, ProjectFileWriteResult } from '@core/platform/public-api';
import { ensureExternalProjectDataDocument, ProjectDataImportStore } from './project-data-legacy-import';
import { materializeGenericProjectDataValues } from './project-data-generic-values';
import { AilyDataRef } from './project-data.types';
import { migrateLegacyShadowIdentities, ProjectBlockIdentityError } from '../legacy-shadow-identities';
import { ProjectBlockFieldUpdates, updateProjectBlockFields } from '../project-block-field-updates';
import { migrateLegacyBlockFieldValues } from '../legacy-block-field-values';
import { migrateLegacyBlockShapeValues } from '../legacy-block-shape-values';
import { migrateLegacyBlockTypes } from '../legacy-block-types';
import { canonicalProjectJsonStringify } from '../project-document-json';

export interface ProjectDataNormalizationStore extends ProjectDataImportStore {
  resolve<T>(ref: AilyDataRef): Promise<T>;
}

export interface DeferredProjectDataNormalization {
  readonly mode: 'load' | 'other';
  readonly projectPath: string;
  readonly originalContent: string;
  readonly persistedText: string;
}
const deferredNormalizations = new WeakSet<object>();

/** Internal prepared data, not a wire capability or permission to replace ABI. */
export function isDeferredProjectDataNormalization(value: unknown): value is DeferredProjectDataNormalization {
  return !!value && typeof value === 'object' && deferredNormalizations.has(value);
}

class AbsNormalizationDeferred extends Error {}

function hasAbsIdentityContext(projectPath: string, files: ProjectFilePublicationPort): boolean | undefined {
  const exists = (files as ProjectFilePublicationPort & { existsSync?: (path: string) => boolean }).existsSync;
  if (typeof exists !== 'function') return undefined;
  return ['project.abs.map.json', '.aily/abs-sync'].some(name => exists.call(files, `${projectPath}/${name}`));
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
  const loadOnly = originalContent !== undefined && materialize && fieldUpdates === undefined
    && canonicalProjectJsonStringify(input.document) === canonicalProjectJsonStringify(JSON.parse(originalContent));
  const identities = migrateLegacyShadowIdentities(input.document);
  const legacyFields = migrateLegacyBlockFieldValues(identities.document);
  const legacyShapes = migrateLegacyBlockShapeValues(legacyFields.document);
  const legacyTypes = migrateLegacyBlockTypes(legacyShapes.document);
  for (const change of identities.changes) if (fieldUpdates && Object.hasOwn(fieldUpdates, change.oldId)) {
    throw new ProjectBlockIdentityError('BLOCKLY_IDENTITY_REFERENCE_AMBIGUOUS', 'A field update targets a duplicated legacy identity.', { blockId: change.oldId });
  }
  const updated = fieldUpdates === undefined ? { document: legacyTypes.document, changed: false }
    : updateProjectBlockFields(legacyTypes.document, fieldUpdates);
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
    // A standalone ABS source has no block-ID binding. Only projection maps or
    // pending sync state can refer to the identities being repaired.
    for (const name of ['project.abs.map.json', '.aily/abs-sync']) {
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
  let deferredNormalization: DeferredProjectDataNormalization | undefined;
  // Candidate field edits also need publication, even when the schema/payloads are already normalized.
  const changed = updated.changed || migration.documentChanged || identities.changes.length > 0
    || legacyFields.changes.length > 0 || legacyShapes.changes.length > 0 || legacyTypes.changes.length > 0;
  let persistedText = originalContent === undefined ? undefined : changed ? JSON.stringify(migration.document) : originalContent;
  if (originalContent !== undefined) {
    // Even an unchanged document must still match the bytes read for this load.
    // Exact no-op publication takes the lock/CAS path without rewriting the file.
    const defer = () => {
      deferredNormalization = Object.freeze({ mode: loadOnly ? 'load' : 'other', projectPath, originalContent, persistedText: persistedText! });
      deferredNormalizations.add(deferredNormalization);
      // The native loader acknowledges the actual old bytes, not an unpublished candidate.
      persistedText = originalContent;
    };
    if (changed && hasAbsIdentityContext(projectPath, files) !== false) defer();
    else {
      const publicationGuard = () => {
        check();
        // Repeated synchronously inside the host's shared publication lock.
        // Another process may have created an ABS generation during resource I/O.
        if (changed && hasAbsIdentityContext(projectPath, files) !== false) throw new AbsNormalizationDeferred();
      };
      try {
        publication = await publishProjectText(projectPath, 'project.abi', persistedText!,
          originalContent, publicationGuard, files,
          changed ? { backup: 'project-data', ...(identities.changes.length ? { migrateLegacyShadowIds: true as const } : {}) } : {});
      } catch (error) {
        // Only a confirmed precommit guard rejection is deferrable. Unknown
        // acknowledgements and actual disk conflicts retain their normal errors.
        if (!(error instanceof AbsNormalizationDeferred)) throw error;
        defer();
      }
    }
  }
  // A confirmed old-context commit stays committed, but its load result is not reusable.
  assertCurrent();
  return { document: restored, persistedText, migration, publication, deferredNormalization, identityMigration: identities.changes,
    legacyFieldMigration: legacyFields.changes, legacyShapeMigration: legacyShapes.changes,
    legacyTypeMigration: legacyTypes.changes };
}
