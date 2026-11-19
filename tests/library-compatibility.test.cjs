const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const servicePath = 'src/app/editors/blockly-editor/components/lib-manager/lib-manager.service';
const componentPath = 'src/app/editors/blockly-editor/components/lib-manager/lib-manager.component.ts';
const compiled = buildSync({
  stdin: {
    contents: `import '@angular/compiler'; export { signal } from '@angular/core'; export { LibManagerService } from './${servicePath}';`,
    resolveDir: root, loader: 'ts',
  },
  absWorkingDir: root, tsconfig: path.join(root, 'tsconfig.json'),
  nodePaths: require.resolve.paths('esbuild'),
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
}).outputFiles[0].text;
const serviceModule = { exports: {} };
new Function('require', 'module', 'exports', compiled)(require, serviceModule, serviceModule.exports);
const { LibManagerService, signal } = serviceModule.exports;

// Keep the actual component methods, isolating Angular rendering and unrelated
// injected services. Search, installed-package merging and install checks call
// the production LibManagerService above, including its real search index.
const componentJs = ts.transpileModule(fs.readFileSync(path.join(root, componentPath), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
}).outputText;
const componentModule = { exports: {} };
const decorator = () => () => {};
new Function('require', 'module', 'exports', componentJs)(name => {
  if (name === '@angular/core') return { Component: decorator, Input: decorator, Output: decorator };
  return {};
}, componentModule, componentModule.exports);
const { LibManagerComponent } = componentModule.exports;

const s31 = { core: 'esp32:esp32', type: 'esp32:esp32:esp32s31' };
const library = (overrides = {}) => ({
  name: '@aily-project/lib-esp32-ws2812', nickname: 'WS2812 strip',
  description: 'ESP32 RMT WS2812 strip', keywords: ['ws2812', 'esp32'],
  version: '2.0.0', spec: true, compatibility: { core: ['esp32:esp32'] },
  tested: false, state: 'default', ...overrides,
});

test('ESP32 family declaration remains visible on IBOX S31', () => {
  const service = new LibManagerService();
  const strip = library();
  assert.deepEqual(service.filterByBoardType([strip], s31.type), [strip]);
});

test('legacy core matching respects colon boundaries and complete board declarations', () => {
  const service = new LibManagerService();
  const cases = [
    ['esp32:esp32', s31.type, true],
    ['esp32:esp32', 'esp32:esp32x:board', false],
    ['esp32:esp32:esp32', 'esp32:esp32:esp32', true],
    ['esp32:esp32:esp32', 'esp32:esp32:esp32c3', false],
    ['esp32:esp32:esp32', s31.type, false],
    ['esp32:esp32', 'other:esp32:esp32s31', false],
    [' Seeeduino:samd ', ' Seeeduino:samd:seeed_wio_terminal ', true],
    ['aily:esp32:esp32', s31.type, true],
    ['esp32:esp32', 'aily:esp32:esp32:esp32s31', true],
  ];
  for (const [declaration, target, expected] of cases) {
    assert.equal(service.filterByBoardType([library({ compatibility: { core: [declaration] } })], target).length > 0,
      expected, `${declaration} -> ${target}`);
  }
});

test('explicit compatibility.type is exact and takes precedence over legacy core', () => {
  const service = new LibManagerService();
  for (const [type, expected] of [[['linux:unihiker'], true], [['linux'], false], [[], false], [['linux:other'], false]]) {
    const item = library({ compatibility: { type, core: ['linux'] } });
    assert.equal(service.filterByBoardType([item], 'linux:unihiker').length > 0, expected);
  }
});

test('ordinary libraries remain searchable and invalid dedicated metadata does not throw', () => {
  const service = new LibManagerService();
  const ordinary = library({ spec: false, compatibility: { core: ['arduino:avr'] } });
  assert.deepEqual(service.filterByBoardType([ordinary], s31.type), [ordinary]);
  assert.deepEqual(service.filterByBoardType([ordinary], undefined), [ordinary]);
  for (const compatibility of [undefined, {}, { core: [] }, { core: ['', null, 1] }, { type: ['', null, 1] }]) {
    assert.deepEqual(service.filterByBoardType([library({ compatibility })], s31.type), []);
  }
  for (const target of ['', ' ', null, undefined]) assert.deepEqual(service.filterByBoardType([library()], target), []);
  assert.deepEqual(service.filterByBoardType(null, s31.type), []);
});

function componentFixture(board = s31, answer = 'cancel') {
  const component = Object.create(LibManagerComponent.prototype);
  const service = new LibManagerService();
  const operations = [], prompts = [];
  Object.assign(component, {
    libManagerService: service, projectService: { currentBoardConfig: board, currentPackageData: {}, currentProjectPath: '/project' },
    libraries: signal([]), resetListScroll() {},
    isLibraryOperationPending: () => false,
    enqueueLibraryOperation: (type, item) => operations.push({ type, item }),
    modal: { create: options => {
      prompts.push(options.nzData);
      return { afterClose: { subscribe: callback => callback({ result: answer }) } };
    } },
  });
  return { component, service, operations, prompts };
}

test('actual search chain finds a family-scoped library before and after installed-package merging', async () => {
  const item = library();
  const { component } = componentFixture();
  let installed = [];
  Object.assign(component, {
    configService: { getLibraryListForProject: () => [item] },
    npmService: { getAllInstalledLibraries: async () => installed },
    applyLibraryOperationStates: items => items,
    translate: { currentLang: 'zh_cn' }, cd: { detectChanges() {} },
    isDestroyed: false, searchRequestToken: 0, keyword: 'WS2812',
  });
  component._libraryList = component.getAvailableLibraryList();
  assert.equal(component._libraryList.length, 1);
  await component.doSearch('WS2812');
  assert.equal(component.libraryList.length, 1);
  assert.equal(component.libraryList[0].state, 'default');
  installed = [library({ state: 'installed' })];
  await component.doSearch('WS2812');
  assert.equal(component.libraryList.length, 1);
  assert.equal(component.libraryList[0].name, item.name);
  assert.equal(component.libraryList[0].spec, true);
  assert.equal(component.libraryList[0].state, 'installed');
});

test('installation accepts the same family declaration without a compatibility prompt', async () => {
  const { component, operations, prompts } = componentFixture();
  await component.installLib(library());
  assert.equal(prompts.length, 0);
  assert.equal(operations.length, 1);
});

test('installation prompts for a different board in the same family and honors cancellation', async () => {
  const { component, operations, prompts } = componentFixture();
  await component.installLib(library({ compatibility: { core: ['esp32:esp32:esp32'] } }));
  assert.equal(prompts.length, 1);
  assert.equal(operations.length, 0);
  assert.equal(prompts[0].boardCore, s31.type);
});

test('ordinary libraries stay visible while incompatible installation requires an explicit continue', async () => {
  const item = library({ spec: false, compatibility: { core: ['arduino:avr'] } });
  const { component, service, operations, prompts } = componentFixture(s31, 'continue');
  assert.deepEqual(service.filterByBoardType([item], s31.type), [item]);
  await component.installLib(item);
  assert.equal(prompts.length, 1);
  assert.equal(operations.length, 1);
});

test('installation keeps exact Linux types and unconstrained-package behavior', async () => {
  const linux = componentFixture({ core: 'linux', type: 'linux:unihiker' });
  await linux.component.installLib(library({ compatibility: { type: ['linux:unihiker'], core: ['other'] } }));
  assert.equal(linux.operations.length, 1);
  assert.equal(linux.prompts.length, 0);
  await linux.component.installLib(library({ compatibility: { type: ['linux'], core: ['linux'] } }));
  assert.equal(linux.prompts.length, 1);
  const unknown = componentFixture({});
  for (const compatibility of [undefined, {}, { core: [] }, { type: [], core: ['other'] }]) {
    await unknown.component.installLib(library({ compatibility }));
  }
  assert.equal(unknown.operations.length, 4);
  assert.equal(unknown.prompts.length, 0);
  const legacy = componentFixture({ core: 'aily:esp32:esp32' });
  await legacy.component.installLib(library());
  assert.equal(legacy.operations.length, 1);
  assert.equal(legacy.prompts.length, 0);
});
