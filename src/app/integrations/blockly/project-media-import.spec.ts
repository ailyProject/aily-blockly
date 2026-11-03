import { importProjectMedia, MediaImportRequest } from './project-media-import';

describe('project media import asset boundary', () => {
  const request: MediaImportRequest = { kind: 'tft_image', source: '/input.png', width: 2, height: 1 };
  function fixture() {
    const files = new Map<string, Uint8Array>([['/input.png', new Uint8Array([1, 2, 3])]]);
    const dirs = new Set(['/project']);
    const links = new Set<string>();
    const written: string[] = [];
    const packed: Uint8Array[] = [];
    let current = true;
    const fs: any = {
      join: (...parts: string[]) => parts.join('/'), isAbsolute: (p: string) => p.startsWith('/'),
      exists: async (p: string) => files.has(p) || dirs.has(p),
      stat: async (p: string) => ({ isFile: files.has(p), isDirectory: dirs.has(p), isSymbolicLink: links.has(p), size: files.get(p)?.length ?? 0 }),
      readBinary: async (p: string) => files.get(p)!.slice(),
      writeBinary: async (p: string, bytes: Uint8Array) => { files.set(p, bytes.slice()); written.push(p); },
      mkdir: async (p: string) => { dirs.add(p); },
    };
    const deps = { fs,
      decode: async (r: any) => ({ ...r, frames: [new Uint8Array([0xf8, 0, 0x07, 0xe0])] }),
      put: async (r: any) => { packed.push(r.value); return { $ailyData: { schemaVersion: 1, id: 'sha256:' + 'a'.repeat(64), logicalType: 'binary', codec: r.codec, storage: 'raw-v1', rawLength: r.value.length, storedLength: r.value.length } } as any; },
      assertCurrent: () => { if (!current) throw new Error('Project changed'); },
    };
    return { files, dirs, links, written, packed, deps, changeProject: () => { current = false; } };
  }
  it('returns canonical frames and preserves original bytes without writing any program mirror', async () => {
    const f = fixture();
    const result = await importProjectMedia('/project', request, f.deps);
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.value.frameCount).toBe(1); expect(result.value.maxFrames).toBe(1);
    expect(result.value.encoding).toBe('rgb565-be'); expect(result.decodedBytes).toBe(4);
    expect(f.packed[0]).toEqual(new Uint8Array([0xf8, 0, 0x07, 0xe0]));
    expect(f.written.length).toBe(1); expect(f.written[0]).toContain('/assets/media-import/');
    expect(f.files.get(f.written[0])).toEqual(new Uint8Array([1, 2, 3]));
    expect((await importProjectMedia('/project', request, f.deps)).ok).toBeTrue();
    expect(f.written.length).toBe(1);
  });
  it('rejects bad dimensions and unsupported input before decoding or writing', async () => {
    const f = fixture(); spyOn(f.deps, 'decode').and.callThrough();
    for (const bad of [{ width: 0 }, { height: 1.5 }, { width: 16384, height: 16384 }, { source: '/sound.wav' }]) {
      expect((await importProjectMedia('/project', { ...request, ...bad }, f.deps)).ok).toBeFalse();
    }
    expect(f.deps.decode).not.toHaveBeenCalled(); expect(f.written.length).toBe(0);
  });
  it('leaves project files untouched on decode failure or invalid frame size', async () => {
    const f = fixture(); f.deps.decode = async () => { throw new Error('Bad media'); };
    expect((await importProjectMedia('/project', request, f.deps)).ok).toBeFalse();
    f.deps.decode = async (r: any) => ({ ...r, frames: [new Uint8Array(1)] });
    expect((await importProjectMedia('/project', request, f.deps)).ok).toBeFalse();
    expect(f.written.length).toBe(0); expect(f.packed.length).toBe(0);
  });
  it('does not publish into a different project after decoding', async () => {
    const f = fixture(), decode = f.deps.decode;
    f.deps.decode = async r => { const result = await decode(r); f.changeProject(); return result; };
    expect((await importProjectMedia('/project', request, f.deps)).ok).toBeFalse();
    expect(f.written.length).toBe(0); expect(f.packed.length).toBe(0);
  });
  it('rejects linked destinations and refuses to overwrite a corrupted source asset', async () => {
    const f = fixture(); f.dirs.add('/project/assets'); f.links.add('/project/assets');
    expect((await importProjectMedia('/project', request, f.deps)).ok).toBeFalse();
    expect(f.written.length).toBe(0); f.links.clear();
    const result = await importProjectMedia('/project', request, f.deps);
    expect(result.ok).toBeTrue();
    const target = f.written[0]; f.files.set(target, new Uint8Array([9]));
    expect((await importProjectMedia('/project', request, f.deps)).ok).toBeFalse();
    expect(f.files.get(target)).toEqual(new Uint8Array([9])); expect(f.written.length).toBe(1);
  });
});
