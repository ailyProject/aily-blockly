import { absJson, hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

export interface AbsJournalReopenObservation {
  generation: string;
  scope: { projectKey: string; pageId: string };
  pointerHash: string;
  hashes: { abi: string | null; abs: string | null; map: string | null };
  canvasHash: string;
  revision: number;
  runtimeRevision: number;
}

/** One recently recovered transaction, not a general reload/unlock capability. */
export class AbsJournalReopenAdmission {
  private recent?: { generation: string; journalToken: string };
  private offered?: { token: string; observation: string; expires: number };

  constructor(private readonly now = Date.now) {}

  remember(generation: string, journalToken: string): void {
    this.recent = { generation, journalToken };
    this.offered = undefined;
  }

  matches(generation?: string): boolean {
    return !!this.recent && (!generation || this.recent.generation === generation);
  }

  async offer(observation: AbsJournalReopenObservation) {
    this.offered = undefined;
    if (!this.matches(observation.generation)) return undefined;
    const recent = this.recent;
    const serialized = absJson(observation);
    const expires = this.now() + 300_000;
    const token = await hashAbsText(absJson({ version: 1, action: 'reopen', ...recent, expires, observation }));
    // Hashing yields; a new recovery may replace the admission meanwhile.
    if (this.recent !== recent) return undefined;
    this.offered = { token, observation: serialized, expires };
    return { action: 'reopen' as const, token, generation: observation.generation, scope: observation.scope };
  }

  consume(generation: string, token: string, observation: AbsJournalReopenObservation): void {
    const offered = this.offered;
    this.offered = undefined;
    if (!this.matches(generation) || observation.generation !== generation || offered?.token !== token || this.now() >= offered.expires
      || offered.observation !== absJson(observation)) {
      throw new AbsSyncError('ABS_JOURNAL_REOPEN_STALE', 'The exact recovered journal, full canvas or project inputs changed. Inspect once for a fresh reopen capability.');
    }
    // Keep transaction provenance for a *fresh* read-only inspection after a
    // lost acknowledgement. The consumed capability itself is never reusable.
  }
}
