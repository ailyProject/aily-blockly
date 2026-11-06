import { sha256Hex } from '../../../utils/crypto.utils';

interface RecoveryStorage {
  read(key: string): Promise<string | null>;
  withLock<T>(run: (storage: { read(key: string): Promise<string | null>;
    replace(key: string, expected: string | null, text: string): Promise<boolean> },
    settle: (result: { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }) => void) => void): Promise<T>;
}

/** Reuse the existing project-bound append-only backup store. This is never a
 * second project, an execution directory, or permission to restore old bytes. */
export async function openProjectRecoveryBackup(project: string, assertCurrent: () => void): Promise<RecoveryStorage> {
  assertCurrent();
  const fs = window['fs'];
  if (fs?.projectSyncStorageVersion !== 2 || typeof fs.openProjectSyncStorage !== 'function') {
    throw Object.assign(new Error('Same-project recovery requires the current project backup host.'), { code: 'PROJECT_RECOVERY_BACKUP_UNAVAILABLE' });
  }
  const store = await fs.openProjectSyncStorage(project, assertCurrent);
  assertCurrent();
  return store;
}

export async function writeProjectRecoveryBackup(project: string, record: unknown, assertCurrent: () => void): Promise<string> {
  const text = JSON.stringify(record), key = `recoveries/source-${await sha256Hex(text)}.json`;
  const store = await openProjectRecoveryBackup(project, assertCurrent);
  await store.withLock<void>((storage, settle) => {
    void Promise.resolve().then(async () => {
      assertCurrent();
      const before = await storage.read(key);
      if (before !== null && before !== text) throw new Error('An immutable recovery backup changed.');
      if (before === null && !await storage.replace(key, null, text)) throw new Error('Recovery backup publication conflicted.');
      assertCurrent();
      if (await storage.read(key) !== text) throw new Error('Recovery backup readback did not match.');
    }).then(() => settle({ ok: true, value: undefined }), error => settle({ ok: false,
      error: { code: error?.code ?? 'PROJECT_RECOVERY_BACKUP_CONFLICT', message: error instanceof Error ? error.message : String(error) } }));
  });
  return `${project}/.aily/abs-sync/${key}`;
}

/** Legacy archives only establish discovery facts. Current bytes must be
 * captured again before any dependency or document mutation is admitted. */
export async function inspectLegacyProjectRecovery(project: string, assertCurrent: () => void) {
  const fs = window['fs'];
  if (typeof fs?.readDirSync !== 'function') return null;
  assertCurrent();
  const entries = fs.readDirSync(project).filter(entry => entry._isFile
    && /^recovery-source-[a-f0-9-]{36}\.json$/.test(entry.name)).slice(0, 8);
  for (const entry of entries) {
    try {
      const archive = `${project}/${entry.name}`, text = fs.readFileSync(archive, 'utf8');
      if (typeof text !== 'string' || text.length > 16 * 1024 * 1024) continue;
      const value = JSON.parse(text), abi = value?.files?.['project.abi'];
      if (value?.version !== 1 || typeof value.sourceProject !== 'string' || !value.sourceProject
        || typeof abi !== 'string') continue;
      const document = JSON.parse(abi);
      if (!document || typeof document !== 'object' || Array.isArray(document)) continue;
      const abiHash = `sha256:${await sha256Hex(abi)}`, raw = value.rawFiles?.['project.abi'];
      if (raw && (raw.encoding !== 'utf8' || raw.hash !== abiHash || raw.bytes !== new TextEncoder().encode(abi).length)) continue;
      assertCurrent();
      if (fs.readFileSync(archive, 'utf8') !== text) continue;
      return { version: 1, project, sourceProject: value.sourceProject, archive, archiveHash: `sha256:${await sha256Hex(text)}`,
        sourceAbiHash: abiHash, authority: 'discovery-only' as const };
    } catch { /* Damaged history cannot block recovery of a verified current document. */ }
  }
  assertCurrent();
  return null;
}
