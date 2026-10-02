import { BehaviorSubject, Subject } from 'rxjs';
import { normalizeBoardMcu, normalizeBoardMcuDeclaration } from './board-mcu';
import { ProjectService } from './project.service';

describe('board package MCU declaration', () => {
  let oldFs: any, oldBoard: any;
  beforeEach(() => { oldFs = window['fs']; oldBoard = window['boardConfig']; });
  afterEach(() => { window['fs'] = oldFs; window['boardConfig'] = oldBoard; });

  it('normalizes generic identifiers without platform-specific name inference', () => {
    for (const value of ['ESP32S3', 'ATmega328P', 'STM32F103C8', 'vendor-chip.v2']) {
      expect(normalizeBoardMcu(' ' + value + ' ')).toBe(value.toLowerCase());
    }
    for (const value of [undefined, null, '', ' ', 32, {}, ['esp32s3'], 'ESP32 S3', '../esp32', 'a'.repeat(65)]) {
      expect(normalizeBoardMcu(value)).toBeUndefined();
    }
    const board = { type: 'esp32:esp32:esp32s3', build: { mcu: 'esp32c3' } };
    normalizeBoardMcuDeclaration(board);
    expect(board).toEqual({ type: 'esp32:esp32:esp32s3', build: { mcu: 'esp32c3' } });
  });

  function fixture(raw: Record<string, any>) {
    const serialized = JSON.stringify(raw), read = jasmine.createSpy('read board').and.returnValue(serialized);
    const service: any = Object.create(ProjectService.prototype);
    service.runtimeBoardModules = new WeakMap();
    service.currentProjectPathSubject = new BehaviorSubject('/fixture');
    service.boardConfigUpdatedSubject = new Subject();
    service.getBoardModule = async () => '@aily-project/board-alias';
    service.isAilyCodeProject = () => true;
    service.electronService = { readFile: read };
    window['fs'] = { existsSync: () => true, writeFileSync: jasmine.createSpy('unexpected write') };
    return { service, read, serialized };
  }

  it('loads and synchronizes Coder without reading SDK files or writing project files', async () => {
    const raw = { type: 'custom:sdk:opaque_alias', mcu: ' ESP32S3 ', digitalPins: [['RX', '4']] };
    const { service, read, serialized } = fixture(raw);
    expect(await service.syncCurrentBoardConfig()).toBeTrue();
    expect(service.currentBoardConfig.mcu).toBe('esp32s3');
    expect(window['boardConfig']).toBe(service.currentBoardConfig);
    expect(service.getRuntimeBoardModule()).toBe('@aily-project/board-alias');
    expect(read).toHaveBeenCalledOnceWith('/fixture/node_modules/@aily-project/board-alias/board.json');
    expect(JSON.stringify(raw)).toBe(serialized);
    expect(window['fs'].writeFileSync).not.toHaveBeenCalled();
  });

  it('preserves declaration and identity through Blockly runtime resolution without MCU-related SDK work', async () => {
    const { service } = fixture({ type: 'custom:sdk:opaque_alias', mcu: 'ATmega328P' });
    service.isCdcOnBootEnabledForProject = jasmine.createSpy('existing CDC path').and.resolveTo(false);
    Object.defineProperty(service, 'application', { value: { applyCdcSerialPortOverrides() {} } });
    const raw = await service.getBoardJson();
    const result = await service.resolveBoardConfigForRuntime(raw);
    service.currentBoardConfig = result;
    expect(result.mcu).toBe('atmega328p');
    expect(result).not.toBe(raw);
    expect(result.build).toBeUndefined();
    expect(service.getRuntimeBoardModule()).toBe('@aily-project/board-alias');
    expect(window['fs'].writeFileSync).not.toHaveBeenCalled();
  });

  it('does not retain a previous MCU when switching to an undeclared or invalid legacy board', async () => {
    const { service, read } = fixture({ mcu: 'esp32s3' });
    await service.syncCurrentBoardConfig();
    for (const next of [{ type: 'esp32:esp32:legacy' }, { mcu: 32 }]) {
      read.and.returnValue(JSON.stringify(next));
      expect(await service.syncCurrentBoardConfig()).toBeTrue();
      expect(service.currentBoardConfig.mcu).toBeUndefined();
      expect(window['boardConfig'].mcu).toBeUndefined();
    }
  });
});
