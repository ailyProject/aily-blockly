import {
  createAlignedProjectSceneFirmwareEvidenceSourceV1,
} from '@aily-project/simulator-host-sdk';

const SCENE_HEAD_PATH = ['.aily', 'simulator', 'scene-network-v2.json'] as const;
const ARTIFACT_MANIFEST_PATH = ['.build', 'aily-artifact-manifest.json'] as const;
const MAX_SCENE_BYTES = 4 * 1024 * 1024;
const MAX_ARTIFACT_MANIFEST_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface SimulatorProjectFirmwareEvidenceFilePort {
  exists(filePath: string): boolean;
  readText(filePath: string): string;
  join(...segments: readonly string[]): string;
}

/**
 * Adds Scene-owned evidence only when the current generated source, committed
 * Scene and latest Artifact are the same immutable product revision.
 *
 * Any missing, stale or malformed input returns the original source so the
 * independent Simulator remains fail-closed and asks its Agent to inspect the
 * bounded full source.
 */
export async function createAlignedSimulatorProjectFirmwareEvidenceSource(
  input: Readonly<{
    projectRoot: string;
    sourceText: string;
    files: SimulatorProjectFirmwareEvidenceFilePort;
  }>,
): Promise<string> {
  const { projectRoot, sourceText, files } = input;
  const scenePath = files.join(projectRoot, ...SCENE_HEAD_PATH);
  const artifactPath = files.join(projectRoot, ...ARTIFACT_MANIFEST_PATH);
  if (!files.exists(scenePath) || !files.exists(artifactPath)) return sourceText;
  try {
    const sceneText = boundedText(files.readText(scenePath), MAX_SCENE_BYTES);
    const artifactText = boundedText(
      files.readText(artifactPath),
      MAX_ARTIFACT_MANIFEST_BYTES,
    );
    const sceneHead = record(JSON.parse(sceneText));
    const descriptor = record(sceneHead['descriptor']);
    const scene = record(descriptor['document']);
    const artifact = record(JSON.parse(artifactText));
    const build = record(artifact['build']);
    const artifactSource = record(build['source']);
    const artifactGraph = record(build['graph']);
    const sceneRevision = text(scene['graphSemanticRevision']);
    const artifactRevision = text(artifactGraph['graphSemanticRevision']);
    const artifactSourceSha256 = text(artifactSource['sha256']);
    if (
      sceneHead['schemaVersion'] !== 1
      || sceneHead['kind'] !== 'aily-blockly-simulator-project-scene-head'
      || descriptor['kind'] !== 'aily-project-scene-network-descriptor'
      || scene['schemaVersion'] !== 2
      || scene['kind'] !== 'aily-scene-editor-document'
      || !SHA256.test(sceneRevision)
      || sceneRevision !== artifactRevision
      || !SHA256.test(artifactSourceSha256)
    ) return sourceText;
    return createAlignedProjectSceneFirmwareEvidenceSourceV1({
      sourceText,
      artifactSourceSha256,
      artifactGraphSemanticRevision: artifactRevision,
      sceneDocument: scene as unknown as Parameters<
        typeof createAlignedProjectSceneFirmwareEvidenceSourceV1
      >[0]['sceneDocument'],
    });
  } catch {
    return sourceText;
  }
}

function boundedText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length > maxBytes) {
    throw new TypeError('Simulator Project evidence input is invalid.');
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Simulator Project evidence record is invalid.');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
