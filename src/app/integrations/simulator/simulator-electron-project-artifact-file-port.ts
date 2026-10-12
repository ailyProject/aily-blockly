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
    existsSync(filePath: string): boolean;
    readFileBufferAsync(filePath: string): Promise<ArrayBuffer>;
    replaceProjectText(request: { projectPath: string; fileName: string; expectedHash: string | null; content: string },
      assertCurrent: () => void): Promise<{ status: string; code?: string; error?: string; warnings?: string[] }>;
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
 * preload file/path primitives; no Simulator-specific preload API or
 * product-specific Runtime entrypoint is involved.
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
    async replaceFileAtomic(
      projectRoot: string,
      relativePath: string,
      expectedBytes: Uint8Array | null,
      bytes: Uint8Array,
      signal: AbortSignal,
    ) {
      requireNotAborted(signal);
      const expectedHash = expectedBytes === null ? null : `sha256:${Array.from(new Uint8Array(
        await crypto.subtle.digest('SHA-256', new Uint8Array(expectedBytes)),
      ), byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const result = await bridge.fs.replaceProjectText({ projectPath: projectRoot, fileName: relativePath,
        expectedHash, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }, () => requireNotAborted(signal));
      requireNotAborted(signal);
      if (result.status === 'CONFLICT') return false;
      if (result.status !== 'COMMITTED' || result.warnings?.length) {
        throw Object.assign(new Error('Project Scene conditional publication failed.'), { code: result.code ?? 'PROJECT_FILE_WRITE_FAILED' });
      }
      return true;
    },
    async lstat(
      filePath: string,
      signal: AbortSignal,
    ): Promise<SimulatorProjectArtifactFileStat> {
      requireNotAborted(signal);
      if (!bridge.fs.existsSync(filePath)) {
        throw createMissingFileError();
      }
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
    || typeof bridge.fs?.existsSync !== 'function'
    || typeof bridge.fs?.readFileBufferAsync !== 'function'
    || typeof bridge.fs?.replaceProjectText !== 'function'
    || typeof bridge.fs?.lstatSync !== 'function'
    || typeof bridge.fs?.realpathAsync !== 'function'
  ) {
    throw new TypeError('Electron Project Artifact bridge is invalid.');
  }
}

function createMissingFileError(): Error & { code: 'ENOENT' } {
  const error = new Error('Project Artifact file is not available.') as Error & {
    code: 'ENOENT';
  };
  error.code = 'ENOENT';
  return error;
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error('Project Artifact filesystem operation cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}
