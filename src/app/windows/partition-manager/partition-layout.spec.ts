import {
  allocatePartitions, createPreset, inferDraft, KIB, MIB, parseBytes, parsePartitionCsv, SECTOR,
  serializePartitions, validatePartitions, type PartitionPreset,
} from './partition-layout';

describe('ESP32 partition layouts', () => {
  function layout(preset: PartitionPreset, flash: number) {
    const draft = createPreset(preset, flash * MIB);
    const generated = allocatePartitions(draft);
    expect(generated.errors).toEqual([]);
    const result = validatePartitions(generated.rows, flash * MIB);
    expect(result.errors).toEqual([]);
    return { draft, rows: generated.rows, result };
  }

  it('accounts for every byte of the IoT presets, including system space', () => {
    for (const [flash, app, storage] of [[4, 1536, 960], [8, 3072, 1984], [16, 4096, 8128]]) {
      const { result } = layout('iot', flash);
      expect(result.appLimit).toBe(app * KIB);
      expect(result.partitions.find(p => p.name === 'spiffs')!.sizeBytes).toBe(storage * KIB);
      expect(result.usedBytes).toBe(flash * MIB);
      expect(result.freeBytes).toBe(0);
      expect(result.ota).toBeTrue();
    }
  });

  it('reproduces exact upstream XiaoZhi reference sizes rather than rounded MiB', () => {
    for (const [flash, app, assets, offset] of [[4, 3008, 1024, 0x10000], [8, 3008, 2048, 0x20000], [16, 4032, 8192, 0x20000]]) {
      const { result } = layout('xiaozhi', flash);
      expect(result.appLimit).toBe(app * KIB);
      expect(result.partitions.find(p => p.typeId === 0)!.offsetBytes).toBe(offset);
      expect(result.partitions.find(p => p.name === 'assets')!.sizeBytes).toBe(assets * KIB);
      expect(result.usedBytes).toBe(flash * MIB);
      expect(result.ota).toBe(flash !== 4);
    }
  });

  it('preserves a manually sized program when toggling OTA and gives the remainder to files', () => {
    const draft = createPreset('iot', 8 * MIB);
    draft.appBytes = 3328 * KIB; draft.appMode = 'fixed';
    expect(validatePartitions(allocatePartitions(draft).rows, draft.flashBytes).partitions.at(-1)!.sizeBytes).toBe(1472 * KIB);
    draft.ota = false;
    const result = validatePartitions(allocatePartitions(draft).rows, draft.flashBytes);
    expect(result.appLimit).toBe(3328 * KIB);
    expect(result.partitions.at(-1)!.sizeBytes).toBe(4800 * KIB);
  });

  it('recomputes an automatic program group and leaves alignment remainders unallocated', () => {
    const draft = createPreset('large', 8 * MIB);
    draft.ota = true;
    let result = validatePartitions(allocatePartitions(draft).rows, draft.flashBytes);
    expect(result.errors).toEqual([]);
    expect(result.appLimit).toBe(4032 * KIB);
    expect(result.freeBytes).toBe(64 * KIB);
    draft.ota = false;
    result = validatePartitions(allocatePartitions(draft).rows, draft.flashBytes);
    expect(result.appLimit).toBe(8128 * KIB);
    expect(result.freeBytes).toBe(0);
  });

  it('allows 4 KiB program sizes while aligning OTA slot addresses to 64 KiB', () => {
    const draft = createPreset('iot', 8 * MIB);
    draft.appMode = 'fixed'; draft.appBytes = 3 * MIB + SECTOR;
    const generated = allocatePartitions(draft);
    const result = validatePartitions(generated.rows, draft.flashBytes);
    expect(generated.errors).toEqual([]); expect(result.errors).toEqual([]);
    const apps = result.partitions.filter(partition => partition.typeId === 0);
    expect(apps.map(app => app.sizeBytes)).toEqual([3 * MIB + SECTOR, 3 * MIB + SECTOR]);
    expect(apps.map(app => app.offsetBytes)).toEqual([0x10000, 0x320000]);
    expect(result.partitions.at(-1)!.offsetBytes).toBe(0x621000);
    expect(result.usedBytes).toBe(8 * MIB);
    expect(inferDraft(generated.rows, draft.flashBytes)?.appBytes).toBe(draft.appBytes);
    draft.ota = false;
    const single = validatePartitions(allocatePartitions(draft).rows, draft.flashBytes);
    expect(single.errors).toEqual([]); expect(single.partitions.at(-1)!.offsetBytes).toBe(0x311000);
  });

  it('aligns app addresses after a larger NVS and reserves crash logs', () => {
    const draft = createPreset('iot', 8 * MIB);
    draft.nvsBytes = 64 * KIB; draft.coredump = true;
    const result = validatePartitions(allocatePartitions(draft).rows, draft.flashBytes);
    expect(result.errors).toEqual([]);
    expect(result.partitions.find(p => p.typeId === 0)!.offsetBytes).toBe(0x20000);
    expect(result.partitions.find(p => p.name === 'spiffs')!.sizeBytes).toBe(1856 * KIB);
    expect(result.partitions.at(-1)!.offsetBytes + result.partitions.at(-1)!.sizeBytes).toBe(8 * MIB);
  });

  it('rejects overflow without shrinking a fixed file partition', () => {
    const draft = createPreset('iot', 4 * MIB);
    draft.storageMode = 'fixed'; draft.storageBytes = MIB; draft.appBytes = 2 * MIB;
    const generated = allocatePartitions(draft);
    expect(generated.rows.at(-1)!.size).toBe(String(MIB));
    expect(validatePartitions(generated.rows, draft.flashBytes).errors.join(' ')).toContain('超出');
  });

  it('supports hexadecimal sizes, K/M suffixes, comments, and automatic aligned offsets', () => {
    const parsed = parsePartitionCsv('\uFEFF# Example\nnvs,data,nvs,0x9000,20K,\nfactory,app,factory,,0x100000,\nspiffs,data,spiffs,,1M,');
    const result = validatePartitions(parsed.rows, 4 * MIB);
    expect(parsed.errors).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.partitions[1].offsetBytes).toBe(0x10000);
    expect(result.partitions[2].offsetBytes).toBe(0x110000);
    expect(parseBytes('1.5M')).toBeNaN();
    expect(parseBytes('12junk')).toBeNaN();
  });

  it('rejects overlap, alignment errors, duplicate names, bad flags and missing OTA metadata', () => {
    const { rows } = layout('iot', 8);
    const cases = [
      (copy: typeof rows) => { copy[2].offset = '0x9000'; },
      (copy: typeof rows) => { copy[3].name = copy[2].name; },
      (copy: typeof rows) => { copy[0].flags = 'unknown'; },
      (copy: typeof rows) => { copy[1].flags = 'readonly'; },
      (copy: typeof rows) => { copy[1].size = '4K'; },
      (copy: typeof rows) => { copy.splice(1, 1); },
      (copy: typeof rows) => { copy[2].size = '-1'; },
    ];
    for (const mutate of cases) {
      const copy = rows.map(row => ({ ...row })); mutate(copy);
      expect(validatePartitions(copy, 8 * MIB).errors.length).toBeGreaterThan(0);
    }
  });

  it('only exposes simple editing when it can preserve every partition field', () => {
    const { rows } = layout('iot', 8);
    expect(inferDraft(rows, 8 * MIB)).not.toBeNull();
    rows[2].name = 'my_firmware';
    expect(inferDraft(rows, 8 * MIB)).toBeNull();
    expect(parsePartitionCsv(serializePartitions(rows)).rows).toEqual(rows);
  });
});
