import { absMapJson } from './abs-map-json';
import { createProjectDataMarker } from '@domain/project/public-api';
import { AbsBaselineStore, AbsSyncStorageAccess, AbsSyncStoragePort, absBaselineKey } from './abs-baseline-store';
import { absJson, hashAbsText, reconstructAbsProjection, supportsAbsProjectionForEditing } from './abs-identity-map';
import { decodeAbsState, splitAbsState } from './abs-full-state';
import { sameAbsProgram } from './abs-program-state';
import { AbsSyncError } from './abs-state';
import { settleAbsProjectOpen } from './abs-project-restart';
import { recoverAbsBaseline } from './abs-baseline-recovery';

/** The normal editor supports both single-workspace ABI and paged projects.
 * Recognition here only selects a read path. Native load still verifies the
 * document, installed block definitions, project data and identities. */
export function readSavedBlocklyAbi(text: string | null): Record<string, unknown> | undefined {
  if (text === null) return undefined;
  try {
    const input = JSON.parse(text);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const blockly = Array.isArray(input.pages)
      ? input.pages.every((page: any) => page && typeof page === 'object' && !Array.isArray(page))
      : !!input.blocks && typeof input.blocks === 'object' && !Array.isArray(input.blocks)
        && (input.blocks.blocks === undefined || Array.isArray(input.blocks.blocks))
        || Object.keys(input).every(key => ['variables', 'comments', '$ailyProjectData'].includes(key));
    return blockly ? input : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

/** Opening a complete ABS regenerates caches; a draft is retained and opens its committed snapshot. */
export async function restoreAbsProjectCaches(port: AbsSyncStoragePort, projectPath: string,
  assertCurrent: () => void, { preferSavedAbi = false } = {}): Promise<string | null> {
  await settleAbsProjectOpen(port, projectPath, assertCurrent);
  const lookup = new AbsBaselineStore(port, { projectKey: projectPath, pageId: '' });
  if (preferSavedAbi) {
    const abi = await port.read('project.abi');
    if (readSavedBlocklyAbi(abi)) {
      // The saved primary is the selected canvas. Even reading the public
      // companions is unnecessary here. An exact, verified private record can
      // mark this ABI as complete; ordinary legacy loading otherwise proceeds.
      try {
        const committed = await lookup.inspectCommitted(), baseline = committed?.projection;
        if (!baseline || !supportsAbsProjectionForEditing(baseline.map.projectionVersion)
          || abi !== await lookup.readDerivedAbi(baseline.map.generation)) return null;
        assertCurrent();
        return await port.read('project.abi') === abi ? abi : null;
      } catch (error) {
        if (!['ABS_BASELINE_CORRUPT', 'ABS_BASELINE_MISSING', 'ABS_STORAGE_ENCODING_INVALID', 'PROJECT_FILE_TOO_LARGE'].includes((error as any)?.code)) throw error;
        return null;
      }
    }
  }
  let expected = await lookup.captureDisk();
  let committed: Awaited<ReturnType<AbsBaselineStore['inspectCommitted']>>;
  try { committed = await lookup.inspectCommitted(); }
  catch (error) {
    if (!['ABS_BASELINE_CORRUPT', 'ABS_BASELINE_MISSING'].includes((error as any)?.code)) throw error;
    await recoverAbsBaseline(port, projectPath, assertCurrent);
    expected = await lookup.captureDisk(); committed = await lookup.inspectCommitted();
  }
  if (!committed && expected.map !== null) {
    await recoverAbsBaseline(port, projectPath, assertCurrent);
    expected = await lookup.captureDisk(); committed = await lookup.inspectCommitted();
  }
  if (committed && expected.abi !== null) {
    let damaged = false;
    try { JSON.parse(expected.abi); } catch { damaged = true; }
    if (damaged) {
      await recoverAbsBaseline(port, projectPath, assertCurrent);
      expected = await lookup.captureDisk(); committed = await lookup.inspectCommitted();
    }
  }
  const baseline = committed?.projection;
  const baselineState = baseline ? splitAbsState(baseline.abs).state : null;
  let publicState: string | null = null;
  try { publicState = expected.abs === null ? null : splitAbsState(expected.abs).state; }
  catch (error) { if (!baselineState) throw error; }
  if (!publicState && !baselineState) return null;
  if (await port.read('prepared.json') !== null) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Recover the pending ABS transaction before opening.');
  const projectMode = await lookup.workspaceMode() === 'project-v1';
  const missingAuthor = expected.abs === null;
  if (missingAuthor && (!projectMode || !baselineState || baseline?.map.scope.projectKey !== projectPath)) {
    throw new AbsSyncError('ABS_SOURCE_MISSING', 'Complete ABS is missing; retain the committed recovery snapshot.');
  }
  // In project-v1 the public ABS is the author file. Use the verified saved
  // snapshot for the canvas while leaving even an absent author file alone.
  let source = baseline && (projectMode || !publicState) ? baseline.abs : expected.abs!;
  // A copied private generation is still foreign. Load its committed content so
  // the workspace can offer explicit rebind, without publishing a new identity
  // or consuming the public draft before that decision.
  if (baseline && baseline.map.scope.projectKey !== projectPath) {
    if (!baselineState) throw new AbsSyncError('ABS_SCOPE_INVALID', 'Copied private state requires explicit project rebind.');
    source = baseline.abs;
  }
  let decoded: Awaited<ReturnType<typeof decodeAbsState>>;
  try { decoded = await decodeAbsState(source); }
  catch (error) {
    // An interrupted text edit can damage the state line as well as the body.
    // Keep those exact bytes as a draft, just as for an ordinary body edit.
    // Only an independently verified committed snapshot may supply the canvas.
    if (!baselineState || !(error instanceof AbsSyncError) || error.code !== 'ABS_STATE_INVALID') throw error;
    source = baseline!.abs;
    decoded = await decodeAbsState(source);
  }
  const document: any = decoded.document;
  if (!document || typeof document.activePageId !== 'string') throw new AbsSyncError('ABS_STATE_INVALID', 'A complete project requires an active page.');
  if (expected.abi !== null) {
    const current = JSON.parse(expected.abi);
    const savedHash = await hashAbsText(absJson(current));
    const reference = baseline?.document ?? document;
    const normalized = { ...reference as object, $ailyProjectData: createProjectDataMarker() };
    if (savedHash !== baseline?.map.savedAbiHash && !sameAbsProgram(current, normalized)
      && !sameAbsProgram(current, reference)) {
      throw new AbsSyncError('ABS_DUAL_EDIT_CONFLICT', 'Derived ABI was externally edited; preserve both versions before restoring ABS.');
    }
  }
  assertCurrent();
  if (baseline?.abs === source) {
    const abi = await lookup.readDerivedAbi(baseline.map.generation);
    if (abi === null) throw new AbsSyncError('ABS_STATE_INVALID', 'This historical export has no saved-cache recipe; explicitly re-export it.');
    if (missingAuthor && expected.abi !== abi) {
      throw new AbsSyncError('ABS_SOURCE_MISSING', 'Missing author ABS requires the exact verified saved ABI.');
    }
    const map = absMapJson(baseline.map);
    const assertSource = async (storage: Pick<AbsSyncStorageAccess, 'read'>) => {
      const pointer = await storage.read('committed.json');
      if (pointer === null || await hashAbsText(pointer) !== committed!.pointerHash
        || absJson(await lookup.captureDisk(storage)) !== absJson(expected)
        || await storage.read('prepared.json') !== null || await storage.read('committed.json') !== pointer) {
        throw new AbsSyncError('ABS_DISK_CONFLICT', 'Project changed during cache restoration.');
      }
      assertCurrent();
    };
    if (expected.abi === abi && expected.map === map) {
      await assertSource(port);
      return abi;
    }
    await port.withLock(async storage => {
      await assertSource(storage);
      for (const [key, before, value] of [['project.abi', expected.abi, abi], ['project.abs.map.json', expected.map, map]]) {
        assertCurrent();
        if (before !== value && !await storage.replace(key!, before === null ? null : await hashAbsText(before!), value!)) {
          throw new AbsSyncError('ABS_DISK_CONFLICT', 'Derived cache changed during restoration.');
        }
      }
    });
    return abi;
  }
  const abi = JSON.stringify({ ...document, $ailyProjectData: createProjectDataMarker() });
  const generation = crypto.randomUUID(), scope = { projectKey: projectPath, pageId: document.activePageId };
  const projection = await reconstructAbsProjection(decoded.workspace, { document, contracts: decoded.contracts,
    generation, baselineRef: absBaselineKey(generation), scope, savedAbiHash: await hashAbsText(absJson(JSON.parse(abi))) }, source);
  if (projection.abs !== source) throw new AbsSyncError('ABS_STATE_INVALID', 'The restored snapshot is not canonical.');
  const store = new AbsBaselineStore(port, scope);
  await store.stage({ projection, mode: 'import', inputAbs: expected.abs, abi, expected }, committed?.pointerHash ?? null);
  const result = await store.commit(generation, assertCurrent, async (text, hash, storage) => {
    assertCurrent();
    if (!await storage.replace('project.abi', hash, text)) throw new AbsSyncError('ABS_DISK_CONFLICT', 'ABI cache changed.');
  });
  if (result.status !== 'COMMITTED') throw new AbsSyncError('ABS_RESTORE_INCOMPLETE', result.error ?? result.status);
  return abi;
}
