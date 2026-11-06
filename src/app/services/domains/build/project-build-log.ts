import { sha256Hex } from '../../../utils/crypto.utils';

/** A single admitted build owns this writer. It never reads the rolling log or
 * installs a project-wide listener that could capture another build's output. */
export interface ProjectBuildLogReference {
  version: 1;
  requestId: string;
  project: string;
  path?: string;
  complete: boolean;
  error?: string;
}

export interface ProjectBuildLog {
  append(text: string): void;
  markIncomplete(reason: string): void;
  run<T extends object>(operation: () => Promise<T>): Promise<T & { buildLog: ProjectBuildLogReference }>;
}

export async function createProjectBuildLog(project: string, requestedId?: string): Promise<ProjectBuildLog> {
  let requestId = requestedId ?? '';
  let path: string | undefined, failure: string | undefined;
  let incomplete: string | undefined;
  let finished: ProjectBuildLogReference | undefined;
  const fail = (error: unknown) => { failure ??= error instanceof Error ? error.message : String(error); };
  try {
    if (typeof window['path']?.join !== 'function' || typeof window['fs']?.writeFileSync !== 'function'
      || typeof window['fs']?.appendFileSync !== 'function' || typeof window['fs']?.lstatSync !== 'function') {
      throw new Error('Build log storage is unavailable.');
    }
    if (!requestId) requestId = window.crypto.randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new Error('Invalid build log request ID.');
    const filename = await sha256Hex(requestId) + '.log';
    const directory = window['path'].join(project, '.log', 'compile', 'requests');
    const candidate = window['path'].join(directory, filename);
    for (const relative of ['.log', '.log/compile', '.log/compile/requests']) {
      const folder = window['path'].join(project, ...relative.split('/'));
      const fs = window['fs'];
      if (fs.existsSync(folder)) {
        const stat = fs.lstatSync(folder);
        if (stat?._isSymbolicLink === true || stat?.isSymbolicLink?.()) throw new Error('Build log directories must not be links.');
      } else fs.mkdirSync(folder);
    }
    // Re-observation reuses the receipt. An actual duplicate execution must not
    // truncate or append to an earlier request's immutable completed log.
    window['fs'].writeFileSync(candidate, `Build request: ${requestId}\nProject: ${project}\n\n`, { encoding: 'utf8', flag: 'wx' });
    path = candidate;
  } catch (error) { fail(error); }
  const append = (text: string) => {
    if (finished || failure || !text) return;
    try { window['fs'].appendFileSync(path, text); } catch (error) { fail(error); }
  };
  const finish = () => finished ??= { version: 1, requestId, project, ...(path ? { path } : {}),
    complete: !failure && !incomplete, ...(failure || incomplete ? { error: failure || incomplete } : {}) };
  return { append,
    markIncomplete(reason: string) {
      incomplete ??= reason;
      append(`\n[Incomplete log capture] ${reason}\n`);
    },
    async run<T extends object>(operation: () => Promise<T>) {
      try {
        const result = await operation();
        const state = (result as any).result ?? result;
        append(`\nBuild finished: ${state.state ?? ''} ${state.text ?? state.message ?? ''}\n`);
        return { ...result, buildLog: finish() };
      }
      catch (error) {
        const detail = (error as any)?.fullStdErr || (error as any)?.stack || (error as any)?.text || (error as any)?.message || String(error);
        append(`\nHost build failed: ${detail}\n`);
        const failure = error && typeof error === 'object' ? error : new Error(String(error));
        throw Object.assign(failure, { buildLog: finish() });
      }
    },
  };
}
