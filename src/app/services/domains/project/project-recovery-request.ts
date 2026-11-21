import { sha256Hex } from '../../../utils/crypto.utils';
import { openProjectRecoveryBackup } from './project-recovery-backup';
import type { ProjectStorageAttachment } from '@shared/public-api';

export const sameRecoveryAttachment = (a?: ProjectStorageAttachment, b?: ProjectStorageAttachment): boolean =>
  a?.version === 1 && b?.version === 1 && !!a.identity && !!b.identity
  && a.root === b.root && a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino
  && a.identity.birthtimeNs === b.identity.birthtimeNs;

type RecoveryStorage = Awaited<ReturnType<typeof openProjectRecoveryBackup>>;

/** Original recovery requests share the existing append-only backup journal.
 * A pending record never authorizes replay after its owner disappears. */
export class ProjectRecoveryRequests {
  private admitted?: { requestId: string; bytes: string; store: RecoveryStorage };

  constructor(private readonly project: string, private readonly assertCurrent: () => void) {}

  private async location(requestId: string) {
    const hash = await sha256Hex(requestId);
    return { request: `recoveries/project-request-${hash}.json`, result: `recoveries/project-result-${hash}.json` };
  }

  async observe(requestId: string, requireAttachment = false): Promise<{ started: boolean; result?: Record<string, any> }> {
    const store = await openProjectRecoveryBackup(this.project, this.assertCurrent), keys = await this.location(requestId);
    const input = await store.read(keys.request);
    if (input === null) return { started: false };
    const record = JSON.parse(input);
    if (record?.version !== 1 || record.project !== this.project || record.requestId !== requestId)
      throw new Error('The original recovery request belongs to different input.');
    if (record.attachment ? !sameRecoveryAttachment(record.attachment, store.attachment) : requireAttachment)
      throw Object.assign(new Error('The recovery record belongs to a different physical project.'), { code: 'PROJECT_RECOVERY_CONTEXT_STALE' });
    const text = await store.read(keys.result);
    if (text === null) return { started: true };
    const completed = JSON.parse(text);
    if (completed?.version !== 1 || completed.project !== this.project || completed.requestId !== requestId
      || completed.requestHash !== `sha256:${await sha256Hex(input)}` || !completed.result
      || typeof completed.result !== 'object' || Array.isArray(completed.result))
      throw new Error('The recovery result does not match its original request.');
    this.assertCurrent();
    return { started: true, result: completed.result };
  }

  async begin(requestId: string, assertAttachment?: (attachment?: ProjectStorageAttachment) => void): Promise<boolean> {
    let metadataOnly = false;
    const store = await openProjectRecoveryBackup(this.project, () => {
      if (!metadataOnly) this.assertCurrent();
    }), keys = await this.location(requestId);
    assertAttachment?.(store.attachment);
    return store.withLock<boolean>((storage, settle) => {
      void Promise.resolve().then(async () => {
        if (await storage.read(keys.request) !== null) return false;
        const source: Record<string, string | null> = {};
        for (const name of ['project.abi', 'project.abs', 'project.abs.map.json', 'committed.json']) {
          const text = await storage.read(name); source[name] = text === null ? null : `sha256:${await sha256Hex(text)}`;
        }
        this.assertCurrent();
        assertAttachment?.(store.attachment);
        const bytes = JSON.stringify({ version: 1, project: this.project, requestId, source,
          ...(store.attachment ? { attachment: store.attachment } : {}) });
        // The held lock and current view authorize this exact admission. Only
        // its receipt can use the retained physical handle after navigation.
        metadataOnly = true;
        if (!await storage.replace(keys.request, null, bytes)) return false;
        this.admitted = { requestId, bytes, store };
        return true;
      }).then(value => settle({ ok: true, value }), error => settle({ ok: false,
        error: { code: error?.code ?? 'PROJECT_RECOVERY_RECEIPT_INVALID', message: error instanceof Error ? error.message : String(error) } }));
    });
  }

  async complete(requestId: string, result: Record<string, any>): Promise<void> {
    const admitted = this.admitted;
    if (!admitted || admitted.requestId !== requestId) throw new Error('The original recovery was not admitted by this owner.');
    const { store, bytes } = admitted, keys = await this.location(requestId);
    await store.withLock<void>((storage, settle) => {
      void Promise.resolve().then(async () => {
        const input = await storage.read(keys.request);
        if (input !== bytes)
          throw new Error('The original recovery request identity changed.');
        const text = JSON.stringify({ version: 1, project: this.project, requestId,
          requestHash: `sha256:${await sha256Hex(input)}`, result });
        if (!await storage.replace(keys.result, null, text) && await storage.read(keys.result) !== text)
          throw new Error('The original recovery result was already recorded differently.');
      }).then(() => settle({ ok: true, value: undefined }), error => settle({ ok: false,
        error: { code: 'PROJECT_RECOVERY_RECEIPT_INVALID', message: error instanceof Error ? error.message : String(error) } }));
    });
  }
}
