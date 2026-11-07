export interface SimulatorCoderSourceReaderOptions {
  requireCurrent(): void;
  hasSavedProject(): Promise<boolean>;
  readManifest(): Record<string, any>;
  readEntry(entry: string, nativeArduino: boolean): string;
  capture(code: string, boardModule: string): { mode: string; sourceSha256: string; digest: string };
  readDelivery(): { kind?: unknown; artifactId?: unknown;
    sourceCapture?: { mode?: unknown; sourceSha256?: unknown; digest?: unknown } } | null;
}

/** Reuse the trusted Builder source capture for disk inputs (including Coder
 * headers/local libraries), rather than inventing a second source enumerator.
 * No editor buffer is presented as a saved Blockly workspace. */
export function createSimulatorCoderSourceReader(options: SimulatorCoderSourceReaderOptions) {
  function snapshot() {
    options.requireCurrent();
    const manifest = options.readManifest();
    if (manifest['type'] !== 'coder') throw new Error('The bound project is not a Coder project.');
    const entry = String(manifest['entry'] || 'src/main.cpp').replaceAll('\\', '/');
    if (entry.startsWith('/') || /^[A-Za-z]:/u.test(entry) || entry.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error('Coder source entry must stay within its saved workspace.');
    }
    const boardModules = Object.keys(manifest['boardDependencies'] ?? manifest['dependencies'] ?? {})
      .filter(name => /^@aily-project\/board-[A-Za-z0-9._-]+$/u.test(name));
    if (boardModules.length !== 1) throw new Error('Coder Simulator requires one selected board module.');
    const code = options.readEntry(entry, manifest['arduinoSketch'] === true);
    const captured = options.capture(code, boardModules[0]);
    if (captured.mode !== 'coder' || !/^[a-f0-9]{64}$/u.test(captured.sourceSha256)
      || !/^[a-f0-9]{64}$/u.test(captured.digest)) throw new Error('The trusted Coder source capture is invalid.');
    options.requireCurrent();
    return captured;
  }
  return Object.freeze({
    /** This private receipt is a staleness veto, never a substitute for the
     * common Artifact authority, byte checks, or actual Builder delivery. */
    async isArtifactCurrent(artifact: { artifactId: string; build: { source: { sha256: string } } }, signal: AbortSignal) {
      signal.throwIfAborted(); options.requireCurrent();
      if (!await options.hasSavedProject()) return false;
      signal.throwIfAborted();
      try {
        const captured = snapshot(), delivery = options.readDelivery();
        return delivery?.kind === 'aily-build-delivery' && delivery.artifactId === artifact.artifactId
          && delivery.sourceCapture?.mode === 'coder'
          && delivery.sourceCapture.sourceSha256 === artifact.build.source.sha256
          && delivery.sourceCapture.digest === captured.digest
          && snapshot().digest === captured.digest;
      } catch { return false; }
    },
    readState() {
      const captured = snapshot();
      return { revision: 0, code: captured.digest };
    },
    async read(signal: AbortSignal) {
      signal.throwIfAborted(); options.requireCurrent();
      if (!await options.hasSavedProject()) return null;
      signal.throwIfAborted();
      const captured = snapshot();
      if (!await options.hasSavedProject()) return null;
      const isCurrent = () => {
        if (signal.aborted) return false;
        try { return snapshot().digest === captured.digest; } catch { return false; }
      };
      return isCurrent() ? { sha256: captured.sourceSha256, isCurrent } : null;
    },
  });
}
