import { CommonModule } from '@angular/common';
import { Component, HostListener, OnInit, TemplateRef, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzModalModule, NzModalService } from 'ng-zorro-antd/modal';
import { firstValueFrom } from 'rxjs';
import { BaseDialogComponent, DialogButton } from '../../components/base-dialog/base-dialog.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import type { PartitionManagerContext } from './partition-manager-host';
import type { DevicePartitionSnapshot, PartitionSerialPort } from './partition-device';
import { deviceFlashRegions, type DeviceFlashRegion } from './partition-device-layout';
import {
  allocatePartitions, createPreset, formatBytes, hex,
  KIB, layoutSegments, MIB, parseBytes, parsePartitionCsv, SECTOR, serializePartitions, validatePartitions,
  type PartitionDraft, type PartitionLayout, type PartitionPreset, type PartitionRow, type PartitionSegment,
} from './partition-layout';

type PresetSelection = PartitionPreset | 'custom';

interface EditorState {
  draft: PartitionDraft | null;
  csv: string;
  flashBytes: number;
  referenceOnly: boolean;
  customized: boolean;
}
interface Repair { label: string; detail: string; state: EditorState; }

@Component({
  selector: 'app-partition-manager',
  imports: [CommonModule, FormsModule, NzButtonModule, NzModalModule, SubWindowComponent, BaseDialogComponent],
  templateUrl: './partition-manager.component.html',
  styleUrl: './partition-manager.component.scss',
})
export class PartitionManagerComponent implements OnInit {
  readonly MIB = MIB;
  readonly KIB = KIB;
  readonly SECTOR = SECTOR;
  readonly format = formatBytes;
  readonly hex = hex;
  readonly presetOptions: { id: PresetSelection; label: string; icon: string }[] = [
    { id: 'iot', label: '物联网应用', icon: 'fa-wifi' },
    { id: 'xiaozhi', label: '小智应用', icon: 'fa-microphone' },
    { id: 'large', label: '大程序（有线更新）', icon: 'fa-microchip' },
    { id: 'custom', label: '自定义', icon: 'fa-sliders' },
  ];
  readonly discardDialogButtons: DialogButton[] = [
    { text: '继续编辑', action: 'cancel' },
    { text: '放弃修改', type: 'primary', action: 'discard' },
  ];
  @ViewChild('discardDialog', { static: true }) private discardDialog!: TemplateRef<unknown>;
  context: PartitionManagerContext | null = null;
  state: EditorState = { draft: null, csv: '', flashBytes: 0, referenceOnly: false, customized: false };
  opening: EditorState | null = null;
  layout: PartitionLayout = validatePartitions([], 0);
  rows: PartitionRow[] = [];
  errors: string[] = [];
  segments: PartitionSegment[] = [];
  repairs: Repair[] = [];
  mapFlashBytes = 0;
  loading = true;
  saving = false;
  readingDevice = false;
  refreshingPorts = false;
  serialPorts: PartitionSerialPort[] = [];
  selectedPort = '';
  portError = '';
  device: DevicePartitionSnapshot | null = null;
  deviceError = '';
  showDevicePartitions = true;
  selectedDeviceOffset: number | null = null;
  error = '';
  notice = '';
  allowClose = false;
  closingPrompt = false;
  private readonly projectPath: string;

  constructor(route: ActivatedRoute, private modal: NzModalService) {
    this.projectPath = route.snapshot.queryParamMap.get('project') || '';
  }

  ngOnInit(): void { void this.load(); void this.refreshPorts(true); }

  get selectedPortAvailable(): boolean { return this.serialPorts.some(port => port.name === this.selectedPort); }
  get flashOptions() {
    const options = this.context?.flashOptions || [];
    const detected = this.device?.flashBytes || 0;
    return detected > 0 && !options.some(option => option.bytes === detected)
      ? [...options, { value: null, bytes: detected }].sort((a, b) => a.bytes - b.bytes) : options;
  }
  get flashSupported(): boolean { return !!this.context?.flashOptions.some(option => option.bytes === this.state.flashBytes); }

  get dirty(): boolean {
    return !!this.opening && (this.state.csv !== this.opening.csv || this.state.flashBytes !== this.opening.flashBytes
      || this.state.referenceOnly !== this.opening.referenceOnly || JSON.stringify(this.draft) !== JSON.stringify(this.opening.draft));
  }
  get activePreset(): PresetSelection { return this.draft && !this.state.customized ? this.draft.preset : 'custom'; }
  get canSave(): boolean {
    return !!this.context && !this.loading && !this.saving && !this.readingDevice && this.flashSupported && !this.errors.length && !this.state.referenceOnly
      && (!this.context.customSelected || this.dirty || this.state.csv !== this.context.csv || this.state.flashBytes !== this.context.flashBytes);
  }
  get draft(): PartitionDraft | null { return this.state.draft; }
  get storageBytes(): number {
    return this.layout.partitions.filter(p => p.typeId === 1 && [0x81, 0x82, 0x83].includes(p.subtypeId)).reduce((sum, p) => sum + p.sizeBytes, 0);
  }
  get systemBytes(): number {
    return this.segments.filter(p => p.kind === 'system').reduce((sum, p) => sum + p.bytes, 0);
  }
  get deviceMapBytes(): number {
    return this.device?.flashBytes || Math.max(this.device ? this.device.tableOffset + SECTOR : 0, ...(this.device?.partitions || []).map(p => p.offset + p.size));
  }
  get deviceSegments(): DeviceFlashRegion[] { return deviceFlashRegions(this.device); }
  selectDeviceRegion(offset: number, table: HTMLElement): void {
    this.selectedDeviceOffset = offset;
    table.querySelector<HTMLElement>(`[data-offset="${offset}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  get changes(): string[] {
    if (!this.context) return [];
    const parsed = parsePartitionCsv(this.context.csv);
    const before = validatePartitions(parsed.rows, this.context.flashBytes);
    const changes: string[] = [];
    if (this.state.flashBytes !== this.context.flashBytes) changes.push(`Flash 配置：${formatBytes(this.context.flashBytes)} → ${formatBytes(this.state.flashBytes)}`);
    if (before.ota !== this.layout.ota) changes.push(`在线更新空间：${before.ota ? '双槽' : '单槽'} → ${this.layout.ota ? '双槽' : '单槽'}`);
    for (const p of this.layout.partitions) {
      const old = before.partitions.find(item => item.name === p.name);
      if (!old) changes.push(`新增 ${p.name}：${formatBytes(p.sizeBytes)}`);
      else {
        if (old.sizeBytes !== p.sizeBytes) changes.push(`${p.name}：${formatBytes(old.sizeBytes)} → ${formatBytes(p.sizeBytes)}`);
        if (old.offsetBytes !== p.offsetBytes || old.typeId !== p.typeId || old.subtypeId !== p.subtypeId) changes.push(`${p.name} 的位置或类型改变${p.typeId === 1 ? '，原有数据可能无法读取' : ''}`);
      }
    }
    for (const old of before.partitions) if (!this.layout.partitions.some(p => p.name === old.name)) changes.push(`移除 ${old.name}`);
    return changes;
  }

  async load(): Promise<void> {
    if (this.readingDevice) return;
    if (this.dirty && !await this.confirmDiscard('重新载入会放弃当前草稿，继续吗？')) return;
    this.loading = true; this.error = '';
    try {
      const response = await this.send({ action: 'partition-manager-load', projectPath: this.projectPath });
      this.context = response.context;
      const csv = this.context.csv;
      const draft = csv ? this.context.draft : createPreset('iot', this.context.flashBytes);
      const customized = !draft || Object.entries(createPreset(draft.preset, this.context.flashBytes))
        .some(([key, value]) => draft[key as keyof PartitionDraft] !== value);
      this.state = { csv: csv || serializePartitions(allocatePartitions(draft!).rows), draft, flashBytes: this.context.flashBytes, referenceOnly: false, customized };
      this.opening = this.clone(this.state);
      this.notice = this.context.customSelected && !csv ? '当前项目缺少自定义分区文件，请选择用途方案重建或导入 CSV。'
        : this.context.source === 'legacy' ? '已载入旧位置的分区文件，保存后会放到编译器使用的项目源码目录。' : '';
      this.recalculate();
    } catch (error) { this.error = this.errorText(error); }
    finally { this.loading = false; }
  }

  async refreshPorts(useCurrent = false): Promise<void> {
    if (this.refreshingPorts || this.readingDevice || this.saving) return;
    this.refreshingPorts = true; this.portError = '';
    try {
      const response = await this.send({ action: 'partition-manager-ports' });
      this.serialPorts = response.ports;
      if (useCurrent || !this.selectedPort) this.selectedPort = response.currentPort || '';
    } catch (error) { this.portError = this.errorText(error); }
    finally { this.refreshingPorts = false; }
  }

  async readDevice(): Promise<void> {
    if (this.readingDevice || this.saving || this.loading || this.closingPrompt || this.refreshingPorts) return;
    if (!this.selectedPortAvailable) { this.deviceError = '请选择已连接的设备串口。'; return; }
    this.readingDevice = true; this.deviceError = '';
    try {
      const response = await this.send({ action: 'partition-manager-read-device', projectPath: this.projectPath, port: this.selectedPort }, 180000);
      this.device = response.device;
      this.showDevicePartitions = true;
      this.selectedDeviceOffset = null;
      if (this.device.flashBytes > 0 && this.device.flashBytes !== this.state.flashBytes) {
        this.changeFlash(this.device.flashBytes, this.state.customized);
        this.notice = `已按设备同步项目 Flash 容量为 ${formatBytes(this.device.flashBytes)}，计划分配已重新计算。`;
      }
    } catch (error) { this.deviceError = this.errorText(error); }
    finally { this.readingDevice = false; }
  }

  selectPreset(preset: PresetSelection): void {
    if (this.activePreset === preset) return;
    this.commit(preset === 'custom' ? { ...this.state, customized: true }
      : this.fromDraft(createPreset(preset, this.state.flashBytes), preset === 'xiaozhi' && !this.context?.xiaozhiSupported, false));
    this.notice = '';
  }

  changeFlash(bytes: number, customized = true): void {
    const next = this.clone(this.state); next.flashBytes = Number(bytes); next.customized = customized;
    if (next.draft) {
      next.draft.flashBytes = next.flashBytes;
      if (next.draft.appMode === 'recommended') next.draft.appBytes = createPreset(next.draft.preset, next.flashBytes).appBytes;
      Object.assign(next, this.fromDraft(next.draft, next.referenceOnly, customized));
    }
    this.commit(next);
  }

  changeOption(key: 'ota' | 'storage' | 'coredump', checked: boolean): void {
    if (!this.draft) return;
    const draft = { ...this.draft, [key]: checked };
    if (key === 'storage' && checked && draft.appMode === 'remaining') {
      draft.storageMode = 'fixed'; draft.storageBytes = draft.storageBytes || MIB;
    }
    this.commit(this.fromDraft(draft, this.state.referenceOnly));
  }

  setSize(key: 'appBytes' | 'storageBytes' | 'nvsBytes', raw: string, input?: HTMLInputElement): void {
    if (!this.draft) return;
    const value = raw.trim() === '' ? NaN : Number(raw);
    const unit = key === 'nvsBytes' ? KIB : MIB;
    const bytes = this.nearestSize(value * unit, key === 'nvsBytes' ? 12 * KIB : SECTOR);
    const draft = { ...this.draft, [key]: bytes };
    if (key === 'appBytes') draft.appMode = 'fixed';
    if (key === 'storageBytes') draft.storageMode = 'fixed';
    this.commit(this.fromDraft(draft, this.state.referenceOnly));
    // Angular may skip writing [value] when rounding returns the previous model value.
    if (input) input.value = String(bytes / unit);
  }

  useSuggestedProgram(): void {
    if (!this.draft) return;
    const recommended = createPreset(this.draft.preset, this.state.flashBytes);
    const draft = { ...this.draft, appMode: recommended.appMode, appBytes: recommended.appBytes };
    if (draft.appMode === 'remaining' && draft.storage) draft.storageMode = 'fixed';
    this.commit(this.fromDraft(draft, this.state.referenceOnly));
  }

  toggleStorageMode(): void {
    if (!this.draft) return;
    const draft = { ...this.draft };
    draft.storageMode = draft.storageMode === 'remaining' ? 'fixed' : 'remaining';
    if (draft.storageMode === 'fixed') draft.storageBytes = this.storageBytes || MIB;
    else if (draft.appMode === 'remaining') { draft.appMode = 'fixed'; draft.appBytes = this.layout.appLimit; }
    this.commit(this.fromDraft(draft, this.state.referenceOnly));
  }

  editRow(index: number, key: keyof PartitionRow, value: string): void {
    const rows = this.rows.map(row => ({ ...row })); rows[index][key] = value;
    this.commit({ ...this.state, draft: null, csv: serializePartitions(rows) });
  }
  rowSize(row: PartitionRow): number | null {
    const bytes = parseBytes(row.size);
    return Number.isFinite(bytes) ? bytes : null;
  }
  setRowSize(index: number, input: HTMLInputElement): void {
    const bytes = this.nearestSize(input.valueAsNumber);
    this.editRow(index, 'size', String(bytes));
    input.value = String(bytes);
  }
  addRow(): void {
    let name = 'storage'; let suffix = 1;
    while (this.rows.some(row => row.name === name)) name = 'storage' + suffix++;
    this.commit({ ...this.state, draft: null, csv: serializePartitions([...this.rows, { name, type: 'data', subtype: 'spiffs', offset: '', size: '4K', flags: '' }]) });
  }
  removeRow(index: number): void {
    this.commit({ ...this.state, draft: null, csv: serializePartitions(this.rows.filter((_, i) => i !== index)) });
  }

  async importCsv(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement; const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 128 * 1024) throw new Error('分区 CSV 不能超过 128 KiB。');
      const csv = await file.text();
      this.commit({ csv, draft: null, flashBytes: this.state.flashBytes, referenceOnly: false, customized: true });
      this.notice = '已导入草稿；原始 CSV 内容保持不变，保存前将再次校验。';
    } catch (error) { this.error = this.errorText(error); }
    finally { input.value = ''; }
  }

  exportCsv(): void {
    const url = URL.createObjectURL(new Blob([this.state.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'partitions.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  applyRepair(repair: Repair): void { this.commit(this.clone(repair.state)); this.notice = '已应用修复到草稿，请核对本次更改后保存。'; }

  async save(): Promise<void> {
    if (!this.canSave) return;
    this.saving = true; this.error = '';
    try {
      await this.send({ action: 'partition-manager-save', token: this.context!.token,
        csv: this.state.csv, flashBytes: this.state.flashBytes, draft: this.state.draft });
      this.allowClose = true;
      window['iWindow']?.close();
    } catch (error) { this.error = this.errorText(error); }
    finally { this.saving = false; }
  }

  async close(): Promise<void> {
    if (this.saving || this.closingPrompt) return;
    if (!this.dirty || this.allowClose || await this.confirmDiscard('放弃本次分区修改？')) {
      this.allowClose = true; window['iWindow']?.close();
    }
  }
  @HostListener('window:beforeunload', ['$event'])
  beforeUnload(event: BeforeUnloadEvent): void {
    if (!this.allowClose && (this.dirty || this.saving)) {
      event.preventDefault(); event.returnValue = '';
      if (!this.saving) void this.close();
    }
  }

  private async send(data: any, timeout = 15000): Promise<any> {
    if (!window['iWindow']?.send) throw new Error('请从桌面软件的分区方案菜单打开此窗口。');
    const response = await window['iWindow'].send({ to: 'main', data, timeout });
    if (!response?.success) throw new Error(response?.error || '主窗口未响应。请检查项目是否仍然打开，再重试。');
    return response;
  }
  private fromDraft(draft: PartitionDraft, referenceOnly = false, customized = true): EditorState {
    return { draft, flashBytes: draft.flashBytes, csv: serializePartitions(allocatePartitions(draft).rows), referenceOnly, customized };
  }
  private clone(state: EditorState): EditorState { return JSON.parse(JSON.stringify(state)); }
  private nearestSize(bytes: number, minimum = SECTOR): number {
    return Number.isFinite(bytes) && bytes > 0 ? Math.max(minimum, Math.round(bytes / SECTOR) * SECTOR) : 0;
  }
  private commit(state: EditorState): void {
    if (this.saving) return;
    this.state = state; this.error = ''; this.notice = ''; this.recalculate();
  }
  private recalculate(): void {
    const parsed = parsePartitionCsv(this.state.csv); this.rows = parsed.rows;
    this.layout = validatePartitions(parsed.rows, this.state.flashBytes);
    const allocationErrors = this.draft ? allocatePartitions(this.draft).errors : [];
    this.errors = [...new Set([...parsed.errors, ...allocationErrors, ...this.layout.errors])];
    if (!this.errors.length) {
      this.segments = layoutSegments(this.layout, this.state.flashBytes); this.mapFlashBytes = this.state.flashBytes;
    }
    this.repairs = [];
    if (this.errors.length && this.draft && !this.state.referenceOnly) {
      const recommended = this.fromDraft(createPreset(this.draft.preset, this.state.flashBytes), false, false);
      const candidates = [{ label: '重新使用用途推荐值', state: recommended }];
      if (this.draft.ota) candidates.push({ label: '改为有线更新', state: this.fromDraft({ ...this.draft, ota: false }) });
      for (const candidate of candidates) {
        const generated = allocatePartitions(candidate.state.draft!);
        const result = validatePartitions(generated.rows, candidate.state.flashBytes);
        if (!generated.errors.length && !result.errors.length) this.repairs.push({ ...candidate,
          detail: `单份程序 ${formatBytes(result.appLimit)}；${candidate.state.draft!.ota ? '保留双槽 OTA' : '不预留在线更新'}。重设相关手动值，固件大小需编译验证。` });
      }
    }
  }
  private async confirmDiscard(title: string): Promise<boolean> {
    if (this.closingPrompt) return false;
    this.closingPrompt = true;
    try {
      const modalRef = this.modal.create<unknown, { title: string }, boolean>({
        nzContent: this.discardDialog,
        nzData: { title },
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzMaskClosable: false,
        nzKeyboard: true,
        nzCentered: true,
        nzWidth: 440,
        nzBodyStyle: { padding: '0' },
      });
      return await firstValueFrom(modalRef.afterClose) === true;
    } finally {
      this.closingPrompt = false;
    }
  }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
