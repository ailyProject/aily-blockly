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
});
