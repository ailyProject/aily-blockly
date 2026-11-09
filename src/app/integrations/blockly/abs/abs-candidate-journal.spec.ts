import type { AbsSyncStoragePort } from './abs-baseline-store';
import { AbsCandidateJournal, assertCandidateArchiveRequest } from './abs-candidate-journal';
import { absJson, hashAbsText } from './abs-identity-map';

describe('retained legacy candidate archives', () => {
  const project = '/private/current', source = 'broken(\n"完整候选🌟"';
  let files: Map<string, string>, port: AbsSyncStoragePort;
  beforeEach(() => {
    files = new Map([['project.abi', 'current C'], ['project.abs', 'current C'], ['committed.json', 'original pointer']]);
    port = { read: async key => files.get(key) ?? null,
      withLock: () => { throw new Error('A legacy reader must never enter a writer'); } };
  });
  async function seed(changes: Record<string, unknown> = {}) {
    const record = { version: 1, kind: 'abs-candidate', project,
      candidate: { source, hash: await hashAbsText(source), bytes: new TextEncoder().encode(source).byteLength,
        intentGeneration: 'original-intent', editProof: { opaque: 'old proof' } }, ...changes };
    const text = absJson(record), hash = await hashAbsText(text);
    files.set(`recoveries/candidate-${hash.slice(7)}.json`, text);
    return hash;
  }
  it('reads exact invalid-syntax A and opaque old proof while leaving current C untouched', async () => {
    const hash = await seed(), before = [...files];
    const read = await new AbsCandidateJournal(port, project, () => {}).read(hash);
    expect(read.candidate.source).toBe(source);
    expect(read.candidate.editProof).toEqual({ opaque: 'old proof' });
    expect(read.candidateArchive.candidateApplied).toBeFalse();
    expect((read as any).evidence).toBeUndefined();
    expect([...files]).toEqual(before);
    expect((new AbsCandidateJournal(port, project, () => {}) as any).preserve).toBeUndefined();
  });
  it('refuses damaged or foreign data rather than rebinding it to the current project', async () => {
    const journal = new AbsCandidateJournal(port, project, () => {}), hash = await seed();
    files.set(`recoveries/candidate-${hash.slice(7)}.json`, 'damaged');
    await expectAsync(journal.read(hash)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_UNAVAILABLE' }));
    const foreign = await seed({ project: '/other' });
    await expectAsync(journal.read(foreign)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_INVALID' }));
    expect(files.get('project.abs')).toBe('current C');
  });
  it('validates retained predecessor observations without creating replacement records', async () => {
    const hash = await seed({ damagedPredecessor: { recordHash: 'sha256:' + 'a'.repeat(64), hash: 'invalid' } });
    const before = [...files];
    await expectAsync(new AbsCandidateJournal(port, project, () => {}).read(hash))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_CANDIDATE_ARCHIVE_INVALID' }));
    expect([...files]).toEqual(before);
  });
  it('accepts only exact read fields and rejects all new legacy archive writes', () => {
    expect(() => assertCandidateArchiveRequest({ version: 2, requestId: 'original', action: 'read_candidate', recordHash: 'sha256:' + 'a'.repeat(64) })).not.toThrow();
    expect(() => assertCandidateArchiveRequest({ action: 'preserve_candidate', abs: source })).toThrow();
    expect(() => assertCandidateArchiveRequest({ action: 'read_candidate', recordHash: 'invalid' })).toThrow();
  });
});
