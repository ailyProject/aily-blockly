import { Injectable } from '@angular/core';
import { Subscription } from 'rxjs';
import { CmdService } from '@core/platform/public-api';
import { ProjectService } from '@domain/project/public-api';
import { validateProjectHardwareIntentCompileContextV1,
  type ProjectHardwareIntentCompileContextV1 } from '@aily-project/simulator-protocol/scene';

type CompilerConfiguration = ProjectHardwareIntentCompileContextV1;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;

/** Generic Host build facts only. Simulator and Agent policy remain consumers. */
@Injectable({ providedIn: 'root' })
export class ProjectCompilerConfigurationService {
  constructor(
    private readonly project: ProjectService,
    private readonly cmd: CmdService,
  ) {}

  async read(projectPath: string, signal?: AbortSignal): Promise<CompilerConfiguration> {
    const deadline = Date.now() + 30_000;
    const board = this.project.currentBoardConfig;
    const boardModule = this.project.getRuntimeBoardModule();
    let session: ReturnType<ProjectService['getProjectDependencySession']>;
    const assertActive = () => {
      if (signal?.aborted || Date.now() >= deadline || !projectPath || this.project.currentProjectPath !== projectPath
          || this.project.currentBoardConfig !== board || this.project.getRuntimeBoardModule() !== boardModule) {
        throw new Error('project-context-changed');
      }
      if (session) this.project.assertProjectDependencySession(session);
    };
    let stage = 'project';
    try {
      assertActive();
      if (!boardModule) throw new Error('board-unavailable');
      session = this.project.getProjectDependencySession(projectPath);
      signal = signal ? AbortSignal.any([signal, session.signal]) : session.signal;
      assertActive();
      const manifest = JSON.stringify(await withinBudget(this.project.getPackageJson(), deadline, signal));
      assertActive();
      stage = 'managed-builder';
      const builder = await withinBudget(Promise.resolve(window['builder']?.status?.()), deadline, signal);
      assertActive();
      if (!builder?.installed || builder.installing || typeof builder.entryPath !== 'string' || !builder.entryPath) {
        throw new Error('builder-unavailable');
      }
      const helper = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'project-compiler-configuration.js');
      const request = JSON.stringify({ schemaVersion: 1, projectPath, boardModule,
        entryPath: builder.entryPath, appDataPath: window['path'].getAppDataPath() });
      const bytes = new TextEncoder().encode(request);
      if (bytes.length > MAX_REQUEST_BYTES) throw new Error('request-budget');
      const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      stage = 'configuration-query';
      const result = await this.query(helper, encoded, projectPath, session.projectSessionId, deadline, signal);
      stage = 'bookend';
      assertActive();
      if (manifest !== JSON.stringify(await withinBudget(this.project.getPackageJson(), deadline, signal))) throw new Error('project-context-changed');
      const currentBuilder = await withinBudget(Promise.resolve(window['builder'].status()), deadline, signal);
      assertActive();
      if (!currentBuilder?.installed || currentBuilder.installing || currentBuilder.entryPath !== builder.entryPath) {
        throw new Error('builder-context-changed');
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'configuration-query-termination-unconfirmed') throw error;
      if (signal?.aborted) throw cancellationError();
      console.warn('[ProjectCompilerConfiguration]', { stage, status: 'unavailable' });
      return unavailableConfiguration();
    }
  }

  private query(helper: string, request: string, cwd: string, projectSessionId: string, deadline: number, signal?: AbortSignal): Promise<CompilerConfiguration> {
    const streamId = `compiler-config-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      let output = '', closed = false, settled = false;
      let subscription: Subscription | undefined;
      const finish = async (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        subscription?.unsubscribe();
        if (!closed && !await this.cmd.kill(streamId).catch(() => false)) {
          reject(new Error('configuration-query-termination-unconfirmed'));
          return;
        }
        if (error) { reject(error); return; }
        try { resolve(validateProjectHardwareIntentCompileContextV1(JSON.parse(output))); }
        catch { reject(new Error('configuration-query-invalid-output')); }
      };
      const onAbort = () => { void finish(cancellationError()); };
      const timer = setTimeout(() => { void finish(new Error('configuration-query-timeout')); }, Math.max(1, deadline - Date.now()));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      subscription = this.cmd.spawn('node', [helper, request], {
        cwd, streamId, shellProfile: false, projectPath: cwd, projectSessionId, signal,
      }, true).subscribe({
        next: event => {
          if (settled) return;
          if (event.type === 'stdout' && event.data) {
            output += event.data;
            if (new TextEncoder().encode(output).length > MAX_OUTPUT_BYTES) {
              void finish(new Error('configuration-query-output-budget'));
            }
          } else if (event.type === 'close') {
            closed = true;
            void finish(event.code === 0 && !event.signal ? undefined : new Error('configuration-query-failed'));
          } else if (event.type === 'error') void finish(new Error('configuration-query-failed'));
        },
        error: () => { void finish(new Error('configuration-query-failed')); },
        complete: () => { if (!settled) void finish(new Error('configuration-query-missing-exit')); },
      });
    });
  }
}

function unavailableConfiguration(): CompilerConfiguration {
  return { schemaVersion: 1, kind: 'aily-resolved-compiler-configuration', scope: 'command-line-only',
    status: 'unavailable', effectiveFqbn: null, platformVersion: null, definitions: [],
    limitations: ['cpp-preprocessing-not-performed', 'configuration-unavailable'] };
}

function cancellationError(): Error {
  return Object.assign(new Error('Compiler configuration query cancelled.'), { name: 'AbortError' });
}

function withinBudget<T>(value: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(cancellationError()); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('configuration-query-timeout')); }, Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    value.then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
  });
}
