import { planBoardSourceEdits, updateBoardSource, writeBoardSourceEdits } from './source-edits';

describe('Coder board menu source migration', () => {
  const on = { _cdcEnabled: true, cdcSerialPort: [['USB', 'Serial']] };
  const off = { ...on, _cdcEnabled: false };
  const rewrite = (source: string) => updateBoardSource(source, 'CDCOnBoot', on, off);

  it('restores hardware UART references when disabling CDC, matching Blockly fields', () => {
    expect(rewrite('Serial0.begin(115200);\nPrint &out = Serial0;\nSerial.print(1); Serial1.read();'))
      .toBe('Serial.begin(115200);\nPrint &out = Serial;\nSerial.print(1); Serial1.read();');
    expect(updateBoardSource('Serial.begin(9600);', 'CDCOnBoot', off, on)).toBe('Serial.begin(9600);');
  });
  it('uses the board-declared CDC value, including a nonstandard serial alias', () => {
    expect(updateBoardSource('Serial0.read();', 'CDCOnBoot', on, { _cdcEnabled: false, cdcSerialPort: [['CDC', 'Serial2']] }))
      .toBe('Serial2.read();');
  });
  it('preserves strings, raw strings, comments, include paths, member names and longer identifiers', () => {
    const untouched = '// Serial0\n/* Serial0 */\n"Serial0 \\" quoted";\nR"tag(Serial0 " text)tag";\n#include <Serial0.h>\nobj.Serial0.read(); ptr->Serial0; ns::Serial0; MySerial0;';
    expect(rewrite(untouched)).toBe(untouched);
    expect(rewrite('// Serial0 \\\nSerial0 is still a comment\nSerial0.read();')).toBe('// Serial0 \\\nSerial0 is still a comment\nSerial.read();');
    expect(rewrite('#define CONSOLE Serial0\nCONSOLE.print(1);')).toContain('#define CONSOLE Serial');
  });
  it('refuses collisions with custom objects and macros', () => {
    for (const declaration of ['HardwareSerial Serial0(1);', 'auto &Serial0 = custom;', 'CustomUart Serial0;', 'auto&Serial0 = custom;', '#define Serial0 custom']) {
      expect(() => rewrite(declaration + '\nSerial0.read();')).toThrowError(/自定义/);
    }
  });
  it('changes unavailable pin symbols and known pin arguments, keeping valid pins and ordinary numbers', () => {
    const previous = { digitalPins: [['PA0', 'PA0'], ['PC13', 'PC13'], ['D7', '7']], analogPins: [['A0', 'PC13']] };
    const next = { digitalPins: [['PA0', 'PA0']], analogPins: [['A1', 'PA1']] };
    expect(updateBoardSource('pinMode(PC13, OUTPUT);\ndigitalWrite(7, 1);\nanalogRead(PC13);\nint delayMs = 7;\ndigitalWrite(PA0, 0);', 'pnum', previous, next))
      .toBe('pinMode(PA0, OUTPUT);\ndigitalWrite(PA0, 1);\nanalogRead(PA1);\nint delayMs = 7;\ndigitalWrite(PA0, 0);');
  });
  it('never rewrites source for compiler-only options or unchanged CDC state', () => {
    for (const key of ['USBMode', 'PSRAM', 'PartitionScheme', 'cpu', 'usb']) {
      expect(updateBoardSource('Serial0.print(1);', key, on, off)).toBe('Serial0.print(1);');
    }
    expect(updateBoardSource('Serial0.print(1);', 'CDCOnBoot', off, off)).toBe('Serial0.print(1);');
  });

  let oldFs: any, oldPath: any;
  beforeEach(() => { oldFs = window['fs']; oldPath = window['path']; });
  afterEach(() => { window['fs'] = oldFs; window['path'] = oldPath; });

  it('scans all project-owned source tabs and headers while excluding libraries and symlinks', () => {
    const dirs: Record<string, any[]> = {
      '/project/sketch': [{ name: 'src', _isDirectory: true }, { name: 'libraries', _isDirectory: true }, { name: 'external' }],
      '/project/sketch/src': [{ name: 'main.cpp', _isFile: true }, { name: 'helpers.h', _isFile: true }, { name: 'note.txt', _isFile: true }],
    };
    window['path'] = { join: (...parts: string[]) => parts.join('/') };
    window['fs'] = { existsSync: (path: string) => !!dirs[path], lstatSync: () => ({ _isSymbolicLink: false }),
      readDirSync: (path: string) => dirs[path], readFileSync: () => 'Serial0.read();' };
    const edits = planBoardSourceEdits('/project', { sourceRoots: ['sketch', '../outside', 'sketch/libraries'] }, 'CDCOnBoot', on, off);
    expect(edits.map(edit => edit.path)).toEqual(['/project/sketch/src/main.cpp', '/project/sketch/src/helpers.h']);
  });
  it('checks every baseline before writing and restores earlier writes after an I/O failure', () => {
    const files: any = { a: 'old a', b: 'old b' };
    const edits = [{ path: 'a', before: files.a, after: 'new a' }, { path: 'b', before: files.b, after: 'new b' }];
    let fail = true;
    window['fs'] = { readFileSync: (path: string) => files[path], writeFileSync: (path: string, content: string) => {
      if (path === 'b' && fail) { fail = false; throw new Error('disk full'); } files[path] = content;
    } };
    expect(() => writeBoardSourceEdits(edits)).toThrowError('disk full');
    expect(files).toEqual({ a: 'old a', b: 'old b' });
    files.b = 'user edit';
    expect(() => writeBoardSourceEdits(edits)).toThrowError(/源码已变化/);
    expect(files.a).toBe('old a');
  });
});
