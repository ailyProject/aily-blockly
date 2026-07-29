import {
  Component,
  NgZone,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { Subscription } from 'rxjs';

import { IframeComponent } from '../../../windows/iframe/iframe.component';
import { ConnectionGraphService } from '../../../services/connection-graph.service';
import { ProjectService } from '../../../services/project.service';
import { ThemeService } from '../../../services/theme.service';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';
import {
  DebugInspectionSnapshot,
  DebugConfigurationRestoreReport,
  DebugConfigurationSnapshot,
  DebugMemoryCapabilities,
  DebugMemoryReadResult,
  DebugRegisterSnapshot,
  DebugSessionSnapshot,
  DebugStackFrame,
  DebugVariableChildrenPage,
  DebugVariableTreeNode,
  DebugVariableTreeSnapshot,
  decodeGatewayBase64,
  RuntimeCrashEvent,
  RuntimeEnvelope,
  SimulationArtifact,
  SimulationManifest,
  SimulatorGatewayError,
  SimulatorGatewayClient,
  SimulatorSessionState,
  SimulatorSessionView,
} from './simulator-gateway-client';
import {
  createEmptyProjectDebugConfiguration,
  ProjectBuildConsistency,
  ProjectDebugConfiguration,
  ProjectDebugConfigurationService,
} from '../../../services/project-debug-configuration.service';
import {
  SimulatorIframeBridgeService,
  SimulatorIframeDebugOperationRequest,
  SimulatorIframeDeviceAction,
  SimulatorIframeSessionOperation,
  SimulatorIframeSessionState,
  SimulatorIframeUartInput,
} from '../../../services/simulator-iframe-bridge.service';
import {
  hasDebugStoppedContextChanged,
  prepareArtifactSourceBreakpointForGateway,
  type DebugSourceArtifact,
} from './simulator-source-breakpoint';

interface DebugVariablePageState {
  total: number;
  hasMore: boolean;
  truncated: boolean;
}

interface ProjectDebugApplyResult {
  blockId: string;
  status: 'applied' | 'already-active' | 'failed';
  code: string | null;
  message: string | null;
}

interface GatewayBootstrap {
  baseUrl: string;
  accessToken: string;
  artifactDirectory: string;
  artifact: SimulationArtifact;
  debugSource: DebugSourceArtifact | null;
  debugSourceMap?: unknown;
  runtimeSource: string;
  runtimePackId?: string;
  runtimeMode?: string;
}

interface DebugBlockSourceMapping {
  blockId: string;
  executionRole: 'statement' | 'value' | 'unknown';
  ranges: Array<{ startLine: number; endLine: number }>;
  executableRanges?: Array<{ startLine: number; endLine: number }>;
  supportRanges?: Array<{ startLine: number; endLine: number }>;
}

interface DebugSourceMapArtifact {
  revision: string;
  source: {
    file: string;
    sizeBytes: number;
    sha256: string;
  };
  mappings: Map<string, DebugBlockSourceMapping>;
}

type SimulatorUiState =
  | SimulatorSessionState
  | 'disconnected'
  | 'preparing';

const IFRAME_SIMULATION_EVENT_TYPES = new Set([
  'session.state',
  'session.error',
  'uart.data',
  'uart.input.accepted',
  'uart.input.error',
  'runtime.crash',
  'runtime.recovered',
  'device.state',
  'device.snapshot',
  'device.action.result',
  'device.action.error',
  'electrical.diagnostics',
  'debug.state',
]);

@Component({
  selector: 'app-simulator-editor',
  imports: [IframeComponent],
  templateUrl: './simulator-editor.component.html',
  styleUrl: './simulator-editor.component.scss',
})
export class SimulatorEditorComponent implements OnInit, OnDestroy {
  iframeUrl = '';
  state: SimulatorUiState = 'disconnected';
  busyAction = '';
  errorMessage = '';
  sceneWarnings: string[] = [];
  diagnosticText = '';
  runtimeSource = '';
  debugAvailable = false;
  debug: DebugSessionSnapshot = createUnavailableDebugSnapshot();
  debugConfiguration: DebugConfigurationSnapshot =
    createEmptyDebugConfiguration();
  debugRestoreReport: DebugConfigurationRestoreReport | null = null;
  projectDebugConfiguration: ProjectDebugConfiguration =
    createEmptyProjectDebugConfiguration();
  projectDebugConfigurationError = '';
  projectDebugApplyResults: ProjectDebugApplyResult[] = [];
  currentSourceMapRevision = '';
  projectBuildConsistency: ProjectBuildConsistency = 'artifact-unavailable';
  projectBuildConsistencyError = '';
  breakpointFile = 'sketch.ino';
  currentDebugBlockId = '';
  debugInspection: DebugInspectionSnapshot = createEmptyDebugInspection();
  debugRegisters: DebugRegisterSnapshot = createEmptyDebugRegisters();
  readonly debugRegisterPageSize = 32;
  debugMemoryCapabilities: DebugMemoryCapabilities =
    createEmptyDebugMemoryCapabilities();
  debugMemoryResult: DebugMemoryReadResult | null = null;
  debugVariableTree: DebugVariableTreeSnapshot =
    createEmptyDebugVariableTree();
  debugVariableChildren: Record<string, DebugVariableTreeNode[]> = {};
  debugVariablePages: Record<string, DebugVariablePageState> = {};
  debugExpandedVariableHandles = new Set<string>();
  private debugSourceArtifact: DebugSourceArtifact | null = null;
  private debugSourceMapArtifact: DebugSourceMapArtifact | null = null;

  private client: SimulatorGatewayClient | null = null;
  private sessionId: string | null = null;
  private manifest: SimulationManifest | null = null;
  private artifactDirectory = '.';
  private streamAbort: AbortController | null = null;
  private lifecycleAbort = new AbortController();
  private removeGatewayStateListener: (() => void) | null = null;
  private gatewayUnavailable = false;
  private debugMemoryCapabilitiesLoaded = false;
  private projectDebugConfigurationSubscription: Subscription | null = null;
  private blockSelectionSubscription: Subscription | null = null;
  private projectActivationSubscription: Subscription | null = null;
  private runtimeProjectPath: string | null = null;
  private readonly runtimeOwnerId = createSimulatorRuntimeOwnerId();
  private selectedProjectDebugTargetBlockId = '';
  private removeIframeOperationHandlers: (() => void) | null = null;
  private iframeSimulationUiReady = false;
  private destroyed = false;

  constructor(
    private readonly connectionGraphService: ConnectionGraphService,
    private readonly projectService: ProjectService,
    private readonly blocklyService: BlocklyService,
    private readonly projectDebugConfigurationService:
      ProjectDebugConfigurationService,
    private readonly themeService: ThemeService,
    private readonly translate: TranslateService,
    private readonly ngZone: NgZone,
    private readonly simulatorIframeBridge: SimulatorIframeBridgeService,
  ) {}

  ngOnInit(): void {
    this.removeIframeOperationHandlers =
      this.simulatorIframeBridge.registerHandlers({
        session: (operation) =>
          this.executeIframeSessionOperation(operation),
        deviceAction: (input) =>
          this.executeIframeDeviceAction(input),
        uartWrite: (input) => this.writeIframeUartInput(input),
        debug: (request) =>
          this.executeIframeDebugOperation(request),
      });
    const electronApi = (window as any).electronAPI;
    const api = electronApi?.simulatorGateway;
    const language = this.translate.currentLang || 'zh_cn';
    const iframeUrl = resolveSimulatorIframeUrl(api?.iframeUrlOverride);
    iframeUrl.searchParams.set('type', 'json');
    iframeUrl.searchParams.set('simulation', '1');
    iframeUrl.searchParams.set('theme', this.themeService.theme());
    iframeUrl.searchParams.set('lang', language);
    this.iframeUrl = iframeUrl.toString();
    this.removeGatewayStateListener = api?.onStateChanged?.((event) => {
      if (
        !event.unexpected
        || (event.state !== 'stopped' && event.state !== 'failed')
      ) return;
      this.ngZone.run(() => {
        this.streamAbort?.abort();
        this.gatewayUnavailable = true;
        this.state = 'crashed';
        const failure = event.failure;
        this.errorMessage = failure?.message
          || `本地仿真服务意外退出（code=${event.code ?? 'unknown'}）。`;
        if (failure?.stderrTail) {
          this.diagnosticText = tailText(
            `${this.diagnosticText}\n${failure.stderrTail}`,
            100_000,
          );
        }
        void this.forwardIframeHostError(this.errorMessage);
      });
    }) ?? null;
    this.projectDebugConfigurationSubscription =
      this.projectDebugConfigurationService.state$.subscribe((state) => {
        if (state.projectPath !== this.projectService.currentProjectPath) {
          return;
        }
        this.projectDebugConfiguration = state.configuration;
        this.currentSourceMapRevision = state.sourceMapRevision;
        this.projectBuildConsistency = state.buildConsistency;
        this.projectBuildConsistencyError = state.buildConsistencyError;
        this.projectDebugConfigurationError = state.configurationError
          || state.sourceMapError;
        this.projectDebugApplyResults = [];
        void this.syncIframeDebugUiSnapshot();
      });
    this.selectedProjectDebugTargetBlockId =
      this.projectDebugConfigurationService.getSelectedDebugTarget(
        this.projectService.currentProjectPath,
      ) || this.readSelectedBlocklyBlockId();
    this.blockSelectionSubscription =
      this.projectDebugConfigurationService.selectedDebugTarget$.subscribe(
        ({ projectPath, blockId }) => {
          if (projectPath !== this.projectService.currentProjectPath) return;
          this.selectedProjectDebugTargetBlockId = blockId;
          void this.syncIframeDebugUiSnapshot();
        },
      );
    this.projectActivationSubscription =
      this.projectService.projectActivation$.subscribe(({ path: projectPath }) => {
        const runtimeProjectPath = this.runtimeProjectPath;
        if (
          !runtimeProjectPath
          || isSameSimulatorProjectPath(projectPath, runtimeProjectPath)
        ) {
          return;
        }
        this.state = 'disconnected';
        void this.disposeRuntime(runtimeProjectPath, 'project-activation');
      });
    this.loadProjectDebugConfiguration();
    void this.connectIframeSimulationUi();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.lifecycleAbort.abort();
    this.streamAbort?.abort();
    this.removeGatewayStateListener?.();
    this.removeIframeOperationHandlers?.();
    this.removeIframeOperationHandlers = null;
    this.projectDebugConfigurationSubscription?.unsubscribe();
    this.projectDebugConfigurationSubscription = null;
    this.blockSelectionSubscription?.unsubscribe();
    this.blockSelectionSubscription = null;
    this.projectActivationSubscription?.unsubscribe();
    this.projectActivationSubscription = null;
    void this.disposeRuntime(this.runtimeProjectPath, 'component-destroy');
  }

  get selectedProjectDebugBlockId(): string {
    return this.selectedProjectDebugTargetBlockId
      || this.readSelectedBlocklyBlockId();
  }

  get projectBuildConsistencyLabel(): string {
    if (this.projectBuildConsistencyError) {
      return this.projectBuildConsistencyError;
    }
    switch (this.projectBuildConsistency) {
      case 'current':
        return '当前工作区已进入最近 Artifact，可保存或重新绑定块断点。';
      case 'dirty':
        return '工作区已有未编译修改，请重新编译后再绑定块断点。';
      case 'checking':
      case 'workspace-unknown':
        return '正在核对当前工作区与最近 Artifact。';
      default:
        return '缺少可验证的 Blockly Artifact，请先使用最新 Builder 编译。';
    }
  }

  private async executeIframeSessionOperation(
    operation: SimulatorIframeSessionOperation,
  ): Promise<{ state: SimulatorIframeSessionState }> {
    if (this.busyAction) {
      throw new Error(`本地仿真正在执行 ${this.busyAction}。`);
    }
    this.busyAction = operation;
    this.errorMessage = '';
    try {
      if (operation === 'session.start') {
        if (
          !this.client
          || !this.sessionId
          || this.state === 'stopped'
          || (this.state === 'crashed' && this.gatewayUnavailable)
        ) {
          await this.prepareSession();
        }
        const { client, sessionId } = this.requireActiveSession();
        this.applySessionView(await client.command(
          sessionId,
          'start',
          this.lifecycleAbort.signal,
        ));
      } else if (operation === 'session.recover') {
        if (this.gatewayUnavailable) {
          throw new Error('本地 Gateway 已退出，请重新运行仿真。');
        }
        const { client, sessionId } = this.requireActiveSession();
        this.applySessionView(await client.recover(
          sessionId,
          this.lifecycleAbort.signal,
        ));
      } else {
        const command = operation.slice('session.'.length) as
          'pause' | 'resume' | 'reset' | 'stop';
        const { client, sessionId } = this.requireActiveSession();
        this.applySessionView(await client.command(
          sessionId,
          command,
          this.lifecycleAbort.signal,
        ));
      }
      return { state: toIframeSessionState(this.state) };
    } catch (error) {
      this.errorMessage = normalizeError(error);
      if (this.state === 'preparing') this.state = 'disconnected';
      throw error;
    } finally {
      this.busyAction = '';
    }
  }

  private async executeIframeDebugOperation(
    request: SimulatorIframeDebugOperationRequest,
  ): Promise<Record<string, unknown>> {
    if (request.operation === 'debug.snapshot') {
      return this.createIframeDebugSnapshot();
    }
    if (this.busyAction) {
      throw new Error(`本地仿真正在执行 ${this.busyAction}。`);
    }
    this.busyAction = request.operation;
    this.errorMessage = '';
    try {
      if (request.operation === 'debug.connect') {
        const { client, sessionId } = this.requireActiveSession();
        this.applyDebugSnapshot(await client.connectDebugger(
          sessionId,
          this.lifecycleAbort.signal,
        ));
        this.applyDebugConfiguration(await client.getDebugConfiguration(
          sessionId,
          this.lifecycleAbort.signal,
        ));
        await this.refreshDebugStoppedViews();
      } else if (request.operation === 'debug.configuration.restore') {
        const { client, sessionId } = this.requireActiveSession();
        const report = await client.restoreDebugConfiguration(
          sessionId,
          this.lifecycleAbort.signal,
        );
        this.applyDebugConfiguration(report.configuration);
        this.applyDebugSnapshot(report.debug);
        this.debugRestoreReport = report;
        await this.refreshDebugStoppedViews();
      } else if (request.operation === 'debug.configuration.remove') {
        const { client, sessionId } = this.requireActiveSession();
        this.applyDebugConfiguration(
          await client.removePendingDebugConfiguration(
            sessionId,
            request.payload.kind,
            request.payload.configurationId,
            this.lifecycleAbort.signal,
          ),
        );
      } else if (request.operation === 'debug.breakpoint.add') {
        const { client, sessionId } = this.requireActiveSession();
        const breakpoint = request.payload.kind === 'source'
          ? this.prepareSourceBreakpointForGateway(request.payload)
          : request.payload;
        this.applyDebugSnapshot(await client.addDebugBreakpoint(
          sessionId,
          breakpoint,
          this.lifecycleAbort.signal,
        ));
      } else if (request.operation === 'debug.breakpoint.remove') {
        const { client, sessionId } = this.requireActiveSession();
        this.applyDebugSnapshot(await client.removeDebugBreakpoint(
          sessionId,
          request.payload.id,
          this.lifecycleAbort.signal,
        ));
      } else if (request.operation === 'debug.step-block') {
        const { client, sessionId } = this.requireActiveSession();
        const result = await client.stepDebuggerToBlock(
          sessionId,
          this.lifecycleAbort.signal,
        );
        this.applyDebugSnapshot(result.debug);
        await this.refreshDebugStoppedViews();
      } else if (
        request.operation === 'debug.continue'
        || request.operation === 'debug.interrupt'
        || request.operation === 'debug.step-over'
        || request.operation === 'debug.step-into'
        || request.operation === 'debug.disconnect'
      ) {
        const { client, sessionId } = this.requireActiveSession();
        const command = request.operation.slice('debug.'.length) as
          | 'continue'
          | 'interrupt'
          | 'step-over'
          | 'step-into'
          | 'disconnect';
        const snapshot = await client.commandDebugger(
          sessionId,
          command,
          this.lifecycleAbort.signal,
        );
        this.applyDebugSnapshot(snapshot);
        if (snapshot.state === 'stopped') {
          await this.refreshDebugStoppedViews();
        } else if (command === 'disconnect') {
          this.debugInspection = createEmptyDebugInspection();
          this.debugRegisters = createEmptyDebugRegisters();
          this.clearDebugMemoryResult();
          this.clearDebugVariableTree();
        }
      } else if (request.operation === 'debug.thread.select') {
        await this.refreshDebugInspection(0, request.payload.threadId);
        await Promise.all([
          this.refreshDebugRegisters(0),
          this.refreshDebugVariableTree(0),
        ]);
        const frame = this.debugInspection.stack.find(
          (candidate) => candidate.level === 0,
        );
        if (frame) this.focusDebugFrame(frame);
      } else if (request.operation === 'debug.frame.select') {
        await this.refreshDebugInspection(request.payload.level);
        await this.refreshDebugVariableTree(request.payload.level);
        const frame = this.debugInspection.stack.find(
          (candidate) => candidate.level === request.payload.level,
        );
        if (frame) this.focusDebugFrame(frame);
      } else if (request.operation === 'debug.watch.add') {
        const { client, sessionId } = this.requireActiveSession();
        await client.addDebugWatch(
          sessionId,
          request.payload.expression,
          this.lifecycleAbort.signal,
        );
        await this.refreshDebugInspection(
          this.debugInspection.selectedFrame,
        );
      } else if (request.operation === 'debug.watch.remove') {
        const { client, sessionId } = this.requireActiveSession();
        await client.removeDebugWatch(
          sessionId,
          request.payload.id,
          this.lifecycleAbort.signal,
        );
        await this.refreshDebugInspection(
          this.debugInspection.selectedFrame,
        );
      } else if (request.operation === 'debug.registers.read') {
        await this.refreshDebugRegisters(request.payload.offset);
      } else if (request.operation === 'debug.memory.read') {
        const { client, sessionId } = this.requireActiveSession();
        this.debugMemoryResult = await client.readDebugMemory(
          sessionId,
          request.payload,
          this.lifecycleAbort.signal,
        );
      } else if (request.operation === 'debug.variable.toggle') {
        const handle = request.payload.handle;
        if (this.debugExpandedVariableHandles.has(handle)) {
          const expanded = new Set(this.debugExpandedVariableHandles);
          expanded.delete(handle);
          this.debugExpandedVariableHandles = expanded;
        } else if (
          Object.prototype.hasOwnProperty.call(
            this.debugVariableChildren,
            handle,
          )
        ) {
          this.debugExpandedVariableHandles = new Set([
            ...this.debugExpandedVariableHandles,
            handle,
          ]);
        } else {
          const node = this.findDebugVariableNode(handle);
          if (!node?.expandable) {
            throw new Error('变量句柄不属于当前可展开变量树。');
          }
          await this.loadDebugVariableChildren(node, 0);
        }
      } else if (request.operation === 'debug.variable.load-more') {
        const handle = request.payload.handle;
        const node = this.findDebugVariableNode(handle);
        if (!node || !this.debugVariablePages[handle]?.hasMore) {
          throw new Error('变量没有可继续加载的子项。');
        }
        await this.loadDebugVariableChildren(
          node,
          this.debugVariableChildren[handle]?.length ?? 0,
        );
      } else if (
        request.operation === 'project.debug.run-to-selected'
      ) {
        const { client, sessionId } = this.requireActiveSession();
        const result = await client.runDebuggerToBlock(
          sessionId,
          this.requireSelectedProjectBlockTarget(),
          this.lifecycleAbort.signal,
        );
        this.applyDebugSnapshot(result.debug);
        await this.refreshDebugStoppedViews();
      } else if (
        request.operation
          === 'project.debug.breakpoint.capture-selected'
      ) {
        this.captureSelectedProjectBlockBreakpoint();
      } else if (
        request.operation === 'project.debug.breakpoint.set-enabled'
      ) {
        this.projectDebugConfiguration =
          this.projectDebugConfigurationService.setBreakpointEnabled(
            this.requireProjectPath(),
            request.payload.blockId,
            request.payload.enabled,
          );
        this.projectDebugConfigurationError = '';
        this.projectDebugApplyResults = [];
      } else if (
        request.operation === 'project.debug.breakpoint.remove'
      ) {
        this.projectDebugConfiguration =
          this.projectDebugConfigurationService.removeBreakpoint(
            this.requireProjectPath(),
            request.payload.blockId,
          );
        this.projectDebugConfigurationError = '';
        this.projectDebugApplyResults = [];
      } else if (
        request.operation === 'project.debug.configuration.apply'
      ) {
        await this.applyProjectDebugConfigurationHeadlessly();
      }
      return this.createIframeDebugSnapshot();
    } catch (error) {
      this.errorMessage = normalizeError(error);
      throw error;
    } finally {
      this.busyAction = '';
    }
  }

  private createIframeDebugSnapshot(): Record<string, unknown> {
    const selectedFrame = this.debugInspection.stack.find(
      (frame) => frame.level === this.debugInspection.selectedFrame,
    ) ?? this.debug.frame;
    const currentBlockId = this.currentDebugBlockId
      || selectedFrame?.blockId
      || this.debug.frame?.blockId
      || '';
    return sanitizeDebugSnapshotForIframe({
      available: this.debugAvailable,
      debug: this.debug,
      configuration: this.debugConfiguration,
      restoreReport: this.debugRestoreReport,
      project: {
        configuration: this.projectDebugConfiguration,
        selectedBlockId: this.selectedProjectDebugBlockId,
        selectedBlockMapping: createDebugBlockSourceSummary(
          this.selectedProjectDebugBlockId,
          null,
          this.debugSourceMapArtifact,
        ),
        currentSourceMapRevision: this.currentSourceMapRevision,
        buildConsistency: this.projectBuildConsistency,
        buildConsistencyMessage: this.projectBuildConsistencyLabel,
        error: this.projectDebugConfigurationError,
        applyResults: this.projectDebugApplyResults,
      },
      currentBlockId,
      inspection: this.debugInspection,
      registers: this.debugRegisters,
      registerPageSize: this.debugRegisterPageSize,
      memory: {
        capabilities: this.debugMemoryCapabilities,
        result: this.debugMemoryResult,
      },
      source: createDebugSourceContext(
        this.debug.state,
        selectedFrame,
        currentBlockId,
        this.debugSourceArtifact,
        this.debugSourceMapArtifact,
      ),
      variables: {
        tree: this.debugVariableTree,
        children: this.debugVariableChildren,
        pages: this.debugVariablePages,
        expandedHandles: [...this.debugExpandedVariableHandles],
      },
    });
  }

  private findDebugVariableNode(
    handle: string,
  ): DebugVariableTreeNode | null {
    for (const node of this.debugVariableTree.roots) {
      if (node.handle === handle) return node;
    }
    for (const children of Object.values(this.debugVariableChildren)) {
      const node = children.find((candidate) => candidate.handle === handle);
      if (node) return node;
    }
    return null;
  }

  private prepareSourceBreakpointForGateway(
    payload: {
      kind: 'source';
      file: string;
      line: number;
      sourceRevision?: string;
    },
  ): { kind: 'source'; file: string; line: number } {
    const selectedFrame = this.debugInspection.stack.find(
      (frame) => frame.level === this.debugInspection.selectedFrame,
    ) ?? this.debug.frame;
    return prepareArtifactSourceBreakpointForGateway(
      payload,
      this.debug.state,
      selectedFrame?.location ?? null,
      this.debugSourceArtifact,
    );
  }

  private captureSelectedProjectBlockBreakpoint(): void {
    this.blocklyService.syncSelectedBlocksFromWorkspace();
    const blockId = this.requireSelectedExecutableBlockId();
    const projectPath = this.requireProjectPath();
    const sourceMapRevision =
      this.projectDebugConfigurationService
        .requireBindableSourceMapRevision(projectPath);
    this.projectDebugConfiguration =
      this.projectDebugConfigurationService.upsertBreakpoint(
        projectPath,
        {
          blockId,
          sourceMapRevision,
          enabled: true,
        },
      );
    this.projectDebugConfigurationError = '';
    this.projectDebugApplyResults = [];
  }

  private requireSelectedProjectBlockTarget(): {
    blockId: string;
    sourceMapRevision: string;
  } {
    const blockId = this.requireSelectedExecutableBlockId();
    return {
      blockId,
      sourceMapRevision:
        this.projectDebugConfigurationService
          .requireBindableSourceMapRevision(this.requireProjectPath()),
    };
  }

  private requireSelectedExecutableBlockId(): string {
    const blockId = this.selectedProjectDebugBlockId;
    if (!blockId) {
      throw new Error('请先在 Blockly 工作区选择一个代码块。');
    }
    const mapping = this.debugSourceMapArtifact?.mappings.get(blockId);
    if (!mapping) {
      throw new Error(
        '当前 Artifact 中没有该块的生成源码位置；请重新编译，或选择会生成可执行代码的语句块。',
      );
    }
    if (mapping.executionRole === 'value') {
      throw new Error(
        '值块是父语句中的表达式，不能作为独立 GDB 停点；'
        + '请选择所属语句块。',
      );
    }
    if (debugExecutableRanges(mapping).length === 0) {
      throw new Error(
        '该块只生成声明或辅助代码，没有可绑定的运行时语句；请选择实际执行该功能的语句块。',
      );
    }
    return blockId;
  }

  private readSelectedBlocklyBlockId(): string {
    return this.blocklyService.selectedBlockIdsSubject.value[0]
      || this.blocklyService.selectedBlockSubject.value
      || '';
  }

  private async applyProjectDebugConfigurationHeadlessly(): Promise<void> {
    const { client, sessionId } = this.requireActiveSession();
    const results: ProjectDebugApplyResult[] = [];
    for (
      const breakpoint
      of this.projectDebugConfiguration.breakpoints.filter(
        (item) => item.enabled,
      )
    ) {
      try {
        this.applyDebugSnapshot(await client.addDebugBreakpoint(
          sessionId,
          {
            kind: 'block',
            blockId: breakpoint.blockId,
            sourceMapRevision: breakpoint.sourceMapRevision,
          },
          this.lifecycleAbort.signal,
        ));
        results.push({
          blockId: breakpoint.blockId,
          status: 'applied',
          code: null,
          message: null,
        });
      } catch (error) {
        if (
          error instanceof SimulatorGatewayError
          && error.code === 'duplicate_debug_configuration'
        ) {
          results.push({
            blockId: breakpoint.blockId,
            status: 'already-active',
            code: error.code,
            message: null,
          });
          continue;
        }
        results.push({
          blockId: breakpoint.blockId,
          status: 'failed',
          code: error instanceof SimulatorGatewayError
            ? error.code
            : 'project_debug_apply_failed',
          message: normalizeError(error),
        });
      }
    }
    this.projectDebugApplyResults = results;
    this.applyDebugConfiguration(await client.getDebugConfiguration(
      sessionId,
      this.lifecycleAbort.signal,
    ));
    await this.refreshDebugStoppedViews();
  }

  private async writeIframeUartInput(
    input: SimulatorIframeUartInput,
  ): Promise<{ uart: number; acceptedBytes: number }> {
    const { client, sessionId } = this.requireActiveSession();
    if (this.state !== 'running') {
      throw new Error('UART0 仅可在仿真运行时写入。');
    }
    return client.writeUartInput(
      sessionId,
      input,
      this.lifecycleAbort.signal,
    );
  }

  private async executeIframeDeviceAction(
    input: SimulatorIframeDeviceAction,
  ): Promise<{
    instanceId: string;
    action: string;
    changed: boolean;
    state: Record<string, string | number | boolean>;
  }> {
    const { client, sessionId } = this.requireActiveSession();
    if (this.state !== 'running') {
      throw new Error('器件输入仅可在仿真运行时修改。');
    }
    const component = this.manifest?.components.find(
      (candidate) => candidate.instanceId === input.instanceId,
    );
    if (
      !component
      || !component.capabilities.includes(`action.${input.action}`)
    ) {
      throw new Error('器件或操作不在当前场景能力列表中。');
    }
    validateIframeDeviceActionForComponent(input);
    return client.invokeDeviceAction(
      sessionId,
      input,
      this.lifecycleAbort.signal,
    );
  }

  private async prepareSession(): Promise<void> {
    this.errorMessage = '';
    this.sceneWarnings = [];
    this.state = 'preparing';
    await this.deleteCurrentSession();

    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) throw new Error('请先打开一个 Blockly 项目。');
    const electronApi = (window as any).electronAPI;
    const gatewayApi = electronApi?.simulatorGateway;
    if (!gatewayApi) {
      throw new Error('本地仿真仅支持 Aily Blockly 桌面版。');
    }
    this.runtimeProjectPath = projectPath;
    let bootstrap: GatewayBootstrap;
    try {
      bootstrap = await gatewayApi.start(
        projectPath,
        this.runtimeOwnerId,
      ) as GatewayBootstrap;
    } catch (error) {
      if (this.runtimeProjectPath === projectPath) {
        this.runtimeProjectPath = null;
      }
      throw error;
    }
    if (
      this.destroyed
      || this.projectService.currentProjectPath !== projectPath
    ) {
      await gatewayApi.stop(projectPath, this.runtimeOwnerId)
        .catch(() => undefined);
      if (this.runtimeProjectPath === projectPath) {
        this.runtimeProjectPath = null;
      }
      throw new Error('项目已切换，本次仿真启动已取消。');
    }
    this.runtimeSource = bootstrap.runtimePackId
      ? `${bootstrap.runtimePackId} (${bootstrap.runtimeMode || 'unknown'})`
      : bootstrap.runtimeSource;
    this.artifactDirectory = bootstrap.artifactDirectory;
    this.debugSourceArtifact = validateDebugSourceArtifact(
      bootstrap.debugSource,
    );
    this.debugSourceMapArtifact = validateDebugSourceMapArtifact(
      bootstrap.debugSourceMap,
      bootstrap.artifact,
    );
    this.breakpointFile = basename(
      bootstrap.artifact.build?.source?.path || 'sketch.ino',
    );
    const sourceMapPath = bootstrap.artifact.debug?.sourceMapPath;
    this.currentSourceMapRevision = (
      bootstrap.artifact.files?.find((file) => (
        file.role === 'source-map'
        && (!sourceMapPath || file.path === sourceMapPath)
      ))?.sha256 || ''
    ).toLowerCase();
    if (/^[a-f0-9]{64}$/.test(this.currentSourceMapRevision)) {
      this.projectDebugConfigurationService.setCurrentSourceMapRevision(
        projectPath,
        this.currentSourceMapRevision,
      );
    }
    this.loadProjectDebugConfiguration();
    this.client = new SimulatorGatewayClient(bootstrap);
    this.gatewayUnavailable = false;

    const boardModule = await this.projectService.getBoardModule();
    const boardPackagePath = electronApi.path.join(
      projectPath,
      'node_modules',
      boardModule,
    );
    const connectionGraph = this.connectionGraphService.buildPayload(
      boardPackagePath,
      projectPath,
    );
    if (!connectionGraph) {
      throw new Error('未找到有效连线图，请先生成或保存连线图。');
    }

    const iframeApi = await this.waitForIframeApi();
    if (typeof iframeApi.receiveData === 'function') {
      await iframeApi.receiveData(connectionGraph);
    }

    const compiled = await this.client.compileScene(
      bootstrap.artifact,
      connectionGraph,
      `project-${stableProjectId(projectPath)}`,
      this.lifecycleAbort.signal,
    );
    this.sceneWarnings = compiled.report.warnings.map(
      (warning) => warning.message,
    );
    if (!compiled.manifest || !compiled.report.supported) {
      const blockers = compiled.report.blockers
        .map((blocker) => `${blocker.code}: ${blocker.message}`)
        .join('\n');
      throw new Error(blockers || '当前连线图包含尚未支持的仿真器件。');
    }
    this.manifest = compiled.manifest;
    this.sessionId = createSessionId();

    this.applySessionView(await this.client.createSession({
      sessionId: this.sessionId,
      artifactDirectory: this.artifactDirectory,
      artifact: bootstrap.artifact,
      manifest: compiled.manifest,
    }, this.lifecycleAbort.signal));
    await this.initializeIframeSimulationUi(iframeApi);
    this.startEventStream(iframeApi);
  }

  private startEventStream(iframeApi: any): void {
    if (!this.client || !this.sessionId) return;
    this.streamAbort?.abort();
    this.streamAbort = new AbortController();
    const client = this.client;
    const sessionId = this.sessionId;
    const signal = this.streamAbort.signal;
    void Promise.all([
      Promise.resolve(iframeApi.resetSimulationDisplays?.()),
      this.iframeSimulationUiReady
        ? Promise.resolve(iframeApi.resetSimulationUi?.())
        : Promise.resolve(),
    ])
      .then(() => client.streamEvents(sessionId, {
        signal,
        reconnect: true,
        ...(this.manifest
          ? { expectedSceneRevision: this.manifest.sceneRevision }
          : {}),
        onEvent: async (event) => {
          if (event.type === 'display.frame') {
            await iframeApi.receiveDisplayFrame?.(event.payload);
          }
          await this.forwardSimulationEventToIframe(iframeApi, event);
          this.ngZone.run(() => this.handleRuntimeEvent(event));
        },
      }))
      .catch((error) => {
        if (signal.aborted || this.destroyed) return;
        this.ngZone.run(() => {
          this.gatewayUnavailable = true;
          this.errorMessage = normalizeError(error);
          this.state = 'crashed';
        });
      });
  }

  private async connectIframeSimulationUi(): Promise<void> {
    try {
      const iframeApi = await this.waitForIframeApi();
      await this.initializeIframeSimulationUi(iframeApi);
    } catch (error) {
      if (this.destroyed) return;
      this.errorMessage = normalizeError(error);
      console.error('初始化 iframe 仿真界面失败。', error);
    }
  }

  private async initializeIframeSimulationUi(iframeApi: any): Promise<void> {
    const supported = typeof iframeApi.initializeSimulationUi === 'function'
      && typeof iframeApi.receiveSimulationEvent === 'function'
      && typeof iframeApi.receiveSimulationDebugSnapshot === 'function'
      && typeof iframeApi.resetSimulationUi === 'function';
    if (!supported) {
      this.iframeSimulationUiReady = false;
      throw new Error('当前 iframe 不支持本地仿真控制协议。');
    }
    await iframeApi.initializeSimulationUi({
      protocolVersion: 1,
      operations: [
        'session.start',
        'session.pause',
        'session.resume',
        'session.reset',
        'session.stop',
        'session.recover',
        'device.action',
        'uart.write',
        'debug.snapshot',
        'debug.connect',
        'debug.disconnect',
        'debug.continue',
        'debug.interrupt',
        'debug.step-block',
        'debug.step-over',
        'debug.step-into',
        'debug.configuration.restore',
        'debug.configuration.remove',
        'debug.breakpoint.add',
        'debug.breakpoint.remove',
        'debug.watch.add',
        'debug.watch.remove',
        'debug.thread.select',
        'debug.frame.select',
        'debug.registers.read',
        'debug.memory.read',
        'debug.variable.toggle',
        'debug.variable.load-more',
        'project.debug.run-to-selected',
        'project.debug.breakpoint.capture-selected',
        'project.debug.breakpoint.set-enabled',
        'project.debug.breakpoint.remove',
        'project.debug.configuration.apply',
      ],
      session: {
        commands: [
          'session.start',
          'session.pause',
          'session.resume',
          'session.reset',
          'session.stop',
          'session.recover',
        ],
      },
      uart: {
        ports: [0],
        maxInputBytes: 4096,
      },
      manifest: this.manifest,
      runtime: {
        sourceLabel: this.runtimeSource,
        warnings: this.sceneWarnings,
        debugAvailable: this.debugAvailable,
      },
      debug: this.createIframeDebugSnapshot(),
    });
    this.iframeSimulationUiReady = true;
  }

  private async syncIframeDebugUiSnapshot(): Promise<void> {
    if (!this.iframeSimulationUiReady || this.destroyed) return;
    const iframeApi = this.connectionGraphService.iframeApi;
    if (
      typeof iframeApi?.receiveSimulationDebugSnapshot !== 'function'
    ) {
      return;
    }
    try {
      await iframeApi.receiveSimulationDebugSnapshot(
        this.createIframeDebugSnapshot(),
      );
    } catch (error) {
      if (this.destroyed) return;
      this.iframeSimulationUiReady = false;
      this.errorMessage = normalizeError(error);
      console.error('iframe 调试快照同步失败。', error);
    }
  }

  private async forwardSimulationEventToIframe(
    iframeApi: any,
    event: RuntimeEnvelope,
  ): Promise<void> {
    if (
      !this.iframeSimulationUiReady
      || !IFRAME_SIMULATION_EVENT_TYPES.has(event.type)
    ) {
      return;
    }
    try {
      await iframeApi.receiveSimulationEvent(
        redactSimulationEventForIframe(event),
      );
    } catch (error) {
      this.ngZone.run(() => {
        this.iframeSimulationUiReady = false;
        this.errorMessage = normalizeError(error);
      });
      console.error('iframe 仿真事件转发失败。', error);
    }
  }

  private async forwardIframeHostError(message: string): Promise<void> {
    if (!this.iframeSimulationUiReady || !message) return;
    const iframeApi = this.connectionGraphService.iframeApi;
    if (typeof iframeApi?.receiveSimulationEvent !== 'function') return;
    await iframeApi.receiveSimulationEvent({
      protocolVersion: 1,
      type: 'host.error',
      sequence: 0,
      simulationTimeNs: 0,
      payload: {
        message: message.slice(0, 512),
      },
    }).catch(() => undefined);
  }

  private handleRuntimeEvent(event: RuntimeEnvelope): void {
    if (event.type === 'runtime.crash') {
      const crash = event.payload as RuntimeCrashEvent;
      this.gatewayUnavailable = false;
      this.state = 'crashed';
      this.debugInspection = createEmptyDebugInspection();
      this.debugRegisters = createEmptyDebugRegisters();
      this.clearDebugMemoryResult();
      this.clearDebugVariableTree();
      const exit = crash.signal
        ? `signal=${crash.signal}`
        : `code=${crash.exitCode ?? 'unknown'}`;
      this.errorMessage =
        `QEMU 仿真内核意外退出（generation=${crash.generation}, ${exit}）。\n`
        + `${crash.message}\n`
        + (crash.recoverable
          ? '可点击“恢复”从原始固件重新创建 flash 并启动仿真。'
          : '当前错误不可恢复，请停止后重新运行。');
      void this.syncIframeDebugUiSnapshot();
      return;
    }
    if (event.type === 'runtime.recovered') {
      this.gatewayUnavailable = false;
      this.errorMessage = '';
      return;
    }
    if (event.type === 'debug.configuration') {
      this.applyDebugConfiguration(
        event.payload as DebugConfigurationSnapshot,
      );
      void this.syncIframeDebugUiSnapshot();
      return;
    }
    if (event.type === 'debug.configuration.restore') {
      const report = event.payload as DebugConfigurationRestoreReport;
      this.applyDebugConfiguration(report.configuration);
      this.debugRestoreReport = report;
      void this.syncIframeDebugUiSnapshot();
      return;
    }
    if (event.type === 'session.state') {
      const state = (event.payload as { state?: SimulatorSessionState }).state;
      if (state) this.state = state;
      return;
    }
    if (event.type === 'diagnostic.data') {
      this.diagnosticText = tailText(
        this.diagnosticText + decodeGatewayBase64(event.payload),
        100_000,
      );
      return;
    }
    if (event.type === 'debug.state') {
      const snapshot = event.payload as DebugSessionSnapshot;
      const stoppedContextChanged = hasDebugStoppedContextChanged(
        this.debug,
        snapshot,
      );
      this.applyDebugSnapshot(snapshot);
      if (snapshot.state === 'stopped' && stoppedContextChanged) {
        void this.refreshDebugStoppedViews()
          .then(() => this.syncIframeDebugUiSnapshot());
      } else {
        void this.syncIframeDebugUiSnapshot();
      }
      return;
    }
    if (event.type === 'debug.diagnostic') {
      const message = (event.payload as { message?: unknown }).message;
      if (typeof message === 'string' && message) {
        this.diagnosticText = tailText(
          `${this.diagnosticText}${message}\n`,
          100_000,
        );
      }
      return;
    }
  }

  private applySessionView(view: SimulatorSessionView): void {
    this.gatewayUnavailable = false;
    this.state = view.session.state;
    if (view.runtime) {
      this.debugAvailable = view.runtime.debugAvailable;
      this.applyDebugSnapshot(view.runtime.debug);
      this.applyDebugConfiguration(view.runtime.debugConfiguration);
    }
    if (view.session.lastError) this.errorMessage = view.session.lastError;
  }

  private applyDebugSnapshot(snapshot: DebugSessionSnapshot): void {
    if (!snapshot || typeof snapshot.state !== 'string') return;
    this.debug = snapshot;
    if (snapshot.lastError) this.errorMessage = snapshot.lastError;
    if (snapshot.state === 'stopped' && snapshot.frame) {
      this.focusDebugFrame(snapshot.frame);
    } else {
      this.setCurrentDebugExecutionBlock('');
    }
    if (
      snapshot.state !== 'stopped'
      && snapshot.state !== 'running'
    ) {
      this.debugInspection = createEmptyDebugInspection();
    }
    if (snapshot.state !== 'stopped') {
      this.debugRegisters = createEmptyDebugRegisters();
      this.clearDebugMemoryResult();
      this.clearDebugVariableTree();
    }
  }

  private applyDebugConfiguration(
    snapshot: DebugConfigurationSnapshot,
  ): void {
    if (
      !snapshot
      || !Number.isSafeInteger(snapshot.revision)
      || !Array.isArray(snapshot.breakpoints)
      || !Array.isArray(snapshot.watches)
    ) {
      return;
    }
    if (snapshot.revision !== this.debugConfiguration.revision) {
      this.debugRestoreReport = null;
    }
    this.debugConfiguration = snapshot;
  }

  private focusDebugFrame(frame: DebugStackFrame): void {
    if (frame.blockId) {
      this.setCurrentDebugExecutionBlock(frame.blockId);
      return;
    }
    const location = frame.location;
    const isGeneratedSource = location
      && basename(location.file).toLowerCase()
        === basename(this.breakpointFile).toLowerCase();
    this.setCurrentDebugExecutionBlock(isGeneratedSource
      ? this.blocklyService.getBlockIdByGeneratedLine(location.line) ?? ''
      : '');
  }

  private setCurrentDebugExecutionBlock(blockId: string): void {
    this.currentDebugBlockId = blockId;
    const projectPath = this.projectService.currentProjectPath;
    if (projectPath && blockId) {
      this.blocklyService.setDebugExecutionMarker(projectPath, blockId);
    } else {
      this.blocklyService.clearDebugExecutionMarker();
    }
  }

  private async refreshDebugStoppedViews(frameLevel = 0): Promise<void> {
    await this.refreshDebugInspection(frameLevel);
    await Promise.all([
      this.refreshDebugRegisters(this.debugRegisters.offset),
      this.loadDebugMemoryCapabilities(),
      this.refreshDebugVariableTree(frameLevel),
    ]);
  }

  private async refreshDebugInspection(
    frameLevel = 0,
    threadId?: number,
  ): Promise<void> {
    if (
      !this.client
      || !this.sessionId
      || this.debug.state !== 'stopped'
    ) return;
    const client = this.client;
    const sessionId = this.sessionId;
    try {
      const inspection = await client.inspectDebugger(
        sessionId,
        frameLevel,
        30,
        this.lifecycleAbort.signal,
        threadId,
      );
      if (
        this.client === client
        && this.sessionId === sessionId
        && this.debug.state === 'stopped'
      ) {
        this.debugInspection = inspection;
      }
    } catch (error) {
      if (
        this.client === client
        && this.sessionId === sessionId
        && this.debug.state === 'stopped'
      ) {
        this.errorMessage = normalizeError(error);
      }
    }
  }

  private async refreshDebugRegisters(offset = 0): Promise<void> {
    if (
      !this.client
      || !this.sessionId
      || this.debug.state !== 'stopped'
    ) return;
    const client = this.client;
    const sessionId = this.sessionId;
    try {
      const registers = await client.readDebugRegisters(
        sessionId,
        offset,
        this.debugRegisterPageSize,
        this.lifecycleAbort.signal,
      );
      if (
        this.client === client
        && this.sessionId === sessionId
        && this.debug.state === 'stopped'
      ) {
        this.debugRegisters = registers;
      }
    } catch (error) {
      if (
        this.client === client
        && this.sessionId === sessionId
        && this.debug.state === 'stopped'
      ) {
        this.errorMessage = normalizeError(error);
      }
    }
  }

  private async refreshDebugVariableTree(
    frameLevel = 0,
  ): Promise<void> {
    if (
      !this.client
      || !this.sessionId
      || this.debug.state !== 'stopped'
    ) return;
    const client = this.client;
    const sessionId = this.sessionId;
    try {
      const tree = await client.listDebugVariables(
        sessionId,
        frameLevel,
        32,
        this.lifecycleAbort.signal,
      );
      if (
        this.client === client
        && this.sessionId === sessionId
        && this.debug.state === 'stopped'
      ) {
        this.debugVariableTree = tree;
        this.debugVariableChildren = {};
        this.debugVariablePages = {};
        this.debugExpandedVariableHandles = new Set<string>();
      }
    } catch (error) {
      if (
        this.client === client
        && this.sessionId === sessionId
        && this.debug.state === 'stopped'
      ) {
        this.errorMessage = normalizeError(error);
      }
    }
  }

  private async loadDebugVariableChildren(
    node: DebugVariableTreeNode,
    offset: number,
  ): Promise<void> {
    const handle = node.handle;
    if (!handle) return;
    const { client, sessionId } = this.requireActiveSession();
    let page: DebugVariableChildrenPage;
    try {
      page = await client.expandDebugVariable(
        sessionId,
        handle,
        offset,
        this.debugVariableTree.maxChildrenPerPage,
        this.lifecycleAbort.signal,
      );
    } catch (error) {
      if (
        typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'debug_variable_handle_expired'
      ) {
        await this.refreshDebugVariableTree(
          this.debugInspection.selectedFrame,
        );
        throw new Error('变量句柄已失效，变量树已刷新，请重新展开。');
      }
      throw error;
    }
    if (
      this.client !== client
      || this.sessionId !== sessionId
      || this.debug.state !== 'stopped'
    ) return;
    const current = this.debugVariableChildren[handle] ?? [];
    const byHandle = new Map(
      current
        .filter((child) => child.handle)
        .map((child) => [child.handle!, child]),
    );
    for (const child of page.children) {
      if (child.handle) byHandle.set(child.handle, child);
    }
    const withoutHandle = [
      ...current.filter((child) => !child.handle),
      ...page.children.filter((child) => !child.handle),
    ];
    this.debugVariableChildren = {
      ...this.debugVariableChildren,
      [handle]: [...byHandle.values(), ...withoutHandle],
    };
    this.debugVariablePages = {
      ...this.debugVariablePages,
      [handle]: {
        total: page.total,
        hasMore: page.hasMore,
        truncated: page.truncated,
      },
    };
    this.debugVariableTree = {
      ...this.debugVariableTree,
      totalNodes: page.totalNodes,
    };
    this.debugExpandedVariableHandles = new Set([
      ...this.debugExpandedVariableHandles,
      handle,
    ]);
  }

  private async loadDebugMemoryCapabilities(): Promise<void> {
    if (
      this.debugMemoryCapabilitiesLoaded
      || !this.client
      || !this.sessionId
    ) return;
    const client = this.client;
    const sessionId = this.sessionId;
    try {
      const capabilities = await client.getDebugMemoryCapabilities(
        sessionId,
        this.lifecycleAbort.signal,
      );
      if (this.client !== client || this.sessionId !== sessionId) return;
      this.debugMemoryCapabilities = capabilities;
      this.debugMemoryCapabilitiesLoaded = true;
    } catch (error) {
      if (this.client === client && this.sessionId === sessionId) {
        this.errorMessage = normalizeError(error);
      }
    }
  }

  private clearDebugMemoryResult(): void {
    this.debugMemoryResult = null;
  }

  private clearDebugVariableTree(): void {
    this.debugVariableTree = createEmptyDebugVariableTree();
    this.debugVariableChildren = {};
    this.debugVariablePages = {};
    this.debugExpandedVariableHandles = new Set<string>();
  }

  private loadProjectDebugConfiguration(): void {
    try {
      this.projectDebugConfiguration =
        this.projectDebugConfigurationService.read(
          this.projectService.currentProjectPath,
        );
      this.projectDebugConfigurationError = '';
      this.projectDebugApplyResults = [];
    } catch (error) {
      this.projectDebugConfiguration = createEmptyProjectDebugConfiguration();
      this.projectDebugConfigurationError = normalizeError(error);
    }
  }

  private requireProjectPath(): string {
    const projectPath = this.projectService.currentProjectPath;
    if (!projectPath) throw new Error('请先打开一个 Blockly 项目。');
    return projectPath;
  }

  private requireActiveSession(): {
    client: SimulatorGatewayClient;
    sessionId: string;
  } {
    if (!this.client || !this.sessionId) {
      throw new Error('当前没有活动的仿真会话。');
    }
    return { client: this.client, sessionId: this.sessionId };
  }

  private async waitForIframeApi(): Promise<any> {
    const deadline = Date.now() + 10_000;
    while (!this.destroyed && Date.now() < deadline) {
      const api = this.connectionGraphService.iframeApi;
      if (
        api
        && typeof api.receiveDisplayFrame === 'function'
        && typeof api.resetSimulationDisplays === 'function'
      ) {
        return api;
      }
      await delay(100, this.lifecycleAbort.signal);
    }
    throw new Error('连线图 iframe 尚未就绪，请稍后重试。');
  }

  private async deleteCurrentSession(): Promise<void> {
    this.streamAbort?.abort();
    this.streamAbort = null;
    const client = this.client;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.manifest = null;
    this.debugAvailable = false;
    this.debug = createUnavailableDebugSnapshot();
    this.debugConfiguration = createEmptyDebugConfiguration();
    this.debugRestoreReport = null;
    this.debugInspection = createEmptyDebugInspection();
    this.debugRegisters = createEmptyDebugRegisters();
    this.debugMemoryCapabilities = createEmptyDebugMemoryCapabilities();
    this.debugMemoryCapabilitiesLoaded = false;
    this.clearDebugMemoryResult();
    this.clearDebugVariableTree();
    this.debugSourceArtifact = null;
    this.debugSourceMapArtifact = null;
    this.setCurrentDebugExecutionBlock('');
    if (client && sessionId) {
      await client.deleteSession(sessionId).catch(() => undefined);
    }
  }

  private async disposeRuntime(
    expectedProjectPath: string | null,
    reason: 'component-destroy' | 'project-activation',
  ): Promise<void> {
    console.info('[SimulatorLifecycle][DISPOSE_RUNTIME]', {
      reason,
      expectedProjectPath,
      ownerId: this.runtimeOwnerId,
      hasClient: !!this.client,
      hasSession: !!this.sessionId,
    });
    const disposedClient = this.client;
    if (
      expectedProjectPath
      && this.runtimeProjectPath === expectedProjectPath
    ) {
      this.runtimeProjectPath = null;
    }
    await this.deleteCurrentSession();
    await (window as any).electronAPI?.simulatorGateway
      ?.stop?.(
        expectedProjectPath || undefined,
        this.runtimeOwnerId,
      )
      .catch(() => undefined);
    if (this.client === disposedClient) this.client = null;
  }
}

function redactSimulationEventForIframe(
  event: RuntimeEnvelope,
): {
  protocolVersion: 1;
  type: string;
  sequence: number;
  simulationTimeNs: number;
  payload: Record<string, unknown>;
} {
  const source = isRecord(event.payload) ? event.payload : {};
  let payload: Record<string, unknown>;
  switch (event.type) {
    case 'session.state':
      payload = { state: toIframeSessionState(source['state']) };
      break;
    case 'session.error':
      payload = {
        message: boundedDisplayText(source['message'], 512),
      };
      break;
    case 'uart.data':
      payload = {
        uart: Number.isSafeInteger(source['uart'])
          ? Number(source['uart'])
          : 0,
        dataEncoding: 'base64',
        dataByteLength: Number.isSafeInteger(source['dataByteLength'])
          ? Number(source['dataByteLength'])
          : 0,
        chunkCount: Number.isSafeInteger(source['chunkCount'])
          ? Number(source['chunkCount'])
          : 0,
        dataBase64: typeof source['dataBase64'] === 'string'
          ? source['dataBase64']
          : '',
      };
      break;
    case 'uart.input.accepted':
      payload = {
        acceptedBytes: Number.isSafeInteger(source['acceptedBytes'])
          ? Number(source['acceptedBytes'])
          : 0,
      };
      break;
    case 'uart.input.error':
    case 'device.action.error':
      payload = {
        message: boundedDisplayText(source['message'], 512),
      };
      break;
    case 'runtime.crash': {
      const crash = source as unknown as RuntimeCrashEvent;
      payload = {
        runtime: 'qemu',
        reason: crash.reason,
        phase: crash.phase,
        generation: crash.generation,
        processId: null,
        exitCode: crash.exitCode,
        signal: crash.signal,
        recoverable: crash.recoverable,
        message: boundedDisplayText(crash.message, 512),
      };
      break;
    }
    case 'runtime.recovered':
      payload = {};
      break;
    case 'device.state':
      payload = {
        instanceId: boundedDisplayText(source['instanceId'], 128),
        modelId: boundedDisplayText(source['modelId'], 128),
        reason:
          source['reason'] === 'initial'
          || source['reason'] === 'signal'
          || source['reason'] === 'action'
          || source['reason'] === 'reset'
            ? source['reason']
            : 'signal',
        state: sanitizeSimulationScalarRecord(source['state']),
      };
      break;
    case 'device.snapshot': {
      const states = isRecord(source['deviceStates'])
        ? source['deviceStates']
        : {};
      payload = {
        deviceStates: Object.fromEntries(
          Object.entries(states).map(([instanceId, state]) => [
            instanceId.slice(0, 128),
            sanitizeSimulationScalarRecord(state),
          ]),
        ),
      };
      break;
    }
    case 'device.action.result':
      payload = {
        instanceId: boundedDisplayText(source['instanceId'], 128),
        action: boundedDisplayText(source['action'], 64),
        changed: source['changed'] === true,
        state: sanitizeSimulationScalarRecord(source['state']),
      };
      break;
    case 'electrical.diagnostics': {
      const rawIssues = Array.isArray(source['issues'])
        ? source['issues'].slice(0, 768)
        : [];
      const issues = rawIssues
        .filter(isRecord)
        .map((issue) => {
          const nodeId = boundedDisplayText(issue['nodeId'], 256);
          const nodeIds = [...new Set(
            (
              Array.isArray(issue['nodeIds'])
                ? issue['nodeIds']
                : [issue['nodeId']]
            )
              .slice(0, 512)
              .map((item) => boundedDisplayText(item, 256))
              .filter((item) => item.length > 0),
          )];
          if (nodeId && !nodeIds.includes(nodeId)) nodeIds.unshift(nodeId);
          return {
            code: issue['code'] === 'ELECTRICAL_NODE_CONFLICT'
              ? 'ELECTRICAL_NODE_CONFLICT'
              : 'ELECTRICAL_GPIO_FLOATING',
            severity:
              issue['severity'] === 'error'
              || issue['severity'] === 'warning'
                ? issue['severity']
                : 'info',
            nodeId,
            nodeIds,
            level: issue['level'] === 'conflict' ? 'conflict' : 'floating',
            strength:
              issue['strength'] === 'strong'
              || issue['strength'] === 'weak'
                ? issue['strength']
                : 'none',
            sources: (
              Array.isArray(issue['sources']) ? issue['sources'] : []
            ).slice(0, 320).map((item) => boundedDisplayText(item, 256)),
            message: boundedDisplayText(issue['message'], 512),
          };
        });
      payload = {
        schemaVersion: 1,
        kind: 'aily-electrical-diagnostics',
        revision: Number.isSafeInteger(source['revision'])
          && Number(source['revision']) > 0
            ? Number(source['revision'])
            : 1,
        status: issues.some(({ severity }) => severity === 'error')
          ? 'error'
          : issues.some(({ severity }) => severity === 'warning')
            ? 'warning'
            : issues.length > 0
              ? 'info'
            : 'healthy',
        issues,
      };
      break;
    }
    case 'debug.state':
      payload = {
        state: typeof source['state'] === 'string'
          ? source['state']
          : 'unavailable',
      };
      break;
    default:
      throw new Error(`不允许向 iframe 转发事件 ${event.type}。`);
  }
  return {
    protocolVersion: 1,
    type: event.type,
    sequence: event.sequence,
    simulationTimeNs: event.simulationTimeNs,
    payload,
  };
}

function validateIframeDeviceActionForComponent(
  input: SimulatorIframeDeviceAction,
): void {
  const parameters = input.parameters ?? {};
  if (input.action === 'press' || input.action === 'release') {
    if (Object.keys(parameters).length !== 0) {
      throw new Error('按钮操作不接受参数。');
    }
    return;
  }
  if (input.action === 'setRaw') {
    const raw = parameters['raw'];
    if (
      !Number.isSafeInteger(raw)
      || Number(raw) < 0
      || Number(raw) > 4095
      || Object.keys(parameters).length !== 1
    ) {
      throw new Error('模拟量输入必须为 0..4095 的整数。');
    }
    return;
  }
  if (input.action === 'setTemperatureCelsius') {
    const temperature = parameters['temperatureCelsius'];
    if (
      typeof temperature !== 'number'
      || !Number.isFinite(temperature)
      || temperature < -55
      || temperature > 125
      || Object.keys(parameters).length !== 1
    ) {
      throw new Error('温度输入必须位于 -55..125 °C。');
    }
    return;
  }
  throw new Error('当前 iframe 不允许该器件操作。');
}

function toIframeSessionState(
  value: unknown,
): SimulatorIframeSessionState {
  return value === 'disconnected'
    || value === 'preparing'
    || value === 'idle'
    || value === 'preflighting'
    || value === 'ready'
    || value === 'starting'
    || value === 'running'
    || value === 'paused'
    || value === 'stopping'
    || value === 'stopped'
    || value === 'crashed'
    || value === 'unsupported'
    ? value
    : 'disconnected';
}

function boundedDisplayText(value: unknown, maxLength: number): string {
  return (typeof value === 'string' ? value : String(value ?? ''))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, '[local-path]')
    .replace(/\\\\[^\\\s]+\\[^\s"'<>]*/g, '[local-path]')
    .replace(/(^|\s)\/(?:[^/\s]+\/)+[^\s"'<>]*/g, '$1[local-path]')
    .slice(0, maxLength)
    || '本地仿真操作失败。';
}

function sanitizeDebugSnapshotForIframe(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeDebugSnapshotValue(value, '') as Record<string, unknown>;
}

function sanitizeDebugSnapshotValue(
  value: unknown,
  key: string,
): unknown {
  if (typeof value === 'string') {
    const maxLength = key === 'value'
      ? 4096
      : key === 'text'
        ? 1024
        : 512;
    return value
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g, '[local-path]')
      .replace(/\\\\[^\\\s]+\\[^\s"'<>]*/g, '[local-path]')
      .replace(
        /(^|\s)\/(?:[^/\s]+\/)+[^\s"'<>]*/g,
        '$1[local-path]',
      )
      .slice(0, maxLength);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugSnapshotValue(item, key));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, item]) => [
      entryKey,
      sanitizeDebugSnapshotValue(item, entryKey),
    ]),
  );
}

function sanitizeSimulationScalarRecord(
  value: unknown,
): Record<string, string | number | boolean> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => (
      typeof item === 'string'
      || typeof item === 'number'
      || typeof item === 'boolean'
    )),
  ) as Record<string, string | number | boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function createSessionId(): string {
  return `blockly-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stableProjectId(projectPath: string): string {
  let hash = 2166136261;
  for (const character of projectPath.replace(/\\/g, '/').toLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createUnavailableDebugSnapshot(): DebugSessionSnapshot {
  return {
    state: 'unavailable',
    reason: 'not-configured',
    frame: null,
    breakpoints: [],
    lastError: null,
  };
}

function createEmptyDebugConfiguration(): DebugConfigurationSnapshot {
  return {
    revision: 0,
    restoreRequired: false,
    breakpoints: [],
    watches: [],
  };
}

function createEmptyDebugInspection(): DebugInspectionSnapshot {
  return {
    selectedThreadId: null,
    threads: [],
    selectedFrame: 0,
    stack: [],
    variables: [],
    watches: [],
  };
}

function createEmptyDebugRegisters(): DebugRegisterSnapshot {
  return {
    offset: 0,
    total: 0,
    registers: [],
  };
}

function createEmptyDebugMemoryCapabilities(): DebugMemoryCapabilities {
  return {
    maxReadBytes: 256,
    source: 'unavailable',
    regions: [],
  };
}

function createEmptyDebugVariableTree(): DebugVariableTreeSnapshot {
  return {
    frameLevel: 0,
    maxDepth: 4,
    maxChildrenPerPage: 64,
    maxTotalNodes: 512,
    totalNodes: 0,
    truncated: false,
    roots: [],
  };
}

function validateDebugSourceArtifact(
  value: DebugSourceArtifact | null | undefined,
): DebugSourceArtifact | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value.file !== 'string'
    || !value.file
    || value.file.length > 512
    || /[\\/\u0000-\u001f\u007f]/.test(value.file)
    || !/^[a-f0-9]{64}$/.test(value.revision)
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 0
    || value.sizeBytes > 2 * 1024 * 1024
    || typeof value.content !== 'string'
    || new TextEncoder().encode(value.content).length !== value.sizeBytes
  ) {
    throw new Error('本地仿真服务返回了无效的 Artifact 调试源码。');
  }
  return {
    file: value.file,
    revision: value.revision,
    sizeBytes: value.sizeBytes,
    content: value.content,
  };
}

function validateDebugSourceMapArtifact(
  value: unknown,
  artifact: SimulationArtifact,
): DebugSourceMapArtifact | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new Error('本地仿真服务返回了无效的 Blockly source-map。');
  }
  const raw = value as Record<string, unknown>;
  const source = raw['source'];
  const mappings = raw['mappings'];
  if (
    typeof raw['revision'] !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw['revision'])
    || typeof source !== 'object'
    || source === null
    || Array.isArray(source)
    || !Array.isArray(mappings)
    || mappings.length > 100_000
  ) {
    throw new Error('本地仿真服务返回了无效的 Blockly source-map。');
  }
  const sourceRecord = source as Record<string, unknown>;
  if (
    typeof sourceRecord['file'] !== 'string'
    || sourceRecord['file'].length === 0
    || sourceRecord['file'].length > 512
    || /[\u0000-\u001f\u007f]/.test(sourceRecord['file'])
    || typeof sourceRecord['sizeBytes'] !== 'number'
    || sourceRecord['sizeBytes'] !== artifact.build.source.sizeBytes
    || typeof sourceRecord['sha256'] !== 'string'
    || sourceRecord['sha256'] !== artifact.build.source.sha256
  ) {
    throw new Error('Blockly source-map 与当前 Artifact 编译输入不一致。');
  }
  const sourceMapDescriptor = artifact.files.find((file) => (
    file.role === 'source-map'
    && (
      !artifact.debug?.sourceMapPath
      || file.path === artifact.debug.sourceMapPath
    )
  ));
  if (!sourceMapDescriptor || sourceMapDescriptor.sha256 !== raw['revision']) {
    throw new Error('Blockly source-map revision 与当前 Artifact 不一致。');
  }
  const byBlockId = new Map<string, DebugBlockSourceMapping>();
  for (const [index, item] of mappings.entries()) {
    if (
      typeof item !== 'object'
      || item === null
      || Array.isArray(item)
    ) {
      throw new Error(`Blockly source-map 第 ${index + 1} 个映射无效。`);
    }
    const mapping = item as Record<string, unknown>;
    const blockId = mapping['blockId'];
    const executionRole = mapping['executionRole'];
    const ranges = mapping['ranges'];
    if (
      typeof blockId !== 'string'
      || blockId.length === 0
      || blockId.length > 256
      || /[\u0000-\u001f\u007f]/.test(blockId)
      || byBlockId.has(blockId)
      || (
        executionRole !== 'statement'
        && executionRole !== 'value'
        && executionRole !== 'unknown'
      )
      || !Array.isArray(ranges)
      || ranges.length === 0
      || ranges.length > 1_024
    ) {
      throw new Error(`Blockly source-map 第 ${index + 1} 个映射无效。`);
    }
    const normalizedRanges = normalizeRendererBlockSourceRanges(
      ranges,
      blockId,
      'ranges',
      false,
    );
    const classifiedRanges: Pick<
      DebugBlockSourceMapping,
      'executableRanges' | 'supportRanges'
    > = {};
    for (const field of ['executableRanges', 'supportRanges'] as const) {
      if (mapping[field] === undefined) continue;
      const normalized = normalizeRendererBlockSourceRanges(
        mapping[field],
        blockId,
        field,
        true,
      );
      if (normalized.some((range) => !normalizedRanges.some((owner) => (
        range.startLine >= owner.startLine
        && range.endLine <= owner.endLine
      )))) {
        throw new Error(
          `Blockly source-map ${blockId} 的 ${field} 超出 ranges。`,
        );
      }
      classifiedRanges[field] = normalized;
    }
    byBlockId.set(blockId, {
      blockId,
      executionRole,
      ranges: normalizedRanges,
      ...classifiedRanges,
    });
  }
  return {
    revision: raw['revision'],
    source: {
      file: sourceRecord['file'],
      sizeBytes: sourceRecord['sizeBytes'],
      sha256: sourceRecord['sha256'],
    },
    mappings: byBlockId,
  } as DebugSourceMapArtifact;
}

function normalizeRendererBlockSourceRanges(
  value: unknown,
  blockId: string,
  field: string,
  allowEmpty: boolean,
): Array<{ startLine: number; endLine: number }> {
  if (
    !Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.length > 1_024
  ) {
    throw new Error(`Blockly source-map ${blockId} 的 ${field} 无效。`);
  }
  return value.map((itemRange, rangeIndex) => {
    if (
      typeof itemRange !== 'object'
      || itemRange === null
      || Array.isArray(itemRange)
    ) {
      throw new Error(
        `Blockly source-map ${blockId} 的 ${field} 第 ${rangeIndex + 1} 个区间无效。`,
      );
    }
    const range = itemRange as Record<string, unknown>;
    if (
      !Number.isSafeInteger(range['startLine'])
      || !Number.isSafeInteger(range['endLine'])
      || Number(range['startLine']) < 1
      || Number(range['endLine']) < Number(range['startLine'])
    ) {
      throw new Error(
        `Blockly source-map ${blockId} 的 ${field} 第 ${rangeIndex + 1} 个区间无效。`,
      );
    }
    return {
      startLine: Number(range['startLine']),
      endLine: Number(range['endLine']),
    };
  }).sort((left, right) => (
    left.startLine - right.startLine
    || left.endLine - right.endLine
  ));
}

function debugExecutableRanges(
  mapping: DebugBlockSourceMapping,
): Array<{ startLine: number; endLine: number }> {
  return mapping.executableRanges ?? mapping.ranges;
}

function debugSupportRanges(
  mapping: DebugBlockSourceMapping,
): Array<{ startLine: number; endLine: number }> {
  return mapping.supportRanges ?? [];
}

function createDebugSourceContext(
  state: DebugSessionSnapshot['state'],
  frame: DebugStackFrame | null,
  blockId: string,
  artifact: DebugSourceArtifact | null,
  sourceMap: DebugSourceMapArtifact | null,
): Record<string, unknown> {
  if (state !== 'stopped') {
    return emptyDebugSourceContext('not-stopped');
  }
  const location = frame?.location;
  if (!location) return emptyDebugSourceContext('unavailable');
  const file = basename(location.file).slice(0, 512);
  const currentLine = Number(location.line);
  if (!artifact) {
    return emptyDebugSourceContext(
      'unavailable',
      file,
      currentLine,
      blockId,
    );
  }
  if (file.toLowerCase() !== artifact.file.toLowerCase()) {
    return emptyDebugSourceContext(
      'external-source',
      file,
      currentLine,
      blockId,
    );
  }
  const sourceLines = artifact.content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  if (
    !Number.isSafeInteger(currentLine)
    || currentLine < 1
    || currentLine > sourceLines.length
  ) {
    return emptyDebugSourceContext(
      'unavailable',
      artifact.file,
      currentLine,
      blockId,
    );
  }
  const startLine = Math.max(1, currentLine - 10);
  const endLine = Math.min(sourceLines.length, currentLine + 10);
  return {
    status: 'available',
    file: artifact.file,
    revision: artifact.revision,
    currentLine,
    startLine,
    endLine,
    blockId: blockId.slice(0, 256),
    blockMapping: createDebugBlockSourceSummary(
      blockId,
      currentLine,
      sourceMap,
    ),
    lines: sourceLines
      .slice(startLine - 1, endLine)
      .map((text, offset) => {
        const line = startLine + offset;
        return {
          line,
          text: text.slice(0, 1024),
          current: line === currentLine,
        };
      }),
  };
}

function createDebugBlockSourceSummary(
  blockId: string,
  currentLine: number | null,
  sourceMap: DebugSourceMapArtifact | null,
): Record<string, unknown> | null {
  if (!blockId || !sourceMap) return null;
  const mapping = sourceMap.mappings.get(blockId);
  if (!mapping) return null;
  const currentRangeIndex = currentLine === null
    ? -1
    : mapping.ranges.findIndex((range) => (
        currentLine >= range.startLine && currentLine <= range.endLine
      ));
  // Keep the Blockly-oriented panel compact even for generator-heavy blocks.
  // The protocol hard limit remains 64; the UI snapshot deliberately shows a
  // smaller representative set and always retains the currently hit range.
  const maximumRanges = 8;
  let visibleRanges = mapping.ranges.slice(0, maximumRanges);
  if (currentRangeIndex >= maximumRanges) {
    visibleRanges = [
      ...mapping.ranges.slice(0, maximumRanges - 1),
      mapping.ranges[currentRangeIndex],
    ];
  }
  return {
    blockId: mapping.blockId,
    executionRole: mapping.executionRole,
    totalRanges: mapping.ranges.length,
    executableRangeCount: debugExecutableRanges(mapping).length,
    supportRangeCount: debugSupportRanges(mapping).length,
    truncated: mapping.ranges.length > visibleRanges.length,
    ranges: visibleRanges.map((range, index) => ({
      startLine: range.startLine,
      endLine: range.endLine,
      current: currentRangeIndex >= 0 && (
        currentRangeIndex < maximumRanges
          ? index === currentRangeIndex
          : index === visibleRanges.length - 1
      ),
    })),
  };
}

function emptyDebugSourceContext(
  status: 'unavailable' | 'not-stopped' | 'external-source',
  file = '',
  currentLine: number | null = null,
  blockId = '',
): Record<string, unknown> {
  return {
    status,
    file,
    revision: '',
    currentLine: Number.isSafeInteger(currentLine) && Number(currentLine) >= 1
      ? currentLine
      : null,
    startLine: 0,
    endLine: 0,
    blockId: blockId.slice(0, 256),
    blockMapping: null,
    lines: [],
  };
}

function createSimulatorRuntimeOwnerId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `simulator-editor:${randomId}`;
}

function isSameSimulatorProjectPath(left: string, right: string): boolean {
  const normalize = (value: string) => value
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return normalize(left) === normalize(right);
}

function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || 'sketch.ino';
}

function tailText(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : value.slice(value.length - maximumLength);
}

function resolveSimulatorIframeUrl(override: unknown): URL {
  const productionUrl = new URL('https://tool.aily.pro/connection-graph');
  if (typeof override !== 'string' || !override) return productionUrl;
  try {
    const candidate = new URL(override);
    if (
      candidate.protocol === 'http:'
      && (
        candidate.hostname === '127.0.0.1'
        || candidate.hostname === 'localhost'
        || candidate.hostname === '[::1]'
      )
    ) {
      return candidate;
    }
  } catch {
    // Ignore invalid E2E-only preload overrides.
  }
  return productionUrl;
}

async function delay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
