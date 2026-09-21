import { _ProjectService } from '../../../editors/blockly-editor/services/project.service';
import { createAilyProjectDataValue, projectDataRuntime, AilyDataRef } from '@domain/project/public-api';

describe('saved ABI revision resource resolution', () => {
  const ref: AilyDataRef = { $ailyData: { schemaVersion: 1, id: `sha256:${'a'.repeat(64)}`,
    codec: 'utf8-v1', logicalType: 'text', storage: 'raw-v1', rawLength: 7, storedLength: 7 } };
  let oldFs: unknown; let disk: string; let revision: number; let session: string; let service: _ProjectService;
  beforeEach(() => {
    oldFs = window['fs']; disk = JSON.stringify({ field: createAilyProjectDataValue(ref) }); revision = 0; session = 'first';
    window['fs'] = { readFileSync: () => disk };
    service = new _ProjectService({ workspace: {}, getActivePageId: () => 'main',
      captureProjectSnapshot: () => ({ revision }), getProjectAbiForSave: () => ({ field: 'payload' }),
      getProjectUsedLibraryManifest: () => ({}),
      normalizeProjectAbi: value => value } as any, {} as any, {} as any);
    service.currentProjectPath = 'D:/project';
    spyOn(projectDataRuntime, 'getSessionToken').and.callFake(() => session);
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'resolve').and.resolveTo('payload');
    spyOn(projectDataRuntime, 'getPrepared').and.throwError('cold cache');
  });
  afterEach(() => { window['fs'] = oldFs; });
  it('resolves a cold/evicted resource without requiring a synchronous prepared cache', async () => {
    const result = await service.getAbiRevisionSnapshot();
    expect(result.changed).toBeFalse(); expect(result.memoryHash).toBe(result.diskHash);
    expect(projectDataRuntime.getPrepared).not.toHaveBeenCalled();
    expect(projectDataRuntime.resolve).toHaveBeenCalledWith(ref);
  });
  for (const phase of ['disk', 'revision', 'runtime']) {
    it(`rejects ${phase} changes during asynchronous materialization`, async () => {
      (projectDataRuntime.resolve as jasmine.Spy).and.callFake(async () => {
        if (phase === 'disk') disk = '{"external":true}';
        else if (phase === 'revision') revision++;
        else session = 'second';
        return 'payload';
      });
      await expectAsync(service.getAbiRevisionSnapshot()).toBeRejectedWithError(/changed/);
    });
  }
});
