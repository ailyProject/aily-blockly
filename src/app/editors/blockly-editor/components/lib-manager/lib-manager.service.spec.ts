import { LibManagerService, PackageInfo } from './lib-manager.service';

describe('LibManagerService.filterByBoardType', () => {
  let service: LibManagerService;

  const library = (overrides: Partial<PackageInfo>): PackageInfo => ({
    name: '@aily-project/lib-test',
    nickname: 'Test',
    tested: false,
    state: 'default',
    ...overrides,
  });

  beforeEach(() => {
    service = new LibManagerService();
  });

  it('keeps ordinary libraries regardless of the selected board', () => {
    const ordinary = library({ compatibility: { core: ['arduino:avr:uno'] } });

    expect(service.filterByBoardType([ordinary], 'esp32:esp32:esp32')).toEqual([ordinary]);
  });

  it('keeps a spec library when compatibility.core contains the selected board type', () => {
    const wio = library({
      spec: true,
      compatibility: { core: ['Seeeduino:samd:seeed_wio_terminal'] },
    });

    expect(
      service.filterByBoardType([wio], 'Seeeduino:samd:seeed_wio_terminal'),
    ).toEqual([wio]);
  });

  it('removes a spec library when compatibility.core does not contain the selected board type', () => {
    const wio = library({
      spec: true,
      compatibility: { core: ['Seeeduino:samd:seeed_wio_terminal'] },
    });

    expect(service.filterByBoardType([wio], 'esp32:esp32:esp32')).toEqual([]);
  });

  it('removes spec libraries when no board type is available', () => {
    const wio = library({
      spec: true,
      compatibility: { core: ['Seeeduino:samd:seeed_wio_terminal'] },
    });

    expect(service.filterByBoardType([wio], '')).toEqual([]);
  });
});
