import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FfsDeviceInfo, FfsFilesystemType, FfsPartitionInfo } from '../../ffs-manager.service';

@Component({
  selector: 'app-device-info',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './device-info.component.html',
  styleUrl: './device-info.component.scss',
})
export class DeviceInfoComponent {
  @Input() deviceInfo: FfsDeviceInfo | null = null;
  @Input() partitions: FfsPartitionInfo[] = [];
  @Input() filesystemPartitions: FfsPartitionInfo[] = [];
  @Output() selectPartition = new EventEmitter<FfsPartitionInfo>();

  constructor(private translate: TranslateService) {}

  get appSizeText(): string {
    const apps = this.partitions.filter(p => p.typeName === 'app');
    if (!apps.length) return '-';
    return this.formatBytes(apps.reduce((sum, p) => sum + (p.size || 0), 0));
  }

  get filesystemSizeText(): string {
    if (!this.filesystemPartitions.length) return '-';
    return this.formatBytes(this.filesystemPartitions.reduce((sum, p) => sum + (p.size || 0), 0));
  }

  get filesystemTypeText(): string {
    if (!this.filesystemPartitions.length) return '-';
    const types = Array.from(new Set(
      this.filesystemPartitions.map(p => this.getFsLabel(p.filesystemType))
    ));
    return types.join(' / ');
  }

  getFsLabel(type: FfsFilesystemType | null | undefined): string {
    if (type === 'spiffs') return 'SPIFFS';
    if (type === 'littlefs') return 'LittleFS';
    if (type === 'fatfs') return 'FATFS';
    return this.translate.instant('FFS_MANAGER.COMMON.NORMAL_PARTITION');
  }

  onSelect(partition: FfsPartitionInfo) {
    this.selectPartition.emit(partition);
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unitIndex]}`;
  }
}
