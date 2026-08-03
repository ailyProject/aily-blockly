import type {
  SimulatorProjectArtifactFilePort,
  SimulatorProjectArtifactFileStat,
} from './simulator-project-artifact-callback-authority';

export interface SimulatorElectronProjectArtifactBridge {
  path: {
    join(...segments: string[]): string;
    resolve(filePath: string): string;
    relative(from: string, to: string): string;
  };
  fs: {
    readFileBufferAsync(filePath: string): Promise<ArrayBuffer>;
    writeFileBufferAtomicAsync(
      filePath: string,
      bytes: ArrayBuffer | Uint8Array,
    ): Promise<void>;
    lstatSync(filePath: string): {
      size: number;
      _isFile: boolean;
      _isSymbolicLink: boolean;
    };
    realpathAsync(filePath: string): Promise<string>;
  };
}

/**
 * Concrete Blockly/Electron filesystem adapter. It consumes only generic
 * preload file/path primitives; no Simulator-specific preload API or old
 * simulator-subapp-host entrypoint is involved.
 */
export function createSimulatorElectronProjectArtifactFilePort(
  bridge: SimulatorElectronProjectArtifactBridge,
): SimulatorProjectArtifactFilePort {
  requireBridge(bridge);
  return Object.freeze({
    join: (...segments: string[]) => bridge.path.join(...segments),
    resolve: (...segments: string[]) => (
      bridge.path.resolve(bridge.path.join(...segments))
    ),
    relative: (from: string, to: string) => bridge.path.relative(from, to),
    async readFile(filePath: string, signal: AbortSignal) {
      requireNotAborted(signal);
      const buffer = await bridge.fs.readFileBufferAsync(filePath);
      requireNotAborted(signal);
      return new Uint8Array(buffer);
    },
    async writeFileAtomic(
      filePath: string,
      bytes: Uint8Array,
      signal: AbortSignal,
    ) {
      requireNotAborted(signal);
      await bridge.fs.writeFileBufferAtomicAsync(filePath, bytes);
      requireNotAborted(signal);
    },
    async lstat(
      filePath: string,
      signal: AbortSignal,
    ): Promise<SimulatorProjectArtifactFileStat> {
      requireNotAborted(signal);
      const stat = bridge.fs.lstatSync(filePath);
      requireNotAborted(signal);
      return {
        size: stat.size,
        isFile: stat._isFile,
        isSymbolicLink: stat._isSymbolicLink,
      };
    },
    async realpath(filePath: string, signal: AbortSignal) {
      requireNotAborted(signal);
      const resolved = await bridge.fs.realpathAsync(filePath);
      requireNotAborted(signal);
      return resolved;
    },
  });
}

function requireBridge(
  bridge: SimulatorElectronProjectArtifactBridge,
): void {
  if (
    !bridge
    || typeof bridge.path?.join !== 'function'
    || typeof bridge.path?.resolve !== 'function'
    || typeof bridge.path?.relative !== 'function'
    || typeof bridge.fs?.readFileBufferAsync !== 'function'
    || typeof bridge.fs?.writeFileBufferAtomicAsync !== 'function'
    || typeof bridge.fs?.lstatSync !== 'function'
    || typeof bridge.fs?.realpathAsync !== 'function'
  ) {
    throw new TypeError('Electron Project Artifact bridge is invalid.');
  }
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('Project Artifact filesystem operation cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
