import {
  ensureExternalProjectDataDocument,
} from './project-data-legacy-import';
import { materializeGenericProjectDataValues } from './project-data-generic-values';
import {
  AilyDataRef,
  createProjectDataMarker,
} from './project-data.types';

function createStore(overrides: Partial<{
  validateReferences: (refs: readonly AilyDataRef[]) => Promise<{ valid: boolean; issues: any[] }>;
}> = {}) {
  const values = new Map<string, unknown>();
  let sequence = 0;
  const store = {
    put: jasmine.createSpy('put').and.callFake(async (request: any) => {
      const id = `sha256:${(++sequence).toString(16).padStart(64, '0')}` as const;
      values.set(id, request.value);
      return {
        $ailyData: {
          schemaVersion: 1,
          id,
          logicalType: request.codec === 'utf8-v1'
            ? 'text'
            : request.codec === 'canonical-json-v1'
              ? 'json'
              : 'binary',
          codec: request.codec,
          storage: request.storage || 'raw-v1',
          rawLength: 1,
          storedLength: 1,
        },
      } as AilyDataRef;
    }),
    resolve: jasmine.createSpy('resolve').and.callFake(async (ref: AilyDataRef) => values.get(ref.$ailyData.id)),
    flushPending: jasmine.createSpy('flushPending').and.resolveTo(),
    collectReferences: jasmine.createSpy('collectReferences').and.returnValue([]),
    validateReferences: jasmine.createSpy('validateReferences')
      .and.callFake(overrides.validateReferences || (async () => ({ valid: true, issues: [] }))),
  };
  return store;
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

  it('externalizes an oversized string field without a block-specific migration', async () => {
    const store = createStore();
    const code = 'const uint16_t data[] = {' + '0x0000,'.repeat(6000) + '};';
    const source = {
      blocks: {
        blocks: [{
          type: 'unknown_future_block',
          fields: { ANY_FIELD: code },
        }],
      },
    };

    const result = await ensureExternalProjectDataDocument(source, store);
    const value = (result.document as any).blocks.blocks[0].fields.ANY_FIELD;

    expect(result.genericExternalized.length).toBe(1);
    expect(result.genericExternalized[0].codec).toBe('utf8-v1');
    expect(value.$ailyProjectDataValue.ref.$ailyData.codec).toBe('utf8-v1');
    expect((source as any).blocks.blocks[0].fields.ANY_FIELD).toBe(code);
    expect(store.put).toHaveBeenCalledWith(jasmine.objectContaining({ codec: 'utf8-v1' }));

    const materialized = await materializeGenericProjectDataValues(result.document, store);
    expect((materialized as any).blocks.blocks[0].fields.ANY_FIELD).toBe(code);
  });

  it('externalizes oversized arrays and extraState through canonical JSON', async () => {
    const store = createStore();
    const values = Array.from({ length: 12000 }, (_, index) => index);
    const source = {
      blocks: {
        blocks: [{
          type: 'unknown_future_json_block',
          fields: { VALUES: values },
          extraState: { mode: 'future', content: 'x'.repeat(40 * 1024) },
        }],
      },
    };

    const result = await ensureExternalProjectDataDocument(source, store);
    expect(result.genericExternalized.map((entry) => entry.codec)).toEqual([
      'canonical-json-v1',
      'canonical-json-v1',
    ]);

    const materialized = await materializeGenericProjectDataValues(result.document, store);
    expect((materialized as any).blocks.blocks[0].fields.VALUES).toEqual(values);
    expect((materialized as any).blocks.blocks[0].extraState).toEqual(source.blocks.blocks[0].extraState);
  });

  it('does not hide an existing resource ref inside a generic resource', async () => {
    const store = createStore();
    const existingRef = await store.put({
      codec: 'utf8-v1',
      storage: 'raw-v1',
      value: 'existing resource',
    });
    store.put.calls.reset();
    const source = {
      blocks: {
        blocks: [{
          type: 'dedicated_slot_block',
          fields: {
            STATE: { metadata: 'x'.repeat(40 * 1024), payload: existingRef },
          },
        }],
      },
    };

    await expectAsync(ensureExternalProjectDataDocument(source, store))
      .toBeRejectedWithError(/oversized inline field value/);
    expect(store.put).not.toHaveBeenCalled();
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
