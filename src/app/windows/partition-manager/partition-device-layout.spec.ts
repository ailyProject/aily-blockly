import type { DevicePartitionSnapshot } from './partition-device';
import { deviceFlashRegions } from './partition-device-layout';
import { MIB } from './partition-layout';

describe('Device flash regions', () => {
  const snapshot = (bootloaderOffset?: number): DevicePartitionSnapshot => ({
    port: 'COM7', chip: 'ESP32', flashBytes: 4 * MIB, tableOffset: 0x8000, bootloaderOffset, readAt: '',
    partitions: [
      { name: 'app', type: 'app', subtype: 'factory', offset: 0x10000, size: MIB, flags: 0 },
      { name: 'nvs', type: 'data', subtype: 'nvs', offset: 0x9000, size: 0x5000, flags: 1 },
    ],
  });

  it('uses the chip boot address, splitting startup reservation and the table sector without losing bytes', () => {
    for (const bootOffset of [0, 0x1000, 0x2000]) {
      const device = snapshot(bootOffset);
      const original = JSON.stringify(device);
      const regions = deviceFlashRegions(device);
      const boot = regions.find(region => region.kind === 'bootloader')!;
      expect([boot.offset, boot.bytes, boot.source]).toEqual([bootOffset, 0x8000 - bootOffset, 'reserved']);
      expect(boot.description).toContain('不代表 bootloader 镜像实际大小');
      expect(regions.find(region => region.kind === 'partition-table')!.bytes).toBe(0x1000);
      expect(regions.filter(region => region.kind === 'reserved').reduce((sum, region) => sum + region.bytes, 0)).toBe(bootOffset);
      expect(regions[0].offset).toBe(0);
      expect(regions.reduce((sum, region) => sum + region.bytes, 0)).toBe(4 * MIB);
      regions.slice(1).forEach((region, index) => expect(region.offset).toBe(regions[index].offset + regions[index].bytes));
      expect(regions.find(region => region.name === 'nvs')!.flags).toBe(1);
      expect(JSON.stringify(device)).toBe(original);
    }
  });

  it('uses the detected non-default table location and labels gaps separately from system data', () => {
    const device = snapshot(0);
    device.tableOffset = 0x10000;
    device.partitions[0].offset = 0x20000;
    device.partitions[1].offset = 0x11000;
    const regions = deviceFlashRegions(device);
    expect(regions.find(region => region.kind === 'bootloader')!.bytes).toBe(0x10000);
    expect(regions.find(region => region.kind === 'partition-table')!.offset).toBe(0x10000);
    expect(regions.find(region => region.kind === 'gap')!.bytes).toBe(0xa000);
    expect(regions.find(region => region.name === 'nvs')!.kind).toBe('system');
  });

  it('keeps explicit bootloader and partition-table entries without adding duplicates', () => {
    const device = snapshot(0x1000);
    device.partitions.push(
      { name: 'custom_boot', type: 'bootloader', subtype: 'primary', offset: 0x1000, size: 0x7000, flags: 1 },
      { name: 'custom_pt', type: 'partition_table', subtype: 'primary', offset: 0x8000, size: 0x1000, flags: 0 },
    );
    const regions = deviceFlashRegions(device);
    expect(regions.filter(region => region.kind === 'bootloader').length).toBe(1);
    expect(regions.find(region => region.kind === 'bootloader')!.name).toBe('custom_boot');
    expect(regions.filter(region => region.kind === 'partition-table').length).toBe(1);
    expect(regions.find(region => region.kind === 'partition-table')!.source).toBe('table');
    expect(regions.reduce((sum, region) => sum + region.bytes, 0)).toBe(4 * MIB);
  });

  it('does not invent bootloader addresses or trailing capacity when they are unavailable', () => {
    const device = snapshot(); device.flashBytes = 0;
    const regions = deviceFlashRegions(device);
    expect(regions.some(region => region.kind === 'bootloader' || region.kind === 'free')).toBeFalse();
    expect(regions[0].name).toBe('启动保留区');
    expect(regions.at(-1)!.offset + regions.at(-1)!.bytes).toBe(0x110000);
    expect(deviceFlashRegions(null)).toEqual([]);
    expect(deviceFlashRegions({ ...device, partitions: [] })).toEqual([]);
  });
});
