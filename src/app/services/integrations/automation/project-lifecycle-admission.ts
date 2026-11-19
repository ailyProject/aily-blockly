export interface ProjectLifecycleSnapshot {
  version: 1;
  sourceProject: string | null;
  rendererGeneration: number;
}

/** The lifecycle snapshot is an admission CAS, never program publication authority. */
export function createProjectLifecycleAssertion(
  input: unknown,
  currentSource: () => string | null,
  currentRenderer: () => number,
  requestRenderer: number | undefined,
): () => void {
  const snapshot = input as ProjectLifecycleSnapshot;
  const reject = (code: string): never => {
    throw Object.assign(
      new Error('The project lifecycle context changed; observe this host again.'),
      {
        code,
        commandDispatched: false,
        stateChanged: false,
        candidateApplied: false,
      },
    );
  };
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    Object.keys(snapshot).some(
      (key) => !['version', 'sourceProject', 'rendererGeneration'].includes(key),
    ) ||
    snapshot.version !== 1 ||
    !Number.isSafeInteger(snapshot.rendererGeneration) ||
    snapshot.rendererGeneration <= 0 ||
    !(
      snapshot.sourceProject === null ||
      (typeof snapshot.sourceProject === 'string' && snapshot.sourceProject.trim().length > 0)
    )
  ) {
    reject('PROJECT_LIFECYCLE_CONTEXT_INVALID');
  }
  const { sourceProject, rendererGeneration } = snapshot;
  return () => {
    if (
      rendererGeneration !== requestRenderer ||
      rendererGeneration !== currentRenderer() ||
      sourceProject !== currentSource()
    ) {
      reject('PROJECT_LIFECYCLE_CONTEXT_CHANGED');
    }
  };
}
