import type { IToolContribution } from 'aily-lex/browser';
import type { IExternalHostAPI } from 'aily-lex/host/blockly';

import { getBlocklyContextSnapshotService } from './blockly-context-snapshot-service';
import { searchBoardsLibrariesTool } from '../tools/searchBoardsLibrariesTool';
import { getBoardParametersTool } from '../tools/getBoardParametersTool';
import { getHardwareCategoriesTool } from '../tools/getHardwareCategoriesTools';
import { reloadProjectTool } from '../tools/reloadProjectTool';
import { error, fromToolResult, text, type InvokeHandler } from './blockly-contributed-tool-runtime';

type DeferredFactory = (group: string, reason: string) => { group: string; reason: string };
type RuntimeScopedToolContribution = IToolContribution & {
  readonly toolSet?: string;
  readonly runtimeModes?: readonly string[];
};

type ExternalProjectServiceView = NonNullable<IExternalHostAPI['project']> & Record<string, unknown>;

interface AskUserExtension {
  ask(options: {
    question: string;
    options?: { label: string; description?: string; recommended?: boolean }[];
    multiSelect: boolean;
    allowFreeform?: boolean;
    signal?: AbortSignal;
    toolCallId?: string;
    trace?: unknown;
  }): Promise<{ answer: string; cancelled: boolean }>;
}

function readActiveProjectPath(project: NonNullable<IExternalHostAPI['project']>): string {
  const getProjectPath = project.getProjectPath;
  if (typeof getProjectPath === 'function') {
    const projectPath = String(getProjectPath.call(project) ?? '').trim();
    if (projectPath) {
      return projectPath;
    }
  }

  const projectRecord = project as Record<string, unknown>;
  return typeof projectRecord['currentProjectPath'] === 'string'
    ? projectRecord['currentProjectPath'].trim()
    : '';
}

function readExternalProjectPath(project: ExternalProjectServiceView | undefined): string {
  const currentProjectPath = typeof project?.['currentProjectPath'] === 'string' ? project['currentProjectPath'].trim() : '';
  if (currentProjectPath) {
    return currentProjectPath;
  }

  const getProjectPath = project?.['getProjectPath'];
  if (typeof getProjectPath === 'function') {
    const projectPath = String(getProjectPath.call(project) ?? '').trim();
    if (projectPath) {
      return projectPath;
    }
  }

  return typeof project?.['projectRootPath'] === 'string' ? project['projectRootPath'].trim() : '';
}

function createExternalProjectServiceView(project: NonNullable<IExternalHostAPI['project']>): ExternalProjectServiceView {
  const source = project as ExternalProjectServiceView;
  const projectService = Object.create(source) as ExternalProjectServiceView;

  Object.defineProperties(projectService, {
    currentProjectPath: {
      enumerable: true,
      configurable: true,
      get: () => readExternalProjectPath(source),
    },
    projectRootPath: {
      enumerable: true,
      configurable: true,
      get: () => {
        const rootPath = typeof source['projectRootPath'] === 'string' ? source['projectRootPath'].trim() : '';
        return rootPath || readExternalProjectPath(source);
      },
    },
  });

  if (typeof source['getBoardJson'] !== 'function' && typeof source.getBoardConfig === 'function') {
    projectService['getBoardJson'] = () => source.getBoardConfig?.();
  }
  if (typeof source['getBoardModule'] !== 'function' && typeof source.getBoard === 'function') {
    projectService['getBoardModule'] = () => source.getBoard?.();
  }
  if (typeof source['currentBoard'] !== 'string' && typeof source.getBoard === 'function') {
    Object.defineProperty(projectService, 'currentBoard', {
      enumerable: true,
      configurable: true,
      get: () => source.getBoard?.(),
    });
  }

  return projectService;
}

function formatExternalResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
}

type BoardLibrarySearchScope = 'boards' | 'libraries' | 'both';
type BoardLibrarySearchKind = 'board' | 'library';

function canonicalAilyPackageName(name: string, kind: BoardLibrarySearchKind): string | undefined {
  const normalizedName = name.trim();
  if (!normalizedName) {
    return undefined;
  }
  if (normalizedName.startsWith('@')) {
    return normalizedName;
  }

  const expectedPrefix = kind === 'library' ? 'lib-' : 'board-';
  return normalizedName.startsWith(expectedPrefix)
    ? `@aily-project/${normalizedName}`
    : undefined;
}

function inferBoardLibrarySearchKind(
  item: Record<string, unknown>,
  scope: BoardLibrarySearchScope,
): BoardLibrarySearchKind | undefined {
  const source = typeof item['source'] === 'string' ? item['source'].toLowerCase() : '';
  const type = typeof item['type'] === 'string' ? item['type'].toLowerCase() : '';
  const name = typeof item['name'] === 'string' ? item['name'].trim() : '';

  if (source === 'library' || type === 'library' || name.startsWith('lib-') || name.includes('/lib-')) {
    return 'library';
  }
  if (source === 'board' || type === 'board' || name.startsWith('board-') || name.includes('/board-')) {
    return 'board';
  }
  if (scope === 'libraries') {
    return 'library';
  }
  if (scope === 'boards') {
    return 'board';
  }
  return undefined;
}

function enrichBoardLibrarySearchResult(
  value: unknown,
  scope: BoardLibrarySearchScope,
): unknown {
  if (Array.isArray(value)) {
    return value.map(item => enrichBoardLibrarySearchResult(item, scope));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;
  const enriched: Record<string, unknown> = { ...source };

  if (Array.isArray(source['boards'])) {
    enriched['boards'] = enrichBoardLibrarySearchResult(source['boards'], 'boards');
  }
  if (Array.isArray(source['libraries'])) {
    enriched['libraries'] = enrichBoardLibrarySearchResult(source['libraries'], 'libraries');
  }
  if (Array.isArray(source['results'])) {
    enriched['results'] = enrichBoardLibrarySearchResult(source['results'], scope);
  }

  const name = typeof source['name'] === 'string' ? source['name'] : '';
  const kind = inferBoardLibrarySearchKind(source, scope);
  const packageName = kind ? canonicalAilyPackageName(name, kind) : undefined;
  if (packageName) {
    enriched['packageName'] = packageName;
  }

  return enriched;
}

function makeProjectContribution(createDeferred: DeferredFactory): RuntimeScopedToolContribution {
  return {
    name: 'project',
    toolSet: 'blockly-project',
    description: 'Manage the current project (create, reload, switch board, configure)',
    prompt: `Use this tool to manage the current project. Actions:
- "create": Create a new project (requires name and board)
- "reload": Reload the current project
- "switch_board": Switch the development board
- "get_board_config": Get board compile/upload configuration
- "set_board_config": Modify board compile/upload configuration

This tool does not install libraries. Once discovery returns a library packageName, install it from the current project root with the terminal command \`npm install <packageName>\`. Use action="reload" only after a successful installation when the Blockly project needs to load the new blocks.

Project creation mutates the workspace and may require host-side user confirmation before execution.
Before action="create" in a no-project request, the agent must have loaded blockly-project-planning, used board/library discovery to produce researched candidate options, and obtained the user's selected/confirmed option. Do not ask the user to choose a board before discovery, and do not use this tool to skip the candidate-plan workflow.
Basic project info (path, board, libraries) is already in the environment section. Do not call this tool for read-only info.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'reload', 'switch_board', 'get_board_config', 'set_board_config'],
          description: 'Action to perform',
        },
        name: { type: 'string', description: 'Project name (for create)' },
        board: { type: 'string', description: 'Board identifier (for create/switch_board)' },
        path: { type: 'string', description: 'Project path (for create, optional)' },
        config: { type: 'object', description: 'Board config key-value pairs (for set_board_config)' },
      },
      required: ['action'],
    },
    annotations: { readOnly: false },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main'],
    deferred: createDeferred('blockly-project-management', '项目创建、切板与配置通常按需使用'),
  };
}

function makeBuildProjectContribution(createDeferred: DeferredFactory): RuntimeScopedToolContribution {
  return {
    name: 'buildProject',
    toolSet: 'blockly-project',
    description: 'Build/compile the current project',
    prompt: `Use this tool to compile the current project. Returns the build output including any errors.
Set verbose to true for detailed compiler output.`,
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Show detailed compiler output', default: false },
      },
    },
    annotations: { readOnly: false },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main'],
    deferred: createDeferred('blockly-project-management', '构建属于按需执行的低频宿主能力'),
  };
}

function makeUploadProjectContribution(createDeferred: DeferredFactory): RuntimeScopedToolContribution {
  return {
    name: 'uploadProject',
    toolSet: 'blockly-project',
    description: 'Upload/flash the current project to an explicit serial port',
    prompt: `Use this tool only when the user asks to upload, flash, or download firmware to hardware.
Call listSerialPorts first and pass one of the returned exact port values. If multiple ports are ambiguous, ask the user which device to use. The upload approval identifies the selected port. Building alone does not require this tool.`,
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Exact serial port value returned by listSerialPorts (for example COM3 or /dev/cu.usbserial-...).',
        },
      },
      required: ['port'],
    },
    annotations: { readOnly: false, destructive: true },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main'],
    deferred: createDeferred('blockly-project-management', 'Firmware upload is exposed only when requested.'),
  };
}

function makeListSerialPortsContribution(createDeferred: DeferredFactory): RuntimeScopedToolContribution {
  return {
    name: 'listSerialPorts',
    toolSet: 'blockly-project',
    description: 'List serial ports currently available for firmware upload',
    prompt: 'Use this read-only tool immediately before uploadProject. Select only an exact port value returned by this tool; do not invent or reuse a stale port.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnly: true },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main'],
    deferred: createDeferred('blockly-project-management', 'Serial port discovery is exposed with firmware upload.'),
  };
}

function makeBoardSearchContribution(createDeferred: DeferredFactory): RuntimeScopedToolContribution {
  return {
    name: 'boardSearch',
    toolSet: 'blockly-discovery',
    description: 'Search for development boards and libraries',
    prompt: `Use this tool to find development boards and libraries by keyword or filter.
- Search by name, description, or tags
- Filter by type: "boards", "libraries", or "both"
- Get board parameters for a specific board
- Get hardware categories for browsing

Search results expose packageName as the canonical npm identity. Once the required library packageName is known, install it directly from the current project root with the terminal command \`npm install <packageName>\`. Do not use tool_search or the project tool to discover an installation mechanism.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'get_categories', 'get_board_parameters'] },
        query: { type: 'string', description: 'Search keyword' },
        type: { type: 'string', enum: ['boards', 'libraries', 'both'], default: 'both', description: 'Search scope: boards, libraries, or both' },
        boardId: { type: 'string', description: 'Board ID for get_board_parameters' },
      },
      required: ['action'],
    },
    annotations: { readOnly: true },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main', 'Plan', 'Explore'],
    deferred: createDeferred('blockly-library-discovery', '开发板与库搜索只在特定查询场景下需要'),
  };
}

function makeSearchBoardsLibrariesContribution(): RuntimeScopedToolContribution {
  return {
    name: 'search_boards_libraries',
    toolSet: 'blockly-discovery',
    description: 'Search Aily development boards and libraries by text query or structured filters',
    prompt: `${searchBoardsLibrariesTool.description}

Each result exposes packageName as the canonical npm identity. Once the required library packageName is known, install it directly from the current project root with the terminal command \`npm install <packageName>\`. Do not use tool_search or the project tool to discover an installation mechanism.`,
    inputSchema: searchBoardsLibrariesTool.parameters,
    annotations: { readOnly: true },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main', 'Plan', 'Explore'],
  };
}

function makeGetHardwareCategoriesContribution(): RuntimeScopedToolContribution {
  return {
    name: 'get_hardware_categories',
    toolSet: 'blockly-discovery',
    description: 'Get board or library category facets for guided hardware selection',
    prompt: getHardwareCategoriesTool.description,
    inputSchema: getHardwareCategoriesTool.parameters,
    annotations: { readOnly: true },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main', 'Plan', 'Explore'],
  };
}

function makeGetBoardParametersContribution(): RuntimeScopedToolContribution {
  return {
    name: 'get_board_parameters',
    toolSet: 'blockly-discovery',
    description: 'Read detailed parameters from the current project board configuration',
    prompt: 'Use this read-only tool when you need the current board pins, serial/I2C/SPI configuration, PWM pins, builtin LEDs, or other board.json parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        parameters: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description: 'Optional parameter name or list. Omit to return all board parameters.',
        },
      },
    },
    annotations: { readOnly: true },
    runtimeModes: ['unbound', 'coder', 'blockly'],
    agentScope: ['main', 'Plan', 'Explore'],
  };
}

export function appendBlocklyProjectContributions(
  contributions: IToolContribution[],
  hostAPI: IExternalHostAPI,
  createDeferred: DeferredFactory,
): void {
  if (hostAPI.project) {
    contributions.push(makeProjectContribution(createDeferred));
  }

  if (hostAPI.builder?.build) {
    contributions.push(makeBuildProjectContribution(createDeferred));
  }
  if (typeof (hostAPI.builder as { upload?: unknown } | undefined)?.upload === 'function') {
    if (typeof (hostAPI.builder as { listSerialPorts?: unknown }).listSerialPorts === 'function') {
      contributions.push(makeListSerialPortsContribution(createDeferred));
    }
    contributions.push(makeUploadProjectContribution(createDeferred));
  }
}

export function appendBlocklyDiscoveryContributions(
  contributions: IToolContribution[],
  hostAPI: IExternalHostAPI,
  createDeferred: DeferredFactory,
): void {
  if (hostAPI.boardSearch?.search) {
    contributions.push(makeSearchBoardsLibrariesContribution());
    contributions.push(makeGetHardwareCategoriesContribution());
    if (hostAPI.project) {
      contributions.push(makeGetBoardParametersContribution());
    }
    contributions.push(makeBoardSearchContribution(createDeferred));
  }
}

export function createBlocklyProjectDiscoveryHandlers(): Record<string, InvokeHandler> {
  return {
    project: async (input, hostAPI, invocationContext) => {
      if (!hostAPI.project) return error('Project management is not available.');
      const projectService = createExternalProjectServiceView(hostAPI.project);
      const contextSnapshotService = getBlocklyContextSnapshotService();

      const action = input['action'] as string;
      switch (action) {
        case 'create': {
          const name = input['name'] as string | undefined;
          const board = input['board'] as string | undefined;
          if (!name || !board) return error('name and board are required for create.');
          if (typeof hostAPI.project.createProject !== 'function') {
            return error('Project creation is not available in the current host context.');
          }
          if (!readActiveProjectPath(hostAPI.project)) {
            const askUser = invocationContext?.host?.getExtension<AskUserExtension>('askUser');
            if (!askUser?.ask) {
              return error('Project creation requires user confirmation, but user interaction is not available.');
            }
            const confirmation = await askUser.ask({
              question: `Create project "${name}" for board "${board}" now?`,
              options: [
                {
                  label: 'Create project',
                  description: 'Create the Blockly project and switch this chat to the new project workspace.',
                  recommended: true,
                },
                {
                  label: 'Cancel',
                  description: 'Do not create a project yet.',
                },
              ],
              multiSelect: false,
              allowFreeform: false,
              signal: invocationContext?.signal,
              toolCallId: invocationContext?.toolCallId,
              trace: invocationContext?.trace,
            });
            if (confirmation.cancelled || confirmation.answer !== 'Create project') {
              return text('Project creation cancelled by user.');
            }
          }
          const result = await (hostAPI.project.createProject as unknown as (
            name: string,
            board: string,
            path: string | undefined,
            context: typeof invocationContext,
          ) => Promise<unknown>)(name, board, typeof input['path'] === 'string' ? input['path'] : undefined, invocationContext);
          contextSnapshotService.invalidate([
            'workspaceIdentity',
            'projectInfo',
            'boardInfo',
            'libraryIndex',
            'libraryReadmeRefs',
            'workspaceArtifacts',
            'workspaceState',
          ], 'project create');
          return text(formatExternalResult(result));
        }
        case 'reload': {
          if (typeof hostAPI.project.reloadProject === 'function') {
            await hostAPI.project.reloadProject();
            contextSnapshotService.invalidate([
              'projectInfo',
              'boardInfo',
              'libraryIndex',
              'libraryReadmeRefs',
              'workspaceArtifacts',
              'workspaceState',
            ], 'project reload');
            return text('Project reloaded.');
          }
          const result = await reloadProjectTool(projectService as any, input);
          if (!result.is_error) {
            contextSnapshotService.invalidate([
              'projectInfo',
              'boardInfo',
              'libraryIndex',
              'libraryReadmeRefs',
              'workspaceArtifacts',
              'workspaceState',
            ], 'project reload');
          }
          return fromToolResult(result);
        }
        case 'switch_board': {
          const board = input['board'] as string | undefined;
          if (!board) return error('board is required for switch_board.');
          if (typeof hostAPI.project.switchBoard !== 'function') {
            return error('Board switching requires the execution-host project mutation bridge.');
          }
          await (hostAPI.project.switchBoard as unknown as (
            board: string,
            context: typeof invocationContext,
          ) => Promise<unknown>)(board, invocationContext);
          contextSnapshotService.invalidate([
            'boardInfo',
            'libraryIndex',
            'libraryReadmeRefs',
            'workspaceArtifacts',
            'workspaceState',
          ], 'switch board');
          return text(`Switched board to ${board}.`);
        }
        case 'get_board_config':
          return fromToolResult(await getBoardParametersTool.handler(projectService, { parameters: input['parameters'] as any }));
        case 'set_board_config': {
          const config = input['config'] as Record<string, unknown> | undefined;
          const directConfigKey = input['config_key'] as string | undefined;
          const directConfigValue = input['config_value'] as string | undefined;

          let configKey = directConfigKey;
          let configValue = directConfigValue;

          if (!configKey && config && Object.keys(config).length === 1) {
            const [entryKey, entryValue] = Object.entries(config)[0];
            configKey = entryKey;
            configValue = entryValue === undefined || entryValue === null ? '' : String(entryValue);
          }

          if (!configKey || configValue === undefined) {
            return error('set_board_config requires config_key/config_value, or a single-entry config object.');
          }

          if (typeof hostAPI.project.setBoardConfig !== 'function') {
            return error('Board configuration requires the execution-host project mutation bridge.');
          }
          await (hostAPI.project.setBoardConfig as unknown as (
            config: Record<string, string>,
            context: typeof invocationContext,
          ) => Promise<unknown>)({ [configKey]: configValue }, invocationContext);
          contextSnapshotService.invalidate([
            'boardInfo',
            'workspaceArtifacts',
            'workspaceState',
          ], 'set board config');
          return text(`Updated board config ${configKey}.`);
        }
        default:
          return error(`Unknown action: ${action}`);
      }
    },

    buildProject: async (_input, hostAPI) => {
      if (!hostAPI.builder?.build) return error('Build system is not available.');
      const projectPath = readActiveProjectPath(hostAPI.project);
      if (!projectPath) return error('No active project is available for build.');
      const result = await (hostAPI.builder.build as unknown as (projectPath: string) => Promise<unknown>)(projectPath);
      return text(formatExternalResult(result));
    },

    listSerialPorts: async (_input, hostAPI) => {
      const listSerialPorts = (hostAPI.builder as {
        listSerialPorts?: () => Promise<unknown>;
      } | undefined)?.listSerialPorts;
      if (typeof listSerialPorts !== 'function') return error('Serial port discovery is not available.');
      return text(formatExternalResult(await listSerialPorts.call(hostAPI.builder)));
    },

    uploadProject: async (input, hostAPI) => {
      const upload = (hostAPI.builder as {
        upload?: (options?: { projectPath?: string; port?: string }) => Promise<unknown>;
      } | undefined)?.upload;
      if (typeof upload !== 'function') return error('Project upload is not available.');
      const projectPath = readActiveProjectPath(hostAPI.project);
      if (!projectPath) return error('No active project is available for upload.');
      const port = typeof input['port'] === 'string' ? input['port'].trim() : '';
      if (!port) return error('uploadProject requires an explicit port from listSerialPorts.');
      const result = await upload.call(hostAPI.builder, { projectPath, port });
      return text(formatExternalResult(result));
    },

    boardSearch: async (input, hostAPI) => {
      if (!hostAPI.boardSearch) return error('Board search is not available.');

      const action = input['action'] as string;
      switch (action) {
        case 'search': {
          const query = input['query'] as string | undefined;
          if (!query) return error('query is required for search.');
          const typeMap: Record<string, 'boards' | 'libraries' | 'both'> = {
            board: 'boards', library: 'libraries', all: 'both',
            boards: 'boards', libraries: 'libraries', both: 'both',
          };
          const rawType = (input['type'] as string) || 'both';
          const scope = typeMap[rawType] ?? 'both';
          const result = await hostAPI.boardSearch.search?.(query, scope);
          return text(formatExternalResult(enrichBoardLibrarySearchResult(result ?? [], scope)));
        }
        case 'get_categories': {
          try {
            const cats = await hostAPI.boardSearch.getCategories?.();
            return text(Array.isArray(cats) ? cats.join('\n') : JSON.stringify(cats ?? []));
          } catch {
            return text('[]');
          }
        }
        case 'get_board_parameters': {
          const boardId = input['boardId'] as string | undefined;
          if (!boardId) return error('boardId is required.');
          if (hostAPI.boardSearch.getBoardParameters) {
            const parameters = await hostAPI.boardSearch.getBoardParameters(boardId);
            return text(formatExternalResult(parameters));
          }
          if (!hostAPI.project) {
            return error('Board parameters are not available.');
          }
          return fromToolResult(await getBoardParametersTool.handler(
            createExternalProjectServiceView(hostAPI.project),
            { parameters: boardId },
          ));
        }
        default:
          return error(`Unknown action: ${action}`);
      }
    },

    search_boards_libraries: async (input, hostAPI) => {
      if (!hostAPI.boardSearch?.search) return error('Board/library search is not available.');
      const query = typeof input['query'] === 'string' ? input['query'] : '';
      if (!query) return error('query is required.');
      const rawType = typeof input['type'] === 'string' ? input['type'] : 'both';
      const scope: BoardLibrarySearchScope = rawType === 'boards' || rawType === 'libraries'
        ? rawType
        : 'both';
      const result = await hostAPI.boardSearch.search(query, scope);
      return text(formatExternalResult(enrichBoardLibrarySearchResult(result, scope)));
    },

    get_hardware_categories: async (_input, hostAPI) => {
      if (!hostAPI.boardSearch?.getCategories) return error('Hardware category search is not available.');
      const result = await hostAPI.boardSearch.getCategories();
      return text(formatExternalResult(result));
    },

    get_board_parameters: async (input, hostAPI) => {
      if (!hostAPI.project) return error('Board parameters are not available.');
      return fromToolResult(await getBoardParametersTool.handler(createExternalProjectServiceView(hostAPI.project), {
        parameters: input['parameters'] as any,
      }));
    },
  };
}
