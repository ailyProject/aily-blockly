import { AbsSyncError } from './abs-state';
import { serializeAbsFailure } from './abs-diagnostics';

/** Coordinator-owned outcome, never inferred from a library error code. */
export class AbsApplicationFailure extends AbsSyncError {
  constructor(error: unknown, readonly applicationStatus: 'NOT_STARTED' | 'ROLLED_BACK') {
    const failure = serializeAbsFailure(error);
    super(failure.code, failure.message, failure.range, [], failure.diagnostic);
  }
}
