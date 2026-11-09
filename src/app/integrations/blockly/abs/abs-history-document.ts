import { AbsSyncError } from './abs-state';
import { mergeAbsStrictDocument } from './abs-strict-document-merge';

/** History and ordinary candidates share one strict document/ID graph policy.
 * Keep the existing public History error code for callers and old receipts. */
export function mergeAbsHistoryDocument<T>(base: T, working: T, target: T): T {
  try {
    return mergeAbsStrictDocument(base, working, target);
  } catch (error) {
    if (
      !(error instanceof AbsSyncError) ||
      error.code !== 'ABS_DOCUMENT_MERGE_CONFLICT'
    )
      throw error;
    throw new AbsSyncError(
      'ABS_HISTORY_DOCUMENT_CONFLICT',
      error.message,
      error.range,
      error.blockIds,
      error.diagnostic,
    );
  }
}
