import type { DevicePartitionSnapshot } from './partition-device';
import { SECTOR, type PartitionSegment } from './partition-layout';

export interface DeviceFlashRegion extends Omit<PartitionSegment, 'kind'> {
  kind: PartitionSegment['kind'] | 'bootloader' | 'partition-table' | 'reserved' | 'gap';
  type: string;
  subtype: string;
  flags: number | null;
  source: 'table' | 'reserved' | 'gap';
  description: string;
}

/** Display regions only: bootloader reservation and table sectors never become editable CSV entries.
 * ESPConnect also supplements the on-device table with these regions. Use the detected chip's
 * bootloader address, and give explicit table entries priority over inferred reservations.
 */
export function deviceFlashRegions(device: DevicePartitionSnapshot | null): DeviceFlashRegion[] {
  if (!device?.partitions.length) return [];
  const partitions = [...device.partitions].sort((a, b) => a.offset - b.offset);
  const flashEnd = device.flashBytes || Math.max(device.tableOffset + SECTOR, ...partitions.map(p => p.offset + p.size));
  const reservations: DeviceFlashRegion[] = [];
  const reserve = (name: string, kind: DeviceFlashRegion['kind'], offset: number, bytes: number, description: string) => {
    if (bytes > 0) reservations.push({ name, kind, offset, bytes, type: kind === 'partition-table' ? 'partition_table' : kind,
      subtype: '—', flags: null, source: 'reserved', description });
  };
  const bootOffset = device.bootloaderOffset;
  if (typeof bootOffset === 'number' && Number.isSafeInteger(bootOffset) && bootOffset >= 0 && bootOffset < device.tableOffset && bootOffset % SECTOR === 0) {
    reserve('芯片保留区', 'reserved', 0, bootOffset, '芯片启动地址之前的保留区域。');
    reserve('bootloader', 'bootloader', bootOffset, device.tableOffset - bootOffset,
      '芯片启动地址至分区表之间的保留范围，不代表 bootloader 镜像实际大小。');
  } else {
    reserve('启动保留区', 'reserved', 0, device.tableOffset, '未获取芯片启动地址，此处显示分区表前的保留范围。');
  }
  reserve('partition_table', 'partition-table', device.tableOffset, SECTOR, '已读取的分区表所在扇区，大小为 4 KiB。');

  const regions: DeviceFlashRegion[] = [];
  const gap = (start: number, end: number, trailing: boolean) => {
    if (end <= start) return;
    regions.push({ name: trailing ? '未分配' : '对齐 / 未分配', kind: trailing ? 'free' : 'gap', offset: start, bytes: end - start,
      type: '未分配', subtype: '—', flags: null, source: 'gap', description: '此范围未被分区表条目覆盖，不表示其中的数据已擦除。' });
  };
  const fillGap = (start: number, end: number, trailing: boolean) => {
    let cursor = start;
    for (const region of reservations) {
      const regionStart = Math.max(cursor, region.offset);
      const regionEnd = Math.min(end, region.offset + region.bytes);
      if (regionEnd <= regionStart) continue;
      gap(cursor, regionStart, trailing);
      regions.push({ ...region, offset: regionStart, bytes: regionEnd - regionStart });
      cursor = regionEnd;
    }
    gap(cursor, end, trailing);
  };
  let cursor = 0;
  let appIndex = 0;
  for (const partition of partitions) {
    fillGap(cursor, partition.offset, false);
    const isStorage = partition.type === 'data' && ['fat', 'spiffs', 'littlefs'].includes(partition.subtype);
    const kind: DeviceFlashRegion['kind'] = partition.type === 'bootloader' ? 'bootloader'
      : partition.type === 'partition_table' ? 'partition-table'
      : partition.type === 'app' ? (appIndex++ === 0 ? 'app' : 'ota') : isStorage ? 'data' : 'system';
    regions.push({ name: partition.name, kind, offset: partition.offset, bytes: partition.size, type: partition.type,
      subtype: partition.subtype, flags: partition.flags, source: 'table', description: '设备分区表中的条目。' });
    cursor = Math.max(cursor, partition.offset + partition.size);
  }
  fillGap(cursor, flashEnd, true);
  return regions;
}
