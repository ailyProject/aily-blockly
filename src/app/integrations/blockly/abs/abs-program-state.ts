import { absJson } from './abs-json';
import type { AbsAbiWorkspace } from './abs-state';

function withoutNumericLayout(value: Record<string, unknown>, keys: readonly string[]) {
  const result = { ...value };
  for (const key of keys) if (typeof result[key] === 'number' && Number.isFinite(result[key])) delete result[key];
  return result;
}

/** Only native root coordinates and viewport values are presentation. Connections,
 * root order, page ownership and extension state still belong to the program.
 * Projection hashes, disk CAS and persistence revisions remain byte-exact. */
export function absProgramDocument(document: unknown): unknown {
  if (!document || typeof document !== 'object' || !Array.isArray(document['pages'])) return document;
  const roots = (blocks: any[]) => blocks.map(block => block && typeof block === 'object' && !Array.isArray(block)
    ? withoutNumericLayout(block, ['x', 'y']) : block);
  const shared = document['sharedModel'];
  return { ...document,
    ...(Array.isArray(shared?.procedureBlocks) ? { sharedModel: { ...shared, procedureBlocks: roots(shared.procedureBlocks) } } : {}),
    pages: document['pages'].map(page => {
      if (!page || typeof page !== 'object' || Array.isArray(page)) return page;
      const result = { ...page };
      if (Array.isArray(page.content?.blocks?.blocks)) {
        result.content = { ...page.content, blocks: { ...page.content.blocks, blocks: roots(page.content.blocks.blocks) } };
      }
      if (!page.viewState || typeof page.viewState !== 'object' || Array.isArray(page.viewState)) return result;
      const viewState = withoutNumericLayout(page.viewState, ['scale', 'scrollX', 'scrollY']);
      delete result.viewState;
      return Object.keys(viewState).length ? { ...result, viewState } : result;
    }),
  };
}

/** Reconciliation owns code; the current editor owns retained roots' layout. */
export function retainAbsRootLayout(target: AbsAbiWorkspace, current: AbsAbiWorkspace): void {
  const roots = new Map(current.blocks.blocks.map(block => [block.id, block]));
  for (const block of target.blocks.blocks) {
    const actual = roots.get(block.id);
    if (!actual || actual.type !== block.type) continue;
    for (const key of ['x', 'y']) {
      if (!Object.hasOwn(actual, key)) delete block[key];
      else block[key] = actual[key];
    }
  }
}

export function sameAbsProgram(a: unknown, b: unknown): boolean {
  return absJson(absProgramDocument(a)) === absJson(absProgramDocument(b));
}
