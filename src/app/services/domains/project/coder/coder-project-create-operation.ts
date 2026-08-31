import { resolveCoderBoard } from './coder-board-resolution';

export interface CoderProjectCreateResult {
  ok: boolean;
  projectPath?: string;
  error?: string;
}

export interface CoderProjectCreateDependencies {
  normalizeBoardName(value: string): string;
  getBoards(): readonly any[];
  loadBoards(): Promise<readonly any[]>;
  defaultParentPath(): Promise<string> | string;
  generateUniqueName(parentPath: string, prefix: string): string;
  createProject(data: {
    name: string;
    path: string;
    board: { name: string; nickname: string; version: string };
    devmode?: string;
  }): Promise<CoderProjectCreateResult>;
  openProject(projectPath: string): Promise<boolean>;
  recordBoardUsage(boardName: string): void;
}

/** Create a Coder project from Blockly's board catalog and its template_arduino directory. */
export async function executeCoderProjectCreateOperation(
  params: Record<string, any>,
  dependencies: CoderProjectCreateDependencies,
): Promise<Record<string, any>> {
  const rawBoardName = String(params['boardName'] || params['board'] || '').trim();
  const boardName = dependencies.normalizeBoardName(rawBoardName);
  if (!rawBoardName) {
    return {
      ok: false,
      operation: 'project_create',
      developmentMode: 'coder',
      reason: 'coder_board_required',
      message: '缺少开发板包名 boardName',
    };
  }

  let boards = dependencies.getBoards();
  let boardInfo = resolveCoderBoard(boards, boardName) || resolveCoderBoard(boards, rawBoardName);
  if (!boardInfo) {
    boards = await dependencies.loadBoards();
    boardInfo = resolveCoderBoard(boards, boardName) || resolveCoderBoard(boards, rawBoardName);
  }
  if (!boardInfo) {
    return {
      ok: false,
      operation: 'project_create',
      developmentMode: 'coder',
      reason: 'coder_board_not_found',
      message: `开发板索引中不存在: ${boardName}`,
      board: { name: boardName, requestedName: rawBoardName },
    };
  }

  const resolvedBoardName = dependencies.normalizeBoardName(String(boardInfo.name || boardName));
  const requestedParentPath = String(params['path'] || '').trim();
  const parentPath = requestedParentPath || await dependencies.defaultParentPath();
  const requestedName = String(params['name'] || '').trim();
  const prefix = String(params['prefix'] || '').trim() || 'project_coder_';
  const projectName = requestedName || dependencies.generateUniqueName(parentPath, prefix);
  const requestedVersion = String(params['boardVersion'] || params['version'] || '').trim();
  const boardVersion = !requestedVersion || requestedVersion === 'latest'
    ? String(boardInfo.version || 'latest').trim() || 'latest'
    : requestedVersion;
  const boardNickname = String(
    params['boardNickname'] || params['nickname'] || boardInfo.nickname || boardInfo.name || resolvedBoardName,
  ).trim() || resolvedBoardName;

  const result = await dependencies.createProject({
    name: projectName,
    path: parentPath,
    board: { name: resolvedBoardName, nickname: boardNickname, version: boardVersion },
    devmode: typeof params['devmode'] === 'string' ? params['devmode'] : undefined,
  });
  if (!result.ok || !result.projectPath) {
    return {
      ok: false,
      operation: 'project_create',
      developmentMode: 'coder',
      reason: normalizeCoderProjectCreateError(result.error),
      message: `Coder 项目创建失败: ${result.error || 'UNKNOWN'}`,
      project: result.projectPath || null,
      name: projectName,
      path: parentPath,
      board: {
        name: resolvedBoardName,
        nickname: boardNickname,
        version: boardVersion,
        requestedName: rawBoardName,
      },
    };
  }

  let opened = false;
  try {
    opened = await dependencies.openProject(result.projectPath);
  } catch (error) {
    return {
      ok: false,
      operation: 'project_create',
      developmentMode: 'coder',
      reason: 'coder_project_activation_failed',
      partialMutation: true,
      project: result.projectPath,
      message: `Coder 项目已创建，但打开失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!opened) {
    return {
      ok: false,
      operation: 'project_create',
      developmentMode: 'coder',
      reason: 'coder_project_activation_failed',
      partialMutation: true,
      project: result.projectPath,
      message: 'Coder 项目已创建，但主软件未能激活该项目',
    };
  }

  dependencies.recordBoardUsage(resolvedBoardName);
  return {
    ok: true,
    operation: 'project_create',
    developmentMode: 'coder',
    projectType: 'coder',
    project: result.projectPath,
    message: `Coder 项目已创建并打开: ${result.projectPath}`,
    name: projectName,
    path: parentPath,
    board: {
      name: resolvedBoardName,
      nickname: boardNickname,
      version: boardVersion,
      requestedName: rawBoardName,
      template: 'template_arduino',
    },
  };
}

function normalizeCoderProjectCreateError(error: string | undefined): string {
  switch (error) {
    case 'NAME_EMPTY': return 'coder_project_name_empty';
    case 'PATH_EMPTY': return 'coder_project_path_empty';
    case 'PATH_EXISTS': return 'project_directory_exists';
    case 'TEMPLATE_MISSING': return 'coder_template_missing';
    default: return 'coder_project_create_failed';
  }
}
