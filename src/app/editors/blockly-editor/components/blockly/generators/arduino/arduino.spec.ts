import * as Blockly from 'blockly';
import {
  ArduinoGenerator,
  normalizeArduinoGeneratedCode,
  Order,
} from './arduino';

describe('normalizeArduinoGeneratedCode', () => {
  it('returns string code unchanged', () => {
    expect(normalizeArduinoGeneratedCode('void setup() {}')).toBe('void setup() {}');
  });

  it('extracts known generated-code fields from structured results', () => {
    expect(normalizeArduinoGeneratedCode({ code: 'void loop() {}' })).toBe('void loop() {}');
    expect(normalizeArduinoGeneratedCode({ generatedCode: 'int value = 1;' })).toBe('int value = 1;');
  });

  it('does not stringify arbitrary objects into sketch code', () => {
    expect(normalizeArduinoGeneratedCode({ ok: true })).toBe('');
  });
});

describe('ArduinoGenerator block source mapping', () => {
  beforeAll(() => {
    if (!Blockly.Blocks['test_source_map_parent']) {
      Blockly.defineBlocksWithJsonArray([
        {
          type: 'test_source_map_parent',
          message0: 'consume %1',
          args0: [{
            type: 'input_value',
            name: 'VALUE',
          }],
          previousStatement: null,
          nextStatement: null,
        },
        {
          type: 'test_source_map_value',
          message0: 'sensor value',
          output: 'Number',
        },
      ]);
    }
  });

  it('keeps both helper fragments and the runtime expression for one value block', () => {
    const workspace = new Blockly.Workspace();
    const generator = new ArduinoGenerator('ArduinoSourceMapTest');
    generator.forBlock['test_source_map_parent'] = (block) => {
      const value = generator.valueToCode(block, 'VALUE', Order.NONE) || '0';
      generator.addLoop('source_map_test_body', `consume(${value});`);
      return '';
    };
    generator.forBlock['test_source_map_value'] = () => {
      generator.addLibrary('source_map_test_library', '#include <Sensor.h>');
      return ['sensor.read()', Order.FUNCTION_CALL];
    };
    const parent = workspace.newBlock('test_source_map_parent');
    const value = workspace.newBlock('test_source_map_value');
    parent.getInput('VALUE')!.connection!.connect(value.outputConnection!);

    const code = generator.workspaceToCode(workspace);
    const mapping = generator.blockCodeMap.get(value.id);

    expect(mapping).toBeDefined();
    expect(mapping!.lineRanges.length).toBe(2);
    expect(
      mapping!.lineRanges.map((range) => (
        code.split('\n')[range.startLine - 1].trim()
      )),
    ).toEqual([
      '#include <Sensor.h>',
      'consume(sensor.read());',
    ]);
    expect(
      mapping!.supportLineRanges!.map((range) => (
        code.split('\n')[range.startLine - 1].trim()
      )),
    ).toEqual(['#include <Sensor.h>']);
    expect(
      mapping!.executableLineRanges!.map((range) => (
        code.split('\n')[range.startLine - 1].trim()
      )),
    ).toEqual(['consume(sensor.read());']);
    workspace.dispose();
  });
});

describe('ArduinoGenerator generated headers', () => {
  beforeAll(() => {
    if (!Blockly.Blocks['test_large_project_data']) {
      Blockly.defineBlocksWithJsonArray([{
        type: 'test_large_project_data',
        message0: 'large data',
        previousStatement: null,
        nextStatement: null,
      }]);
    }
  });

  it('moves large global declarations out of sketch.ino', () => {
    const workspace = new Blockly.Workspace();
    const generator = new ArduinoGenerator('ArduinoGeneratedHeaderTest');
    generator.forBlock['test_large_project_data'] = () => {
      generator.addVariable('animation_frames', `const unsigned char frames[] = {${'1,'.repeat(17000)}0};`);
      return '';
    };
    workspace.newBlock('test_large_project_data');

    const code = generator.workspaceToCode(workspace);
    const artifacts = generator.getGeneratedArtifacts();

    expect(artifacts.length).toBe(1);
    expect(artifacts[0].fileName).toMatch(/^variables_animation_frames-[a-f0-9]{8}\.h$/);
    expect(artifacts[0].content).toContain('const unsigned char frames[]');
    expect(code).toContain(`#include "${artifacts[0].fileName}"`);
    expect(code).not.toContain('1,1,1,1,1,1,1,1,1,1');
    const mapping = generator.blockCodeMap.get(workspace.getTopBlocks()[0].id);
    expect(mapping?.codeSnippet).toContain(`#include "${artifacts[0].fileName}"`);
    workspace.dispose();
  });

  it('moves large object declarations out of sketch.ino', () => {
    const workspace = new Blockly.Workspace();
    const generator = new ArduinoGenerator('ArduinoGeneratedObjectHeaderTest');
    generator.forBlock['test_large_project_data'] = () => {
      generator.addObject('rgb_image', `const uint32_t rgbImage[] = {${'0x123456UL,'.repeat(4000)}0};`);
      return '';
    };
    workspace.newBlock('test_large_project_data');

    const code = generator.workspaceToCode(workspace);
    const artifacts = generator.getGeneratedArtifacts();

    expect(artifacts.length).toBe(1);
    expect(artifacts[0].fileName).toMatch(/^objects_rgb_image-[a-f0-9]{8}\.h$/);
    expect(code).toContain(`#include "${artifacts[0].fileName}"`);
    expect(code).not.toContain('0x123456UL,0x123456UL');
    workspace.dispose();
  });
});
