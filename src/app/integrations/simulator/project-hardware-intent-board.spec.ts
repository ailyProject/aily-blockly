import { resolveProjectHardwareIntentBoard } from './project-hardware-intent-board';
import { normalizeBoardMcuDeclaration } from '../../services/domains/project/board-mcu';

describe('Project hardware Board identity', () => {
  const board = { type: 'esp32:esp32:esp32', core: 'esp32:esp32', mcu: 'esp32', version: '3.3.1' };

  it('keeps exact installed npm identity separate from shared SDK board and FQBN', () => {
    for (const [name, version] of [
      ['@aily-project/board-esp32', '3.3.10'],
      ['@aily-project/board-wifiduino_esp32dev', '3.3.1'],
      ['@aily-project/board-summer-v2', '3.3.1'],
    ]) {
      expect(resolveProjectHardwareIntentBoard(board, { dependencies: { [name]: '^3.3.0' } }, { name, version }))
        .toEqual({ fqbn: 'esp32:esp32:esp32', boardId: 'esp32', architecture: 'esp32', mcu: 'esp32', projectPackage: { name, version } });
    }
  });

  it('uses the installed package version, never the SDK version or dependency range', () => {
    const name = '@aily-project/board-esp32';
    const result = resolveProjectHardwareIntentBoard(board, { dependencies: { [name]: '^3.3.0' } }, { name, version: '3.3.10' });
    expect(result.projectPackage?.version).toBe('3.3.10');
    expect(() => resolveProjectHardwareIntentBoard(board, { dependencies: { [name]: '^3.3.0' } }, { name, version: '^3.3.0' }))
      .toThrowError(/installed version/u);
  });

  it('does not invent npm package identity for a generic Host without package facts', () => {
    expect(resolveProjectHardwareIntentBoard(board, { dependencies: { '@aily-project/board-esp32': '3.3.10' } }).projectPackage)
      .toBeUndefined();
  });

  it('keeps the H2 compiler board distinct from classic ESP32 when no MCU field is declared', () => {
    const result = resolveProjectHardwareIntentBoard({ type: 'esp32:esp32:esp32h2', core: 'esp32:esp32' }, {});
    expect(result.mcu).toBe('esp32h2');
    expect(result.boardId).toBe('esp32h2');
  });

  it('keeps C5 and existing ESP compiler boards distinct from the classic fallback', () => {
    for (const mcu of ['esp32c5', 'esp32h2', 'esp32c3', 'esp32c6', 'esp32s3', 'esp32s2', 'esp32']) {
      const fqbn = `esp32:esp32:${mcu}`;
      expect(resolveProjectHardwareIntentBoard({ type: fqbn, core: 'esp32:esp32' }, {}))
        .toEqual({ fqbn, boardId: mcu, architecture: 'esp32', mcu });
    }
  });

  it('preserves C5 declarations, resolved compiler markers and upload-command evidence', () => {
    const c5 = { type: 'esp32:esp32:esp32c5', core: 'esp32:esp32' };
    expect(resolveProjectHardwareIntentBoard({ ...c5, mcu: 'ESP32C5' }, {}).mcu).toBe('esp32c5');
    expect(resolveProjectHardwareIntentBoard(c5, {}, undefined,
      { boardId: 'esp32c5', mcu: 'esp32c5' }).mcu).toBe('esp32c5');
    for (const command of ['linkUploadParam', 'uploadParam']) {
      expect(resolveProjectHardwareIntentBoard({ type: 'vendor:esp32:logical', core: 'vendor:esp32',
        [command]: 'esptool --chip esp32c5 write-flash firmware.bin' }, {}).mcu).toBe('esp32c5');
    }
    expect(() => resolveProjectHardwareIntentBoard({ ...c5, mcu: 'esp32c5' }, {}, undefined,
      { boardId: 'esp32c5', mcu: 'esp32c6' })).toThrowError(/MCU conflicts/u);
  });

  it('preserves explicit physical variant identity within a shared compiler board', () => {
    const name = '@aily-project/board-stm32f103c8';
    const result = resolveProjectHardwareIntentBoard({ type: 'STMicroelectronics:stm32:GenF1', core: 'STMicroelectronics:stm32', mcu: 'stm32f103c8' },
      { projectConfig: { pnum: 'BLUEPILL_F103C8' }, dependencies: { [name]: '3.0.0' } }, { name, version: '3.0.0' });
    expect(result.boardId).toBe('BLUEPILL_F103C8');
    expect(result.projectPackage).toEqual({ name, version: '3.0.0' });
  });

  it('preserves the real F103C8 package declaration through normal Project normalization', () => {
    // These fields match the installed package in the completed P6.1 product
    // project, not an MCU inferred from its upload command or display name.
    const name = '@aily-project/board-stm32f103c8';
    const configuration = { name: 'STM32F103C8', version: '1.0.0', mcu: 'stm32f103c8',
      type: 'STMicroelectronics:stm32:GenF1', core: 'STMicroelectronics:stm32',
      linkUploadParam: 'probe-rs download --chip STM32F103C8 --verify firmware.elf' };
    normalizeBoardMcuDeclaration(configuration);
    const identity = resolveProjectHardwareIntentBoard(configuration,
      { projectConfig: { pnum: 'GENERIC_F103C8TX' }, dependencies: { [name]: '3.0.0' } },
      { name, version: '3.0.0' });
    expect(identity.mcu).toBe('stm32f103c8');
    expect(identity.boardId).toBe('GENERIC_F103C8TX');
    expect(identity.projectPackage).toEqual({ name, version: '3.0.0' });
  });

  it('accepts the normal boardDependencies selection and rejects undeclared or malformed installed packages', () => {
    const name = '@aily-project/board-esp32';
    expect(resolveProjectHardwareIntentBoard(board, { boardDependencies: { [name]: '3.3.10' } }, { name, version: '3.3.10' }).projectPackage)
      .toEqual({ name, version: '3.3.10' });
    for (const installed of [null, {}, { name: '@aily-project/board-other', version: '3.3.10' }, { name, version: 'file:C:/private' }]) {
      expect(() => resolveProjectHardwareIntentBoard(board, { dependencies: { [name]: '3.3.10' } }, installed)).toThrow();
    }
  });

  const genericF1 = { name: 'STM32F1 Series', type: 'STMicroelectronics:stm32:GenF1', core: 'STMicroelectronics:stm32',
    linkUploadParam: 'probe-rs download --chip ${pnum} --verify firmware.elf' };
  const f1Package = { name: '@aily-project/board-stm32f1', version: '3.0.0' };
  const f1Project = (pnum: string) => ({ projectConfig: { pnum }, dependencies: { [f1Package.name]: '3.0.0' } });

  for (const [pnum, mcu] of [['GENERIC_F103C8TX', 'STM32F103C8'], ['GENERIC_F103CBTX', 'STM32F103CB']]) {
    it(`uses the normal compiler exact target without mutating generic Board metadata: ${mcu}`, () => {
      const input = { ...genericF1 };
      const result = resolveProjectHardwareIntentBoard(input, f1Project(pnum), f1Package, { boardId: pnum, mcu });
      expect(result.mcu).toBe(mcu.toLowerCase()); expect(result.boardId).toBe(pnum);
      expect(Object.hasOwn(input, 'mcu')).toBeFalse();
    });
  }

  it('does not treat a shared GenF1 FQBN or display name as exact MCU evidence', () => {
    for (const markers of [undefined, null, {}]) {
      expect(() => resolveProjectHardwareIntentBoard(genericF1, f1Project('GENERIC_F103CBTX'), f1Package, markers))
        .toThrowError(/requires current resolved compiler target markers/u);
    }
  });

  it('rejects a stale compiler selection and conflicting exact C8 versus CB declarations', () => {
    expect(() => resolveProjectHardwareIntentBoard(genericF1, f1Project('GENERIC_F103CBTX'), f1Package,
      { boardId: 'GENERIC_F103C8TX', mcu: 'STM32F103C8' })).toThrowError(/Board identity conflicts/u);
    expect(() => resolveProjectHardwareIntentBoard({ ...genericF1, mcu: 'stm32f103c8' }, f1Project('GENERIC_F103CBTX'), f1Package,
      { boardId: 'GENERIC_F103CBTX', mcu: 'STM32F103CB' })).toThrowError(/MCU conflicts/u);
  });

  it('keeps an exact explicit F407 declaration when the compiler marker is only its broad family', () => {
    const result = resolveProjectHardwareIntentBoard({ type: 'STMicroelectronics:stm32:GenF4', core: 'STMicroelectronics:stm32', mcu: 'stm32f407vg' },
      { projectConfig: { pnum: 'BLACK_F407VG' } }, undefined, { boardId: 'BLACK_F407VG', mcu: 'STM32F407xx' });
    expect(result.mcu).toBe('stm32f407vg');
    expect(() => resolveProjectHardwareIntentBoard({ type: 'STMicroelectronics:stm32:GenF4', core: 'STMicroelectronics:stm32', mcu: 'stm32f407vg' },
      { projectConfig: { pnum: 'BLACK_F407VG' } }, undefined, { boardId: 'BLACK_F407VG', mcu: 'STM32F103CB' })).toThrowError(/MCU conflicts/u);
  });

  it('preserves prior ESP and AVR exact declarations and rejects contradictory resolved targets', () => {
    for (const [type, core, mcu] of [['esp32:esp32:esp32', 'esp32:esp32', 'esp32'],
      ['arduino:avr:uno', 'arduino:avr', 'atmega328p']]) {
      expect(resolveProjectHardwareIntentBoard({ type, core, mcu }, {}, undefined, { mcu }).mcu).toBe(mcu);
      expect(() => resolveProjectHardwareIntentBoard({ type, core, mcu }, {}, undefined, { mcu: 'different-chip' }))
        .toThrowError(/MCU conflicts/u);
    }
  });
});
