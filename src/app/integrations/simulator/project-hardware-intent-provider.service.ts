import { Injectable } from '@angular/core';
import {
  buildProjectHardwareIntentSnapshot,
  type ProjectHardwareIntentSnapshotV1,
} from '@aily-project/simulator-host-sdk';

import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { ProjectService } from '@domain/project/public-api';
import { createAlignedSimulatorProjectFirmwareEvidenceSource } from './simulator-project-firmware-evidence-source';
import { resolveProjectHardwareIntentBoard } from './project-hardware-intent-board';

interface SceneGenerationIdentity {
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly instruction?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ProjectHardwareIntentProviderService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly blocklyService: BlocklyService,
  ) {}

  async resolve(
    request: SceneGenerationIdentity,
    signal?: AbortSignal,
  ): Promise<ProjectHardwareIntentSnapshotV1> {
    let stage = 'project-binding';
    try {
      throwIfAborted(signal);
      const projectRoot = this.projectService.currentProjectPath;
      if (!projectRoot) {
        throw new Error('Project hardware intent requires an open project.');
      }
      stage = 'generated-code';
      const generatedSource =
        await this.blocklyService.waitForReusableGeneratedCode({
          signal,
          timeoutMs: 30_000,
        });
      if (generatedSource.trim().length === 0) {
        throw new Error(
          'Generated Arduino source is empty; add executable Blockly content before creating a Scene.',
        );
      }
      stage = 'firmware-evidence';
      const sourceText =
        await createAlignedSimulatorProjectFirmwareEvidenceSource({
          projectRoot,
          sourceText: generatedSource,
          files: {
            exists: (filePath) => window['fs'].existsSync(filePath),
            readText: (filePath) => window['fs'].readFileSync(filePath, 'utf8'),
            join: (...segments) => window['path'].join(...segments),
          },
        });
      stage = 'project-package';
      const packageJson = await this.projectService.getPackageJson();
      throwIfAborted(signal);
      stage = 'board-config';
      const boardConfig =
        this.projectService.currentBoardConfig ??
        (await this.projectService.getBoardJson());
      throwIfAborted(signal);
      stage = 'snapshot';
      return await buildProjectHardwareIntentSnapshot({
        request: {
          requestId: request.requestId,
          projectIdentity: request.projectIdentity,
        },
        board: resolveProjectHardwareIntentBoard(boardConfig, packageJson),
        sourceText,
        libraries: resolveLibraries(packageJson),
        userIntent: request.instruction ?? null,
      });
    } catch (error) {
      logHardwareIntentFailure(stage, error);
      throw error;
    }
  }
}

function logHardwareIntentFailure(stage: string, error: unknown): void {
  const value = error !== null && typeof error === 'object'
    ? error as { name?: unknown; code?: unknown; message?: unknown }
    : null;
  console.error('[SimulatorHost][HardwareIntentReadFailed]', JSON.stringify({
    stage,
    errorName: typeof value?.name === 'string'
      ? value.name.slice(0, 80)
      : null,
    errorCode: typeof value?.code === 'string'
      ? value.code.slice(0, 80)
      : null,
    errorMessage: typeof value?.message === 'string'
      ? value.message.slice(0, 240)
      : null,
    rendererRealmError: error instanceof Error,
  }));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Project hardware intent request was cancelled.');
}

function resolveLibraries(
  value: unknown,
): Array<{ name: string; version: string | null }> {
  const packageJson = record(value);
  const dependencyGroups = [
    packageJson['dependencies'],
    packageJson['optionalDependencies'],
  ].map(record);
  const libraries = new Map<string, string | null>();
  for (const dependencies of dependencyGroups) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (
        name.startsWith('@aily-project/board-') ||
        name.startsWith('@aily-project/coder-')
      ) {
        continue;
      }
      libraries.set(
        name,
        typeof version === 'string' && version.trim() ? version.trim() : null,
      );
    }
  }
  return [...libraries.entries()].map(([name, version]) => ({ name, version }));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
