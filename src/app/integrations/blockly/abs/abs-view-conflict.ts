import { absJson, hashAbsText } from './abs-identity-map';
import type { AbsDiskSnapshot } from './abs-baseline-store';
import type { AbsProjectionContracts } from './abs-state';

export type AbsViewConflictChoice = 'keep_view' | 'replace_view';
export interface AbsViewConflictOffer {
  project: string;
  token: string;
  choices: readonly ['keep_view', 'replace_view'];
  source: 'saved-abi';
  inputAbiHash: string;
}

/** A choice authorizes one observed pair, not a force-save or a claim that an
 * unapplied draft is the newest project. Full view state participates so a
 * dialog cannot silently consume an edit made while it was open. */
export async function describeAbsViewConflict(input: {
  project: string; scope: unknown; disk: AbsDiskSnapshot; pointerHash: string;
  snapshot: unknown; contracts: AbsProjectionContracts; repairToken?: string;
}): Promise<AbsViewConflictOffer | undefined> {
  if (!input.repairToken || input.disk.abi === null) return;
  return { project: input.project,
    token: await hashAbsText(absJson({ version: 1, kind: 'view-conflict', ...input })),
    choices: ['keep_view', 'replace_view'], source: 'saved-abi',
    inputAbiHash: await hashAbsText(input.disk.abi) };
}
