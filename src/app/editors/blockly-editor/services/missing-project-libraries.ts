import { validRange } from 'semver';

/** Automatic recovery may use only an explicit saved spec or a real local
 * source. In particular an empty/file-only value must never mean npm latest. */
export function assertKnownMissingLibraryRecoverySources(libraries: readonly {
  name: string; version?: string; localPath?: string;
}[], exists: (source: string) => boolean): void {
  for (const library of libraries) {
    if (library.localPath) {
      if (!exists(library.localPath)) throw Object.assign(new Error('原项目所需本地积木库来源不存在；已保留完整程序，未推测或替换依赖来源。'),
        { code: 'PROJECT_RECOVERY_LIBRARY_SOURCE_MISSING' });
      continue;
    }
    const version = library.version?.trim();
    if (!version || /^file:/i.test(version) || /["'`]/.test(version)
      || !validRange(version) && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(version)) {
      throw Object.assign(new Error('原项目没有可确认的积木库版本或本地来源；已保留程序，未推测安装最新版本。'),
        { code: 'PROJECT_RECOVERY_LIBRARY_SPEC_MISSING', packageName: library.name });
    }
  }
}

export interface MissingLibraryInstall {
  packages: string[];
  localSource?: { packageName: string; source: string; force: false };
}

interface MissingLibraryEnvironmentPort {
  capabilities(): Promise<{ dependencyEnvironmentVersion?: number }>;
  mutate(project: string, request: Record<string, unknown>): Promise<any>;
  observeEnvironment(project: string, request: { requestId: string }): Promise<any>;
}

/** Loading has no admitted Program workspace yet. Install only through the
 * existing Main environment owner, then continue that same document load. */
export async function installMissingLibrariesManaged(input: {
  project: string;
  installs: MissingLibraryInstall[];
  host: MissingLibraryEnvironmentPort;
  signal: AbortSignal;
  assertCurrent(): void;
  options: Record<string, unknown>;
  cancel(requestId: string): Promise<unknown>;
  verify(requestId: string, packages: string[]): Promise<unknown>;
}): Promise<void> {
  input.assertCurrent();
  const capability = await input.host.capabilities();
  input.assertCurrent();
  if (capability?.dependencyEnvironmentVersion !== 2) {
    throw Object.assign(new Error('Missing library recovery requires the matching managed dependency publisher.'),
      { code: 'LIBRARY_ENVIRONMENT_UNAVAILABLE' });
  }
  for (const install of input.installs) {
    input.assertCurrent();
    const requestId = `env1-${globalThis.crypto.randomUUID()}`;
    // Register the exact cancellation identity before dispatch, including the
    // race in which cancellation reaches Main before its mutate IPC does.
    let cancellation: Promise<unknown> | undefined;
    const stop = () => {
      cancellation ??= input.cancel(requestId).catch(cause => {
        throw Object.assign(new Error('Cancellation of the original missing-library environment is unconfirmed.'),
          { code: 'LIBRARY_ENVIRONMENT_CANCELLATION_UNCONFIRMED', requestId, cause });
      });
      void cancellation.catch(() => undefined);
    };
    input.signal.addEventListener('abort', stop, { once: true });
    try {
      input.signal.throwIfAborted();
      let failure: unknown;
      try {
        await input.host.mutate(input.project, { requestId, action: 'install',
          packages: install.packages, options: input.options,
          ...(install.localSource ? { localSource: install.localSource } : {}) });
      } catch (error) { failure = error; }
      if (input.signal.aborted) {
        stop();
        await cancellation;
        input.signal.throwIfAborted();
      }
      input.assertCurrent();
      // A lost acknowledgement never authorizes another install. Read only
      // this original journal result, not the manager's latest convenience row.
      const observed = await input.host.observeEnvironment(input.project, { requestId });
      input.assertCurrent();
      if (observed?.environment?.requestId !== requestId || observed.environment.status !== 'completed'
        || observed.environment.current !== true) {
        throw Object.assign(new Error(failure instanceof Error ? failure.message : 'The original missing-library installation is not verified complete.'),
          { code: 'LIBRARY_ENVIRONMENT_UNCERTAIN', requestId, environment: observed?.environment });
      }
      await input.verify(requestId, install.packages);
      input.assertCurrent();
    } finally {
      input.signal.removeEventListener('abort', stop);
      // Session teardown may stop waiting for load work, but the actual Main
      // worker must still settle this same ID rather than continue unowned.
      await cancellation;
    }
  }
}
