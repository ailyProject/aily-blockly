import { Injectable, NgZone } from '@angular/core';
import {
  SimulatorHostProviderOperationError,
  createSimulatorHostProviderDispatcherAdapterBundle,
  type SimulatorSubappHostProjectDebugConfigurationReadV1,
  type SimulatorSubappHostProjectDebugConfigurationSnapshotV1,
} from '@aily-project/simulator-host-sdk';

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
    const projectRoot = this.readActiveBlocklyProjectRoot();
    if (!projectRoot) {
      return bindProviderSession(context, [], () => undefined);
    }
    const normalizedRoot = normalizeProjectRoot(projectRoot);
    const rootDigest = await sha256Text(normalizedRoot);
    const activeAfterDigest = this.readActiveBlocklyProjectRoot();
    if (!activeAfterDigest || !sameProjectRoot(activeAfterDigest, projectRoot)) {
      return bindProviderSession(context, [], () => undefined);
    }
    const projectIdentity = `project-v1-${rootDigest}`;
    const workspaceIdentity = `workspace-v1-${rootDigest}`;
    const activeProject: SimulatorActiveProjectBindingPort = {
      readActiveBinding: () => {
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
          window['fs'].readFileBufferAsync(filePath)
        ),
        writeFileBufferAtomicAsync: (filePath, bytes) => (
          window['fs'].writeFileBufferAtomicAsync(filePath, bytes)
        ),
        lstatSync: (filePath) => window['fs'].lstatSync(filePath),
        realpathAsync: (filePath) => window['fs'].realpathAsync(filePath),
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
    });
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
    const entitlement = new SimulatorEntitlementCallbackAuthority({
      account: this.entitlementAccount,
    });
    const projectActivationSubscription =
      this.project.projectActivation$.subscribe(() => {
        const activeRoot = this.project.currentProjectPath;
        if (!activeRoot || !sameProjectRoot(activeRoot, projectRoot)) {
          editor.clearDebugMarker();
        }
      });
    let bundle: ReturnType<
      typeof createSimulatorHostProviderDispatcherAdapterBundle
    >;
    try {
      bundle =
        createSimulatorHostProviderDispatcherAdapterBundle({
          project: {
            ...composition.projectCallbacks,
            readHardwareIntent: (request, signal) => (
              this.hardwareIntent.resolve(request, signal)
            ),
            readDebugConfiguration: (request, signal) => (
              this.readProjectDebugConfiguration({
                request,
                signal,
                projectRoot,
                projectIdentity,
                composition,
                activeProject,
              })
            ),
          },
          build: composition.buildCallbacks,
          editor: editor.callbacks,
          entitlement: entitlement.callbacks,
        });
    } catch (error) {
      projectActivationSubscription.unsubscribe();
      entitlement.close();
      editor.close();
      composition.close();
      throw error;
    }
    return bindProviderSession(
      context,
      bundle.adapters as readonly SubappHostProviderAdapter[],
      () => {
        projectActivationSubscription.unsubscribe();
        bundle.close();
        entitlement.close();
        editor.close();
        composition.close();
      },
    );
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
  try {
    unbind = dispatcher.bindTransport(context.transport);
  } catch (error) {
    await dispatcher.close();
    await closeProduct();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    async close() {
      if (closed) return;
      closed = true;
      unbind?.();
      unbind = null;
      await dispatcher.close();
      await closeProduct();
    },
  });
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
