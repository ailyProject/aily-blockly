'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { once } = require('node:events');
const { createNpmMutationQueue } = require('../../electron/npm-mutation-queue');
const { npmIpcFixture } = require('./fixtures/npm-ipc-fixture.cjs');
const { npmTarball } = require('./fixtures/npm-tarball-fixture.js');

test('real npm compiler postinstall and board install coexist at one prefix through both IPC paths', { timeout: 60000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aily npm install ')));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const prefix = path.join(root, 'app data'); fs.mkdirSync(prefix);
  fs.writeFileSync(path.join(prefix, 'package.json'), '{"name":"isolated-npm-race","version":"1.0.0","private":true}');
  const ready = path.join(root, 'compiler-started'), gate = path.join(root, 'allow-compiler-finish');
  const compilerTarball = path.join(root, 'compiler.tgz'), boardTarball = path.join(root, 'board.tgz');
  fs.writeFileSync(compilerTarball, npmTarball({
    'package.json': JSON.stringify({ name: 'aily-fixture-compiler', version: '1.0.0', scripts: { postinstall: 'node postinstall.cjs' } }),
    'postinstall.cjs': `const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      const deadline = Date.now() + 20000;
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(gate)})) {
          fs.writeFileSync('compiler-ready.txt', 'complete'); clearInterval(timer);
        } else if (Date.now() > deadline) { clearInterval(timer); process.exitCode = 1; }
      }, 30);`,
  }));
  fs.writeFileSync(boardTarball, npmTarball({
    'package.json': JSON.stringify({ name: 'aily-fixture-board', version: '1.0.0' }),
    'board.json': '{"ready":true}',
  }));
  const userconfig = path.join(root, '.npmrc'); fs.writeFileSync(userconfig, '');
  const options = ['--prefix', prefix, '--cache', path.join(root, 'cache'), '--userconfig', userconfig,
    '--offline', '--no-audit', '--no-fund', '--save-exact', '--foreground-scripts'];
  const fixture = npmIpcFixture({ acquireNpmMutation: createNpmMutationQueue(), native: true });
  const compiler = fixture.runNpm({ cmd: ['npm', 'install', compilerTarball, ...options]
    .map(argument => /\s/.test(argument) ? `"${argument}"` : argument).join(' ') });
  const compilerResult = compiler.then(value => ({ value }), error => ({ error }));
  try {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(fs.existsSync(ready), 'real compiler postinstall started');
    const board = fixture.runCmd({ command: 'npm', args: ['install', boardTarball, ...options], streamId: 'real-board' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(fixture.children.length, 1, 'board npm cannot reify while compiler postinstall runs');
    fs.writeFileSync(gate, 'finish');
    const result = await compilerResult; assert.ifError(result.error);
    assert.equal((await board).success, true);
    assert.equal(fixture.children.length, 2);
    const child = fixture.children[1], errors = [];
    child.stderr.on('data', data => errors.push(String(data)));
    const [code] = await once(child, 'close');
    assert.equal(code, 0, errors.join(''));
    const manifest = JSON.parse(fs.readFileSync(path.join(prefix, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['aily-fixture-board', 'aily-fixture-compiler']);
    assert.equal(fs.readFileSync(path.join(prefix, 'node_modules/aily-fixture-compiler/compiler-ready.txt'), 'utf8'), 'complete');
    assert.equal(JSON.parse(fs.readFileSync(path.join(prefix, 'node_modules/aily-fixture-board/board.json'), 'utf8')).ready, true);
    const lock = JSON.parse(fs.readFileSync(path.join(prefix, 'package-lock.json'), 'utf8'));
    assert.ok(lock.packages['node_modules/aily-fixture-board']);
    assert.ok(lock.packages['node_modules/aily-fixture-compiler']);
  } finally {
    fs.writeFileSync(gate, 'finish');
    await compilerResult;
    await Promise.all(fixture.children.filter(child => child.exitCode === null && child.signalCode === null)
      .map(child => once(child, 'close')));
  }
});
