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

/** Capture generator-owned files without writing into the active project. */
export function collectArduinoGeneratedArtifacts(
  generator: unknown,
): readonly ArduinoGeneratedArtifact[] {
  if (!isArduinoGeneratedArtifactSource(generator)) return Object.freeze([]);
  return Object.freeze(
    generator.getGeneratedArtifacts().map((artifact) => Object.freeze({
      fileName: artifact.fileName,
      content: artifact.content,
      sourceTag: artifact.sourceTag,
    })),
  );
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
export async function writeArduinoGeneratedArtifacts(
  projectPath: string | null | undefined,
  generator: unknown,
): Promise<void> {
  if (!projectPath || !isArduinoGeneratedArtifactSource(generator)) return;
  const fsApi = window['fs'];
  const pathApi = window['path'];
  const artifacts = collectArduinoGeneratedArtifacts(generator);
  const outputDirectory = pathApi.join(projectPath, 'src');
  if (!artifacts.length && !fsApi.existsSync(outputDirectory)) return;
  if (!fsApi.existsSync(outputDirectory)) fsApi.mkdirSync(outputDirectory, { recursive: true });

  const requiredNames = new Set(artifacts.map((artifact) => artifact.fileName));
  const existingNames: string[] = fsApi.existsSync(outputDirectory)
    ? (fsApi.readdirSync(outputDirectory) || []).map(String)
    : [];
  for (const fileName of existingNames) {
    if (!GENERATED_HEADER_PATTERN.test(fileName) || requiredNames.has(fileName)) continue;
    fsApi.unlinkSync(pathApi.join(outputDirectory, fileName));
  }

  for (const artifact of artifacts) {
    const finalPath = pathApi.join(outputDirectory, artifact.fileName);
    const current = fsApi.existsSync(finalPath) ? fsApi.readFileSync(finalPath, 'utf8') : null;
    if (current === artifact.content) continue;
    const tempPath = `${finalPath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    fsApi.writeFileSync(tempPath, artifact.content);
    fsApi.renameSync(tempPath, finalPath);
  }

  // Remove headers produced by the previous hidden-directory implementation.
  // Only files matching our deterministic generated-header namespace qualify.
  const legacyDirectory = pathApi.join(projectPath, '.temp', 'sketch', 'generated');
  if (fsApi.existsSync(legacyDirectory)) {
    for (const fileName of (fsApi.readdirSync(legacyDirectory) || []).map(String)) {
      if (GENERATED_HEADER_PATTERN.test(fileName)) {
        fsApi.unlinkSync(pathApi.join(legacyDirectory, fileName));
      }
    }
  }
}

/** Copy regular project sources into the temporary Arduino sketch root. */
export function syncArduinoProjectSourceToSketch(
  projectPath: string | null | undefined,
  sketchPath: string | null | undefined,
): void {
  if (!projectPath || !sketchPath) return;
  const fsApi = window['fs'];
  const pathApi = window['path'];
  const sourceDirectory = pathApi.join(projectPath, 'src');
  if (!fsApi.existsSync(sourceDirectory)) return;
  if (!fsApi.existsSync(sketchPath)) fsApi.mkdirSync(sketchPath, { recursive: true });
  fsApi.copySync(sourceDirectory, sketchPath);
}
