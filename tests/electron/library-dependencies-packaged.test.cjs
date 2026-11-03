const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createPackage } = require('@electron/asar');
const { packageBuildLockRuntime } = require('../../scripts/package-build-lock-runtime.cjs');
const run = promisify(execFile);

test('cold packaged Electron prepares archives and persists libraries through the external child runtime',
  { skip: process.platform !== 'darwin', timeout: 90_000 }, async t => {
    const workspace = path.resolve(__dirname, '../..');
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aily-library-package-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bundle = path.join(root, 'LibraryAutoSave.app');
    await fs.cp(path.join(workspace, 'node_modules/electron/dist/Electron.app'), bundle,
      { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await fs.rename(path.join(bundle, 'Contents/MacOS/Electron'), path.join(bundle, 'Contents/MacOS/LibraryAutoSave'));
    await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleExecutable LibraryAutoSave', path.join(bundle, 'Contents/Info.plist')]);
    const resources = path.join(bundle, 'Contents/Resources');
    const source = path.join(root, 'source');
    await fs.mkdir(path.join(source, 'electron'), { recursive: true });
    for (const name of ['library-dependencies.js', 'library-history.js', 'library-history-io.js', 'library-dependency-sessions.js', 'library-dependency-worker.js',
      'library-dependency-conflicts.js', 'library-local-changes.js', 'project-file-access.js', 'project-companion.js', 'child-script-path.js']) {
      await fs.copyFile(path.join(workspace, 'electron', name), path.join(source, 'electron', name));
    }
    const child = path.join(resources, 'child');
    await fs.cp(path.join(workspace, 'child/node'), path.join(child, 'node'), { recursive: true, mode: constants.COPYFILE_FICLONE });
    await fs.copyFile(path.join(workspace, 'child/7zz'), path.join(child, '7zz'));
    await fs.cp(path.join(workspace, 'child/scripts'), path.join(child, 'scripts'), {
      recursive: true, filter: file => !/\.test\.[cm]?js$/.test(file),
    });
    await packageBuildLockRuntime({ destination: child, platform: process.platform, arch: process.arch });
    const project = path.join(root, 'project'), library = '@aily-project/lib-packaged-fixture';
    const input = path.join(root, 'input');
    await fs.mkdir(input); await fs.writeFile(path.join(input, 'Packaged.h'), '// packaged source\n');
    await fs.mkdir(path.join(project, 'local-library'), { recursive: true });
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'packaged-project', version: '1.0.0' }));
    await fs.writeFile(path.join(project, 'local-library/package.json'), JSON.stringify({ name: library, version: '1.0.0' }));
    await run(path.join(child, '7zz'), ['a', '-t7z', path.join(project, 'local-library/src.7z'), '.'], { cwd: input });
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'library-package-probe', version: '1.0.0', main: 'probe.cjs' }));
    await fs.writeFile(path.join(source, 'probe.cjs'), `
      const { app } = require('electron');
      const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
      app.whenReady().then(async () => {
        assert.equal(app.isPackaged, true);
        assert.equal(process.env.AILY_CHILD_PATH, undefined);
        assert.equal(process.env.NODE_PATH, undefined);
        assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
        const project = process.env.AILY_LIBRARY_PACKAGE_TEST_PROJECT;
        const { LibraryDependencies } = require('./electron/library-dependencies');
        const { LibraryDependencySessions } = require('./electron/library-dependency-sessions');
        const libraries = new LibraryDependencies(), sessions = new LibraryDependencySessions(libraries);
        const read = file => JSON.parse(fs.readFileSync(path.join(project, file), 'utf8'));
        const name = '@aily-project/lib-packaged-fixture';
        const { token } = await sessions.run('historyBegin', project, { packages: [name] });
        await sessions.run('mutate', project, { action: 'install', packages: [name + '@file:local-library'], options: { installLinks: false } });
        assert.equal(libraries.status(project).dirty, false);
        assert.ok(read('package.json').dependencies[name]);
        assert.deepEqual(read('package-lock.json').packages[''].dependencies, read('package.json').dependencies);
        assert.equal(fs.readFileSync(path.join(project, 'node_modules', name, 'src/Packaged.h'), 'utf8'), '// packaged source\\n');
        assert.equal((await sessions.run('historyCommit', project, { token })).changed, true);
        await sessions.run('historyRestore', project, { token, forward: false });
        assert.equal(read('package.json').dependencies?.[name], undefined);
        await sessions.run('historyRestore', project, { token, forward: true });
        assert.equal(fs.readFileSync(path.join(project, 'node_modules', name, 'src/Packaged.h'), 'utf8'), '// packaged source\\n');
        await sessions.run('historyDiscard', project, { token });
        await sessions.run('mutate', project, { action: 'remove', packages: [name] });
        assert.equal(read('package.json').dependencies?.[name], undefined);
        assert.equal(fs.existsSync(path.join(project, 'node_modules', name)), false);
        fs.writeFileSync(process.env.AILY_LIBRARY_PACKAGE_TEST_RESULT, JSON.stringify({ packaged: app.isPackaged, passed: true }));
        app.exit(0);
      }).catch(error => { console.error(error.stack); app.exit(1); });
    `);
    await createPackage(source, path.join(resources, 'app.asar'));
    const env = { ...process.env, AILY_LIBRARY_PACKAGE_TEST_PROJECT: project, AILY_LIBRARY_PACKAGE_TEST_RESULT: path.join(root, 'result.json') };
    for (const name of ['AILY_CHILD_PATH', 'AILY_7ZA_PATH', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[name];
    await run(path.join(bundle, 'Contents/MacOS/LibraryAutoSave'), [`--user-data-dir=${path.join(root, 'profile')}`, '--disable-gpu'],
      { env, cwd: root, timeout: 60_000 });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8')), { packaged: true, passed: true });
  });
