import { encodeSaveSnapshot, readSaveSnapshot } from './abs-save-snapshot';
import { absJson } from './abs-identity-map';
import type { AbsOperationSnapshot } from './abs-operation-journal';

describe('plain document save recovery bytes', () => {
  const make = (id: string, value = 'original'): AbsOperationSnapshot => ({
    version: 1, kind: 'document-save', project: '/project', id,
    nativeSave: { version: 2, operation: 'project_save', requestId: id, inputDigest: 'test' },
    committed: null, disk: { abi: value, abs: null, map: null }, document: { text: value }
  });
  const setup = () => {
    const files = new Map<string, string>();
    const storage = {
      read: async (key: string) => files.get(key) ?? null,
      replace: async (key: string, expected: string | null, text: string | null) => {
        if (expected !== null || files.has(key) || text === null) return false;
        files.set(key, text); return true;
      }
    };
    return { files, storage };
  };
  it('stores identical content once with separately readable original requests and accepts existing inline records', async () => {
    const { files, storage } = setup();
    for (const id of ['first', 'second']) {
      const original = make(id);
      const header = await encodeSaveSnapshot(storage, original);
      expect(await readSaveSnapshot(storage, header)).toEqual(original);
      expect(JSON.parse(header).disk).toBeUndefined();
    }
    expect(files.size).toBe(1);
    const changed = make('third', 'changed');
    expect(await readSaveSnapshot(storage, await encodeSaveSnapshot(storage, changed))).toEqual(changed);
    expect(files.size).toBe(2);
    expect(await readSaveSnapshot(storage, absJson(make('legacy')))).toEqual(make('legacy'));
  });
  it('rejects changed historical bytes but can save a new independently observed input', async () => {
    const { files, storage } = setup();
    const header = await encodeSaveSnapshot(storage, make('first'));
    const [key] = files.keys();
    files.set(key, 'different');
    await expectAsync(readSaveSnapshot(storage, header)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_OPERATION_CORRUPT' }));
    const next = make('next');
    expect(await encodeSaveSnapshot(storage, next)).toBe(absJson(next));
    expect(files.get(key)).toBe('different');
    files.delete(key);
    await expectAsync(readSaveSnapshot(storage, header)).toBeRejected();
  });
});
