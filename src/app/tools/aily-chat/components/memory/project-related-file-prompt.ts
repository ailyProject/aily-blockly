import { AilyHost } from '../../core/host';
import { ProjectRelatedFileStorage } from './project-related-file-storage';
import type { RelatedContentScope } from './project-related-file.types';

export function buildProjectRelatedFilesPromptText(
  scope: RelatedContentScope,
  projectPath: string | undefined,
  sessionId?: string,
): string {
  const normalizedProjectPath = typeof projectPath === 'string'
    ? projectPath.trim()
    : '';
  if (!normalizedProjectPath) {
    return '';
  }

  const storage = new ProjectRelatedFileStorage(AilyHost.get());
  return storage.buildPromptText(scope, normalizedProjectPath, sessionId);
}
