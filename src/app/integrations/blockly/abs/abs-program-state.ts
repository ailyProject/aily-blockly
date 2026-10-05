import { absJson } from './abs-json';
import type { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';

/** Use the persistence ownership partition before native verification as well as load. */
export function orderAbsSharedRoots(target: AbsAbiWorkspace, document: unknown, contracts: AbsProjectionContracts): void {
  const shared = (document as { sharedModel?: { procedureBlocks?: Array<{ id: string }> } } | null)?.sharedModel?.procedureBlocks ?? [];
  const ids = new Set(shared.map(block => block.id));
  for (const [id, procedure] of Object.entries(contracts.procedures ?? {})) {
    if (procedure.role === 'definition') ids.add(id);
  }
  target.blocks.blocks.sort((a, b) => Number(!ids.has(a.id)) - Number(!ids.has(b.id)));
}

function withoutNumericLayout(value: Record<string, unknown>, keys: readonly string[]) {
  const result = { ...value };
  for (const key of keys) if (typeof result[key] === 'number' && Number.isFinite(result[key])) delete result[key];
  return result;
}

/** Root positions are presentation, not ABS semantics. Field/resource values
 * named x/y and every nested connection remain part of the program. */
export function absProgramWorkspace<T extends Record<string, any>>(workspace: T): T {
  if (!Array.isArray(workspace['blocks']?.blocks)) return workspace;
  return { ...workspace, blocks: { ...workspace['blocks'], blocks: workspace['blocks'].blocks
    .map(block => withoutNumericLayout(block, ['x', 'y'])) } };
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
