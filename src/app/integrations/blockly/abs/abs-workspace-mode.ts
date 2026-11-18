import { AbsSyncError } from './abs-state';
import { absJson } from './abs-identity-map';
import type { AbsGenerationBinding } from './abs-generation-protocol';
import type { AbsProjectAttachment } from './abs-baseline-store';

export type AbsWorkspaceMode = 'overlay-v1' | 'project-v1';
export const ABS_WORKSPACE_MODES: readonly AbsWorkspaceMode[] = ['overlay-v1', 'project-v1'];
/** Native storage maps this read-only key to .aily/workspace-mode.json. */
export const ABS_WORKSPACE_MODE_KEY = 'workspace-mode.json';

export async function readAbsWorkspaceMode(storage: { read(key: string): Promise<string | null> }): Promise<AbsWorkspaceMode> {
  const text = await storage.read(ABS_WORKSPACE_MODE_KEY);
  if (text === null) return 'overlay-v1';
  try {
    const value = JSON.parse(text);
    if (value?.version === 1 && ABS_WORKSPACE_MODES.includes(value.mode)
      && Object.keys(value).sort().join(',') === 'mode,version') return value.mode;
  } catch { /* An invalid explicit selection cannot choose the old engine. */ }
  throw new AbsSyncError('ABS_WORKSPACE_MODE_INVALID', 'The project execution mode is invalid; no fallback was selected.');
}

export interface AbsAuthorSourceRecord {
  version: 1;
  inputHash: string | null;
  hash: string | null;
  disposition: 'accepted' | 'refreshed' | 'preserved';
}

export interface AbsAcceptedSourceProof {
  version: 1;
  workspaceMode: 'project-v1';
  attachment: AbsProjectAttachment;
  binding: AbsGenerationBinding;
  committedHash: string;
  authorSource: { path: 'project.abs'; hash: string | null; bytes: number | null; pending: boolean };
}

export function acceptedSourceMatches(value: unknown, binding: AbsGenerationBinding, attachment?: AbsProjectAttachment): value is AbsAcceptedSourceProof {
  const proof = value as AbsAcceptedSourceProof;
  return proof?.version === 1 && proof.workspaceMode === 'project-v1'
    && !!attachment && absJson(proof.attachment) === absJson(attachment)
    && absJson(proof.binding) === absJson(binding)
    && /^sha256:[a-f0-9]{64}$/.test(proof.committedHash)
    && proof.authorSource?.path === 'project.abs' && typeof proof.authorSource.pending === 'boolean'
    && (proof.authorSource.hash === null && proof.authorSource.bytes === null
      || typeof proof.authorSource.hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(proof.authorSource.hash)
        && Number.isSafeInteger(proof.authorSource.bytes) && proof.authorSource.bytes! >= 0);
}
