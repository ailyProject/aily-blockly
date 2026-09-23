import { sha256Hex } from '../../../utils/crypto.utils';

export type ProjectMirrorName = 'project.abi' | 'project.abs' | 'project.abs.map.json' | 'package.json';
export interface ProjectFileWriteResult {
  status: 'COMMITTED' | 'CONFLICT' | 'NOT_COMMITTED' | 'UNKNOWN';
  hash?: string;
  backupHash?: string;
  code?: string;
  error?: string;
  warnings?: readonly string[];
}
export interface ProjectFilePublicationPort {
  readonly projectFilePublicationVersion?: number;
  readonly projectShadowIdentityMigrationVersion?: number;
  replaceProjectText(request: { projectPath: string; fileName: ProjectMirrorName; expectedHash: string | null; content: string; backup?: 'project-data'; migrateLegacyShadowIds?: true },
    assertCurrent: () => void): Promise<ProjectFileWriteResult>;
}
export class ProjectFilePublicationError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) { super(message); }
}

/** One host publication path for ABI saves and ABS mirrors. Never falls back to unchecked writes. */
export async function publishProjectText(
  projectPath: string, fileName: ProjectMirrorName, content: string, expected: string | null,
  assertCurrent: () => void, port: ProjectFilePublicationPort = window['fs'],
  options: { backup?: 'project-data'; migrateLegacyShadowIds?: true } = {},
): Promise<ProjectFileWriteResult> {
  assertCurrent();
  if (typeof port?.replaceProjectText !== 'function') throw new ProjectFilePublicationError('PROJECT_FILE_HOST_UNAVAILABLE', 'Project file publication requires the updated Electron host.');
  if (options.backup && port.projectFilePublicationVersion !== 2) {
    throw new ProjectFilePublicationError('PROJECT_FILE_HOST_UNAVAILABLE', 'Project Data migration requires host publication v2. Fully restart Electron before retrying.');
  }
  if (options.migrateLegacyShadowIds && port.projectShadowIdentityMigrationVersion !== 1) {
    throw new ProjectFilePublicationError('PROJECT_FILE_HOST_UNAVAILABLE', 'Legacy shadow identity migration requires the updated Electron host. Fully restart Electron.');
  }
  const [expectedHash, outputHash] = await Promise.all([expected === null ? null : sha256Hex(expected), sha256Hex(content)]);
  assertCurrent();
  let result: ProjectFileWriteResult;
  try {
    result = await port.replaceProjectText({ projectPath, fileName, content, expectedHash: expectedHash === null ? null : `sha256:${expectedHash}`,
      ...options }, assertCurrent);
  } catch (error) {
    // A broken transport may have lost a successful commit acknowledgement.
    throw new ProjectFilePublicationError('PROJECT_FILE_COMMIT_UNCERTAIN', String(error), true);
  }
  if (result?.status === 'COMMITTED' && result.hash === `sha256:${outputHash}`
    && (!options.backup || (expectedHash !== null && result.backupHash === `sha256:${expectedHash}`))) return result;
  if (result?.status === 'CONFLICT' || result?.status === 'NOT_COMMITTED') {
    throw new ProjectFilePublicationError(result.code || (result.status === 'CONFLICT' ? 'PROJECT_FILE_CONFLICT' : 'PROJECT_FILE_NOT_COMMITTED'), result.error || 'Project file was not committed.');
  }
  throw new ProjectFilePublicationError('PROJECT_FILE_COMMIT_UNCERTAIN', result?.error || 'Invalid project publication acknowledgement.', true);
}
