import {
  ensureExternalProjectDataDocument,
} from './project-data-legacy-import';
import {
  AilyDataRef,
  createProjectDataMarker,
} from './project-data.types';

function createStore(overrides: Partial<{
  validateReferences: (refs: readonly AilyDataRef[]) => Promise<{ valid: boolean; issues: any[] }>;
}> = {}) {
  return {
    put: jasmine.createSpy('put').and.resolveTo({
      $ailyData: {
        schemaVersion: 1,
        id: `sha256:${'a'.repeat(64)}`,
        logicalType: 'binary',
        codec: 'u8g2-xbm-frames-v1',
        storage: 'raw-v1',
        rawLength: 1,
        storedLength: 1,
      },
    } as AilyDataRef),
    flushPending: jasmine.createSpy('flushPending').and.resolveTo(),
    collectReferences: jasmine.createSpy('collectReferences').and.returnValue([]),
    validateReferences: jasmine.createSpy('validateReferences')
      .and.callFake(overrides.validateReferences || (async () => ({ valid: true, issues: [] }))),
  };
}

describe('ensureExternalProjectDataDocument', () => {
  it('upgrades a markerless legacy ABI without mutating the parsed source', async () => {
    const source = { blocks: { blocks: [] } };
    const result = await ensureExternalProjectDataDocument(source, createStore());

    expect(result.upgradedLegacyDocument).toBeTrue();
    expect(result.document['$ailyProjectData']).toEqual(createProjectDataMarker());
    expect((source as any).$ailyProjectData).toBeUndefined();
  });

  it('migrates known U8g2 inline animation frames before adding the marker', async () => {
    const store = createStore();
    const source = {
      blocks: {
        blocks: [{
          type: 'u8g2_animation',
          fields: {
            DATA: {
              width: 2,
              height: 1,
              dither: false,
              threshold: 128,
              frames: [[[1, 0]]],
            },
          },
        }],
      },
    };

    const result = await ensureExternalProjectDataDocument(source, store);
    const data = (result.document as any).blocks.blocks[0].fields.DATA;

    expect(result.migration.migrated.length).toBe(1);
    expect(data.frames.$ailyData.codec).toBe('u8g2-xbm-frames-v1');
    expect(store.put).toHaveBeenCalled();
  });

  it('validates but does not rewrite a correctly marked ABI', async () => {
    const source = {
      $ailyProjectData: createProjectDataMarker(),
      blocks: { blocks: [] },
    };
    const result = await ensureExternalProjectDataDocument(source, createStore());

    expect(result.upgradedLegacyDocument).toBeFalse();
    expect(result.document).toBe(source);
  });

  it('rejects an unsupported marker instead of treating it as a legacy ABI', async () => {
    const source = {
      $ailyProjectData: { schemaVersion: 99, mode: 'external-only' },
      blocks: { blocks: [] },
    };

    await expectAsync(ensureExternalProjectDataDocument(source, createStore()))
      .toBeRejectedWithError(/Unsupported project\.abi/);
  });

  it('keeps missing referenced resources as a strict load failure', async () => {
    const source = {
      $ailyProjectData: createProjectDataMarker(),
      blocks: { blocks: [] },
    };
    const store = createStore({
      validateReferences: async () => ({
        valid: false,
        issues: [{ error: 'Resource file is missing.' }],
      }),
    });

    await expectAsync(ensureExternalProjectDataDocument(source, store))
      .toBeRejectedWithError(/Resource file is missing/);
  });
});
