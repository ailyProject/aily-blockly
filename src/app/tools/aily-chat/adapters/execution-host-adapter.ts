import type {
  IAilyHostAPI,
  IBuildProvider,
  IConnectionGraphProvider,
  IEditorProvider,
  IProjectProvider,
} from '../core/host-api';
import type {
  ChatRuntimeHostResourceOperationPayload,
  ChatRuntimeHostResourceOperationRequest,
  ChatRuntimeHostResourceOperationResult,
  ChatRuntimeHostSessionId,
} from '../core/chat-runtime-host-contract';

export interface ExecutionHostResourceClient {
  requestResourceOperation(request: ChatRuntimeHostResourceOperationRequest): Promise<ChatRuntimeHostResourceOperationResult>;
}

export interface ExecutionHostProjectSnapshot {
  readonly projectOpened?: boolean;
  readonly path?: string;
  readonly rootPath?: string;
  readonly board?: string;
  readonly name?: string;
}

export interface ExecutionHostAdapterDeps {
  readonly sessionId: ChatRuntimeHostSessionId;
  readonly baseHost: Pick<
    IAilyHostAPI,
    | 'fs'
    | 'path'
    | 'terminal'
    | 'dialog'
    | 'platform'
    | 'auth'
    | 'config'
    | 'notification'
    | 'env'
    | 'shell'
    | 'clipboard'
    | 'log'
    | 'mcp'
  >;
  readonly resourceClient: ExecutionHostResourceClient;
  readonly initialProjectSnapshot?: ExecutionHostProjectSnapshot | null;
}

export function createExecutionHostAdapter(deps: ExecutionHostAdapterDeps): IAilyHostAPI {
  let projectSnapshot = normalizeProjectSnapshot(deps.initialProjectSnapshot);

  const requestResource = async (
    kind: ChatRuntimeHostResourceOperationRequest['kind'],
    payload: ChatRuntimeHostResourceOperationPayload,
  ): Promise<unknown> => {
    const result = await deps.resourceClient.requestResourceOperation({
      sessionId: deps.sessionId,
      kind,
      payload,
    });
    return result.result;
  };

  const requestProjectInfo = async (action: 'getProjectInfo' | 'getPackageJson' | 'getBoardJson' | 'getBoardModule' | 'getBoardPackageJson') =>
    await requestResource('project-info', { adapter: 'project', action });

  const project: IProjectProvider = {
    get currentProjectPath() {
      return projectSnapshot.path;
    },
    get projectRootPath() {
      return projectSnapshot.rootPath || projectSnapshot.path;
    },
    get currentBoard() {
      return projectSnapshot.board;
    },
    get projectName() {
      return projectSnapshot.name;
    },
    getProjectInfo: async () => {
      const info = await requestProjectInfo('getProjectInfo');
      projectSnapshot = normalizeProjectSnapshot(info);
      return info;
    },
    getPackageJson: async () => await requestProjectInfo('getPackageJson'),
    getBoardJson: async () => await requestProjectInfo('getBoardJson'),
    getBoardModule: async () => String(await requestProjectInfo('getBoardModule') ?? ''),
    getBoardPackageJson: async () => await requestProjectInfo('getBoardPackageJson'),
  };

  const builder: IBuildProvider = {
    build: async (projectPath: string) => normalizeBuildResult(await requestResource('project-build', {
      adapter: 'builder',
      action: 'build',
      projectPath,
    })),
    upload: async (projectPath: string, port: string) => normalizeBuildResult(await requestResource('project-build', {
      adapter: 'builder',
      action: 'upload',
      projectPath,
      port,
    })),
  };

  const connectionGraph: IConnectionGraphProvider = {
    generateConnectionGraph: async args => await requestConnectionGraph('generateConnectionGraph', args),
    getPinmapSummary: async args => await requestConnectionGraph('getPinmapSummary', args),
    validateConnectionGraph: async args => await requestConnectionGraph('validateConnectionGraph', args),
    getSensorPinmapCatalog: async args => await requestConnectionGraph('getSensorPinmapCatalog', args),
    generatePinmap: async args => await requestConnectionGraph('generatePinmap', args),
    savePinmap: async args => await requestConnectionGraph('savePinmap', args),
    getCurrentSchematic: async args => await requestConnectionGraph('getCurrentSchematic', args),
    applySchematic: async args => await requestConnectionGraph('applySchematic', args),
  };

  async function requestConnectionGraph(
    action: NonNullable<ChatRuntimeHostResourceOperationPayload extends infer P
      ? P extends { adapter: 'connectionGraph'; action: infer A } ? A : never
      : never>,
    args: unknown,
  ): Promise<unknown> {
    return await requestResource('connection-graph', {
      adapter: 'connectionGraph',
      action,
      args,
    });
  }

  const editor: IEditorProvider = {
    getWorkspaceXml: () => requestBlocklyWorkspace('getWorkspaceXml') as unknown as string,
    loadWorkspace: (xml: string) => {
      void requestBlocklyWorkspace('loadWorkspace', { xml });
    },
    getGeneratedCode: () => requestBlocklyWorkspace('getGeneratedCode') as unknown as string,
    reloadAbiJson: () => {
      void requestBlocklyWorkspace('reloadAbiJson');
    },
    getBlockDefinitions: () => requestBlocklyWorkspace('getBlockDefinitions') as unknown as any[],
    connectionGraph,
  };

  const arduinoLint = {
    checkSyntax: async (code: string, options?: Readonly<Record<string, unknown>>) => await requestResource('project-lint', {
      adapter: 'arduinoLint',
      action: 'checkSyntax',
      code,
      options,
    }),
  };

  return {
    ...deps.baseHost,
    project,
    builder,
    editor,
    connectionGraph,
    arduinoLint,
    blockly: undefined,
    absSync: undefined,
    cmd: undefined,
    crossPlatformCmd: undefined,
    notice: undefined,
    electron: undefined,
    ui: undefined,
    onboarding: undefined,
  };

  async function requestBlocklyWorkspace(
    action: 'getWorkspaceXml' | 'loadWorkspace' | 'getGeneratedCode' | 'reloadAbiJson' | 'getBlockDefinitions',
    extras: { xml?: string } = {},
  ): Promise<unknown> {
    return await requestResource('blockly-workspace', {
      adapter: 'blockly',
      action,
      ...extras,
    });
  }
}

function normalizeProjectSnapshot(value: unknown): Required<ExecutionHostProjectSnapshot> {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const projectOpened = record['projectOpened'] !== false;
  const path = projectOpened ? normalizeString(record['path']) : '';
  return {
    projectOpened,
    path,
    rootPath: normalizeString(record['rootPath']) || path,
    board: normalizeString(record['board']),
    name: normalizeString(record['name']),
  };
}

function normalizeBuildResult(value: unknown): { success: boolean; output: string } {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if ('success' in record || 'output' in record) {
    return {
      success: record['success'] !== false,
      output: normalizeString(record['output']) || JSON.stringify(value ?? null),
    };
  }
  return {
    success: record['state'] !== 'error' && record['state'] !== 'warn',
    output: normalizeString(record['text']) || normalizeString(record['output']) || JSON.stringify(value ?? null),
  };
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
