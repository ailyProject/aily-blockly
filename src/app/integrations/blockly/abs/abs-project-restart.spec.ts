import { AbsBaselineStore, absBaselineKey, type AbsSyncStoragePort } from './abs-baseline-store';
import { AbsOperationJournal } from './abs-operation-journal';
import { recoverAbsProjectOperation, settleAbsProjectTransaction } from './abs-project-restart';
import { readAbsRecoveryLineage, rememberAbsRecoveryLineage } from './abs-recovery-lineage';
import { absJson, createAbsProjection, hashAbsText } from './abs-identity-map';
import { SerialOperationQueue } from '@shared/public-api';
import { AbsApplicationJournal } from './abs-application-journal';
import { generationEvidence } from './abs-generation-protocol';
import { inspectAbsBaselineRecovery, recoverAbsBaseline } from './abs-baseline-recovery';

describe('same-project durable operation recovery', () => {
  const project = 'same-project', scope = { projectKey: project, pageId: 'main' };
  let files: Map<string, string>, port: AbsSyncStoragePort, fail: string | undefined;
  const document = (value: string) => ({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'main', content: { blocks: { blocks: [{ id: 'keep', type: 'text',
      fields: { TEXT: value }, icons: { comment: { text: 'retained comment' } } }] } } },
    { id: 'inactive', title: 'inactive', content: { blocks: { blocks: [{ id: 'other', type: 'text', fields: { TEXT: 'other' } }] } } }],
    sharedModel: { procedureBlocks: [] } });
  const connect = (): AbsSyncStoragePort => {
    const queue = new SerialOperationQueue();
    const read = async (key: string) => files.get(key) ?? null;
    return { read, withLock: operation => queue.run(() => operation({ read, replace: async (key, expected, value) => {
      if (key === fail) throw new Error(`injected ${key}`);
      const old = await read(key);
      if ((old === null ? null : await hashAbsText(old)) !== expected) return false;
      if (value === null) files.delete(key); else files.set(key, value);
      return true;
    } })) };
  };
  beforeEach(() => { files = new Map(); fail = undefined; port = connect(); });
  async function save(value: string) {
    const store = new AbsBaselineStore(port, scope), doc = document(value), abi = JSON.stringify(doc), generation = crypto.randomUUID();
    const projection = await createAbsProjection(doc.pages[0].content, { document: doc, scope, generation,
      baselineRef: absBaselineKey(generation), savedAbiHash: await hashAbsText(absJson(doc)) });
    await store.stage({ projection, mode: 'import', inputAbs: projection.abs, abi, expected: await store.captureDisk() });
    return { store, generation, abi, projection, commit: () => store.commit(generation, () => {}, async (text, hash, storage) => {
      if (!await storage.replace('project.abi', hash, text)) throw new Error('CAS');
    }) };
  }
  async function operation(kind: 'runtime-rebuild' | 'abs-apply' = 'runtime-rebuild') {
    const journal = new AbsOperationJournal(port, project);
    const complete = document('unsaved last edit');
    const disk = await new AbsBaselineStore(port, scope).captureDisk();
    const candidate = { source: 'retained unapplied candidate', generation: 'original-generation', hash: await hashAbsText('retained unapplied candidate') };
    const id = await journal.begin({ kind, document: complete, disk, candidate }, () => {});
    return { journal, complete, disk, candidate, id };
  }
  it('discovers the exact complete unsaved pre-rebuild view after a cold reconnect without saving/applying it', async () => {
    await (await save('saved')).commit();
    const old = await operation(); port = connect();
    const recovered = await recoverAbsProjectOperation(port, project, () => {});
    expect(recovered).toEqual(jasmine.objectContaining({ operationId: old.id, document: old.complete, candidateApplied: false }));
    expect(JSON.parse(files.get('project.abi')!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('saved');
    expect((await new AbsOperationJournal(port, project).inspect())!.candidate).toEqual(old.candidate);
    await new AbsOperationJournal(port, project).restored(old.id, () => {});
    expect((await recoverAbsProjectOperation(connect(), project, () => {}))!.document).toEqual(old.complete);
    await (await save('explicitly saved recovered view')).commit();
    expect(await recoverAbsProjectOperation(connect(), project, () => {})).toBeNull();
  });
  for (const stage of ['project.abi', 'project.abs', 'project.abs.map.json', 'committed.json', 'prepared.json']) {
    it(`converges a save interrupted at ${stage} without replaying the candidate`, async () => {
      await (await save('old')).commit();
      const next = await save('new');
      // prepared.json failure here occurs at creation; all other failures occur after the journal exists.
      fail = stage; await next.commit().catch(() => undefined); fail = undefined;
      port = connect();
      await settleAbsProjectTransaction(port, project, () => {});
      expect(files.has('prepared.json')).toBeFalse();
      const expected = ['project.abi', 'prepared.json'].includes(stage) ? 'old' : 'new';
      expect(JSON.parse(files.get('project.abi')!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe(expected);
      expect((await new AbsBaselineStore(port, scope).loadCommitted())!.document).toEqual(document(expected));
    });
  }
  it('does not restore a pre-operation view over an applied commit whose response was lost', async () => {
    await (await save('saved')).commit(); await operation('abs-apply'); await (await save('applied')).commit();
    port = connect(); expect(await recoverAbsProjectOperation(port, project, () => {})).toBeNull();
    expect(JSON.parse(files.get('project.abi')!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('applied');
  });
  it('preserves damaged primary bytes and recovers only the exact retained saved source', async () => {
    const first = await save('saved'); await first.commit(); await operation();
    files.set('project.abi', '{truncated');
    const result = await recoverAbsProjectOperation(connect(), project, () => {});
    expect(result!.document).toEqual(document('unsaved last edit')); expect(files.get('project.abi')).toBe(first.abi);
    const archive = [...files].find(([key]) => key.startsWith('recoveries/damaged-') || key.startsWith('recoveries/primary-'))!;
    expect(JSON.parse(archive[1]).disk.abi).toBe('{truncated');
  });
  it('never overwrites a newer valid primary or silently discards a corrupt journal', async () => {
    await (await save('saved')).commit(); await operation(); files.set('project.abi', JSON.stringify(document('external newer')));
    const before = [...files];
    await expectAsync(recoverAbsProjectOperation(connect(), project, () => {})).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_OPERATION_SOURCE_CHANGED' }));
    expect([...files]).toEqual(before);
    files.set('prepared.json', '{damaged'); const corrupt = [...files];
    await expectAsync(settleAbsProjectTransaction(connect(), project, () => {})).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_BASELINE_CORRUPT' }));
    expect([...files]).toEqual(corrupt);
  });
  it('cancellation before ABI commit abandons only that transaction and keeps the full candidate snapshot', async () => {
    await (await save('saved')).commit(); const retained = await operation('abs-apply');
    const pending = await save('candidate'); fail = 'project.abi'; await pending.commit(); fail = undefined;
    await settleAbsProjectTransaction(connect(), project, () => {});
    expect((await new AbsOperationJournal(connect(), project).inspect())!.candidate).toEqual(retained.candidate);
    expect(JSON.parse(files.get('project.abi')!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('saved');
  });
  it('retains lineage through ordinary edits/restarts without granting any document mutation capability', async () => {
    const lineage = { version: 1 as const, project, sourceProject: 'source', operationId: crypto.randomUUID() };
    await rememberAbsRecoveryLineage(port, lineage, () => {});
    files.set('project.abi', JSON.stringify(document('normal edit')));
    expect(await readAbsRecoveryLineage(connect(), project)).toEqual(lineage);
    expect((await readAbsRecoveryLineage(connect(), project) as any).abiHash).toBeUndefined();
    const before = [...files];
    await expectAsync(rememberAbsRecoveryLineage(connect(), { ...lineage, sourceProject: 'unrelated' }, () => {})).toBeRejected();
    expect([...files]).toEqual(before);
  });

  async function prepareApplication() {
    const previous = await save('previous'); await previous.commit();
    const source = 'exact complete candidate', requestId = 'original-apply-request-001';
    const validation = { version: 2, requestId, base: (await generationEvidence(previous.projection, previous.abi)).binding,
      candidate: { hash: await hashAbsText(source), bytes: source.length }, workspaceRevision: 1,
      sourceEdits: { exact: 'full original source edit payload is retained' } };
    const journal = new AbsOperationJournal(port, project);
    const id = await journal.begin({ kind: 'abs-apply', document: document('unsaved before'), disk: await previous.store.captureDisk(),
      candidate: { source, generation: previous.generation, hash: validation.candidate.hash }, application: { requestId, validation } }, () => {});
    const next = await save('requested candidate');
    const outcome = { publication: { status: 'COMMITTED', generation: next.generation, abiSaved: true, absMirrored: true, mapPublished: true },
      appliedRevision: 2, requiresReload: false, evidence: await generationEvidence(next.projection, next.abi), abs: next.projection.abs,
      historyBase: { hash: 'original history hash', inputAbsHash: 'original input hash', completeSnapshot: document('unsaved before') } };
    await new AbsApplicationJournal(port, project).stage(id, validation, outcome, () => {});
    return { id, requestId, next, validation, outcome };
  }
  it('observes an exact COMMITTED application after reply loss without writing or applying again', async () => {
    const original = await prepareApplication(); await original.next.commit();
    const before = [...files], observed = await new AbsApplicationJournal(connect(), project).observe(original.requestId, () => {});
    expect(observed.result.ok).toBeTrue(); expect(observed.result.receipt.sourceEdits).toEqual(original.validation.sourceEdits);
    expect(observed.result.historyBase).toEqual(original.outcome.historyBase);
    expect(observed.result.applicationObservation.current).toBeTrue(); expect([...files]).toEqual(before);
  });
  it('recovers the commit-to-receipt crash gap and keeps historical proof through later editing', async () => {
    const original = await prepareApplication(); fail = 'project.abs.map.json'; await original.next.commit(); fail = undefined;
    const before = [...files], pending = await new AbsApplicationJournal(connect(), project).observe(original.requestId, () => {});
    expect(pending.result.code).toBe('ABS_APPLY_OBSERVATION_PENDING'); expect([...files]).toEqual(before);
    expect(await recoverAbsProjectOperation(connect(), project, () => {})).toBeNull();
    await (await save('newer user edit')).commit();
    const changed = [...files], observed = await new AbsApplicationJournal(connect(), project).observe(original.requestId, () => {});
    expect(observed.result.ok).toBeTrue(); expect(observed.result.applicationObservation.current).toBeFalse();
    expect(observed.result.receipt.output).toEqual(original.outcome.evidence); expect([...files]).toEqual(changed);
  });
  it('does not equate staged metadata or current readiness with a committed application', async () => {
    const original = await prepareApplication(), before = [...files];
    const observed = await new AbsApplicationJournal(connect(), project).observe(original.requestId, () => {});
    expect(observed.result.code).toBe('ABS_APPLY_OBSERVATION_PENDING'); expect([...files]).toEqual(before);
    expect((await new AbsApplicationJournal(connect(), project).observe('different-original-request', () => {})).result.code).toBe('ABS_APPLY_OBSERVATION_UNKNOWN');
    await expectAsync(new AbsOperationJournal(port, project).begin({ kind: 'abs-apply', document: document('another'),
      disk: await original.next.store.captureDisk(), application: { requestId: original.requestId, validation: original.validation } }, () => {})).toBeRejected();
  });
  it('proves an unacknowledged historical commit from verified successor pointer lineage', async () => {
    const original = await prepareApplication(); await original.next.commit();
    // Another cooperative writer advances the source before the response is sealed.
    await (await save('newer concurrent source')).commit();
    const before = [...files], observed = await new AbsApplicationJournal(connect(), project).observe(original.requestId, () => {});
    expect(observed.result.ok).toBeTrue(); expect(observed.result.applicationObservation.current).toBeFalse();
    expect(observed.result.receipt.output).toEqual(original.outcome.evidence); expect([...files]).toEqual(before);
  });
  it('reconstructs missing private baseline metadata from matching complete public source without changing the saved ABI', async () => {
    const original = await save('complete'); await original.commit();
    files.delete(absBaselineKey(original.generation)); const abi = files.get('project.abi');
    expect((await inspectAbsBaselineRecovery(connect(), project))!.source).toBe('public-generation');
    const repaired = await recoverAbsBaseline(connect(), project, () => {});
    expect(repaired.changed).toBeTrue(); expect(files.get('project.abi')).toBe(abi);
    expect((await new AbsBaselineStore(connect(), scope).loadCommitted())!.document).toEqual(document('complete'));
    expect([...files.keys()].some(key => key.startsWith('recoveries/baseline-'))).toBeTrue();
  });
  it('restores a corrupt primary only from verified committed content and preserves damaged bytes', async () => {
    const original = await save('complete'); await original.commit(); files.set('project.abi', '{interrupted');
    expect((await inspectAbsBaselineRecovery(connect(), project))!.source).toBe('saved-document');
    await recoverAbsBaseline(connect(), project, () => {});
    expect(files.get('project.abi')).toBe(original.abi);
    const archive = [...files].find(([key]) => key.startsWith('recoveries/primary-'))!;
    expect(JSON.parse(archive[1]).disk.abi).toBe('{interrupted');
  });
  it('never repairs a missing baseline by consuming a competing public draft', async () => {
    const original = await save('complete'); await original.commit(); files.delete(absBaselineKey(original.generation));
    files.set('project.abs', original.projection.abs.replace('TEXT="complete"', 'TEXT="unapplied draft"'));
    const before = [...files]; expect(await inspectAbsBaselineRecovery(connect(), project)).toBeNull();
    await expectAsync(recoverAbsBaseline(connect(), project, () => {})).toBeRejected(); expect([...files]).toEqual(before);
  });
  it('keeps the unsaved complete view across a metadata-only baseline repair and another restart', async () => {
    const original = await save('saved'); await original.commit(); const retained = await operation();
    files.delete(absBaselineKey(original.generation));
    const recovered = await recoverAbsProjectOperation(connect(), project, () => {});
    expect(recovered!.document).toEqual(retained.complete);
    expect(files.get('project.abi')).toBe(original.abi);
    await new AbsOperationJournal(connect(), project).restored(retained.id, () => {});
    expect((await recoverAbsProjectOperation(connect(), project, () => {}))!.document).toEqual(retained.complete);
    await (await save('user explicitly saved')).commit();
    expect(await recoverAbsProjectOperation(connect(), project, () => {})).toBeNull();
  });
  it('recovers a kill exactly after metadata commit and before operation source re-anchor', async () => {
    const original = await save('saved B'); await original.commit(); const retained = await operation();
    files.delete(absBaselineKey(original.generation));
    await recoverAbsBaseline(connect(), project, () => {});
    // No reanchorSource call: the host exits at this exact boundary.
    const recovered = await recoverAbsProjectOperation(connect(), project, () => {});
    expect(recovered!.document).toEqual(retained.complete); expect(files.get('project.abi')).toBe(original.abi);
    await new AbsOperationJournal(connect(), project).restored(retained.id, () => {});
    expect((await recoverAbsProjectOperation(connect(), project, () => {}))!.document).toEqual(retained.complete);
  });
  it('retains this save input rather than an older recovery view when a byte-identical save is interrupted', async () => {
    const saved = await save('saved B'); await saved.commit(); const older = await operation();
    await older.journal.restored(older.id, () => {});
    const saveJournal = new AbsOperationJournal(connect(), project);
    const id = await saveJournal.begin({ kind: 'document-save', document: document('saved B'), disk: await saved.store.captureDisk() }, () => {});
    expect((await recoverAbsProjectOperation(connect(), project, () => {}))!.document).toEqual(document('saved B'));
    // No ABI/pointer mutation is necessary; the verified acknowledgement CAS
    // itself is the no-op save point.
    await saveJournal.finishUnchangedSave(id, await saved.store.captureDisk(), () => {});
    expect(await recoverAbsProjectOperation(connect(), project, () => {})).toBeNull();
  });
  it('rejects a forged metadata-only marker when the saved source would change', async () => {
    await (await save('saved')).commit(); const next = await save('changed');
    const store = new AbsBaselineStore(connect(), scope), expected = await store.captureDisk();
    const generation = crypto.randomUUID(), projection = await createAbsProjection(next.projection.workspace, {
      document: next.projection.document, scope, generation, baselineRef: absBaselineKey(generation),
      savedAbiHash: next.projection.map.savedAbiHash });
    const before = [...files];
    await expectAsync(store.stage({ projection, mode: 'import', inputAbs: projection.abs, abi: next.abi, expected, metadataOnly: true }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_GENERATION_INVALID' }));
    expect([...files]).toEqual(before);
  });
  it('never reanchors an obsolete unsaved view across a real save merely because ABI bytes equal its old source again', async () => {
    await (await save('saved B')).commit(); const retained = await operation();
    await (await save('different real save')).commit(); await (await save('saved B')).commit();
    expect(await retained.journal.reanchorSource(retained.id, () => {})).toBeFalse();
    expect(await recoverAbsProjectOperation(connect(), project, () => {})).toBeNull();
  });
  it('retains conflict evidence when a real intervening commit is missing and metadata recovery cannot prove the old view lineage', async () => {
    await (await save('saved B')).commit(); const retained = await operation();
    const later = await save('saved B'); await later.commit(); files.delete(absBaselineKey(later.generation));
    await recoverAbsBaseline(connect(), project, () => {});
    const before = files.get('operation.json');
    await expectAsync(retained.journal.reanchorSource(retained.id, () => {})).toBeRejected();
    expect(files.get('operation.json')).toBe(before);
    expect((await retained.journal.inspect())!.document).toEqual(retained.complete);
  });
  it('does not acknowledge a byte-identical save when another source writer wins before its save point', async () => {
    const old = await save('saved B'); await old.commit();
    const journal = new AbsOperationJournal(connect(), project), expected = await old.store.captureDisk();
    const id = await journal.begin({ kind: 'document-save', document: document('saved B'), disk: expected }, () => {});
    await (await save('concurrent C')).commit(); const before = files.get('operation.json');
    await expectAsync(journal.finishUnchangedSave(id, expected, () => {})).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_DISK_CONFLICT' }));
    expect(files.get('operation.json')).toBe(before);
    expect(JSON.parse(files.get('project.abi')!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('concurrent C');
  });
  it('loads a committed apply after reply loss and metadata repair instead of restoring its older pre-apply view', async () => {
    const original = await prepareApplication(); await original.next.commit(); files.delete(absBaselineKey(original.next.generation));
    expect(await recoverAbsProjectOperation(connect(), project, () => {})).toBeNull();
    expect(JSON.parse(files.get('project.abi')!).pages[0].content.blocks.blocks[0].fields.TEXT).toBe('requested candidate');
  });
});
