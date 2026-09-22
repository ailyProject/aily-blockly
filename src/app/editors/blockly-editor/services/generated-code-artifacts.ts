import type { ArduinoGeneratedArtifact } from '../components/blockly/generators/arduino/arduino';

const GENERATED_HEADER_PATTERN = /^(?:variables|objects)_[a-zA-Z0-9_-]+-[a-f0-9]{8}\.h$/;

interface ArduinoGeneratedArtifactSource {
  getGeneratedArtifacts(): readonly ArduinoGeneratedArtifact[];
}

function isArduinoGeneratedArtifactSource(
  generator: unknown,
): generator is ArduinoGeneratedArtifactSource {
  return typeof (generator as ArduinoGeneratedArtifactSource | null)?.getGeneratedArtifacts === 'function';
}

/** Copy within workspaceToCode's synchronous phase; never retain a mutable runtime source. */
export function captureArduinoGeneratedArtifacts(generator: unknown): readonly ArduinoGeneratedArtifact[] | null {
  if (!isArduinoGeneratedArtifactSource(generator)) return null;
  return Object.freeze(generator.getGeneratedArtifacts().map(artifact => {
    const { fileName, content, sourceTag } = artifact;
    if (!GENERATED_HEADER_PATTERN.test(fileName) || typeof content !== 'string' || typeof sourceTag !== 'string') {
      throw new Error('Invalid generated Arduino artifact.');
    }
    return Object.freeze({ fileName, content, sourceTag });
  }));
}

/**
 * Materialize large generator declarations in the project's regular Arduino
 * source directory. The build and lint boundaries copy project/src into the
 * temporary sketch root, so generated includes follow the same rules as user
 * authored headers.
 *
 * Project generators are runtime-scoped and may be Arduino or MicroPython.
 * Artifact emission is an Arduino capability, so non-Arduino generators are a
 * deliberate no-op instead of falling back to the old global generator.
 */
/** True when another host build/preprocess/publish still owns the project workspace. */
export function isBuildWorkspaceBusyError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  return code === 'BUILD_WORKSPACE_BUSY' || message.startsWith('BUILD_WORKSPACE_BUSY:');
}

export async function writePreparedArduinoGeneratedArtifacts(
  projectPath: string | null | undefined,
  artifacts: readonly ArduinoGeneratedArtifact[] | null,
  sketchCode?: string,
): Promise<void> {
  if (!projectPath || (artifacts === null && sketchCode === undefined)) return;
  const publish = window['builder']?.publishArduinoGeneratedCode;
  if (typeof publish !== 'function') throw new Error('Build publication bridge unavailable; restart the host to load matching scripts.');
  publish(projectPath, { artifacts, ...(sketchCode !== undefined ? { sketchCode } : {}) });
}
