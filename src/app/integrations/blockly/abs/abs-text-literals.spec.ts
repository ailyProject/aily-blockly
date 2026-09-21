import { cppStringLiteral } from '../../../editors/blockly-editor/components/blockly/generators/arduino/cpp-string-literal';
import { adaptArduinoTextLiterals } from '../../../editors/blockly-editor/services/blockly-arduino-text-literals';
import { ArduinoGenerator } from '../../../editors/blockly-editor/components/blockly/generators/arduino/arduino';

describe('C++ text data encoding at the shared runtime boundary', () => {
  it('encodes quotes, slashes, controls and Unicode without changing the input', () => {
    const value = '{"city":"成都","path":"C:\\tmp"}\r\n\t\0' + '17\x1f\x7f';
    const expected = '"{\\"city\\":\\"成都\\",\\"path\\":\\"C:\\\\tmp\\"}\\r\\n\\t\\00017\\037\\177"';
    expect(cppStringLiteral(value)).toBe(expected);
    const generator = new ArduinoGenerator();
    expect(generator.quote_(value)).toBe(expected);
    expect(generator.multiline_quote_(value)).toBe(expected);
    expect(cppStringLiteral("it's fine")).toBe('"it\'s fine"');
  });
  it('repairs only raw literal results, preserving effects, arguments, precedence and idempotence', () => {
    const block = { getFieldValue: () => '{"value":1}' }, context = {};
    const original = jasmine.createSpy().and.callFake(function(this: unknown, value: typeof block, order: number) {
      expect(this).toBe(context); return ['"' + value.getFieldValue() + '"', order];
    });
    const generator = { forBlock: { text: original } };
    adaptArduinoTextLiterals(generator);
    const wrapped = generator.forBlock.text;
    adaptArduinoTextLiterals(generator); expect(generator.forBlock.text).toBe(wrapped);
    expect(wrapped.call(context, block, 9)).toEqual([cppStringLiteral(block.getFieldValue()), 9]);
    expect(original).toHaveBeenCalledTimes(1);
    for (const result of [[cppStringLiteral(block.getFieldValue()), 2], ['String(payload)', 2], 'custom']) {
      generator.forBlock.text = (() => result) as any;
      adaptArduinoTextLiterals(generator);
      expect(generator.forBlock.text(block)).toBe(result);
    }
  });
});
