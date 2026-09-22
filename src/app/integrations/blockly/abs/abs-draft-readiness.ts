import { materializeGenericProjectDataValues, projectDataRuntime } from '@domain/project/public-api';
import { compareAbsContracts } from './abs-contract-compatibility';
import { inspectAbsGeneration } from './abs-generation-inspection';
import { generationEvidence, AbsGenerationEvidence } from './abs-generation-protocol';
import { absJson, hashAbsText } from './abs-identity-map';
import { AbsAbiWorkspace, AbsProjectionContracts } from './abs-state';
import { absProgramDocument, sameAbsProgram } from './abs-program-state';

type Inspection = Awaited<ReturnType<typeof inspectAbsGeneration>>;
export interface AbsDraftReadiness {
  draft?: { hash: string; bytes: number; canValidate: boolean };
  baseline?: AbsGenerationEvidence;
  runtime?: ReturnType<typeof compareAbsContracts>;
  refresh?: { token: string };
  /** Canvas uses its live baseline; savedChangedFromBaseline uses the saved ABI
   * hash, not the normalized live document. Neither grants overwrite authority. */
  workspace?: { changedFromBaseline: boolean; savedChangedFromBaseline: boolean; matchesSaved: boolean };
}

/** Read-only readiness, not candidate validation. Resolve resources without creating
 * assets or changing mirrors. Only a proven unchanged project can refresh a draft. */
export async function inspectAbsDraft(inspection: Inspection, document: unknown,
  runtime: { state: AbsAbiWorkspace; contracts: AbsProjectionContracts }) {
  const diagnostics: Inspection['diagnostics'] & AbsDraftReadiness = { ...inspection.diagnostics };
  if (!inspection.committed || !inspection.disk.abs) return diagnostics;
  const draft = diagnostics.issues.includes('ABS_SOURCE_CONFLICT');
  if (draft) diagnostics.draft = { hash: diagnostics.hashes.abs!, bytes: new TextEncoder().encode(inspection.disk.abs).byteLength, canValidate: false };
  if (diagnostics.issues.some(issue => issue !== 'ABS_SOURCE_CONFLICT')) return diagnostics;
  const baseline = inspection.committed!.projection;
  const resolve: Pick<typeof projectDataRuntime, 'resolve'> = { resolve: ref => projectDataRuntime.resolve(ref) };
  const sameDocument = sameAbsProgram(document, baseline.document)
    || sameAbsProgram(await materializeGenericProjectDataValues(document, resolve),
      await materializeGenericProjectDataValues(baseline.document, resolve));
  const sameSaved = inspection.disk.abi !== null
    && await hashAbsText(absJson(JSON.parse(inspection.disk.abi))) === baseline.map.savedAbiHash;
  if (inspection.disk.abi !== null) {
    const saved = JSON.parse(inspection.disk.abi);
    const same = async (a: unknown, b: unknown) => sameAbsProgram(a, b)
      || sameAbsProgram(await materializeGenericProjectDataValues(a, resolve), await materializeGenericProjectDataValues(b, resolve));
    diagnostics.workspace = { changedFromBaseline: !sameDocument,
      savedChangedFromBaseline: !sameSaved, matchesSaved: await same(document, saved) };
  }
  const runtimeStatus = compareAbsContracts(baseline.contracts, runtime.contracts, runtime.state);
  diagnostics.runtime = runtimeStatus;
  diagnostics.issues = [...diagnostics.issues,
    ...(!sameDocument || !sameSaved ? ['ABS_BASELINE_STALE'] : []),
    ...(diagnostics.workspace?.savedChangedFromBaseline && !diagnostics.workspace.matchesSaved ? ['ABS_DUAL_EDIT_CONFLICT'] : []),
    ...(runtimeStatus.status === 'incompatible' ? ['ABS_RUNTIME_CONTRACT_STALE'] : [])];
  diagnostics.status = diagnostics.issues.length ? 'blocked' : 'ready';
  if (draft && sameDocument && sameSaved) {
    diagnostics.baseline = await generationEvidence(baseline, inspection.disk.abi);
    diagnostics.draft.canValidate = runtimeStatus.status !== 'incompatible';
    diagnostics.refresh = { token: await hashAbsText(absJson({
      scope: diagnostics.scope, hashes: diagnostics.hashes, committed: inspection.committed!.pointerHash,
      contracts: runtime.contracts, document: absProgramDocument(document),
    })) };
  }
  return diagnostics;
}
