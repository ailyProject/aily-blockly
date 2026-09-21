/** Byte-based layout rules shared by the window and the main-window save handler. */
export const KIB = 1024;
export const MIB = 1024 * KIB;
export const APP_ALIGNMENT = 64 * KIB;
export const SECTOR = 4 * KIB;
export const PARTITION_TABLE_OFFSET = 0x8000;
export type PartitionPreset = 'iot' | 'xiaozhi' | 'large';
export type SizeMode = 'recommended' | 'fixed' | 'remaining';

export interface PartitionRow {
  name: string;
  type: string;
  subtype: string;
  offset: string;
  size: string;
  flags: string;
}
export interface ResolvedPartition extends PartitionRow {
  typeId: number;
  subtypeId: number;
  offsetBytes: number;
  sizeBytes: number;
}
export interface PartitionLayout {
  partitions: ResolvedPartition[];
  errors: string[];
  warnings: string[];
  usedBytes: number;
  freeBytes: number;
  appLimit: number;
  ota: boolean;
}
export interface PartitionDraft {
  preset: PartitionPreset;
  flashBytes: number;
  ota: boolean;
  storage: boolean;
  appBytes: number;
  appMode: SizeMode;
  storageBytes: number;
  storageMode: 'fixed' | 'remaining';
  nvsBytes: number;
  coredump: boolean;
}
export interface PartitionSegment {
  name: string;
  bytes: number;
  kind: 'app' | 'ota' | 'data' | 'system' | 'free';
  offset: number;
}

const DATA_SUBTYPES: Record<string, number> = {
  ota: 0, phy: 1, nvs: 2, coredump: 3, nvs_keys: 4, efuse: 5,
  undefined: 6, esphttpd: 0x80, fat: 0x81, spiffs: 0x82, littlefs: 0x83,
};

export function alignUp(bytes: number, step: number): number {
  return Math.ceil(bytes / step) * step;
}
export function hex(bytes: number): string {
  return '0x' + bytes.toString(16).toUpperCase();
}
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= MIB) return `${Number((bytes / MIB).toFixed(4))} MiB`;
  return `${Number((bytes / KIB).toFixed(3))} KiB`;
}
export function parseBytes(value: string): number {
  const match = String(value).trim().match(/^(0x[\da-f]+|\d+)\s*([km])?$/i);
  if (!match) return NaN;
  const n = Number(match[1]) * ({ k: KIB, m: MIB }[match[2]?.toLowerCase()] || 1);
  return Number.isSafeInteger(n) && n <= 0xffffffff ? n : NaN;
}
export function parseFlashSize(value: unknown): number {
  const match = String(value || '').trim().match(/^(\d+)\s*M(?:i?B)?$/i);
  return match ? Number(match[1]) * MIB : 0;
}
function identifier(value: string, names: Record<string, number>): number {
  const lower = value.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(names, lower)) return names[lower];
  return /^(0x[\da-f]+|\d+)$/i.test(lower) ? Number(lower) : NaN;
}
function subtype(type: number, value: string): number {
  if (type === 0) {
    const ota = value.match(/^ota_(\d+)$/i);
    if (ota && Number(ota[1]) < 16) return 0x10 + Number(ota[1]);
    return identifier(value, { factory: 0, test: 0x20 });
  }
  return identifier(value || 'undefined', type === 1 ? DATA_SUBTYPES : {});
}

export function parsePartitionCsv(csv: string): { rows: PartitionRow[]; errors: string[] } {
  const rows: PartitionRow[] = [];
  const errors: string[] = [];
  if (csv.length > 128 * 1024) return { rows, errors: ['分区 CSV 过大（最多 128 KiB）。'] };
  csv.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;
    const fields = text.split(',').map(field => field.trim());
    if (fields.length < 5 || fields.length > 6) {
      errors.push(`第 ${index + 1} 行需要 5 或 6 个 CSV 字段。`);
      return;
    }
    const [name, type, subtypeValue, offset, size, flags = ''] = fields;
    rows.push({ name, type, subtype: subtypeValue, offset, size, flags });
  });
  return { rows, errors };
}

export function serializePartitions(rows: PartitionRow[]): string {
  return '# ESP-IDF Partition Table\n# Name, Type, SubType, Offset, Size, Flags\n'
    + rows.map(row => [row.name, row.type, row.subtype, row.offset, row.size, row.flags].join(', ')).join('\n') + '\n';
}

export function validatePartitions(rows: PartitionRow[], flashBytes: number): PartitionLayout {
  const errors: string[] = [];
  const warnings: string[] = [];
  const partitions: ResolvedPartition[] = [];
  if (!Number.isSafeInteger(flashBytes) || flashBytes <= 0) errors.push('请先设置当前板卡的 Flash 容量。');
  if (!rows.length) errors.push('至少需要一个程序分区。');
  if (rows.length > 94) errors.push('含校验信息的分区表最多支持 94 个分区。');
  let nextOffset = PARTITION_TABLE_OFFSET + SECTOR;
  const names = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const label = row.name || `第 ${index + 1} 行`;
    if (!/^[\x21-\x7E]{1,16}$/.test(row.name) || /[,#"$]/.test(row.name)) errors.push(`${label}：名称应为 1–16 个 ASCII 字符，不含空格、逗号或特殊占位符。`);
    if (names.has(row.name)) errors.push(`${label}：分区名称重复。`);
    names.add(row.name);
    const typeId = identifier(row.type, { app: 0, data: 1 });
    const subtypeId = subtype(typeId, row.subtype);
    if (!Number.isInteger(typeId) || typeId < 0 || typeId > 0xfe || (typeId > 1 && typeId < 0x40)) errors.push(`${label}：不支持的分区类型。`);
    if (!Number.isInteger(subtypeId) || subtypeId < 0 || subtypeId > 0xfe) errors.push(`${label}：无法识别子类型，请保留原文件并核对工具链。`);
    const alignment = typeId === 0 ? APP_ALIGNMENT : SECTOR;
    const offsetBytes = row.offset.trim() ? parseBytes(row.offset) : alignUp(nextOffset, alignment);
    const sizeBytes = parseBytes(row.size);
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < PARTITION_TABLE_OFFSET + SECTOR || offsetBytes % alignment) errors.push(`${label}：起始地址必须位于分区表之后，并按 ${formatBytes(alignment)} 对齐。`);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes % SECTOR) errors.push(`${label}：大小必须为正数，且按 4 KiB 对齐。`);
    const flags = row.flags.split(':').filter(Boolean);
    if (flags.some(flag => !['encrypted', 'readonly'].includes(flag))) errors.push(`${label}：包含不支持的标志，不能丢弃后保存。`);
    if (flags.includes('readonly') && (typeId !== 1 || [0, 3].includes(subtypeId))) errors.push(`${label}：此分区不能设为只读。`);
    if (flags.includes('encrypted')) warnings.push('加密标志需要与固件安全配置一致，管理器不会启用设备加密。');
    if (typeId === 1 && subtypeId === 0 && sizeBytes !== 8 * KIB) errors.push(`${label}：OTA 信息分区必须为 8 KiB。`);
    if (typeId === 1 && subtypeId === 2 && sizeBytes < (flags.includes('readonly') ? SECTOR : 12 * KIB)) errors.push(`${label}：可写 NVS 至少 12 KiB，只读 NVS 至少 4 KiB。`);
    if (Number.isSafeInteger(offsetBytes) && Number.isSafeInteger(sizeBytes) && sizeBytes > 0) {
      partitions.push({ ...row, typeId, subtypeId, offsetBytes, sizeBytes });
      nextOffset = offsetBytes + sizeBytes;
    }
  }
  const sorted = [...partitions].sort((a, b) => a.offsetBytes - b.offsetBytes);
  let end = PARTITION_TABLE_OFFSET + SECTOR;
  for (const p of sorted) {
    if (p.offsetBytes < end) errors.push(`${p.name}：与前面的分区重叠。`);
    end = Math.max(end, p.offsetBytes + p.sizeBytes);
  }
  if (flashBytes > 0 && end > flashBytes) errors.push(`空间不足，超出 Flash 容量 ${formatBytes(end - flashBytes)}。`);
  const apps = partitions.filter(p => p.typeId === 0);
  const otaApps = apps.filter(p => p.subtypeId >= 0x10 && p.subtypeId <= 0x1f);
  const otaData = partitions.filter(p => p.typeId === 1 && p.subtypeId === 0);
  if (!apps.length) errors.push('缺少程序分区。');
  if (new Set(apps.map(p => p.subtypeId)).size !== apps.length) errors.push('程序分区子类型重复。');
  if (otaData.length > 1) errors.push('OTA 信息分区只能有一个。');
  if (otaApps.length && !otaData.length) errors.push('OTA 程序分区需要一个 8 KiB 的 OTA 信息分区。');
  if (otaApps.length === 1) warnings.push('只有一个 OTA 程序槽，不具备双槽在线更新空间。');
  if (!partitions.some(p => p.name === 'nvs' && p.typeId === 1 && p.subtypeId === 2)) errors.push('当前 Arduino ESP32 方案必须保留名为 nvs 的配置分区。');
  const appLimit = apps.length ? Math.min(...(otaApps.length >= 2 ? otaApps : apps).map(p => p.sizeBytes)) : 0;
  return { partitions, errors: [...new Set(errors)], warnings: [...new Set(warnings)], usedBytes: end, freeBytes: Math.max(0, flashBytes - end), appLimit, ota: otaApps.length >= 2 && otaData.length === 1 };
}

export function createPreset(preset: PartitionPreset, flashBytes: number): PartitionDraft {
  const x = preset === 'xiaozhi';
  const flashMiB = flashBytes / MIB;
  return {
    preset, flashBytes, ota: preset !== 'large' && !(x && flashMiB === 4), storage: preset !== 'large',
    appBytes: x ? (flashMiB === 16 ? 4032 : 3008) * KIB : (flashMiB <= 4 ? 1536 : flashMiB <= 8 ? 3072 : 4096) * KIB,
    appMode: preset === 'large' ? 'remaining' : 'recommended',
    storageBytes: x ? (flashMiB === 16 ? 8 : flashMiB === 8 ? 2 : 1) * MIB : 256 * KIB,
    storageMode: 'remaining', nvsBytes: (x ? 16 : 20) * KIB, coredump: false,
  };
}

export function allocatePartitions(draft: PartitionDraft): { rows: PartitionRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: PartitionRow[] = [];
  const x = draft.preset === 'xiaozhi';
  if (x && ![4, 8, 16].includes(draft.flashBytes / MIB)) errors.push('小智参考方案仅提供 4、8、16 MiB 布局。');
  if (x && !draft.storage) errors.push('小智方案必须保留资源分区。');
  if (draft.appMode === 'remaining' && draft.storage && draft.storageMode === 'remaining') errors.push('只能有一个分区接收剩余空间。');
  const add = (name: string, type: string, sub: string, offset: number, size: number) => {
    rows.push({ name, type, subtype: sub, offset: hex(offset), size: String(size), flags: '' });
  };
  let cursor = PARTITION_TABLE_OFFSET + SECTOR;
  add('nvs', 'data', 'nvs', cursor, draft.nvsBytes);
  cursor += draft.nvsBytes;
  if (draft.ota || x) { add('otadata', 'data', 'ota', cursor, 8 * KIB); cursor += 8 * KIB; }
  if (x) { add('phy_init', 'data', 'phy', cursor, SECTOR); cursor += SECTOR; }
  cursor = Math.max(alignUp(cursor, APP_ALIGNMENT), x && draft.ota ? 0x20000 : 0x10000);
  const slots = draft.ota ? 2 : 1;
  const dumpSize = draft.coredump ? APP_ALIGNMENT : 0;
  const fixedStorage = draft.storage && draft.storageMode === 'fixed' ? draft.storageBytes : 0;
  const appSize = draft.appMode === 'remaining'
    ? Math.floor((draft.flashBytes - cursor - dumpSize - fixedStorage) / slots / APP_ALIGNMENT) * APP_ALIGNMENT
    : draft.appBytes;
  if (!Number.isSafeInteger(appSize) || appSize <= 0 || appSize % SECTOR) errors.push('单份程序空间必须大于 0，并按 4 KiB 对齐。');
  add(draft.ota ? (x ? 'ota_0' : 'app0') : 'factory', 'app', draft.ota ? 'ota_0' : 'factory', cursor, appSize);
  cursor += appSize;
  if (draft.ota) {
    cursor = alignUp(cursor, APP_ALIGNMENT);
    add(x ? 'ota_1' : 'app1', 'app', 'ota_1', cursor, appSize); cursor += appSize;
  }
  if (draft.storage) {
    const dataSize = draft.storageMode === 'remaining' ? Math.floor((draft.flashBytes - cursor - dumpSize) / SECTOR) * SECTOR : draft.storageBytes;
    if (dataSize < SECTOR) errors.push(`存储空间不足，还需要 ${formatBytes(SECTOR - dataSize)}。请调整程序大小或在线更新选项。`);
    add(x ? 'assets' : 'spiffs', 'data', 'spiffs', cursor, Math.max(0, dataSize)); cursor += Math.max(0, dataSize);
  }
  if (draft.coredump) add('coredump', 'data', 'coredump', cursor, dumpSize);
  return { rows, errors };
}

export function layoutSegments(layout: PartitionLayout, flashBytes: number): PartitionSegment[] {
  if (layout.errors.length || flashBytes <= 0) return [];
  const result: PartitionSegment[] = [];
  let cursor = 0;
  let appIndex = 0;
  for (const p of [...layout.partitions].sort((a, b) => a.offsetBytes - b.offsetBytes)) {
    if (p.offsetBytes > cursor) result.push({ name: '系统与对齐', bytes: p.offsetBytes - cursor, kind: 'system', offset: cursor });
    const isStorage = p.typeId === 1 && [0x81, 0x82, 0x83].includes(p.subtypeId);
    const kind = p.typeId === 0 ? (appIndex++ === 0 ? 'app' : 'ota') : isStorage ? 'data' : 'system';
    result.push({ name: p.name, bytes: p.sizeBytes, kind, offset: p.offsetBytes });
    cursor = p.offsetBytes + p.sizeBytes;
  }
  if (cursor < flashBytes) result.push({ name: '未分配', bytes: flashBytes - cursor, kind: 'free', offset: cursor });
  return result;
}

/** Only map a CSV back to simple controls if regenerating it loses no semantic fields. */
export function inferDraft(rows: PartitionRow[], flashBytes: number): PartitionDraft | null {
  const layout = validatePartitions(rows, flashBytes);
  if (layout.errors.length) return null;
  const preset: PartitionPreset = layout.partitions.some(p => p.name === 'assets') ? 'xiaozhi' : 'iot';
  const draft = createPreset(preset, flashBytes);
  const nvs = layout.partitions.find(p => p.name === 'nvs');
  const apps = layout.partitions.filter(p => p.typeId === 0);
  const storage = layout.partitions.find(p => p.name === (preset === 'xiaozhi' ? 'assets' : 'spiffs'));
  if (apps.some(p => p.sizeBytes !== apps[0].sizeBytes)) return null;
  Object.assign(draft, {
    ota: layout.ota, storage: !!storage, appBytes: apps[0].sizeBytes, appMode: 'fixed',
    storageBytes: storage?.sizeBytes || 0, storageMode: 'fixed', nvsBytes: nvs?.sizeBytes,
    coredump: layout.partitions.some(p => p.name === 'coredump'),
  });
  const regenerated = allocatePartitions(draft);
  if (regenerated.errors.length) return null;
  const rebuilt = validatePartitions(regenerated.rows, flashBytes);
  const signature = (ps: ResolvedPartition[]) => JSON.stringify(ps.map(p => [p.name, p.typeId, p.subtypeId, p.offsetBytes, p.sizeBytes, p.flags]));
  return !rebuilt.errors.length && signature(layout.partitions) === signature(rebuilt.partitions) ? draft : null;
}
