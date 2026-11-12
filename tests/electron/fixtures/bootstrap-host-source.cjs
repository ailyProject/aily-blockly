'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../../..');

function evaluate(source, globals = {}) {
  const module = { exports: {} };
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require,
    console,
    setTimeout,
    clearTimeout,
    setImmediate,
    AbortSignal,
      Error,
    Map,
    Set,
    Symbol,
    ...globals,
  });
  return module.exports;
}
function sourceTree(relative) {
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
}
function sourceClass(relative, name, globals = {}, selected) {
  const tree = sourceTree(relative),
    declaration = tree.statements.find(
      (item) => ts.isClassDeclaration(item) && item.name?.text === name,
    );
  const members = declaration.members.filter(
    (item) =>
      ts.isMethodDeclaration(item) && (!selected || selected.includes(item.name.getText(tree))),
  );
  return evaluate(
    `export class Subject { ${members.map((item) => item.getText(tree)).join('\n')} }`,
    globals,
  ).Subject;
}
function sourceFunctions(names, globals) {
  const tree = sourceTree('electron/main.js');
  return evaluate(
    tree.statements
      .filter((item) => ts.isFunctionDeclaration(item) && names.includes(item.name.text))
      .map((item) => item.getText(tree))
      .join('\n') +
      '\nmodule.exports={' +
      names.join(',') +
      '}',
    globals,
  );
}
function readPureModule(relative, globals) {
  if (!fs.existsSync(path.join(root, relative))) return {};
  return evaluate(fs.readFileSync(path.join(root, relative), 'utf8'), globals);
}
function bridgeFixture(sourceProject = '', generation = 7) {
  const window = {
    path,
    platform: { type: 'darwin', isWindows: false },
    electronAPI: { versions: () => ({ electron: 'fixture' }) },
  };
  const { ProjectLifecycleGate } = readPureModule(
    'src/app/services/domains/project/project-lifecycle-gate.ts',
  );
  const protocolTree = sourceTree('src/app/integrations/blockly/abs/abs-live-protocol.ts');
  const protocol = evaluate(
    protocolTree.statements
      .filter(
        (item) =>
          (ts.isVariableStatement(item) &&
            item.declarationList.declarations.some(
              (value) => value.name.getText(protocolTree) === 'ABS_LIVE_PROTOCOL',
            )) ||
          (ts.isFunctionDeclaration(item) && item.name?.text === 'absProtocolReply'),
      )
      .map((item) => item.getText(protocolTree))
      .join('\n'),
  );
  const globals = {
    window,
    ...protocol,
    ...readPureModule('src/app/services/integrations/automation/project-lifecycle-admission.ts'),
  };
  const Domain = sourceClass(
    'src/app/services/domains/project/project.service.ts',
    'ProjectService',
    { normalizeProjectOpenPath: (value) => value },
    ['withProjectLifecycleAdmission', 'acquireProjectLifecycle', 'projectOpen'],
  );
  const domain = new Domain();
  domain.currentProjectPath = sourceProject;
  domain.projectLifecycle = new ProjectLifecycleGate();
  domain.dependencyLifecycle = { isStopping: () => false };
  domain.application = { hasActiveProjectMutation: () => false };
  domain.getProjectMode = () => 'blockly';
  domain.isCloudBuild = () => false;
  domain.coderProjects = [];
  domain.isSameProjectPath = (left, right) => left === right;
  const Bridge = sourceClass(
    'src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts',
    'BlocklyLiveOperationBridgeService',
    {
      ...globals,
      sameAbsProjectDirectory: async (left, right) => left === right,
      getProjectCreationModeError: () => null,
    },
  );
  const bridge = new Bridge(),
    calls = [];
  bridge.projectService = domain;
  bridge.electronService = {
    currentRendererGeneration: generation,
    applicationVersion: 'fixture-product',
  };
  bridge.configService = new Proxy(
    {
      data: {},
      getApplicationName: () => 'Aily Blockly',
      getDevelopmentModePreference: () => 'blockly',
    },
    {
      get(target, key) {
        return key in target ? target[key] : () => null;
      },
    },
  );
  bridge.themeService = {
    theme: () => 'dark',
    getBlocklyThemeId: () => 'dark',
    getBlocklyRenderer: () => 'thrasos',
  };
  bridge.readAilyToolStatus = async () => ({ installed: false });
  const originalMethods = {};
  for (const method of [
    'executeProjectCreate',
    'executeProjectOpen',
    'executeProjectClose',
    'executeProjectReload',
  ]) {
    originalMethods[method] = bridge[method];
    bridge[method] = async (...args) => {
      calls.push({ method, args });
      return { ok: true };
    };
  }
  return { bridge, domain, calls, window, generation, originalMethods };
}
function mainRouteFixture(sourceProject = '/source') {
  const calls = [],
    globals = {
      fs: { existsSync: () => true },
      path,
      getOpenedProjectPathFromWindow: () => sourceProject,
      requestMainWindow: async (...args) => {
        calls.push(args[2]);
        return { ok: true };
      },
      ...require('../../../electron/live-operation-project-routing'),
    };
  return { ...sourceFunctions(['handleCliBridgeCommand'], globals), calls };
}
function mainRequestFixture(generation = 7) {
  const sent = [],
    ipcMain = new EventEmitter(),
    webContents = {
      mainFrame: {},
      isDestroyed: () => false,
      send(channel, value) {
        sent.push(value);
        setImmediate(() =>
          ipcMain.emit(
            'response',
            { sender: webContents, senderFrame: webContents.mainFrame },
            { requestId: value.requestId, rendererGeneration: value.rendererGeneration, ok: true },
          ),
        );
      },
    };
  const globals = {
    rendererGeneration: generation,
    readyRendererGeneration: generation,
    RENDERER_STARTUP_WAIT_MS: 20,
    mainWindow: { webContents, isDestroyed: () => false },
    ipcMain,
    isCurrentMainRenderer: (value) => value === webContents,
    isCurrentRendererGenerationReady: () => true,
    ...require('../../../electron/live-operation-project-routing'),
  };
  return {
    ...sourceFunctions(['rendererCommandAvailability', 'requestMainWindow'], globals),
    sent,
  };
}
module.exports = { bridgeFixture, mainRouteFixture, mainRequestFixture, readPureModule, sourceClass };
