import {
  DEFAULT_CODER_ARDUINO_SOURCE,
  copyCoderArduinoTemplate,
  resolveCoderProjectCreationTemplate,
  resolveCoderTemplatePath,
} from './coder-project-template';

describe('Coder project template', () => {
  const join = (...parts: string[]) => parts.join('/');

  it('keeps using template_arduino when the board provides it', () => {
    const path = resolveCoderTemplatePath('/board', {
      join,
      isExists: value => value === '/board/template_arduino',
    });

    expect(path).toBe('/board/template_arduino');
  });

  it('retains compatibility with the legacy template_arrduino directory', () => {
    const path = resolveCoderTemplatePath('/board', {
      join,
      isExists: value => value === '/board/template_arrduino',
    });

    expect(path).toBe('/board/template_arrduino');
  });

  it('falls back to the Blockly package manifest only when no Coder template directory exists', () => {
    const result = resolveCoderProjectCreationTemplate('/board', {
      join,
      isExists: () => false,
    });

    expect(result).toEqual({
      templatePath: '/board/template',
      useDefaultSource: true,
    });
  });

  it('writes the basic Arduino main.cpp when the board has no template_arduino', () => {
    const existingPaths = new Set(['/board/template/package.json']);
    const copied: Array<[string, string]> = [];
    const written: Array<[string, string]> = [];
    const createdDirectories: string[] = [];

    copyCoderArduinoTemplate(
      '/board/template',
      '/projects/demo',
      {
        join,
        isExists: value => existingPaths.has(value),
      },
      {
        copySync: (source, destination) => copied.push([source, destination]),
        mkdirSync: path => createdDirectories.push(path),
        writeFileSync: (path, content) => written.push([path, content]),
      },
      { useDefaultSource: true },
    );

    expect(copied).toEqual([
      ['/board/template/package.json', '/projects/demo/package.json'],
    ]);
    expect(createdDirectories).toEqual([
      '/projects/demo/sketch/src',
      '/projects/demo/sketch/libraries',
    ]);
    expect(written).toEqual([
      ['/projects/demo/sketch/src/main.cpp', DEFAULT_CODER_ARDUINO_SOURCE],
    ]);
    expect(DEFAULT_CODER_ARDUINO_SOURCE).toBe(`#include <Arduino.h>

void setup() {
  // put your setup code here, to run once:
}

void loop() {
  // put your main code here, to run repeatedly:
}
`);
  });

  it('keeps copying project.aci unchanged when a Coder template is present', () => {
    const copied: Array<[string, string]> = [];

    copyCoderArduinoTemplate(
      '/board/template_arduino',
      '/projects/demo',
      {
        join,
        isExists: value => [
          '/board/template_arduino/package.json',
          '/board/template_arduino/project.aci',
        ].includes(value),
      },
      {
        copySync: (source, destination) => copied.push([source, destination]),
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
      },
    );

    expect(copied).toEqual([
      ['/board/template_arduino/package.json', '/projects/demo/package.json'],
      ['/board/template_arduino/project.aci', '/projects/demo/sketch/src/main.cpp'],
    ]);
  });

  it('still rejects an incomplete template_arduino directory', () => {
    expect(() => copyCoderArduinoTemplate(
      '/board/template_arduino',
      '/projects/demo',
      {
        join,
        isExists: value => value === '/board/template_arduino/package.json',
      },
      {
        copySync: () => undefined,
        mkdirSync: () => undefined,
        writeFileSync: () => undefined,
      },
    )).toThrowError('Coder 板卡模板缺少 project.aci: /board/template_arduino/project.aci');
  });
});
