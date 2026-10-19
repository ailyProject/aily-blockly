const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { parse } = require('acorn');
const { isProductProtocolUrl } = require('./build-product');
const projectImport = require('./project-url-import');

// Execute the real lifecycle handlers without starting Electron or its services.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
function registration(object, event) {
  const node = ast.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
    && node.expression.callee.type === 'MemberExpression' && node.expression.callee.object.name === object
    && node.expression.callee.property.name === 'on' && node.expression.arguments[0]?.value === event);
  assert.ok(node, `${object} ${event} handler is required`);
  return node;
}
function code(node) { return source.slice(node.start, node.end); }
const readyHandler = registration('app', 'ready').expression.arguments[1];
const projectReadyRegistration = registration('ipcMain', 'project-open-ready');
const logValueFunction = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'protocolLogValue');
assert.ok(logValueFunction, 'protocolLogValue is required');
const protocolLogValue = vm.runInNewContext('(' + code(logValueFunction) + ')');
const packageUrl = 'https://downloads.example/project.7z';
const products = [['blockly', 'abis'], ['coder', 'acis']];
const noop = () => {};
const quiet = { log: noop, error: noop, warn: noop };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function runReady(product, locked, url) {
  const calls = { quit: 0, env: 0, window: 0, handled: [] };
  const context = {
    process: { argv: ['product.exe', url], env: { AILY_BUILD_PRODUCT: product } },
    app: { quit: () => calls.quit++ }, gotTheLock: locked,
    isSupportedProtocolUrl: value => isProductProtocolUrl(product, value), getBuildProduct: () => product,
    require: name => { assert.equal(name, './project-url-import'); return projectImport; },
    console: quiet, URL, protocolLogValue, isDarwin: false, isWin32: false, Menu: {},
    ensureRosettaIfNeededOnDarwin: noop, loadEnv: () => calls.env++, applyAppIdentity: noop,
    setImmediate: callback => callback(), refreshApplicationMenu: noop,
    setTimeout: callback => callback(), handleProtocol: value => calls.handled.push(value),
    ensurePackagedRendererServerStarted: async () => {}, createWindow: () => calls.window++,
    registerPowerMonitorLifecycle: noop, startCliBridgeIfPossible: noop,
  };
  await vm.runInNewContext('(' + code(readyHandler) + ')', context)();
  return calls;
}

function runProtocol(product, importUrl) {
  const calls = { imports: [], sent: [], focused: 0, errors: [] };
  const webContents = { send: (...args) => calls.sent.push(args) };
  let ready;
  const context = {
    console: quiet, URL, URLSearchParams, path, os,
    process: { env: { AILY_7ZA_PATH: path.join(__dirname, '7za.exe') } },
    app: { getPath: name => { assert.equal(name, 'documents'); return path.join(os.tmpdir(), 'documents'); }, isReady: () => true },
    mainWindow: { webContents, isMinimized: () => false, focus: () => calls.focused++ },
    ipcMain: { on: (event, callback) => { assert.equal(event, 'project-open-ready'); ready = callback; } },
    dialog: { showMessageBox: async value => calls.errors.push(value) },
    isSupportedProtocolUrl: value => isProductProtocolUrl(product, value), getBuildProduct: () => product,
    require: name => {
      assert.equal(name, './project-url-import');
      return { ...projectImport, importProjectUrl: async options => {
        calls.imports.push(options);
        return importUrl(options);
      } };
    },
  };
  const names = new Set(['pendingFileToOpen', 'projectOpenRendererReady', 'pendingProjectImports', 'projectImportRunning', 'pendingRoute', 'pendingQueryParams']);
  const declarations = ast.body.filter(node => node.type === 'VariableDeclaration'
    && node.declarations.some(declaration => names.has(declaration.id.name)));
  const functions = ['protocolLogValue', 'handleProtocol', 'processPendingProjectImports', 'updateMainWindowWithPendingData'].map(name => {
    const node = ast.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
    assert.ok(node, `${name} is required`);
    return node;
  });
  const handlers = vm.runInNewContext([
    ...declarations.map(code), ...functions.map(code), code(projectReadyRegistration),
    '({ handleProtocol, processPendingProjectImports })',
  ].join('\n'), context);
  return { ...handlers, calls, webContents, ready: sender => ready({ sender }) };
}

test('a project forwarding process exits before environment, renderer and import side effects', async () => {
  for (const [product, protocol] of products) {
    const calls = await runReady(product, false, `${protocol}://project/import?url=${encodeURIComponent(packageUrl)}`);
    assert.deepEqual(calls, { quit: 1, env: 0, window: 0, handled: [] });
  }
});

test('the first project process opens normally and examples retain their own-window behavior', async () => {
  for (const [product, protocol] of products) {
    const projectUrl = `${protocol}://project/import?url=${encodeURIComponent(packageUrl)}`;
    assert.deepEqual(await runReady(product, true, projectUrl), { quit: 0, env: 1, window: 1, handled: [projectUrl] });
    const example = `${protocol}://examples`;
    assert.deepEqual(await runReady(product, false, example), { quit: 0, env: 1, window: 1, handled: [example] });
  }
});

test('project import logs hide signed download URLs while examples retain their original value', () => {
  const signedUrl = 'https://cdn.example.com/project.7z?signature=private-download-token';
  for (const protocol of ['abis', 'acis', 'ailyblockly', 'ailycoder']) {
    assert.equal(protocolLogValue(`${protocol}://project/import?url=${encodeURIComponent(signedUrl)}`), '[project import]');
    const example = `${protocol}://examples`;
    assert.equal(protocolLogValue(example), example);
  }
});

test('cold project links wait for the project renderer and import a queued URL once', async () => {
  for (const [product, protocol] of products) {
    const directory = path.join(os.tmpdir(), `import-${product}`);
    let finishImport;
    const instance = runProtocol(product, () => new Promise(resolve => { finishImport = resolve; }));
    const url = `${protocol}://project/import?url=${encodeURIComponent(packageUrl)}`;
    instance.handleProtocol(url);
    instance.handleProtocol(url);
    await instance.processPendingProjectImports();
    assert.equal(instance.calls.imports.length, 0);
    instance.ready({});
    await tick();
    assert.equal(instance.calls.imports.length, 0, 'an unrelated renderer cannot release pending imports');
    instance.ready(instance.webContents);
    instance.ready(instance.webContents);
    assert.equal(instance.calls.imports.length, 1);
    instance.handleProtocol(url); // Repeated links during the same download share its queued import.
    finishImport(directory);
    await tick();
    instance.ready(instance.webContents);
    await instance.processPendingProjectImports();
    assert.equal(instance.calls.imports.length, 1);
    assert.deepEqual(instance.calls.sent, [['open-project-from-file', directory]]);
    assert.deepEqual(instance.calls.errors, []);
  }
});

test('a hot project link passes its URL to the downloader and opens the returned directory', async () => {
  for (const [product, protocol] of products) {
    const directory = path.join(os.tmpdir(), `import-hot-${product}`);
    const instance = runProtocol(product, async () => directory);
    instance.ready(instance.webContents);
    instance.handleProtocol(`${protocol}://project/import?url=${encodeURIComponent(packageUrl)}`);
    await tick();
    assert.equal(instance.calls.imports.length, 1);
    const options = instance.calls.imports[0];
    assert.equal(options.url, packageUrl);
    assert.equal(options.product, product);
    assert.deepEqual(Object.keys(options).sort(), ['product', 'projectRoot', 'sevenZipPath', 'url']);
    assert.equal(options.projectRoot, path.join(os.tmpdir(), 'documents', 'aily-project'));
    assert.equal(options.sevenZipPath, path.join(__dirname, '7za.exe'));
    assert.deepEqual(instance.calls.sent, [['open-project-from-file', directory]]);
    assert.equal(instance.calls.focused, 1);
    assert.deepEqual(instance.calls.errors, []);
  }
});
