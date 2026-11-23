import {
  applyCoderProjectPackageConfig,
  copyCoderArduinoTemplate,
  DEFAULT_CODER_ARDUINO_SOURCE,
  findReusableCoderBoardTemplate,
  resolveCoderProjectCreationTemplate,
  resolveCoderTemplatePath,
} from './coder-project-template';

const join = (...parts: string[]) => parts.join('/');
const boardPackage = '/board';
const dedicatedTemplate = '/board/template_arduino';
const sharedManifest = '/board/template/package.json';
const project = '/projects/demo';
const board = { name: '@aily-project/board-ci1306', version: '1.0.18' };

function fixture(input: Record<string, string>) {
  const files = new Map(Object.entries(input));
  const directories = new Set<string>();
  const makeDirectory = (directory: string) => {
    for (let current = directory; current; current = current.slice(0, current.lastIndexOf('/'))) {
      directories.add(current);
      if (!current.includes('/')) break;
    }
  };
  makeDirectory(project);
  for (const name of files.keys()) makeDirectory(name.slice(0, name.lastIndexOf('/')));

  const path = { join, isExists: (name: string) => files.has(name) || directories.has(name) };
  const fs = {
    lstatSync: (name: string) => ({ _isFile: files.has(name), _isDirectory: directories.has(name) }),
    readFileSync: (name: string) => {
      const content = files.get(name);
      if (content === undefined) throw new Error(`Missing fixture file: ${name}`);
      return content;
    },
    mkdirSync: makeDirectory,
    copySync: (source: string, destination: string) => { files.set(destination, fs.readFileSync(source)); },
    copyCoderTemplateDirectory: (source: string, destination: string) => {
      for (const [name, content] of files) {
        if (!name.startsWith(`${source}/`)) continue;
        const relative = name.slice(source.length + 1);
        if (relative === 'package.json' || relative === 'project.aci') continue;
        files.set(join(destination, relative), content);
      }
    },
    writeFileSync: (name: string, content: string) => { files.set(name, content); },
  };
  const selection = resolveCoderProjectCreationTemplate(boardPackage, path);
  return { files, fs, path, selection, create: () => copyCoderArduinoTemplate(selection, project, path, fs) };
}

describe('Coder project template', () => {
  it('prefers the dedicated manifest and copies the full project skeleton without replacing its entry', () => {
    const { selection, create, files } = fixture({
      [sharedManifest]: JSON.stringify({ entry: 'src/main.cpp' }),
      '/board/template_arrduino/package.json': JSON.stringify({ entry: 'src/legacy.cpp' }),
      [join(dedicatedTemplate, 'package.json')]: JSON.stringify({ entry: 'src/main.ino', description: 'custom' }),
      [join(dedicatedTemplate, 'sketch/src/main.ino')]: '#include "helper.h"\nvoid setup(){}\nvoid loop(){}\n',
      [join(dedicatedTemplate, 'sketch/src/helper.h')]: '#pragma once',
      [join(dedicatedTemplate, 'sketch/libraries/Extra/library.properties')]: 'name=Extra',
      [join(dedicatedTemplate, 'assets/greeting.txt')]: 'Hello',
      [join(dedicatedTemplate, 'project.aci')]: 'obsolete entry',
    });

    expect(selection.packagePath).toBe(join(dedicatedTemplate, 'package.json'));
    expect(create()).toBe('src/main.ino');
    expect(JSON.parse(files.get(join(project, 'package.json'))!).description).toBe('custom');
    expect(files.get(join(project, 'sketch/src/main.ino'))).toContain('#include "helper.h"');
    expect(files.get(join(project, 'sketch/src/helper.h'))).toBe('#pragma once');
    expect(files.get(join(project, 'sketch/libraries/Extra/library.properties'))).toBe('name=Extra');
    expect(files.get(join(project, 'assets/greeting.txt'))).toBe('Hello');
    expect(files.has(join(project, 'sketch/src/main.cpp'))).toBeFalse();
    expect(files.has(join(project, 'project.aci'))).toBeFalse();
  });

  it('falls back to the shared manifest while retaining the dedicated template files', () => {
    const { selection, create, files, fs, path } = fixture({
      '/board/package.json': JSON.stringify(board),
      '/board/board.json': '{}',
      [sharedManifest]: JSON.stringify({ entry: 'src/main.ino' }),
      '/board/template/project.abi': '{}',
      [join(dedicatedTemplate, 'sketch/src/main.ino')]: 'template Arduino code',
      [join(dedicatedTemplate, 'README.md')]: 'project instructions',
    });

    expect(selection).toEqual({ packagePath: sharedManifest, sourceDirectory: dedicatedTemplate });
    expect(findReusableCoderBoardTemplate(boardPackage, board, path, fs)).toEqual(selection);
    expect(create()).toBe('src/main.ino');
    expect(files.get(join(project, 'sketch/src/main.ino'))).toBe('template Arduino code');
    expect(files.get(join(project, 'README.md'))).toBe('project instructions');
    expect(files.has(join(project, 'project.abi'))).toBeFalse();
  });

  it('generates the default main.cpp from a shared manifest without an entry', () => {
    const { create, files, path } = fixture({ [sharedManifest]: '{}', '/board/template/project.abi': '{}' });
    expect(create()).toBe('src/main.cpp');
    expect(files.get(join(project, 'sketch/src/main.cpp'))).toBe(DEFAULT_CODER_ARDUINO_SOURCE);
    expect(path.isExists(join(project, 'sketch/libraries'))).toBeTrue();
    expect(files.has(join(project, 'project.abi'))).toBeFalse();
  });

  it('generates a declared INO entry when the shared template only provides a manifest', () => {
    const { create, files } = fixture({ [sharedManifest]: JSON.stringify({ entry: 'src/main.ino' }) });
    const entry = create();
    const manifest = JSON.parse(files.get(join(project, 'package.json'))!);
    applyCoderProjectPackageConfig(manifest, board.name, '^1.0.18', { entry });
    expect(manifest.entry).toBe('src/main.ino');
    expect(files.get(join(project, 'sketch/src/main.ino'))).toBe(DEFAULT_CODER_ARDUINO_SOURCE);
  });

  it('reads legacy project.aci as the source when the template supplies no entry file', () => {
    const legacy = '/board/template_arrduino';
    const { create, files, path } = fixture({
      [join(legacy, 'package.json')]: JSON.stringify({ entry: 'src\\firmware\\demo.ino' }),
      [join(legacy, 'project.aci')]: 'legacy Arduino source',
    });
    expect(resolveCoderTemplatePath(boardPackage, path)).toBe(legacy);
    expect(create()).toBe('src/firmware/demo.ino');
    expect(files.get(join(project, 'sketch/src/firmware/demo.ino'))).toBe('legacy Arduino source');
    expect(files.has(join(project, 'project.aci'))).toBeFalse();
  });

  it('keeps the source path of a native Arduino skeleton at its project root', () => {
    const { create, files } = fixture({
      [join(dedicatedTemplate, 'package.json')]: JSON.stringify({ arduinoSketch: true, entry: 'Demo.ino' }),
      [join(dedicatedTemplate, 'Demo.ino')]: 'native source',
    });
    expect(create()).toBe('Demo.ino');
    expect(files.get(join(project, 'Demo.ino'))).toBe('native source');
    expect(files.has(join(project, 'sketch/Demo.ino'))).toBeFalse();
  });

  for (const entry of ['../main.ino', 'src\\..\\..\\main.ino', '/main.ino', 'C:\\main.ino', 'src/main.txt']) {
    it(`rejects invalid template entry ${entry} before copying any files`, () => {
      const { create, files } = fixture({
        [join(dedicatedTemplate, 'package.json')]: JSON.stringify({ entry }),
        [join(dedicatedTemplate, 'README.md')]: 'project instructions',
      });
      expect(create).toThrowError(/entry 必须是工程源码目录内/);
      expect([...files.keys()].some(name => name.startsWith(`${project}/`))).toBeFalse();
    });
  }
});
