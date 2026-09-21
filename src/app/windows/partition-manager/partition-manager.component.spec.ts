import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OverlayContainer } from '@angular/cdk/overlay';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { ElectronService, PlatformService } from '@core/platform/public-api';
import { NzModalService } from 'ng-zorro-antd/modal';
import { TranslateModule } from '@ngx-translate/core';
import { PartitionManagerComponent } from './partition-manager.component';
import { allocatePartitions, createPreset, KIB, MIB, SECTOR, serializePartitions } from './partition-layout';

describe('Partition manager window interactions', () => {
  let fixture: ComponentFixture<PartitionManagerComponent>;
  let component: PartitionManagerComponent;
  let originalWindow: any;
  let bridge: any;
  let modal: NzModalService;
  let overlay: HTMLElement;
  const text = () => fixture.nativeElement.textContent as string;
  const button = (label: string): HTMLButtonElement => Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
    .find(item => item.textContent!.trim() === label)!;
  const dialog = (): HTMLElement => overlay.querySelector('app-base-dialog')!;
  const dialogButton = (label: string): HTMLButtonElement => Array.from(dialog().querySelectorAll('button'))
    .find(item => item.textContent!.trim() === label)!;

  beforeEach(async () => {
    originalWindow = window['iWindow'];
    bridge = { close: jasmine.createSpy('close'), send: jasmine.createSpy('send').and.resolveTo({ success: true, context: {
      token: 'session', projectPath: '/project', projectName: 'Test project', boardName: 'ESP32-S3',
      flashBytes: 8 * MIB, flashOptions: [{ value: '4M', bytes: 4 * MIB }, { value: '8M', bytes: 8 * MIB }],
      csv: '', source: 'missing', customSelected: false, draft: null, xiaozhiSupported: false,
    }, ports: [{ name: 'COM7', text: 'USB Serial' }, { name: 'COM8', text: 'ESP32' }], currentPort: 'COM7' }) };
    window['iWindow'] = bridge;
    await TestBed.configureTestingModule({
      imports: [PartitionManagerComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ project: '/project' }) } } },
        { provide: ElectronService, useValue: { isElectron: false, isWindowFullScreen: () => false } },
        { provide: PlatformService, useValue: { isMac: () => false } },
      ],
    }).compileComponents();
    modal = TestBed.inject(NzModalService);
    overlay = TestBed.inject(OverlayContainer).getContainerElement();
    fixture = TestBed.createComponent(PartitionManagerComponent);
    component = fixture.componentInstance;
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  });
  afterEach(() => { modal.closeAll(); fixture.destroy(); window['iWindow'] = originalWindow; });

  it('opens with recommended controls, an OTA layout, and no writes', () => {
    expect(text()).toContain('物联网应用'); expect(text()).toContain('单份程序上限');
    expect(component.layout.ota).toBeTrue(); expect(component.dirty).toBeFalse();
    expect(fixture.nativeElement.querySelector('.allocation #advanced-editor table')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#advanced-editor .section-heading')).toBeNull();
    expect(fixture.nativeElement.querySelector('.allocation #app-size')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.presets-section')).toBeNull();
    expect(fixture.nativeElement.querySelector('.allocation > .section-heading .badge')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.allocation > .preset-buttons button').length).toBe(4);
    expect(button('物联网应用').getAttribute('aria-pressed')).toBe('true');
    expect(button('自定义').getAttribute('aria-pressed')).toBe('false');
    expect(fixture.nativeElement.querySelector('footer .footer-validation.valid').textContent).toContain('分区布局有效');
    expect(fixture.nativeElement.querySelector('.save-scope')).toBeNull();
    expect(fixture.nativeElement.querySelector('.content-area .validation')).toBeNull();
    expect(fixture.nativeElement.querySelector('.editor-toggles')).toBeNull();
    expect(component.selectedPort).toBe('COM7');
    expect(fixture.nativeElement.querySelector('.port-select select').value).toBe('COM7');
    expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(bridge.send.calls.first().args[0].data.action).toBe('partition-manager-load');
  });

  it('applies presets through buttons and reapplies a preset after manual customization', () => {
    button('小智应用').click(); fixture.detectChanges();
    expect(component.draft!.preset).toBe('xiaozhi');
    expect(component.layout.appLimit).toBe(3008 * 1024);
    expect(component.rows.some(row => row.name === 'assets')).toBeTrue();
    expect(button('小智应用').getAttribute('aria-pressed')).toBe('true');
    button('大程序（有线更新）').click(); fixture.detectChanges();
    expect(component.layout.ota).toBeFalse();
    expect(component.rows.filter(row => row.type === 'app').length).toBe(1);
    expect(component.rows.some(row => row.name === 'assets')).toBeFalse();
    button('物联网应用').click(); component.setSize('appBytes', '2.5'); fixture.detectChanges();
    expect(button('自定义').getAttribute('aria-pressed')).toBe('true');
    expect(button('物联网应用').getAttribute('aria-pressed')).toBe('false');
    const csv = component.state.csv;
    button('自定义').click(); fixture.detectChanges();
    expect(component.state.csv).toBe(csv);
    expect(component.layout.appLimit).toBe(2.5 * MIB);
    button('物联网应用').click(); fixture.detectChanges();
    expect(component.layout.appLimit).toBe(3 * MIB);
    expect(button('物联网应用').getAttribute('aria-pressed')).toBe('true');
    expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it('enters custom mode without changing the layout or removing its adjustment controls', () => {
    const csv = component.state.csv; const draft = component.draft;
    button('自定义').click(); fixture.detectChanges();
    expect(button('自定义').getAttribute('aria-pressed')).toBe('true');
    expect(component.state.csv).toBe(csv); expect(component.draft).toBe(draft); expect(component.dirty).toBeFalse();
    expect(fixture.nativeElement.querySelector('#app-size')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#advanced-editor table')).not.toBeNull();
    button('物联网应用').click(); fixture.detectChanges();
    expect(button('物联网应用').getAttribute('aria-pressed')).toBe('true');
  });

  it('activates custom for option, capacity, size and row edits', () => {
    const edits = [
      () => component.changeOption('ota', false),
      () => component.changeOption('storage', false),
      () => component.changeOption('coredump', true),
      () => component.changeFlash(4 * MIB),
      () => component.setSize('nvsBytes', '24'),
      () => component.setSize('storageBytes', '1'),
      () => component.toggleStorageMode(),
      () => component.editRow(0, 'size', '24K'),
      () => component.addRow(),
      () => component.removeRow(1),
    ];
    for (const edit of edits) {
      edit(); fixture.detectChanges();
      expect(button('自定义').getAttribute('aria-pressed')).toBe('true');
      expect(fixture.nativeElement.querySelectorAll('.preset-button[aria-pressed="true"]').length).toBe(1);
      component.selectPreset('iot'); fixture.detectChanges();
      expect(button('物联网应用').getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('recognizes saved customized drafts while keeping their size controls available', async () => {
    const draft = { ...createPreset('iot', 8 * MIB), nvsBytes: 24 * 1024 };
    bridge.send.and.resolveTo({ success: true, context: { ...component.context,
      csv: serializePartitions(allocatePartitions(draft).rows), draft, customSelected: true,
    } });
    await component.load(); fixture.detectChanges();
    expect(button('自定义').getAttribute('aria-pressed')).toBe('true');
    expect(component.dirty).toBeFalse();
    expect(fixture.nativeElement.querySelector('#nvs-size').value).toBe('24');
  });

  it('preserves manually assigned program size when OTA changes without showing storage change notices', async () => {
    const input: HTMLInputElement = fixture.nativeElement.querySelector('#app-size');
    input.value = '2.5'; input.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(button('自定义').getAttribute('aria-pressed')).toBe('true');
    const ota: HTMLInputElement = fixture.nativeElement.querySelector('.feature input');
    ota.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(component.layout.ota).toBeFalse(); expect(component.layout.appLimit).toBe(2.5 * MIB);
    expect(fixture.nativeElement.querySelector('.feedback.notice')).toBeNull();
    ota.click(); await fixture.whenStable(); fixture.detectChanges();
    expect(component.layout.ota).toBeTrue(); expect(component.layout.appLimit).toBe(2.5 * MIB);
    expect(fixture.nativeElement.querySelector('.feedback.notice')).toBeNull();
  });

  it('blocks overflow, offers valid repairs, and retains the last valid map', () => {
    const previous = component.segments;
    component.setSize('appBytes', '5'); fixture.detectChanges();
    expect(button('保存分区方案').disabled).toBeTrue(); expect(text()).toContain('空间不足');
    expect(fixture.nativeElement.querySelector('footer .footer-validation.invalid').textContent).toContain('分区布局无效');
    expect(component.segments).toBe(previous); expect(component.repairs.length).toBeGreaterThan(0);
    component.applyRepair(component.repairs[0]); fixture.detectChanges();
    expect(component.errors).toEqual([]); expect(button('保存分区方案').disabled).toBeFalse();
    expect(fixture.nativeElement.querySelector('footer .footer-validation.valid').textContent).toContain('分区布局有效');
  });

  it('rounds manual sizes to the nearest sector and writes back even when the model value is unchanged', () => {
    const nvs: HTMLInputElement = fixture.nativeElement.querySelector('#nvs-size');
    for (const [raw, expected] of [['21', '20'], ['22', '24'], ['23', '24'], ['1', '12']]) {
      nvs.value = raw; nvs.dispatchEvent(new Event('change')); fixture.detectChanges();
      expect(nvs.value).toBe(expected); expect(component.draft!.nvsBytes).toBe(Number(expected) * KIB);
    }
    const app: HTMLInputElement = fixture.nativeElement.querySelector('#app-size');
    for (const [extra, expected] of [[KIB, 3 * MIB], [3 * KIB, 3 * MIB + SECTOR]]) {
      app.value = String(3 + extra / MIB); app.dispatchEvent(new Event('change')); fixture.detectChanges();
      expect(Number(app.value) * MIB).toBe(expected); expect(component.layout.appLimit).toBe(expected);
      expect(component.errors).toEqual([]);
    }
    component.toggleStorageMode(); fixture.detectChanges();
    const storage: HTMLInputElement = fixture.nativeElement.querySelector('#storage-size');
    storage.value = String(1 + KIB / MIB); storage.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(storage.value).toBe('1'); expect(component.storageBytes).toBe(MIB);
    expect(component.activePreset).toBe('custom');
  });

  it('steps program, file and NVS inputs up and down by exactly 4 KiB', () => {
    component.toggleStorageMode(); fixture.detectChanges();
    for (const [id, unit] of [['app-size', MIB], ['storage-size', MIB], ['nvs-size', KIB]] as const) {
      const input: HTMLInputElement = fixture.nativeElement.querySelector('#' + id);
      const before = Number(input.value) * unit;
      input.stepUp(); input.dispatchEvent(new Event('change')); fixture.detectChanges();
      expect(Number(input.value) * unit).toBe(before + SECTOR);
      input.stepDown(); input.dispatchEvent(new Event('change')); fixture.detectChanges();
      expect(Number(input.value) * unit).toBe(before);
    }
    expect(component.errors).toEqual([]);
  });

  it('keeps imported size notation intact until a table size is edited and rounds table values in bytes', async () => {
    const csv = component.state.csv.replace('20480', '20K');
    await component.importCsv({ target: { files: [{ size: csv.length, text: async () => csv }], value: 'file.csv' } } as any);
    fixture.detectChanges();
    const size: HTMLInputElement = fixture.nativeElement.querySelector('input[aria-label="nvs 大小"]');
    expect(size.value).toBe('20480'); expect(component.state.csv).toBe(csv);
    size.value = '21504'; size.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(size.value).toBe('20480'); expect(component.rows[0].size).toBe('20480');
    size.stepUp(); size.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(size.value).toBe('24576'); expect(component.rows[0].size).toBe('24576');
    size.stepDown(); size.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(size.value).toBe('20480'); expect(component.errors).toEqual([]);
    size.value = ''; size.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(component.canSave).toBeFalse(); expect(component.errors.length).toBeGreaterThan(0);
  });

  it('keeps an imported CSV unchanged and requires explicit discard before closing', async () => {
    const raw = '\uFEFF# custom comment\r\n' + serializePartitions(allocatePartitions(createPreset('iot', 8 * MIB)).rows);
    await component.importCsv({ target: { files: [{ size: raw.length, text: async () => raw }], value: 'file.csv' } } as any);
    fixture.detectChanges(); expect(component.state.csv).toBe(raw); expect(component.draft).toBeNull();
    expect(button('自定义').getAttribute('aria-pressed')).toBe('true');
    const pending = component.close(); expect(bridge.close).not.toHaveBeenCalled();
    fixture.detectChanges(); await fixture.whenStable();
    expect(dialog().textContent).toContain('放弃本次分区修改？');
    expect(dialog().textContent).toContain('项目和设备尚未改变。');
    dialogButton('继续编辑').click(); await pending;
    expect(bridge.close).not.toHaveBeenCalled(); expect(component.state.csv).toBe(raw);
    expect(component.closingPrompt).toBeFalse();

    const discard = component.close(); fixture.detectChanges(); await fixture.whenStable();
    dialogButton('放弃修改').click(); await discard;
    expect(bridge.close).toHaveBeenCalledTimes(1); expect(component.allowClose).toBeTrue();
  });

  it('preserves the draft when the reload dialog is dismissed and reloads only after discard', async () => {
    component.setSize('appBytes', '2.5'); const csv = component.state.csv;
    const pending = component.load(); fixture.detectChanges(); await fixture.whenStable();
    expect(dialog().textContent).toContain('重新载入会放弃当前草稿，继续吗？');
    dialog().querySelector<HTMLElement>('.close')!.click(); await pending;
    expect(component.state.csv).toBe(csv); expect(bridge.send).toHaveBeenCalledTimes(2);
    expect(component.closingPrompt).toBeFalse();

    const reload = component.load(); fixture.detectChanges(); await fixture.whenStable();
    dialogButton('放弃修改').click(); await reload;
    expect(bridge.send).toHaveBeenCalledTimes(3);
    expect(bridge.send.calls.mostRecent().args[0].data.action).toBe('partition-manager-load');
    expect(component.dirty).toBeFalse(); expect(bridge.close).not.toHaveBeenCalled();
  });

  it('opens one discard dialog for repeated requests and treats Escape as cancellation', async () => {
    component.setSize('appBytes', '2.5'); const csv = component.state.csv;
    const pending = component.close(); fixture.detectChanges(); await fixture.whenStable();
    await component.close(); await component.load();
    expect(overlay.querySelectorAll('app-base-dialog').length).toBe(1);
    overlay.querySelector<HTMLElement>('.ant-modal')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', keyCode: 27, bubbles: true,
    }));
    await pending;
    expect(component.state.csv).toBe(csv); expect(component.closingPrompt).toBeFalse();
    expect(bridge.close).not.toHaveBeenCalled(); expect(bridge.send).toHaveBeenCalledTimes(2);
  });

  it('shows XiaoZhi as a reference when the project lacks a matching layout', () => {
    component.selectPreset('xiaozhi'); fixture.detectChanges();
    expect(text()).toContain('当前仅预览'); expect(component.canSave).toBeFalse();
    component.selectPreset('iot'); expect(component.canSave).toBeTrue();
  });

  it('reads the selected port, synchronizes capacity and preserves manually assigned sizes', async () => {
    component.setSize('appBytes', '2.5'); const csv = component.state.csv;
    bridge.send.and.resolveTo({ success: true, device: {
      port: 'COM8', chip: 'ESP32-S3', flashBytes: 4 * MIB, tableOffset: 0x8000, readAt: '2026-09-21T08:00:00Z',
      partitions: [{ name: 'device_nvs', type: 'data', subtype: 'nvs', offset: 0x9000, size: 0x6000, flags: 0 }],
    } });
    const portSelect: HTMLSelectElement = fixture.nativeElement.querySelector('.port-select select');
    portSelect.value = 'COM8'; portSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges(); await fixture.whenStable();
    button('读取设备分区').click(); fixture.detectChanges();
    expect(component.readingDevice).toBeTrue(); expect(component.canSave).toBeFalse();
    await fixture.whenStable(); fixture.detectChanges();
    await fixture.whenStable(); fixture.detectChanges();
    expect(bridge.send.calls.mostRecent().args[0].data.action).toBe('partition-manager-read-device');
    expect(bridge.send.calls.mostRecent().args[0].data.port).toBe('COM8');
    expect(text()).toContain('COM8'); expect(text()).toContain('device_nvs');
    expect(text()).toContain('当前设备分区'); expect(text()).toContain('计划空间分配');
    expect(fixture.nativeElement.querySelector('.device-panel').nextElementSibling.classList).toContain('allocation');
    expect(fixture.nativeElement.querySelector('.project-summary')).toBeNull();
    expect(component.state.csv).not.toBe(csv);
    expect(component.draft!.appBytes).toBe(2.5 * MIB);
    expect(component.state.flashBytes).toBe(4 * MIB); expect(component.readingDevice).toBeFalse();
    expect(fixture.nativeElement.querySelector('.capacity-select select').selectedOptions[0].textContent).toContain('4 MiB');
    component.changeFlash(8 * MIB); expect(component.state.csv).toBe(csv); expect(component.state.flashBytes).toBe(8 * MIB);
  });

  it('maps actual device addresses and capacity independently of the planned layout', async () => {
    const partitions = [
      { name: 'assets', type: 'data', subtype: 'littlefs', offset: 0x310000, size: 0x80000, flags: 0 },
      { name: 'app1', type: 'app', subtype: 'ota_1', offset: 0x190000, size: 0x180000, flags: 0 },
      { name: 'nvs', type: 'data', subtype: 'nvs', offset: 0x9000, size: 0x6000, flags: 0 },
      { name: 'app0', type: 'app', subtype: 'ota_0', offset: 0x10000, size: 0x180000, flags: 0 },
    ];
    bridge.send.and.resolveTo({ success: true, device: {
      port: 'COM7', chip: 'ESP32-S3', flashBytes: 8 * MIB, tableOffset: 0x8000, bootloaderOffset: 0, readAt: '', partitions,
    } });
    await component.readDevice(); fixture.detectChanges();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.device-panel .capacity-bar');
    const segments = component.deviceSegments;
    expect(bar.getAttribute('aria-label')).toContain('8 MiB');
    expect(segments.map(segment => [segment.kind, segment.offset, segment.bytes])).toEqual([
      ['bootloader', 0, 0x8000], ['partition-table', 0x8000, 0x1000], ['system', 0x9000, 0x6000], ['gap', 0xf000, 0x1000],
      ['app', 0x10000, 0x180000], ['ota', 0x190000, 0x180000],
      ['data', 0x310000, 0x80000], ['free', 0x390000, 0x470000],
    ]);
    expect(Array.from(bar.querySelectorAll<HTMLElement>('.segment')).reduce((sum, item) => sum + parseFloat(item.style.width), 0)).toBeCloseTo(100);
    expect(bar.querySelector<HTMLElement>('.app')!.style.width).toBe('18.75%');
    expect(bar.querySelector<HTMLElement>('.app')!.title).toContain('app0 · 1.5 MiB · 0x10000');
    expect(component.device!.partitions.map(partition => partition.name)).toEqual(['assets', 'app1', 'nvs', 'app0']);
    component.changeFlash(4 * MIB); component.setSize('appBytes', '1'); fixture.detectChanges();
    expect(component.deviceSegments).toEqual(segments);
    expect(bar.querySelector<HTMLElement>('.app')!.style.width).toBe('18.75%');
  });

  it('shows startup regions in the table and selects their rows from the device map without changing the project', async () => {
    const csv = component.state.csv;
    bridge.send.and.resolveTo({ success: true, device: {
      port: 'COM7', chip: 'ESP32', flashBytes: 8 * MIB, tableOffset: 0x8000, bootloaderOffset: 0x1000, readAt: '',
      partitions: [{ name: 'nvs', type: 'data', subtype: 'nvs', offset: 0x9000, size: 0x6000, flags: 0 }],
    } });
    await component.readDevice(); fixture.detectChanges();
    const table: HTMLElement = fixture.nativeElement.querySelector('.device-table');
    expect(table.textContent).toContain('芯片保留区'); expect(table.textContent).toContain('bootloader');
    expect(table.textContent).toContain('partition_table'); expect(table.textContent).toContain('保留范围');
    const row = table.querySelector<HTMLElement>('[data-offset="4096"]')!;
    const scroll = spyOn(row, 'scrollIntoView');
    fixture.nativeElement.querySelector('.device-panel .segment.bootloader').click(); fixture.detectChanges();
    expect(scroll).toHaveBeenCalled(); expect(row.classList.contains('selected')).toBeTrue();
    expect(component.selectedDeviceOffset).toBe(0x1000);
    expect(component.state.csv).toBe(csv); expect(component.dirty).toBeFalse();
    expect(component.device!.partitions.length).toBe(1);
    await component.readDevice(); expect(component.selectedDeviceOffset).toBeNull();
  });

  it('recomputes recommended sizes when device capacity is detected', async () => {
    bridge.send.and.resolveTo({ success: true, device: {
      port: 'COM7', chip: 'ESP32-S3', flashBytes: 4 * MIB, tableOffset: 0x8000, readAt: '', partitions: [],
    } });
    await component.readDevice();
    expect(component.state.flashBytes).toBe(4 * MIB);
    expect(component.draft!.appBytes).toBe(1.5 * MIB); expect(component.errors).toEqual([]);
    expect(component.activePreset).toBe('iot');
    expect(component.canSave).toBeTrue();
  });

  it('shows detected capacity even when the board cannot save that capacity', async () => {
    bridge.send.and.resolveTo({ success: true, device: {
      port: 'COM7', chip: 'ESP32-S3', flashBytes: 16 * MIB, tableOffset: 0x8000, readAt: '', partitions: [],
    } });
    await component.readDevice(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(component.state.flashBytes).toBe(16 * MIB);
    expect(fixture.nativeElement.querySelector('.capacity-select select').selectedOptions[0].textContent).toContain('16 MiB');
    expect(component.canSave).toBeFalse(); expect(text()).toContain('当前开发板未提供 16 MiB');
  });

  it('keeps an imported layout and project capacity when capacity detection is unavailable', async () => {
    const csv = component.state.csv;
    await component.importCsv({ target: { files: [{ size: csv.length, text: async () => csv }], value: 'file.csv' } } as any);
    bridge.send.and.resolveTo({ success: true, device: {
      port: 'COM7', chip: 'ESP32-S3', flashBytes: 0, tableOffset: 0x8000, readAt: '',
      partitions: [{ name: 'factory', type: 'app', subtype: 'factory', offset: 0x10000, size: MIB, flags: 0 }],
    } });
    await component.readDevice(); fixture.detectChanges();
    expect(component.state.flashBytes).toBe(8 * MIB); expect(component.state.csv).toBe(csv);
    expect(fixture.nativeElement.querySelector('#advanced-editor table')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.custom-adjustment-hint')).not.toBeNull();
    expect(component.deviceMapBytes).toBe(0x10000 + MIB);
    expect(fixture.nativeElement.querySelector('.device-panel .capacity-bar').getAttribute('aria-label')).toContain('已读取分区范围');
    expect(fixture.nativeElement.querySelector('.device-panel .segment.free')).toBeNull();
    expect(text()).toContain('Flash 容量未识别，分段条按已读取分区范围显示。');
  });

  it('preserves the chosen port on refresh and blocks reading a disconnected port', async () => {
    component.selectedPort = 'COM8';
    bridge.send.and.resolveTo({ success: true, currentPort: 'COM7', ports: [{ name: 'COM8', text: 'ESP32' }] });
    const portSelect: HTMLSelectElement = fixture.nativeElement.querySelector('.port-select select');
    portSelect.dispatchEvent(new Event('pointerdown')); fixture.detectChanges();
    expect(portSelect.disabled).toBeFalse();
    await fixture.whenStable(); fixture.detectChanges();
    expect(component.selectedPort).toBe('COM8');
    expect(bridge.send.calls.mostRecent().args[0].data.action).toBe('partition-manager-ports');
    expect(fixture.nativeElement.querySelector('.refresh-ports')).toBeNull();
    bridge.send.and.resolveTo({ success: true, currentPort: 'COM7', ports: [] });
    await component.refreshPorts(); fixture.detectChanges();
    expect(component.selectedPort).toBe('COM8'); expect(button('读取设备分区').disabled).toBeTrue();
    const requests = bridge.send.calls.count();
    await component.readDevice(); expect(bridge.send.calls.count()).toBe(requests);
  });

  it('prevents repeated device reads and keeps the draft after failure', async () => {
    component.setSize('appBytes', '2.5'); const csv = component.state.csv;
    let finish!: (result: any) => void;
    bridge.send.and.returnValue(new Promise(resolve => { finish = resolve; }));
    const pending = component.readDevice(); await component.readDevice();
    expect(bridge.send).toHaveBeenCalledTimes(3);
    finish({ success: false, error: '设备已断开' }); await pending; fixture.detectChanges();
    expect(text()).toContain('设备已断开'); expect(component.readingDevice).toBeFalse();
    expect(component.state.csv).toBe(csv); expect(component.canSave).toBeTrue();
  });

  it('keeps the window and draft on save failure, then closes after a successful retry', async () => {
    component.setSize('appBytes', '2.5'); const csv = component.state.csv;
    bridge.send.and.resolveTo({ success: false, error: 'external change' });
    await component.save(); fixture.detectChanges();
    expect(text()).toContain('external change'); expect(component.state.csv).toBe(csv);
    expect(bridge.close).not.toHaveBeenCalled(); expect(component.saving).toBeFalse();
    bridge.send.and.resolveTo({ success: true }); await component.save();
    expect(bridge.close).toHaveBeenCalledTimes(1); expect(component.allowClose).toBeTrue();
    expect(bridge.send.calls.mostRecent().args[0].data.csv).toBe(csv);
  });
});
