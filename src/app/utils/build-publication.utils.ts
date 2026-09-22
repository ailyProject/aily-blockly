export interface BuildMetadataPatch {
  codeHash?: string;
  buildInfo?: {
    lastBuildTime: string;
    lastBuildCode: string;
    lastBuildStatus: 'success' | 'failed' | 'cancelled';
    lastBuildDuration: number;
  };
}

/** Synchronous host read: record the actual prepared bytes, not mutable generator objects. */
export function captureBuildSource(config: { currentProjectPath: string; boardModule: string; code: string }, workspace?: {
  documentText: string; revision: number; runtimeRevision: number; pageId: string;
}): unknown {
  const capture = window['builder']?.captureBuildSource;
  if (typeof capture !== 'function') throw new Error('Build source capture bridge unavailable; restart the host to load matching scripts.');
  return capture(config, workspace);
}

/** Do not fall back to unguarded renderer filesystem writes on an old preload. */
export function patchBuildMetadata(projectPath: string, patch: BuildMetadataPatch): any {
  const publish = window['builder']?.patchBuildMetadata;
  if (typeof publish !== 'function') throw new Error('Build publication bridge unavailable; restart the host to load matching scripts.');
  return publish(projectPath, patch);
}
