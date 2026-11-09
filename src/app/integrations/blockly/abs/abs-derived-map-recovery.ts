import { AbsBaselineStore, type AbsSyncStoragePort } from './abs-baseline-store';
import { hashAbsText } from './abs-identity-map';
import { AbsSyncError } from './abs-state';

/** Shell diagnostics select a cache repair, never supply publication authority.
 * Re-read all source bytes, the head and the physical attachment on the Host. */
export async function restoreObservedProgramMap(port: AbsSyncStoragePort, project: string,
  input: unknown, assertCurrent: () => void) {
  const value = input as any;
  const normalize = (path: string) => {
    const value = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:\//.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
  };
  const invalid = () => new AbsSyncError('ABS_MAP_REPAIR_UNPROVEN', 'The original complete source does not prove a derived map repair.');
  if (value?.version !== 1 || value.authority !== 'diagnostic-only' || typeof value.project !== 'string'
    || normalize(value.project) !== normalize(project) || !port.attachment || !value.attachment
    || value.attachment.version !== 1 || typeof value.attachment.root !== 'string'
    || normalize(value.attachment.root) !== normalize(port.attachment.root)
    || !(['dev', 'ino', 'birthtimeNs'] as const).every(key => value.attachment.identity?.[key] === port.attachment!.identity[key])) throw invalid();
  const names = ['abiHash', 'absHash', 'mapHash', 'committedHash', 'preparedHash'];
  for (const side of [value.before, value.after]) {
    if (!side || !names.every(key => side[key] === null || typeof side[key] === 'string' && /^sha256:[a-f0-9]{64}$/.test(side[key]))) throw invalid();
  }
  if (value.before.preparedHash !== null || value.after.preparedHash !== null
    || ['abiHash', 'absHash', 'committedHash'].some(key => value.before[key] !== value.after[key])) throw invalid();
  const store = new AbsBaselineStore(port, { projectKey: project, pageId: '' }), disk = await store.captureDisk();
  const pointer = await port.read('committed.json'), prepared = await port.read('prepared.json');
  const rawHash = async (text: string | null) => text === null ? null : hashAbsText(text);
  const hashes = await Promise.all([disk.abi, disk.abs, disk.map, pointer, prepared].map(rawHash));
  assertCurrent();
  if (pointer === null || names.some((key, i) => value.after[key] !== hashes[i])) throw invalid();
  const result = await store.restoreCommittedMap(assertCurrent, { disk, pointerHash: await hashAbsText(pointer) });
  return { ok: true as const, project, mapRestored: true as const, ...result };
}
