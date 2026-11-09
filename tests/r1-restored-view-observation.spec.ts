import { AbsWorkspaceSyncService } from '../src/app/integrations/blockly/abs/abs-workspace-sync.service';
import { AbsApplicationJournal } from '../src/app/integrations/blockly/abs/abs-application-journal';
import { AbsOperationJournal } from '../src/app/integrations/blockly/abs/abs-operation-journal';

describe('R1 restored Working observation at the coordinator boundary', () => {
  let oldFs: any, originalInspector: PropertyDescriptor | undefined;
  let service: any, revision: number, validContext: boolean, document: any;
  let inspect: jasmine.Spy, originalResult: any;
  const requestId = '1356d182-9dfb-4da8-9f35-cfa87b1c5bac';
  const retained = () => ({ schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
    pages: [{ id: 'main', title: 'Main', content: { blocks: { languageVersion: 0,
      blocks: [{ type: 'math_number', id: 'a', x: 12, y: 24, fields: { NUM: 201 },
        extraState: { opaque: 'preserved' }, comment: 'keep' }] } }, viewState: { scrollX: 7 } }],
    sharedModel: { variables: [], procedureBlocks: [] }, extension: { hidden: true } });
  // Controlled kernel-port facts, not a fabricated original application result.
  // The journal's disk, physical identity and exited-writer checks have separate native tests.
  const facts = { version: 1, requestId, candidateApplied: false, originalPublication: 'UNKNOWN' };

  beforeEach(() => {
    oldFs = window['fs'];
    window['fs'] = { projectSyncStorageVersion: 2, openProjectSyncStorage: async () => ({
      read: async () => null, withLock: () => { throw Error('Unexpected storage mutation'); },
    }) };
    revision = 1; validContext = true; document = retained();
    service = Object.create(AbsWorkspaceSyncService.prototype);
    service.context = () => ({ path: 'D:/isolated-r1-project', assertCurrent: () => {
      if (!validContext) throw Error('Foreign project context');
    } });
    service.editor = { captureProjectSnapshot: () => ({ revision, document }) };
    originalResult = { ok: false, publication: { status: 'UNKNOWN' },
      code: 'ABS_APPLY_OBSERVATION_UNKNOWN', applicationObservation: { version: 1, requestId, current: false } };
    spyOn(AbsApplicationJournal.prototype, 'observe').and.callFake(async () => ({ result: originalResult }));
    originalInspector = Object.getOwnPropertyDescriptor(AbsOperationJournal.prototype, 'inspectRestoredApplication');
    inspect = jasmine.createSpy('verified restored operation').and.callFake(async (id, guard, readback) => {
      expect(id).toBe(requestId); guard(); await readback(retained()); guard(); return facts;
    });
    Object.defineProperty(AbsOperationJournal.prototype, 'inspectRestoredApplication', {
      configurable: true, writable: true, value: inspect,
    });
  });
  afterEach(() => {
    window['fs'] = oldFs;
    if (originalInspector) Object.defineProperty(AbsOperationJournal.prototype, 'inspectRestoredApplication', originalInspector);
    else delete (AbsOperationJournal.prototype as any).inspectRestoredApplication;
  });

  it('adds a separately verified current Working fact while preserving the original UNKNOWN', async () => {
    const result = await service.observeApplication(requestId);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(result.currentDocumentRecovery).toBe(facts);
    expect(result.ok).toBeFalse();
    expect(result.publication.status).toBe('UNKNOWN');
    expect(result.applicationObservation.current).toBeFalse();
  });
  for (const change of ['hidden state', 'layout', 'field']) it(`rejects restored facts after a ${change} mismatch`, async () => {
    const block = document.pages[0].content.blocks.blocks[0];
    if (change === 'hidden state') block.extraState.opaque = 'changed';
    else if (change === 'layout') block.x++;
    else block.fields.NUM++;
    const result = await service.observeApplication(requestId);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(result.currentDocumentRecovery).toBeUndefined();
    expect(result.publication.status).toBe('UNKNOWN');
  });
  it('rejects a revision change during asynchronous readback', async () => {
    inspect.and.callFake(async (_id, guard, readback) => {
      await readback(retained()); revision++; guard(); return facts;
    });
    expect((await service.observeApplication(requestId)).currentDocumentRecovery).toBeUndefined();
  });
  it('does not carry a recovered fact into a replacement project context', async () => {
    inspect.and.callFake(async (_id, guard, readback) => {
      await readback(retained()); validContext = false; guard(); return facts;
    });
    await expectAsync(service.observeApplication(requestId)).toBeRejectedWithError('Foreign project context');
  });
  it('does not infer a recovery fact for a historical COMMITTED result', async () => {
    originalResult.publication.status = 'COMMITTED';
    expect((await service.observeApplication(requestId)).currentDocumentRecovery).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });
});
