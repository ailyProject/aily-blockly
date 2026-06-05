import { CommonModule } from '@angular/common';
import { Component, HostListener, Input } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { FfsPartitionInfo } from '../../ffs-manager.service';

type PartitionCategory = 'spiffs' | 'littlefs' | 'fatfs' | 'app' | 'bootloader' | 'nvs' | 'otadata' | 'phy' | 'coredump' | 'normal';

@Component({
  selector: 'app-partition-map',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './partition-map.component.html',
  styleUrl: './partition-map.component.scss',
})
export class PartitionMapComponent {
  @Input() partitions: FfsPartitionInfo[] = [];

  hoveredPartition: FfsPartitionInfo | null = null;
  tooltipLeft = 0;
  tooltipTop = 0;
  tooltipPlacement: 'bottom' | 'top' = 'bottom';
  tooltipHorizontal: 'center' | 'left' | 'right' = 'center';

  private readonly tooltipMaxWidth = 240;
  private readonly tooltipEstimatedHeight = 110;
  private readonly tooltipGap = 8;
  private readonly viewportPadding = 8;
  private readonly viewportPaddingX = 10;

  trackById = (_: number, item: FfsPartitionInfo) => item.index;

  get totalSize(): number {
    return this.partitions.reduce((sum, item) => sum + item.size, 0);
  }

  getHeight(partition: FfsPartitionInfo): number {
    const total = this.totalSize;
    if (!total) return 0;
    return partition.size / total * 100;
  }

  getCategory(partition: FfsPartitionInfo): PartitionCategory {
    if (partition.filesystemType) return partition.filesystemType;
    const sub = (partition.subtypeName || '').toLowerCase();
    const type = (partition.typeName || '').toLowerCase();
    if (type === 'app' || sub.startsWith('ota_') || sub === 'factory' || sub === 'test') return 'app';
    if (sub === 'nvs' || sub === 'nvs_keys') return 'nvs';
    if (sub === 'ota') return 'otadata';
    if (sub === 'phy') return 'phy';
    if (sub === 'coredump') return 'coredump';
    if (sub === 'bootloader') return 'bootloader';
    return 'normal';
  }

  onSegmentEnter(partition: FfsPartitionInfo, event: MouseEvent) {
    this.hoveredPartition = partition;
    this.updateTooltipPosition(event.currentTarget as HTMLElement);
  }

  onSegmentLeave() {
    this.hoveredPartition = null;
  }

  @HostListener('window:scroll')
  @HostListener('window:resize')
  onViewportChange() {
    this.hoveredPartition = null;
  }

  private updateTooltipPosition(anchor: HTMLElement | null) {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const halfW = this.tooltipMaxWidth / 2;

    const container = anchor.closest('.summary-panel') as HTMLElement | null;
    const containerRect = container?.getBoundingClientRect();
    const leftBound = Math.max(this.viewportPaddingX, (containerRect?.left ?? 0) + this.viewportPaddingX);
    const rightBound = Math.min(vw - this.viewportPaddingX, (containerRect?.right ?? vw) - this.viewportPaddingX);

    const center = rect.left + rect.width / 2;
    let left: number;
    if (center + halfW > rightBound) {
      this.tooltipHorizontal = 'right';
      left = rightBound;
    } else if (center - halfW < leftBound) {
      this.tooltipHorizontal = 'left';
      left = leftBound;
    } else {
      this.tooltipHorizontal = 'center';
      left = center;
    }

    const spaceBelow = vh - rect.bottom;
    if (spaceBelow >= this.tooltipEstimatedHeight + this.tooltipGap + this.viewportPadding) {
      this.tooltipPlacement = 'bottom';
      this.tooltipTop = rect.bottom + this.tooltipGap;
    } else {
      this.tooltipPlacement = 'top';
      this.tooltipTop = rect.top - this.tooltipGap;
    }
    this.tooltipLeft = left;
  }
}
