import type { ProjectSaveOutcome } from './project-save-outcome';

export type ProjectConflictChoice = 'keep_view' | 'replace_view';

/** An inspected capability for one exact current project, not an overwrite flag. */
export interface ProjectConflictOffer {
  project: string;
  token: string;
}

export interface ProjectConflictResolution extends ProjectSaveOutcome {
  project: string;
  choice: ProjectConflictChoice;
  refreshed: boolean;
  generation: string;
}

const recoverableSaveCodes = new Set([
  'ABS_DUAL_EDIT_CONFLICT', 'ABS_SOURCE_CONFLICT', 'ABS_MAP_INVALID',
  'ABS_BASELINE_STALE', 'ABS_RUNTIME_CONTRACT_STALE', 'ABS_SAVED_ABI_CHANGED',
]);

/** Unknown/timeout acknowledgements and unrelated I/O failures never authorize resolution. */
export function isProjectSaveConflict(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && recoverableSaveCodes.has((value as { code?: unknown }).code as string);
}

export function isProjectConflictChoice(value: unknown): value is ProjectConflictChoice {
  return value === 'keep_view' || value === 'replace_view';
}

export function isProjectConflictOffer(value: unknown, project: string): value is ProjectConflictOffer {
  const offer = value as ProjectConflictOffer | undefined;
  return !!offer && offer.project === project && typeof offer.token === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(offer.token);
}

export function isProjectConflictResolution(value: unknown, project: string,
  choice: ProjectConflictChoice): value is ProjectConflictResolution {
  const result = value as ProjectConflictResolution | undefined;
  return !!result && result.project === project && result.choice === choice
    && result.refreshed === (choice === 'replace_view')
    && typeof result.generation === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(result.generation)
    && typeof result.projectSaved === 'boolean' && typeof result.generatedCodePublished === 'boolean'
    && typeof result.partial === 'boolean';
}
