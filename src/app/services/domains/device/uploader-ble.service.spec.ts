import { UploaderBleService } from './uploader-ble.service';

describe('BLE and WiFi OTA firmware discovery', () => {
  let original: any;
  let files: Record<string, number | 'link'>;
  let service: UploaderBleService;

  beforeEach(() => {
    original = {fs: window['fs'], path: window['path']};
    files = {'boot_app0.bin':8192, 'sketch.bin':305296, 'sketch.bootloader.bin':19984,
      'sketch.partitions.bin':3072, 'sketch.merged.bin':4194304};
    window['path'] = {join: (...parts: string[]) => parts.join('/')};
    window['fs'] = {
      existsSync: () => true,
      readDirSync: () => Object.keys(files).map(name => ({name, _isDirectory:false, _isFile:true})),
      lstatSync: (file: string) => ({_isSymbolicLink: files[file.split('/').pop()] === 'link'}),
      statSync: (file: string) => ({size: files[file.split('/').pop()]}),
    };
    service = Object.create(UploaderBleService.prototype);
  });

  afterEach(() => Object.assign(window, original));

  it('selects the application while excluding all standard ESP32 outputs', () => {
    expect(service.findFirmwareFile('/build')).toBe('/build/sketch.bin');
    delete files['sketch.bin'];
    expect(service.findFirmwareFile('/build')).toBe('');
  });

  it('rejects a second application even if it has a preferred ino.bin suffix', () => {
    files['old.ino.bin'] = 400;
    expect(() => service.findFirmwareFile('/build')).toThrowError(/FIRMWARE_AMBIGUOUS/);
  });

  it('rejects an empty application and ignores linked copies', () => {
    files['backup.bin'] = 'link';
    expect(service.findFirmwareFile('/build')).toBe('/build/sketch.bin');
    files['sketch.bin'] = 0;
    expect(() => service.findFirmwareFile('/build')).toThrowError(/FIRMWARE_EMPTY/);
  });
});
