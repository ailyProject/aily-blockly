import type { BlockCodeMapping } from './arduino';
import { applyArduinoEntrypointBlockMappings } from './arduino-entrypoint-mapping';

describe('applyArduinoEntrypointBlockMappings', () => {
  const finalCodeLines = [
    '#include <Arduino.h>',
    '',
    'void setup() {',
    '  if (ready) {',
    '    Serial.println("}");',
    '  }',
    '}',
    '',
    'void loop() {',
    '  while (running) {',
    '    tick();',
    '  }',
    '}',
  ];

  it('maps setup and loop containers to their complete function ranges', () => {
    const blockCodeMap = new Map<string, BlockCodeMapping>([
      ['setup-root', createMapping('setup-root', 'arduino_setup', 5)],
      ['loop-root', createMapping('loop-root', 'arduino_loop', 11)],
    ]);

    applyArduinoEntrypointBlockMappings(
      finalCodeLines,
      new Map([
        ['setup-root', 'arduino_setup'],
        ['loop-root', 'arduino_loop'],
      ]),
      blockCodeMap,
    );

    expect(blockCodeMap.get('setup-root')).toEqual(jasmine.objectContaining({
      lineRanges: [{ startLine: 3, endLine: 7 }],
      executableLineRanges: [],
      supportLineRanges: [{ startLine: 3, endLine: 7 }],
      codeSnippet: [
        'void setup() {',
        '  if (ready) {',
        '    Serial.println("}");',
        '  }',
        '}',
      ].join('\n'),
    }));
    expect(blockCodeMap.get('loop-root')).toEqual(jasmine.objectContaining({
      lineRanges: [{ startLine: 9, endLine: 13 }],
      executableLineRanges: [],
      supportLineRanges: [{ startLine: 9, endLine: 13 }],
      codeSnippet: [
        'void loop() {',
        '  while (running) {',
        '    tick();',
        '  }',
        '}',
      ].join('\n'),
    }));
  });

  it('does not change mappings owned by nested statement blocks', () => {
    const childMapping = createMapping('serial-print', 'serial_println', 5);
    const blockCodeMap = new Map<string, BlockCodeMapping>([
      ['setup-root', createMapping('setup-root', 'arduino_setup', 5)],
      ['serial-print', childMapping],
    ]);

    applyArduinoEntrypointBlockMappings(
      finalCodeLines,
      new Map([
        ['setup-root', 'arduino_setup'],
        ['serial-print', 'serial_println'],
      ]),
      blockCodeMap,
    );

    expect(blockCodeMap.get('serial-print')).toBe(childMapping);
    expect(blockCodeMap.get('serial-print')?.lineRanges).toEqual([
      { startLine: 5, endLine: 5 },
    ]);
  });
});

function createMapping(
  blockId: string,
  blockType: string,
  line: number,
): BlockCodeMapping {
  const lineRange = { startLine: line, endLine: line };
  return {
    blockId,
    blockType,
    fragments: [],
    lineRanges: [lineRange],
    executableLineRanges: [lineRange],
    supportLineRanges: [],
    codeSnippet: '',
  };
}
