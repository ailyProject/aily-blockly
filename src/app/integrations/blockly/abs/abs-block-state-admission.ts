import { AbsSyncError } from './abs-state';

/** A first-generation state change is bound to one inspected canvas, never a
 * wildcard generation. The caller supplies exact serialized context/disk facts.
 * Admission is process-local, short-lived, single-use and cannot survive reload. */
export class AbsBlockStateAdmission {
  private current?: { token: string; facts: string; expires: number; isCurrent: () => boolean };

  issue(facts: string, isCurrent: () => boolean): string {
    const token = crypto.randomUUID();
    this.current = { token, facts, isCurrent, expires: Date.now() + 5 * 60 * 1000 };
    return token;
  }

  consume(token: string, facts: string): void {
    const current = this.current;
    if (!current || current.token !== token || current.expires < Date.now()
      || !current.isCurrent() || current.facts !== facts) {
      throw new AbsSyncError('ABS_BLOCK_STATE_INSPECTION_STALE',
        'The inspected canvas or project files changed. Inspect block states again before an explicit update.');
    }
    this.current = undefined;
  }
}
