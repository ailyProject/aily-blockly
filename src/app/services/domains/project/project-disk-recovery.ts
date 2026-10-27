import { captureProjectRecoveryFiles, assertProjectRecoveryFilesCurrent, type ProjectRecoveryFileReader } from '@shared/public-api';
import type { BlocklySaveAsSnapshot, ProjectRecoveryActivationBlocked, ProjectRecoverySource } from './project-save-outcome';

const sourceNames = ['package.json', 'project.abi', 'project.abs', 'project.abs.map.json'] as const;
type SourceFiles = Record<typeof sourceNames[number], string | null>;

export interface ProjectRecoveryFragment {
  /** A closed source has no renderer or partial native view to lose. */
  notApplicable?: true;
  documentText?: string;
  error?: string;
  /** Internal context guards, never serialized into a recovery archive or wire receipt. */
  isCurrent?(): boolean;
  freezeForActivation?(): () => void;
}

interface DiskRecoveryNative extends ProjectRecoveryFileReader {
  readFileSync(path: string, encoding: string | null): string;
  writeFileSync(path: string, value: string, options?: { flag: string }): void;
}

const nativePort = (): DiskRecoveryNative => window['fs'];
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function abiStatus(text: string | null): 'available' | 'missing' | 'invalid' {
  if (text === null) return 'missing';
  try {
    const value: unknown = JSON.parse(text);
    return record(value) ? 'available' : 'invalid';
  } catch { return 'invalid'; }
}

/** Read-only public-file facts; no private ABS store, native callback or data configuration. */
export async function inspectProjectDiskRecovery(project: string, assertCurrent: () => void,
  native = nativePort()) {
  assertCurrent();
  const captured = await captureProjectRecoveryFiles(project, sourceNames, assertCurrent, native);
  const raw = captured.rawFiles;
  return { abi: captured.files['project.abi'] === null && raw['project.abi'] !== null
      ? 'invalid' as const : abiStatus(captured.files['project.abi']),
    abs: raw['project.abs'] === null ? 'missing' as const : 'available' as const,
    map: raw['project.abs.map.json'] === null ? 'missing' as const : 'available' as const,
    hashes: { abi: raw['project.abi']?.hash ?? null, abs: raw['project.abs']?.hash ?? null, map: raw['project.abs.map.json']?.hash ?? null } };
}

/** A failed load has no authoritative complete native canvas. Keep the saved
 * document byte-for-byte as the target primary and archive any partial view
 * separately. The normal directory copier retains project-data sidecars. */
export async function captureProjectDiskRecovery(project: string, assertContext: () => void,
  fragment: ProjectRecoveryFragment, native = nativePort()): Promise<BlocklySaveAsSnapshot> {
  assertContext();
  const captured = await captureProjectRecoveryFiles(project, sourceNames, assertContext, native);
  const source = captured.files as SourceFiles;
  const status = source['project.abi'] === null && captured.rawFiles['project.abi'] !== null ? 'invalid' : abiStatus(source['project.abi']);
  if (status !== 'available') throw failure('PROJECT_RECOVERY_SOURCE_UNAVAILABLE',
    `The saved project.abi is ${status}; no complete primary document was replaced or invented. Preserve the source and inspect its existing backups and dependency diagnostics.`);
  if (fragment.documentText !== undefined) {
    // It is an archive, not target authority; still require an intact JSON document.
    try { if (!record(JSON.parse(fragment.documentText))) throw new Error('Expected a document object.'); }
    catch { throw failure('PROJECT_RECOVERY_FRAGMENT_INVALID', 'The partial canvas archive is not an intact JSON document. The source remains unchanged.'); }
  }
  const activationBlocked: ProjectRecoveryActivationBlocked | undefined = !fragment.notApplicable && fragment.documentText === undefined
    ? { reason: 'partial-canvas-unavailable', message: fragment.error || 'The partial canvas could not be preserved; the original view must remain active.' }
    : undefined;
  const recoverySource: ProjectRecoverySource = { version: 1, kind: 'saved-document', complete: true,
    loadFailed: !fragment.notApplicable, partialCanvas: fragment.notApplicable ? 'not-applicable' : activationBlocked ? 'unavailable' : 'archived' };
  let disposed = false;
  const assertCurrent = () => {
    if (disposed) throw failure('PROJECT_RECOVERY_STALE', 'The saved recovery snapshot was disposed.');
    assertContext();
    if (fragment.documentText !== undefined && fragment.isCurrent && !fragment.isCurrent()) {
      throw failure('PROJECT_RECOVERY_SOURCE_CHANGED', 'The partial canvas changed after capture. Keep its current view; no older fragment may replace it.');
    }
    assertProjectRecoveryFilesCurrent(project, captured, native);
  };
  return {
    activationBlocked,
    publish: async target => {
      assertCurrent();
      const targetAbi = `${target}/project.abi`;
      if (!native.existsSync(targetAbi) || native.readFileSync(targetAbi, 'utf8') !== source['project.abi']) {
        throw failure('PROJECT_RECOVERY_TARGET_CONFLICT', 'The recovery destination does not match the complete saved source document; no partial canvas was published over it.');
      }
      const archive = `${target}/recovery-source-${crypto.randomUUID()}.json`;
      native.writeFileSync(archive, JSON.stringify({ version: 1, sourceProject: project, recoverySource,
        files: source, rawFiles: captured.rawFiles, partialCanvas: fragment.notApplicable ? { applicable: false }
          : fragment.documentText === undefined
          ? { captured: false, error: activationBlocked!.message }
          : { captured: true, document: JSON.parse(fragment.documentText) } }), { flag: 'wx' });
      assertCurrent();
      if (native.readFileSync(targetAbi, 'utf8') !== source['project.abi']) throw failure('PROJECT_RECOVERY_TARGET_CONFLICT',
        'The recovery primary document changed during archive publication. Preserve the destination instead of overwriting it.');
      return { projectSaved: true, generatedCodePublished: false, partial: true, projectionPending: true,
        recoverySource, recoveryArchive: archive, ...(activationBlocked ? { activationBlocked } : {}),
        code: 'PROJECT_RECOVERY_RUNTIME_REQUIRED',
        error: 'The complete saved document is preserved in an independent project. Load its runtime before creating a fresh ABS baseline; the partial canvas is not the primary document.' };
    },
    isCurrent: () => { try { assertCurrent(); return true; } catch { return false; } },
    freezeForActivation: () => { assertCurrent(); return fragment.freezeForActivation?.() ?? (() => {}); },
    dispose: () => { disposed = true; },
  };
}
