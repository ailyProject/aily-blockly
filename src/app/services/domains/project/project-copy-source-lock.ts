type Settlement = { ok: true } | { ok: false; error: { code?: string; message: string } };
interface SourceCopyHost {
  projectCopySourceVersion?: number;
  withProjectCopySource?: (project: string, assertCurrent: () => void,
    action: (assertOwned: () => void, settle: (result: Settlement) => void) => void) => Promise<{
      ok: boolean; source?: { mode: string }; error?: { code?: string; message?: string; uncertain?: boolean };
    }>;
}

/** Reuse the host's file-publication exclusion for a closed-source capture.
 * The callback only publishes the independent target; release precedes any
 * navigation. Build outputs/leases remain excluded by the existing copier. */
export async function withProjectCopySourceLock(project: string, assertCurrent: () => void,
  publish: (assertOwned: () => void) => Promise<void>, host: SourceCopyHost = window['fs']): Promise<void> {
  assertCurrent();
  if (host.projectCopySourceVersion !== 1 || typeof host.withProjectCopySource !== 'function') {
    throw Object.assign(new Error('Recovery copy requires the host source-file coordination capability.'),
      { code: 'PROJECT_RECOVERY_LOCK_UNAVAILABLE' });
  }
  let publicationError: unknown;
  let completed = false;
  const result = await host.withProjectCopySource(project, assertCurrent, (assertOwned, settle) => {
    // contextBridge callbacks return void; do not clone Angular promises.
    Promise.resolve().then(() => {
      assertCurrent();
      assertOwned();
      return publish(assertOwned);
    }).then(
      () => { completed = true; settle({ ok: true }); },
      error => {
        publicationError = error;
        settle({ ok: false, error: { ...(typeof error?.code === 'string' ? { code: error.code } : {}),
          message: error instanceof Error ? error.message : String(error) } });
      });
  });
  if (result?.ok !== true) {
    // Keep local publication facts (including UNKNOWN/partial) that the narrow
    // native error serializer intentionally does not carry across Realms.
    if (publicationError !== undefined) {
      if (result?.error?.uncertain) throw Object.assign(new Error(
        publicationError instanceof Error ? publicationError.message : String(publicationError)),
        typeof publicationError === 'object' && publicationError !== null ? publicationError : {},
        { uncertain: true, sourceCopyDiagnostic: result.error });
      throw publicationError;
    }
    throw Object.assign(new Error(result?.error?.message || 'Source-copy exclusion was not confirmed.'),
      result?.error, { code: result?.error?.code || 'PROJECT_RECOVERY_LOCK_UNAVAILABLE' });
  }
  if (!completed || !['exclusive', 'retained-dead-owner'].includes(result.source?.mode || ''))
    throw Object.assign(new Error('Source-copy publication did not complete inside its host exclusion.'),
      { code: 'PROJECT_RECOVERY_COPY_UNCONFIRMED' });
}
