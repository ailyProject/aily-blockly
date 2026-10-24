import { createProjectDataMarker } from '@domain/project/public-api';
import { AbsBaselineStore, AbsSyncStoragePort, absBaselineKey } from './abs-baseline-store';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { decodeAbsState, splitAbsState } from './abs-full-state';
import { sameAbsProgram } from './abs-program-state';
import { AbsSyncError } from './abs-state';

/** Opening a complete ABS regenerates caches; a draft is retained and opens its committed snapshot. */
export async function restoreAbsProjectCaches(port: AbsSyncStoragePort, projectPath: string,
  assertCurrent: () => void): Promise<string | null> {
  const lookup = new AbsBaselineStore(port, { projectKey: projectPath, pageId: '' });
  const expected = await lookup.captureDisk();
  const committed = await lookup.inspectCommitted();
  const baseline = committed?.projection;
  const baselineState = baseline ? splitAbsState(baseline.abs).state : null;
  let publicState: string | null = null;
  try { publicState = expected.abs === null ? null : splitAbsState(expected.abs).state; }
  catch (error) { if (!baselineState) throw error; }
  if (!publicState && !baselineState) return null;
  if (await port.read('prepared.json') !== null) throw new AbsSyncError('ABS_TRANSACTION_PENDING', 'Recover the pending ABS transaction before opening.');
  if (expected.abs === null) throw new AbsSyncError('ABS_SOURCE_MISSING', 'Complete ABS is missing; retain the committed recovery snapshot.');
  let source = expected.abs;
  if (!publicState) source = baseline!.abs;
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
    await port.withLock(async storage => {
      if (absJson(await lookup.captureDisk(storage)) !== absJson(expected)
        || await hashAbsText((await storage.read('committed.json'))!) !== committed!.pointerHash) {
        throw new AbsSyncError('ABS_DISK_CONFLICT', 'Project changed during cache restoration.');
      }
      for (const [key, before, value] of [['project.abi', expected.abi, abi], ['project.abs.map.json', expected.map, absJson(baseline.map)]]) {
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
  const projection = await createAbsProjection(decoded.workspace, { document, contracts: decoded.contracts,
    generation, baselineRef: absBaselineKey(generation), scope, savedAbiHash: await hashAbsText(absJson(JSON.parse(abi))) });
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
