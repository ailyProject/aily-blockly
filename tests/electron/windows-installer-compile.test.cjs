const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createBuilderConfig, createBuildPlan } = require('../../scripts/build-electron');

const root = path.resolve(__dirname, '../..');
const outputRoot = path.join(root, 'tests/.artifacts/windows-installer-compile');

// Compile the real installer AND uninstaller with the locked electron-builder.
// The tiny MZ payload is intentionally not runnable: this tests NSIS compilation,
// not Windows shortcuts, Shell pinning, application launch or a production build.
for (const product of ['blockly', 'coder']) {
  test(`${product} Windows installer and uninstaller compile with production hooks`, { timeout: 180000 }, async () => {
    await fs.mkdir(outputRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(outputRoot, `${product}-`));
    const productName = `Aily ${product} Shortcut Compile Test`;
    await fs.mkdir(path.join(directory, 'payload/resources'), { recursive: true });
    await fs.writeFile(path.join(directory, 'payload', `${productName}.exe`), 'MZ compilation fixture');
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
      name: `aily-${product}-shortcut-compile-test`, version: '1.0.1',
      description: 'NSIS compilation fixture only', author: 'Aily', main: 'main.js',
    }));
    const plan = createBuildPlan(['--product', product], require('../../electron/config/config.json'));
    const config = createBuilderConfig(plan, require('../../package.json').build);
    Object.assign(config, {
      appId: `pro.aily.shortcut-compile-test.${product}`,
      productName,
      electronVersion: require('electron/package.json').version,
      directories: { buildResources: path.join(root, 'build'), output: path.join(directory, 'out') },
      publish: null,
      win: { target: 'nsis', signAndEditExecutable: false, icon: path.join(root, 'public/icon.ico') },
      nsis: {
        ...config.nsis,
        include: path.join(root, config.nsis.include),
        shortcutName: productName,
        artifactName: 'compile-test.exe',
        runAfterFinish: false,
      },
    });
    await fs.writeFile(path.join(directory, 'builder.json'), JSON.stringify(config));
    let log = '';
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve('electron-builder/cli.js'),
        '--projectDir', directory, '--config', 'builder.json', '--win', '--x64',
        '--prepackaged', 'payload', '--publish', 'never'], {
        cwd: root,
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', data => { log += data; });
      child.stderr.on('data', data => { log += data; });
      const timer = setTimeout(() => child.kill(), 170000);
      child.once('error', reject);
      child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
    await fs.writeFile(path.join(directory, 'compile.log'), log);
    assert.equal(code, 0, `NSIS compilation failed; ${directory}/compile.log\n${log.slice(-3000)}`);
    const installer = await fs.readFile(path.join(directory, 'out/compile-test.exe'));
    assert.equal(installer.subarray(0, 2).toString(), 'MZ');
    assert.ok(installer.length > 100000);
  });
}
