import { Injectable, NgZone } from '@angular/core';
import { lastValueFrom } from 'rxjs';
import { CmdService } from '@core/platform/public-api';
import { AilyChatDemandSessionService } from '@integration/simulator/public-api';
import { SimulatorBoardDemonstrationProvider } from './simulator-board-demonstration-provider';

import {
  SimulatorHostProviderOperationError,
  SimulatorProjectHostProviderAdapter,
  createSimulatorHostProviderDispatcherAdapterBundle,
  type SimulatorProjectHostProviderAdapterOptions,
} from '@aily-project/simulator-host-sdk';
import type {
  SimulatorSubappHostProjectDebugConfigurationReadV1,
  SimulatorSubappHostProjectDebugConfigurationSnapshotV1,
} from '@aily-project/simulator-protocol/host';

import { BuilderService } from '@domain/build/public-api';
import { ProjectDebugConfigurationService, ProjectService } from '@domain/project/public-api';
import { ProjectHardwareIntentProviderService } from './project-hardware-intent-provider.service';
import { SimulatorEntitlementAccountService } from './simulator-entitlement-account.service';
import { SimulatorMainAgentSceneChangeService } from './simulator-main-agent-scene-change.service';
import {
  SubappHostProviderDispatcher,
  SubappHostProviderProductRegistryService,
  type SubappHostProviderAdapter,
  type SubappHostProviderProductOpenContext,
  type SubappHostProviderProductSession,
} from '@integration/subapps/public-api';
import { SimulatorBuildProductComposition } from './simulator-build-product-composition';
import {
  SimulatorBlocklyEditorCallbackAuthority,
} from './simulator-blockly-editor-callback-authority';
import {
  SimulatorEntitlementCallbackAuthority,
} from './simulator-entitlement-callback-authority';
import type {
  SimulatorActiveProjectBindingPort,
} from './simulator-build-execution-port';
import { createSimulatorElectronProjectArtifactFilePort } from './simulator-electron-project-artifact-file-port';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { captureSimulatorProjectReadAuthority,
  type SimulatorCurrentProjectScope, type SimulatorProjectReadAuthorityCapture } from './simulator-current-project-scope';

const SIMULATOR_TOOL_ID = 'simulator';
const SIMULATOR_PROVIDER_MESSAGE_BUDGET = 4 * 1024 * 1024 + 16 * 1024;

/**
 * Registers Blockly's Project/Build/Editor/Entitlement callbacks for the independently
 * installed Simulator Subapp. It never acquires or controls the Child Tool
 * process; the generic Child Tool Host supplies and owns that lifecycle.
 */
@Injectable({ providedIn: 'root' })
export class SimulatorHostProviderProductService {
  private unregister: (() => void) | null = null;

  constructor(
    private readonly registry: SubappHostProviderProductRegistryService,
    private readonly project: ProjectService,
    private readonly builder: BuilderService,
    private readonly simulatorMainAgent: SimulatorMainAgentSceneChangeService,
    private readonly hardwareIntent: ProjectHardwareIntentProviderService,
    private readonly entitlementAccount: SimulatorEntitlementAccountService,
    private readonly blockly: BlocklyService,
    private readonly projectDebug: ProjectDebugConfigurationService,
    private readonly ngZone: NgZone,
    private readonly demandSessions: AilyChatDemandSessionService,
    private readonly commands: CmdService,
  ) {}

  ensureRegistered(): void {
    if (this.unregister) return;
    this.unregister = this.registry.register(SIMULATOR_TOOL_ID, {
      open: (context) => this.open(context),
    });
  }

  private async open(
    context: SubappHostProviderProductOpenContext,
  ): Promise<SubappHostProviderProductSession> {
    const scope = await this.openCurrentProjectScope(undefined, context.runtimePackagePath);
    return scope
      ? bindProviderSession(context, scope.adapters as readonly SubappHostProviderAdapter[], () => scope.close())
      : bindProviderSession(context, [], () => undefined);
  }

  /** Build the active code once before opening the Simulator, through Blockly's normal Builder. */
  async prepareCurrentProjectForSimulation(signal?: AbortSignal): Promise<void> {
    const scope = await this.openCurrentProjectScope(signal);

    if (!scope) throw new Error('请先打开一个 Blockly 项目。');

    const current = AbortSignal.any([scope.activation.signal, ...(signal ? [signal] : [])]);
    const requestId = `simulator-open-${crypto.randomUUID()}`;
    const cancel = () => this.builder.cancelActiveBlocklyProjectBuild(requestId);

    current.addEventListener('abort', cancel, { once: true });

    try {
      scope.requireCurrent();

      const scene = await scope.callbacks.readScene({
        projectIdentity: scope.projectIdentity,
        sceneId: scope.sceneId,
      }, current);

      if (scene.kind !== 'aily-project-scene-network-descriptor') {
        throw new Error('当前项目还没有电路场景，请先生成电路连线。');
      }

      await this.builder.buildActiveBlocklyProject({
        projectPath: scope.activation.path,
        graphSemanticRevision: scene.document.graphSemanticRevision,
        sceneDocument: scene.document,
        requestId,
      });

      scope.requireCurrent();

      const context = await scope.callbacks.readContext({ projectIdentity: scope.projectIdentity }, current);

      if (!context.activeArtifactRevision) throw new Error('Builder 未生成当前项目的仿真固件。');

      await scope.callbacks.readArtifact({
        projectIdentity: scope.projectIdentity,
        artifactRevision: context.activeArtifactRevision,
      }, current);

      scope.requireCurrent();
    } finally {
      current.removeEventListener('abort', cancel);
      await scope.close();
    }
  }

  /** The normal Browser caller borrows the same product construction as the
   * Native registration. No Runtime, project table or replacement owner is
   * created here; a same-path reload ends the original captured session. */
  async openCurrentProjectScope(
    signal?: AbortSignal,
    runtimePackagePath?: string,
  ): Promise<SimulatorCurrentProjectScope | null> {
    signal?.throwIfAborted();
    const captured = this.project.captureCurrentProjectActivation();
    const projectRoot = this.readActiveBlocklyProjectRoot();
    if (!captured || !projectRoot || !sameProjectRoot(captured.path, projectRoot)) return null;
    const lifetime = new AbortController();
    const activationSignal = AbortSignal.any([captured.signal, lifetime.signal, ...(signal ? [signal] : [])]);
    let closeRequested = false, closed = false, closing: Promise<void> | null = null;
    const pending = new Set<Promise<unknown>>();
    const cleanup = new Set<() => void>();
    const requireCurrent = () => {
      activationSignal.throwIfAborted();
      if (closeRequested) throw new SimulatorHostProviderOperationError('cancelled');
      captured.requireCurrent();
      const current = this.readActiveBlocklyProjectRoot();
      if (!current || !sameProjectRoot(current, projectRoot)) throw new SimulatorHostProviderOperationError('conflict');
    };
    function trackOriginal<T>(action: () => T | Promise<T>): Promise<T> {
      const original = Promise.resolve().then(action).finally(() => { pending.delete(original); });
      pending.add(original);
      void original.catch(() => { /* Observing rejection does not cancel or release the actual operation. */ });
      return original;
    }
    function run<T>(external: AbortSignal, action: (current: AbortSignal) => T | Promise<T>): Promise<T> {
      try { requireCurrent(); external.throwIfAborted(); }
      catch (error) { return Promise.reject(error); }
      const current = AbortSignal.any([activationSignal, external]);
      const original = Promise.resolve().then(() => { requireCurrent(); current.throwIfAborted(); return action(current); })
        .then(value => { requireCurrent(); current.throwIfAborted(); return value; })
        .finally(() => { pending.delete(original); });
      pending.add(original);
      void original.catch(() => { /* Original callbacks remain joined until their actual outcome. */ });
      return original;
    }
    function close(): Promise<void> {
      closeRequested = true;
      lifetime.abort(new DOMException('The caller closed its original Simulator product scope.', 'AbortError'));
      if (closed) return Promise.resolve();
      if (closing) return closing;
      const original = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        for (const release of [...cleanup]) {
          try { release(); cleanup.delete(release); } catch (error) { failures.push(error); }
        }
        // Abort is an intent, not proof that an ignored file operation settled.
        // A composite callback may reject before a sibling file operation.
        // Join each original operation, including children started while a
        // currently pending callback unwinds after cancellation.
        while (pending.size) await Promise.allSettled([...pending]);
        if (failures.length) throw new AggregateError(failures, 'Original Simulator product cleanup remains unconfirmed.');
        closed = true;
      }).finally(() => { if (closing === original) closing = null; });
      closing = original;
      void original.catch(() => { /* Keep failed releases for retry on this exact scope. */ });
      return original;
    }
    const ended = () => {
      if (!closeRequested) void close().catch(error => console.error('Original Simulator product scope cleanup remains unconfirmed', error));
    };
    try {
      requireCurrent();
      const normalizedRoot = normalizeProjectRoot(projectRoot);
      const rootDigest = await sha256Text(normalizedRoot);
      requireCurrent();
      const projectIdentity = `project-v1-${rootDigest}`;
      const workspaceIdentity = `workspace-v1-${rootDigest}`;
      const activeProject: SimulatorActiveProjectBindingPort = {
        readActiveBinding: () => {
          try { requireCurrent(); } catch { return null; }
          const activeRoot = this.project.currentProjectPath;
          if (
            !activeRoot
            || this.project.isProjectOpening
            || this.project.isAilyCodeProject(activeRoot)
            || !sameProjectRoot(activeRoot, projectRoot)
          ) {
            return null;
          }
          return {
            projectRoot,
            projectIdentity,
            sceneId: 'main',
            editorKind: 'blockly',
          };
        },
        isSameProjectRoot: sameProjectRoot,
      };
      const files = createSimulatorElectronProjectArtifactFilePort({
        path: {
          join: (...segments) => window['path'].join(...segments),
          resolve: (filePath) => window['path'].resolve(filePath),
          relative: (from, to) => window['path'].relative(from, to),
        },
        fs: {
          existsSync: (filePath) => window['fs'].existsSync(filePath),
          readFileBufferAsync: (filePath) => (
            trackOriginal(() => window['fs'].readFileBufferAsync(filePath))
          ),
          replaceProjectText: (request, assertCurrent) => (
            trackOriginal(() => window['fs'].replaceProjectText(request, assertCurrent))
          ),
          lstatSync: (filePath) => window['fs'].lstatSync(filePath),
          realpathAsync: (filePath) => trackOriginal(() => window['fs'].realpathAsync(filePath)),
        },
      });
      const composition = new SimulatorBuildProductComposition({
        projectRoot,
        projectIdentity,
        workspaceIdentity,
        sceneId: 'main',
        files,
        activeProject,
        mainAgent: this.simulatorMainAgent,
        builderService: this.builder,
        readWorkspaceSource: async (signal) => {
          if (signal.aborted) {
            throw new SimulatorHostProviderOperationError('cancelled');
          }
          if (!activeProject.readActiveBinding()) return null;
          const revision = this.blockly.getWorkspaceContentRevision();
          const code = this.blockly.getReusableGeneratedCode();
          if (code === null) return null;
          const sourceSha256 = await sha256Text(code);
          if (signal.aborted) {
            throw new SimulatorHostProviderOperationError('cancelled');
          }
          // Hashing is asynchronous: never pair an old source with a changed
          // project, generation revision, or active workspace edit lease.
          const isCurrent = () => (
            !!activeProject.readActiveBinding()
            && revision === this.blockly.getWorkspaceContentRevision()
            && code === this.blockly.getReusableGeneratedCode()
          );
          return isCurrent() ? { sha256: sourceSha256, isCurrent } : null;
        },
      });
      cleanup.add(() => composition.close());
      const demonstrations = new SimulatorBoardDemonstrationProvider({ projectIdentity, projectRoot, workspaceIdentity, files,
        compile: async (board, graph, signal, program) => {
          const streamId = `board-demo-${crypto.randomUUID()}`;
          const script = window['path'].join(window['path'].getAilyChildPath(), 'scripts', 'compile-board-demonstration.js');
          const cancel = () => { void this.commands.kill(streamId); };

          signal.addEventListener('abort', cancel, { once: true });

          try {
            const result = await lastValueFrom(this.commands.spawn('node', [script, board.path, board.demoPath, window['path'].getAppDataPath(), graph, ...(program ? [program] : [])],
              { streamId, signal }, true));

            signal.throwIfAborted();

            if (result.type !== 'close' || result.code !== 0) throw new Error(result.stderr || 'Board demonstration compilation failed.');

            const line = result.stdout?.split(/\r?\n/).findLast(line => line.startsWith('AILY_DEMO_BUILD '));
            const built = line && JSON.parse(line.slice('AILY_DEMO_BUILD '.length));

            if (typeof built?.root !== 'string') throw new Error('Board demonstration compilation returned no Artifact directory.');

            return built.root;
          } finally {
            signal.removeEventListener('abort', cancel);

            if (signal.aborted) await this.commands.kill(streamId);
          }
        },
        assertCurrent: () => {
          if (!activeProject.readActiveBinding()) throw new SimulatorHostProviderOperationError('conflict');
        },
        readBoard: async signal => {
          const path = await this.project.getBoardPackagePath();
          const manifest = await this.project.getBoardPackageJson();

          if (!activeProject.readActiveBinding() || (this.project.getRuntimeBoardModule()
            && this.project.getRuntimeBoardModule() !== manifest.name)) throw new SimulatorHostProviderOperationError('conflict');

          const packagePath = runtimePackagePath;

          if (!packagePath) throw new SimulatorHostProviderOperationError('operation-failed', 'Simulator resources are unavailable.');

          const assets = files.join(packagePath, 'assets');

          const index = JSON.parse(new TextDecoder('utf-8', { fatal: true })
            .decode(await files.readFile(files.join(assets, 'demo-index.json'), signal)));

          const id = index[manifest.name];

          if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
            throw new SimulatorHostProviderOperationError('operation-failed', 'This board has no demonstration resources.');
          }

          return { id, path, demoPath: files.join(assets, id, 'demo'), name: manifest.name, version: manifest.version };
        },
      });

      cleanup.add(() => demonstrations.close());

      const editor = new SimulatorBlocklyEditorCallbackAuthority({
        projectRoot,
        projectIdentity,
        sceneId: 'main',
        activeProject,
        source: {
          readState: (boundProjectRoot) => {
            const state = this.projectDebug.refresh(boundProjectRoot);
            return {
              sourceMapRevision: state.sourceMapRevision,
              sourcePath: state.artifactSourcePath,
              workspaceCurrent: state.buildConsistency === 'current',
            };
          },
          resolveBlockIdByGeneratedLine: (line) => (
            this.blockly.getBlockIdByGeneratedLine(line)
          ),
        },
        view: {
          hasBlock: (blockId) => this.blockly.hasWorkspaceBlock(blockId),
          showDebugBlock: (boundProjectRoot, blockId, focus) => {
            this.ngZone.run(() => {
              this.blockly.setDebugExecutionMarker(
                boundProjectRoot,
                blockId,
                { focus },
              );
            });
          },
          clearDebugBlock: (boundProjectRoot) => {
            this.ngZone.run(() => {
              this.blockly.clearDebugExecutionMarker(boundProjectRoot);
            });
          },
        },
      });
      cleanup.add(() => editor.close());
      const entitlement = new SimulatorEntitlementCallbackAuthority({
        account: this.entitlementAccount,
      });
      cleanup.add(() => entitlement.close());
      const projectActivationSubscription =
        // An activation event itself revokes this capture. Do not depend on
        // whether other subscribers have already updated their selected state.
        this.project.projectActivation$.subscribe(ended);
      cleanup.add(() => projectActivationSubscription.unsubscribe());
      const callbacks = Object.freeze<SimulatorProjectHostProviderAdapterOptions>({
        requestBoardDemonstrationCode: (request, current) => run(current, async signal => {
          const source = await demonstrations.read({ projectIdentity: request.projectIdentity, lessonId: request.lessonId }, signal);
          const lesson = source.script.lessons.find(item => item.id === request.lessonId);

          if (!lesson || source.boardPackageName !== request.boardPackageName || source.revision !== request.expectedRevision
            || source.sourceCode !== request.sourceCode || !activeProject.readActiveBinding()) {
            throw new SimulatorHostProviderOperationError('conflict');
          }

          const result = await this.demandSessions.sendLessonCode(projectRoot,
            `请根据「${source.script.title} / ${lesson.title}」的示例，把对应功能添加到当前项目代码中。先读取当前代码，保留已有功能，按当前开发板的引脚和库配置合并初始化与循环逻辑。不要整段覆盖项目代码，也不要修改课程示例文件。\n\n课程说明：${lesson.explanation}\n\n参考程序已作为资源附在本条消息中。`,
            `添加课程功能：${lesson.title}`, [{ type: 'file', name: 'demo.ino', content: source.sourceCode }], signal);

          if (!result.sessionId) throw new SimulatorHostProviderOperationError('operation-failed');

          return { projectIdentity: request.projectIdentity, lessonId: lesson.id, sessionId: result.sessionId };
        }),
        compileBoardDemonstration: (request, current) => run(current, signal => demonstrations.compile(request, signal)),
        readBoardDemonstration: (request, current) => run(current, signal => demonstrations.read(request, signal)),
        writeBoardDemonstration: (request, current) => run(current, signal => demonstrations.write(request, signal)),
        readContext: (request, current) => run(current, bound => composition.projectCallbacks.readContext(request, bound)),
        readScene: (request, current) => run(current, bound => composition.projectCallbacks.readScene(request, bound)),
        writeScene: (request, current) => run(current, bound => composition.projectCallbacks.writeScene(request, bound)),
        readArtifact: (request, current) => run(current, bound => composition.projectCallbacks.readArtifact(request, bound)),
        readArtifactChunk: (request, current) => run(current, bound => demonstrations.hasArtifactReference(request.artifactReference)
          ? demonstrations.readArtifactChunk(request, bound)
          : composition.projectCallbacks.readArtifactChunk(request, bound)),
        readHardwareIntent: (request, current) => run(current, bound => this.hardwareIntent.resolve(request, bound)),
        readDebugConfiguration: (request, current) => run(current, bound => this.readProjectDebugConfiguration({
          request, signal: bound, projectRoot, projectIdentity, composition, activeProject,
        })),
      });
      const captureArtifactReadAuthority = (input: SimulatorProjectReadAuthorityCapture) => {
        return captureSimulatorProjectReadAuthority(input, {
          activation: activationSignal, projectIdentity, workspaceIdentity, requireCurrent,
          captureValidity: descriptor => composition.captureArtifactReadValidity(descriptor),
          readWorkspaceState: () => ({ revision: this.blockly.getWorkspaceContentRevision(), code: this.blockly.getReusableGeneratedCode() }),
          readContext: async signal => callbacks.readContext({ projectIdentity }, signal),
        });
      };
      const bundle = createSimulatorHostProviderDispatcherAdapterBundle({
        project: callbacks,
        build: composition.buildCallbacks,
        editor: editor.callbacks,
        entitlement: entitlement.callbacks,
      });
      cleanup.add(() => bundle.close());
      let projectAdapter: SimulatorProjectHostProviderAdapter | null = null;
      cleanup.add(() => projectAdapter?.close());
      activationSignal.addEventListener('abort', ended, { once: true });
      cleanup.add(() => activationSignal.removeEventListener('abort', ended));
      requireCurrent();
      return Object.freeze({
        activation: Object.freeze({ path: captured.path, projectSessionId: captured.projectSessionId,
          signal: activationSignal, requireCurrent }),
        projectIdentity, workspaceIdentity, sceneId: 'main' as const,
        get project() { requireCurrent(); return projectAdapter ??= new SimulatorProjectHostProviderAdapter(callbacks); },
        callbacks, buildCallbacks: composition.buildCallbacks, editorCallbacks: editor.callbacks,
        entitlementCallbacks: entitlement.callbacks, adapters: bundle.adapters,
        requireCurrent, captureArtifactReadAuthority, close,
        snapshot: () => ({ closeRequested, closed, pendingOperations: pending.size, retainedCleanupSteps: cleanup.size,
          cleanupPending: closing !== null, WorkerPhysicalExitConfirmed: false as const,
          NodeBusinessACK: false as const, MainBusinessACK: false as const }),
      });
    } catch (error) {
      try { await close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Simulator product scope creation and cleanup failed.'); }
      throw error;
    }
  }

  private readActiveBlocklyProjectRoot(): string | null {
    const projectRoot = this.project.currentProjectPath;
    if (
      !projectRoot
      || this.project.isProjectOpening
      || this.project.isAilyCodeProject(projectRoot)
    ) {
      return null;
    }
    return projectRoot;
  }

  private async readProjectDebugConfiguration(input: {
    request: SimulatorSubappHostProjectDebugConfigurationReadV1;
    signal: AbortSignal;
    projectRoot: string;
    projectIdentity: string;
    composition: SimulatorBuildProductComposition;
    activeProject: SimulatorActiveProjectBindingPort;
  }): Promise<SimulatorSubappHostProjectDebugConfigurationSnapshotV1> {
    if (input.signal.aborted) {
      throw new SimulatorHostProviderOperationError('cancelled');
    }
    const binding = input.activeProject.readActiveBinding();
    if (
      !binding
      || binding.projectIdentity !== input.projectIdentity
      || input.request.projectIdentity !== input.projectIdentity
      || !sameProjectRoot(binding.projectRoot, input.projectRoot)
    ) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
    const context = await input.composition.projectCallbacks.readContext(
      { projectIdentity: input.projectIdentity },
      input.signal,
    );
    if (
      context.activeArtifactRevision !== input.request.artifactRevision
    ) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
    const state = this.projectDebug.refresh(input.projectRoot);
    if (input.signal.aborted) {
      throw new SimulatorHostProviderOperationError('cancelled');
    }
    if (state.configurationError || state.sourceMapError) {
      throw new SimulatorHostProviderOperationError('operation-failed');
    }
    if (
      state.sourceMapRevision !== input.request.sourceMapRevision
      || state.buildConsistency === 'dirty'
    ) {
      throw new SimulatorHostProviderOperationError('conflict');
    }
    return {
      schemaVersion: 1,
      kind: 'aily-simulator-host-project-debug-configuration-snapshot',
      projectIdentity: input.projectIdentity,
      artifactRevision: input.request.artifactRevision,
      sourceMapRevision: input.request.sourceMapRevision,
      configuration: {
        ...state.configuration,
        breakpoints: state.configuration.breakpoints
          .filter((breakpoint) => (
            breakpoint.sourceMapRevision === input.request.sourceMapRevision
          ))
          .map((breakpoint) => ({ ...breakpoint })),
      },
    };
  }
}

async function bindProviderSession(
  context: SubappHostProviderProductOpenContext,
  adapters: readonly SubappHostProviderAdapter[],
  closeProduct: () => void | Promise<void>,
): Promise<SubappHostProviderProductSession> {
  const dispatcher = new SubappHostProviderDispatcher({
    hostInstanceId: `simulator-host:${context.hostInstanceId}`,
    adapters,
    maxMessageBytes: SIMULATOR_PROVIDER_MESSAGE_BUDGET,
  });
  let unbind: (() => void) | null = null;
  // Each successful release is recorded independently. Closing intent remains
  // latched after a failure, while the exact failed release can be retried.
  const releases = new Set<() => void | Promise<void>>([
    () => dispatcher.close(),
    () => { unbind?.(); unbind = null; },
    closeProduct,
  ]);
  let closed = false, closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    const original = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const release of [...releases]) {
        try { await release(); releases.delete(release); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Simulator provider session cleanup remains unconfirmed.');
      closed = true;
    }).finally(() => { if (closing === original) closing = null; });
    closing = original;
    void original.catch(() => { /* Retain the original failed release for retry. */ });
    return original;
  };
  try {
    unbind = dispatcher.bindTransport(context.transport);
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Simulator provider binding and cleanup failed.'); }
    throw error;
  }
  return Object.freeze({ close });
}

function normalizeProjectRoot(projectRoot: string): string {
  const normalized = window['path'].resolve(projectRoot)
    .replaceAll('\\', '/')
    .replace(/\/+$/u, '');
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

function sameProjectRoot(left: string, right: string): boolean {
  return normalizeProjectRoot(left) === normalizeProjectRoot(right);
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:\//u.test(value);
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
