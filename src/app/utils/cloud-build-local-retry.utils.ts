/** A failed build stays failed. Only an explicit click may start a new local task. */
export function createCloudBuildLocalRetry(options: {
  settled: Promise<unknown>;
  isCurrent: () => boolean;
  canStart: () => boolean;
  retry: () => Promise<unknown>;
}): () => Promise<void> {
  let requested = false;
  return async () => {
    if (requested || !options.isCurrent()) return;
    requested = true;
    // Metadata, process cancellation and the old backend lease must finish first.
    await options.settled;
    if (!options.isCurrent() || !options.canStart()) return;
    // The new build owns error presentation; a click must not produce an
    // unhandled rejection or silently retry a second time.
    await options.retry().catch(() => undefined);
  };
}
