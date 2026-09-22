import { describeBuildEnvironment, type BuildEnvironmentInput } from './build-environment';

describe('build environment facts', () => {
  const input = (): BuildEnvironmentInput => ({
    project: '/project', appDataPath: '/app', boardModule: '@aily-project/board-demo',
    board: { core: 'esp32:esp32', compilerParam: '-b esp32:esp32:demo --verbose' },
    dependencies: {
      '@aily-project/sdk-esp32': '3.3.1',
      '@aily-project/compiler-xtensa': '14.2.0',
      '@aily-project/tool-idf_esp32s3': '5.5.1',
      '@aily-project/tool-other': '2.0',
    },
    packageJson: { macros: ['TEST=1'] }, coder: false,
  });
  const paths = { join: (...parts: string[]) => parts.join('/'), exists: (_: string) => true };

  it('reports the preprocessor install layout including the IDF artifact alias', () => {
    const result = describeBuildEnvironment(input(), paths);
    expect(result.status).toBe('available');
    expect(result.artifacts.map(item => item.root)).toEqual([
      '/app/sdk/esp32_3.3.1', '/app/compiler/xtensa@14.2.0',
      '/app/tools/esp32-arduino-libs@5.5.1', '/app/tools/other@2.0',
    ]);
    expect(result.target).toBe('esp32:esp32:demo');
    expect(result.searchRoots).not.toContain('/app/compiler/xtensa@14.2.0');
    expect(result.generatedSketch).toEqual({ path: '/project/.temp/sketch/sketch.ino', exists: true, readOnly: true });
    expect(result.macros).toEqual(['TEST=1']);
    expect(result.targetCompileContext.path).toBe('/project/.temp/target-compile.json');
    expect(result.targetCompileContext.readOnly).toBeTrue();
  });

  it('never presents dependency ranges, path escapes or missing SDKs as installed', () => {
    const data = input();
    data.dependencies = { '@aily-project/sdk-test': '^1.2.3', '@aily-project/tool-test': '../../outside' };
    const result = describeBuildEnvironment(data, paths);
    expect(result.status).toBe('unavailable');
    expect(result.artifacts.every(item => item.root === null && !item.installed)).toBeTrue();
    expect(result.searchRoots).toEqual([]);
    expect(describeBuildEnvironment(input(), { ...paths, exists: () => false }).status).toBe('unavailable');
  });

  it('supports non-ESP32 dependencies and does not invent Blockly output in Coder', () => {
    const data = input();
    data.dependencies = { '@aily-project/sdk-avr': '1.8.6' };
    data.coder = true;
    data.board = {};
    data.packageJson = { projectConfig: { macros: ['OTHER'] } };
    const result = describeBuildEnvironment(data, paths);
    expect(result.artifacts[0].root).toBe('/app/sdk/avr_1.8.6');
    expect(result.target).toBeNull();
    expect(result.generatedSketch).toBeNull();
    expect(result.targetCompileContext.path).toBe('/project/sketch/target-compile.json');
    expect(result.macros).toEqual(['OTHER']);
  });
});
