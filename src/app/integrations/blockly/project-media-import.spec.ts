import { decodeProjectMedia, importProjectMedia, MediaImportRequest } from './project-media-import';
import { bindMediaImportTarget } from './project-media-target';

describe('project media import asset boundary', () => {
  const request: MediaImportRequest = { kind: 'tft_image', source: '/input.png', width: 2, height: 1 };
  function fixture() {
    const files = new Map<string, Uint8Array>([['/input.png', new Uint8Array([1, 2, 3])]]);
    const dirs = new Set(['/project']);
    const links = new Set<string>();
    const written: string[] = [];
    const packed: Uint8Array[] = [];
    let current = true;
    const resolve = (p: string) => {
      const parts: string[] = [];
      for (const segment of p.split('/').filter(Boolean)) {
        if (segment === '..') parts.pop();
        else if (segment !== '.') parts.push(segment);
      }
      return '/' + parts.join('/');
    };
    const fs: any = {
      join: (...parts: string[]) => parts.join('/'), isAbsolute: (p: string) => p.startsWith('/'),
      resolve, relative: (from: string, to: string) => to.startsWith(from + '/') ? to.slice(from.length + 1) : '..' + to,
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
    if (!result.ok || result.kind === 'u8g2_bitmap') return;
    expect(result.value.frameCount).toBe(1); expect(result.value.maxFrames).toBe(1);
    expect(result.value.encoding).toBe('rgb565-be'); expect(result.decodedBytes).toBe(4);
    expect(f.packed[0]).toEqual(new Uint8Array([0xf8, 0, 0x07, 0xe0]));
    expect(f.written.length).toBe(1); expect(f.written[0]).toContain('/assets/media-import/');
    expect(f.files.get(f.written[0])).toEqual(new Uint8Array([1, 2, 3]));
    expect((await importProjectMedia('/project', request, f.deps)).ok).toBeTrue();
    expect(f.written.length).toBe(1);
  });
  async function png(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    draw(canvas.getContext('2d')!);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  const bitmapRequest: MediaImportRequest = { kind: 'u8g2_bitmap', source: '/input.png', width: 104, height: 212 };
  it('decodes a real Linkbit portrait image into its native resource without dropping the last row', async () => {
    const f = fixture();
    const original = await png(104, 212, context => {
      context.fillRect(0, 0, 1, 1);
      context.fillRect(103, 211, 1, 1);
      context.fillStyle = 'rgba(0, 0, 0, 0.4)';
      context.fillRect(102, 211, 1, 1);
    });
    f.files.set('/input.png', original);
    const result = await importProjectMedia('/project', bitmapRequest, f.deps);
    expect(result.ok).toBeTrue();
    if (!result.ok || result.kind !== 'u8g2_bitmap') return;
    expect(result.fieldType).toBe('field_bitmap_u8g2');
    expect(result.value).toEqual({ schemaVersion: 1, encoding: 'xbm-lsb-row-v1', width: 104, height: 212,
      bitmap: jasmine.objectContaining({ $ailyData: jasmine.objectContaining({ codec: 'u8g2-xbm-v1', rawLength: 2756 }) }) });
    const expected = new Uint8Array(2756);
    expected[0] = 1;
    expected[2755] = 128;
    expect(result.decodedBytes).toBe(expected.length);
    expect(f.packed[0]).toEqual(expected);
    expect(f.written).toEqual([`/project/${result.sourcePath}`]);
    expect(f.files.get(f.written[0])).toEqual(original);
  });
  it('centers an image with white padding and packs each row independently', async () => {
    const f = fixture();
    f.files.set('/input.png', await png(9, 1, context => context.fillRect(0, 0, 9, 1)));
    const result = await importProjectMedia('/project', { ...bitmapRequest, width: 9, height: 3 }, f.deps);
    expect(result.ok).toBeTrue();
    expect(f.packed[0]).toEqual(new Uint8Array([0, 0, 255, 1, 0, 0]));
  });
  it('resolves a registered media field and returns its fitted geometry and exact ABS argument', async () => {
    const f = fixture();
    f.dirs.add('/project/.assets');
    f.files.set('/project/.assets/image.png', await png(9, 1, context => context.fillRect(0, 0, 9, 1)));
    const definitions = {
      types: ['screen_bitmap'], registered: () => true, assertCurrent: () => {},
      get: (type: string) => type === 'screen_bitmap' ? { args1: [{ type: 'field_bitmap_u8g2', name: 'DATA', width: 9, height: 3 }] } : undefined
    };
    const result = await importProjectMedia('/project', { source: '.assets/image.png', target: { blockType: 'screen_bitmap' } },
      f.deps, target => bindMediaImportTarget(target, definitions, () => {}));
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result).toEqual(jasmine.objectContaining({ kind: 'u8g2_bitmap', blockType: 'screen_bitmap', fieldName: 'DATA',
      geometry: { source: { width: 9, height: 1 }, target: { width: 9, height: 3 }, content: { x: 0, y: 1, width: 9, height: 1 }, fit: 'contain' } }));
    expect(JSON.parse(result.absArgument)).toEqual(result.value);
    expect(f.packed[0]).toEqual(new Uint8Array([0, 0, 255, 1, 0, 0]));
  });
  it('uses the native field defaults and contain mode for a TFT target and rejects an ambiguous target', async () => {
    const f = fixture();
    f.files.set('/project/image.png', new Uint8Array([1, 2, 3]));
    const target = { blockType: 'photo', fieldName: 'IMAGE' };
    const definitions = {
      types: ['photo'], registered: () => true, assertCurrent: () => {},
      get: () => ({ args0: [{ type: 'field_tftespi_image', name: 'IMAGE' }, { type: 'field_tftespi_image', name: 'OTHER' }] })
    };
    const bind = (selection: typeof target | { blockType: string }) => bindMediaImportTarget(selection, definitions, () => {});
    expect(() => bind({ blockType: 'photo' })).toThrowError(/IMAGE, OTHER/);
    f.deps.decode = async request => {
      expect(request.width).toBe(160); expect(request.height).toBe(120); expect(request.fit).toBe('contain');
      return { ...request, frames: [new Uint8Array(160 * 120 * 2)] };
    };
    const result = await importProjectMedia('/project', { source: 'image.png', target }, f.deps, bind);
    expect(result.ok).toBeTrue();
    if (result.ok) expect(JSON.parse(result.absArgument)).toEqual(result.value);
  });
  it('fits real RGB565 worker frames into the target dimensions with centered black padding', async () => {
    const source = await png(2, 1, context => {
      context.fillStyle = '#ff0000';
      context.fillRect(0, 0, 2, 1);
    });
    const result = await decodeProjectMedia({
      type: 'decode', requestId: 1, fileName: 'image.png', mimeType: 'image/png',
      buffer: source.buffer as ArrayBuffer, width: 2, height: 3, fps: 1, maxFrames: 1, format: 'rgb565', fit: 'contain',
    });
    expect(result.firstFrame).toEqual({ source: { width: 2, height: 1 }, content: { x: 0, y: 1, width: 2, height: 1 } });
    expect(result.frames).toEqual([new Uint8Array([0, 0, 0, 0, 0xf8, 0, 0xf8, 0, 0, 0, 0, 0])]);
  });
  it('rejects paths escaping or traversing links and stops if the resolved field goes stale', async () => {
    const f = fixture();
    const target = { blockType: 'photo' };
    f.dirs.add('/project/.assets'); f.links.add('/project/.assets');
    f.files.set('/project/.assets/image.png', new Uint8Array([1, 2, 3]));
    let current = true;
    const bind = () => ({ kind: 'tft_image' as const, blockType: 'photo', fieldName: 'IMAGE', fieldType: 'field_tftespi_image',
      width: 2, height: 1, assertCurrent: () => { if (!current) throw new Error('Field changed'); } });
    for (const source of ['../input.png', '/input.png', '.assets/image.png']) {
      expect((await importProjectMedia('/project', { source, target }, f.deps, bind)).ok).toBeFalse();
    }
    f.links.clear();
    const decode = f.deps.decode;
    f.deps.decode = async r => { const decoded = await decode(r); current = false; return decoded; };
    expect((await importProjectMedia('/project', { source: '.assets/image.png', target }, f.deps, bind)).ok).toBeFalse();
    expect(f.written).toEqual([]); expect(f.packed).toEqual([]);
  });
  it('rejects oversized bitmap dimensions, video, or undecodable bytes before asset writes', async () => {
    const f = fixture();
    for (const invalid of [{ width: 257 }, { source: '/input.mp4' }, {}]) {
      expect((await importProjectMedia('/project', { ...bitmapRequest, ...invalid }, f.deps)).ok).toBeFalse();
    }
    expect(f.written.length).toBe(0);
    expect(f.packed.length).toBe(0);
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
