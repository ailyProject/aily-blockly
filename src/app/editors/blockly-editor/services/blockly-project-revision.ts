import { canonicalJsonStringify } from '@domain/project/public-api';

/** Observed persisted state, independent of code-generation events (which omit layout/UI state).
 * Deliberately compares content until every custom serializer has a reliable invalidation contract.
 */
export class BlocklyProjectRevision {
  private revision = 0;
  private text: string | undefined;
  get current(): number { return this.revision; }

  observe(document: unknown): number {
    const text = canonicalJsonStringify(document);
    if (this.text !== text) { this.text = text; this.revision++; }
    return this.revision;
  }

  invalidate(): void {
    this.text = undefined;
  }
}
