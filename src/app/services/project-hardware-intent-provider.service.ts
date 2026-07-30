import { Injectable } from '@angular/core';

import { BlocklyService } from '../editors/blockly-editor/services/blockly.service';
import { ProjectService } from './project.service';
import { buildProjectHardwareIntentSnapshot } from '../tools/simulator/project-hardware-intent';

interface SceneGenerationIdentity {
  readonly requestId: string;
  readonly projectIdentity: string;
}

@Injectable({ providedIn: 'root' })
export class ProjectHardwareIntentProviderService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly blocklyService: BlocklyService,
  ) {}

  async resolve(request: SceneGenerationIdentity): Promise<Record<string, unknown>> {
    if (!this.projectService.currentProjectPath) {
      throw new Error('Project hardware intent requires an open project.');
    }
    const sourceText = this.blocklyService.getReusableGeneratedCode();
    if (sourceText === null || sourceText.trim().length === 0) {
      throw new Error(
        'Generated Arduino source is missing or stale; regenerate the Blockly code before creating a Scene.',
      );
    }
    const boardConfig = this.projectService.currentBoardConfig
      ?? await this.projectService.getBoardJson();
    const packageJson = await this.projectService.getPackageJson();
    return buildProjectHardwareIntentSnapshot({
      request: {
        requestId: request.requestId,
        projectIdentity: request.projectIdentity,
      },
      board: resolveBoard(boardConfig),
      sourceText,
      libraries: resolveLibraries(packageJson),
      userIntent: null,
    });
  }
}

function resolveBoard(value: unknown): {
  fqbn: string;
  boardId: string;
  architecture: string;
  mcu: string;
} {
  const board = record(value);
  const fqbn = text(board['fqbn']) || text(board['type']);
  const core = text(board['core']);
  const boardId = text(board['boardId'])
    || fqbn.split(':').filter(Boolean).at(-1)
    || text(board['name']);
  const architecture = text(board['architecture'])
    || core.split(':').filter(Boolean)[0]
    || fqbn.split(':').filter(Boolean)[0];
  const uploadParam = text(board['uploadParam']).toLowerCase();
  const mcu = text(board['mcu'])
    || uploadParam.match(/--chip\s+([a-z0-9_-]+)/u)?.[1]
    || inferMcu(fqbn);
  if (!fqbn || !boardId || !architecture || !mcu) {
    throw new Error('Current board metadata is incomplete for Scene generation.');
  }
  return { fqbn, boardId, architecture, mcu };
}

function resolveLibraries(value: unknown): Array<{ name: string; version: string | null }> {
  const packageJson = record(value);
  const dependencyGroups = [
    packageJson['dependencies'],
    packageJson['optionalDependencies'],
  ].map(record);
  const libraries = new Map<string, string | null>();
  for (const dependencies of dependencyGroups) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (
        name.startsWith('@aily-project/board-')
        || name.startsWith('@aily-project/coder-')
      ) {
        continue;
      }
      libraries.set(name, typeof version === 'string' && version.trim()
        ? version.trim()
        : null);
    }
  }
  return [...libraries.entries()].map(([name, version]) => ({ name, version }));
}

function inferMcu(fqbn: string): string {
  const normalized = fqbn.toLowerCase();
  for (const candidate of ['esp32s3', 'esp32c3', 'esp32c6', 'esp32s2', 'esp32']) {
    if (normalized.includes(candidate)) return candidate;
  }
  return normalized.split(':').filter(Boolean).at(-1) || '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
