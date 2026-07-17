import { AilyHost } from './host';
import { getProjectInfoTool } from '../tools/getProjectInfoTool';
import type { ContextSnapshot, WorkspaceArtifactsSnapshot } from 'aily-lex/browser';

export interface BlocklyProjectLibraryInfo {
  name: string;
  path: string;
  readmePath?: string;
}

export interface BlocklyProjectInfo {
  projectOpened: boolean;
  projectPath?: string;
  projectName?: string;
  board?: {
    name: string;
    path: string;
  };
  libraries?: BlocklyProjectLibraryInfo[];
}

export interface BlocklyContextSnapshotMeta {
  version: number;
  resolvedAt: number;
  stale: boolean;
  invalidatedBy?: string;
}

export interface BlocklyContextSnapshot extends ContextSnapshot {
  meta: BlocklyContextSnapshotMeta;
  workspaceIdentity?: {
    cwd: string;
    hostId: 'blockly';
    platform?: string;
  };
  projectInfo?: {
    projectOpened: boolean;
    projectPath?: string;
    projectName?: string;
  };
  boardInfo?: {
    currentBoard?: string;
    fqbn?: string;
  };
  libraryIndex?: readonly BlocklyProjectLibraryInfo[];
  workspaceArtifacts?: WorkspaceArtifactsSnapshot & {
    mainEntryPath?: string;
  };
}

export interface BlocklyContextSummaryOptions {
  maxLibraries?: number;
  maxReadmeRefs?: number;
  maxLibrariesWithoutReadme?: number;
  includeReadmeReferences?: boolean;
  includeLibrariesWithoutReadme?: boolean;
}

const MAX_ENV_LIBRARY_NAMES = 24;
const MAX_ENV_README_REFS = 16;
const MAX_ENV_LIBRARIES_WITHOUT_README = 16;
const AILY_PROJECT_SCOPE = '@aily-project/';
const AILY_BOARD_DEP_PREFIX = `${AILY_PROJECT_SCOPE}board-`;
const AILY_LIBRARY_DEP_PREFIX = `${AILY_PROJECT_SCOPE}lib-`;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeProjectPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    : undefined;
}

function isSameProjectPath(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeProjectPath(left);
  const normalizedRight = normalizeProjectPath(right);
  if (!normalizedLeft || !normalizedRight) {
    return normalizedLeft === normalizedRight;
  }
  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function resolveActiveProjectPath(project: any, projectInfo: BlocklyProjectInfo | null): string | undefined {
  if (projectInfo?.projectOpened === false) {
    return undefined;
  }

  const projectInfoPath = normalizeProjectPath(projectInfo?.projectPath);
  if (projectInfo?.projectOpened === true && projectInfoPath) {
    return projectInfoPath;
  }

  const currentProjectPath = normalizeProjectPath(project?.currentProjectPath);
  const projectRootPath = normalizeProjectPath(project?.projectRootPath);
  if (!currentProjectPath || isSameProjectPath(currentProjectPath, projectRootPath)) {
    return undefined;
  }
  return currentProjectPath;
}

function joinHostPath(host: any, ...parts: string[]): string {
  const pathApi = host?.path ?? (typeof window !== 'undefined' ? (window as any).path : undefined);
  if (pathApi && typeof pathApi.join === 'function') {
    return pathApi.join(...parts);
  }
  return parts.join('/').replace(/\/+/g, '/');
}

function simplifiedAilyProjectPath(packageName: string): string {
  return `{projectPath}/node_modules/${AILY_PROJECT_SCOPE}${packageName}`;
}

function getDependencyNames(packageJson: JsonRecord | null): string[] {
  if (!packageJson) {
    return [];
  }

  const dependencyBlocks = [
    packageJson['dependencies'],
    packageJson['devDependencies'],
    packageJson['peerDependencies'],
  ].filter(isRecord);
  const names: string[] = [];
  for (const block of dependencyBlocks) {
    names.push(...Object.keys(block));
  }
  return Array.from(new Set(names));
}

function readJsonObjectFromText(text: unknown): JsonRecord | null {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveProjectPackageJson(host: any, projectPath: string | undefined, project: any): Promise<JsonRecord | null> {
  if (projectPath && host?.fs) {
    const packageJsonPath = joinHostPath(host, projectPath, 'package.json');
    try {
      if (typeof host.fs.existsSync !== 'function' || host.fs.existsSync(packageJsonPath)) {
        const fileText = host.fs.readFileSync?.(packageJsonPath, 'utf8');
        const filePackageJson = readJsonObjectFromText(fileText);
        if (filePackageJson) {
          return filePackageJson;
        }
      }
    } catch {
      // Fall through to the host project package cache.
    }
  }

  try {
    if (typeof project?.getPackageJsonSync === 'function') {
      const cachedPackageJson = project.getPackageJsonSync();
      if (isRecord(cachedPackageJson)) {
        return cachedPackageJson;
      }
    }
  } catch {
    // Fall through to async package cache.
  }

  try {
    if (typeof project?.getPackageJson === 'function') {
      const cachedPackageJson = await project.getPackageJson();
      if (isRecord(cachedPackageJson)) {
        return cachedPackageJson;
      }
    }
  } catch {
    // No package snapshot is available.
  }

  return null;
}

function resolvePackageBoardInfo(packageJson: JsonRecord | null): BlocklyProjectInfo['board'] | undefined {
  if (!packageJson) {
    return undefined;
  }

  const boardDependency = getDependencyNames(packageJson).find(name => name.startsWith(AILY_BOARD_DEP_PREFIX));
  const boardPackageName = boardDependency?.slice(AILY_PROJECT_SCOPE.length);
  const packageBoardName = asString(packageJson['board']);
  const boardName = packageBoardName ?? boardPackageName;
  if (!boardName) {
    return undefined;
  }

  return {
    name: boardName,
    path: boardPackageName ? simplifiedAilyProjectPath(boardPackageName) : '',
  };
}

function resolvePackageLibraries(host: any, projectPath: string | undefined, packageJson: JsonRecord | null): BlocklyProjectLibraryInfo[] {
  if (!packageJson) {
    return [];
  }

  return getDependencyNames(packageJson)
    .filter(name => name.startsWith(AILY_LIBRARY_DEP_PREFIX))
    .map((dependencyName): BlocklyProjectLibraryInfo => {
      const packageName = dependencyName.slice(AILY_PROJECT_SCOPE.length);
      const simplifiedPath = simplifiedAilyProjectPath(packageName);
      const readmePath = projectPath
        ? joinHostPath(host, projectPath, 'node_modules', AILY_PROJECT_SCOPE.slice(0, -1), packageName, 'readme_ai.md')
        : undefined;
      const hasReadme = Boolean(readmePath && host?.fs?.existsSync?.(readmePath));
      return {
        name: packageName,
        path: simplifiedPath,
        ...(hasReadme ? { readmePath: `${simplifiedPath}/readme_ai.md` } : {}),
      };
    });
}

export async function buildBlocklyWorkspaceIdentityLines(host = AilyHost.get()): Promise<string[]> {
  const snapshot = await buildBlocklyContextSnapshot(host);
  return summarizeBlocklyContextSnapshot(snapshot);
}

export async function buildBlocklyContextSnapshot(
  host = AilyHost.get(),
  options?: { version?: number; invalidatedBy?: string },
): Promise<BlocklyContextSnapshot> {
  const project = host.project as any;
  const projectInfo = await resolveBlocklyProjectInfo(host);
  const projectPath = resolveActiveProjectPath(project, projectInfo);
  const projectOpened = Boolean(projectPath);
  const packageJson = await resolveProjectPackageJson(host, projectPath, project);
  const packageBoard = resolvePackageBoardInfo(packageJson);
  const packageLibraries = resolvePackageLibraries(host, projectPath, packageJson);
  const projectName = projectOpened
    ? asString(packageJson?.['name']) || projectInfo?.projectName || project?.projectName
    : undefined;
  const currentBoard = projectOpened
    ? packageBoard?.name || projectInfo?.board?.name || project?.currentBoard
    : undefined;
  const platformType = host.platform?.type || ((host.platform as any)?.isWindows ? 'win32' : undefined);
  const libraries = projectOpened
    ? packageLibraries.length > 0 ? packageLibraries : projectInfo?.libraries ?? []
    : [];

  return {
    meta: {
      version: options?.version ?? 1,
      resolvedAt: Date.now(),
      stale: false,
      ...(options?.invalidatedBy ? { invalidatedBy: options.invalidatedBy } : {}),
    },
    ...(projectPath ? {
      workspaceIdentity: {
        cwd: projectPath,
        hostId: 'blockly',
        ...(platformType ? { platform: platformType } : {}),
      },
    } : {}),
    projectInfo: {
      projectOpened,
      ...(projectPath ? { projectPath } : {}),
      ...(projectName ? { projectName } : {}),
    },
    ...(currentBoard ? {
      boardInfo: {
        currentBoard,
      },
    } : {}),
    ...(libraries.length > 0 ? { libraryIndex: libraries } : {}),
    ...(projectPath ? {
      workspaceArtifacts: {
        absPath: joinHostPath(host, projectPath, 'project.abs'),
        generatedCodePath: joinHostPath(host, projectPath, '.temp', 'sketch', 'sketch.ino'),
      },
    } : {}),
  };
}

export function summarizeBlocklyContextSnapshot(
  snapshot: BlocklyContextSnapshot,
  options?: BlocklyContextSummaryOptions,
): string[] {
  const lines: string[] = [];
  const maxLibraries = options?.maxLibraries ?? MAX_ENV_LIBRARY_NAMES;
  const maxReadmeRefs = options?.maxReadmeRefs ?? MAX_ENV_README_REFS;
  const maxLibrariesWithoutReadme = options?.maxLibrariesWithoutReadme ?? MAX_ENV_LIBRARIES_WITHOUT_README;
  const includeReadmeReferences = options?.includeReadmeReferences !== false;
  const includeLibrariesWithoutReadme = options?.includeLibrariesWithoutReadme !== false;

  if (snapshot.projectInfo?.projectPath) {
    lines.push(`Project path: ${snapshot.projectInfo.projectPath}`);
  } else if (snapshot.projectInfo?.projectOpened === false) {
    lines.push('No project is currently open.');
  }
  if (snapshot.projectInfo?.projectName) {
    lines.push(`Project: ${snapshot.projectInfo.projectName}`);
  }
  if (snapshot.boardInfo?.currentBoard) {
    lines.push(`Current board: ${snapshot.boardInfo.currentBoard}`);
  }

  const libraries = snapshot.libraryIndex ?? [];
  if (libraries.length > 0) {
    const librariesWithReadme = libraries.filter(library => Boolean(library.readmePath));
    const librariesWithoutReadme = libraries.filter(library => !library.readmePath);
    lines.push(
      `Library inventory: total ${libraries.length}; with readme_ai.md ${librariesWithReadme.length}; without readme_ai.md ${librariesWithoutReadme.length}`,
    );

    const displayedLibraryNames = libraries.slice(0, maxLibraries).map(library => library.name);
    const remainingLibraryNames = libraries.length - displayedLibraryNames.length;
    lines.push(
      `Installed libraries (${displayedLibraryNames.length}/${libraries.length} shown): ${displayedLibraryNames.join(', ')}`
      + (remainingLibraryNames > 0 ? ` ... (+${remainingLibraryNames} more)` : ''),
    );

    if (includeReadmeReferences && librariesWithReadme.length > 0) {
      const displayedReadmes = librariesWithReadme.slice(0, maxReadmeRefs);
      const remainingReadmes = librariesWithReadme.length - displayedReadmes.length;
      lines.push(
        `Library README docs (${displayedReadmes.length}/${librariesWithReadme.length} shown): ${displayedReadmes
          .map(library => `${library.name}=${library.readmePath}`)
          .join('; ')}`
        + (remainingReadmes > 0 ? ` ... (+${remainingReadmes} more)` : ''),
      );
    }

    if (includeLibrariesWithoutReadme && librariesWithoutReadme.length > 0) {
      const displayedWithoutReadme = librariesWithoutReadme.slice(0, maxLibrariesWithoutReadme);
      const remainingWithoutReadme = librariesWithoutReadme.length - displayedWithoutReadme.length;
      lines.push(
        `Libraries without readme_ai.md (${displayedWithoutReadme.length}/${librariesWithoutReadme.length} shown): ${displayedWithoutReadme
          .map(library => library.name)
          .join(', ')}`
        + (remainingWithoutReadme > 0 ? ` ... (+${remainingWithoutReadme} more)` : ''),
      );
    }
  }

  if (snapshot.workspaceArtifacts?.absPath) {
    lines.push(`ABS source: ${snapshot.workspaceArtifacts.absPath}`);
  }
  if (snapshot.workspaceArtifacts?.generatedCodePath) {
    lines.push(`Generated C++: ${snapshot.workspaceArtifacts.generatedCodePath}`);
  }

  return lines;
}

export async function resolveBlocklyProjectInfo(host = AilyHost.get()): Promise<BlocklyProjectInfo | null> {
  const project = host.project as any;

  if (!project) {
    return null;
  }

  try {
    if (typeof project.getProjectInfo === 'function') {
      const info = await project.getProjectInfo();
      if (info && typeof info === 'object') {
        return info as BlocklyProjectInfo;
      }
    }
  } catch {
    // Fall through to legacy project discovery.
  }

  try {
    const legacyResult = await getProjectInfoTool(project, { include_readme: true });
    const content = legacyResult?.content;
    if (typeof content !== 'string') {
      return null;
    }
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed as BlocklyProjectInfo : null;
  } catch {
    return null;
  }
}
