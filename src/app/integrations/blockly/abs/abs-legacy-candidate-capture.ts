import { AbsBaselineStore, absBaselineKey, type AbsSyncStoragePort } from './abs-baseline-store';
import { absJson, hashAbsText } from './abs-identity-map';
import { generationEvidence } from './abs-generation-protocol';
import { AbsSyncError } from './abs-state';

/** Read-only migration adapter. An exact original proof selects G0. Neither
 * the current Working document nor the current committed pointer selects it. */
export async function readLegacyCandidateCapture(port: AbsSyncStoragePort, project: string, legacy: any) {
  const invalid = (): never => { throw new AbsSyncError('ABS_LEGACY_CANDIDATE_UNPROVEN', 'The exact original candidate baseline is unavailable; the old source and proof remain retained.'); };
  if (!legacy || typeof legacy !== 'object' || Object.keys(legacy).some(key => !['generation', 'absHash', 'mapHash'].includes(key))
    || !/^[A-Za-z0-9_-]{1,96}$/.test(legacy.generation) || !/^sha256:[a-f0-9]{64}$/.test(legacy.absHash)
    || !/^[a-f0-9]{64}$/.test(legacy.mapHash) || !port.attachment) return invalid();
  const text = await port.read(absBaselineKey(legacy.generation));
  if (text === null) return invalid();
  let record: any;
  try { record = JSON.parse(text); } catch { return invalid(); }
  const scope = record.schemaVersion === 2 ? record.context?.scope : record.projection?.map?.scope;
  if (scope?.projectKey !== project || typeof scope?.pageId !== 'string' || !scope.pageId) return invalid();
  const store = new AbsBaselineStore(port, scope), projection = await store.load(legacy.generation);
  if (projection.map.generation !== legacy.generation || projection.map.baseAbsHash !== legacy.absHash
    || await hashAbsText(absJson(projection.map)) !== `sha256:${legacy.mapHash}`) return invalid();
  const abi = await store.readDerivedAbi(legacy.generation);
  return { version: 1, document: absJson(projection.document), abs: projection.abs, map: absJson(projection.map),
    contracts: absJson(projection.contracts), scope: { kind: 'pages', pageIds: [scope.pageId] }, attachment: port.attachment,
    published: (await generationEvidence(projection, abi)).binding, publishedObservation: { status: 'captured' },
    working: { revision: 0 } };
}
