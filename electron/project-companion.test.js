const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { findCompanionApplication, companionLaunch, openCompanionProject, readProjectMode, windowsInstallDirectories } = require('./project-companion');

test('macOS discovers custom installations by bundle ID and rejects a namesake application', async () => {
  const calls = [];
  const result = await findCompanionApplication('coder', {
    platform: 'darwin', home: '/users/test', exists: () => true,
    run: async (command, args) => {
      calls.push([command, args]);
      return { stdout: command.endsWith('mdfind') ? '/Custom/Aily Coder.app\n/Other/Code.app\n'
        : args.at(-1).startsWith('/Other/') ? 'coder.aily.pro\n' : 'someone.else\n' };
    },
  });
  assert.equal(result, '/Other/Code.app');
  assert.equal(calls[0][1][0], "kMDItemCFBundleIdentifier == 'coder.aily.pro'");
});

test('Windows discovers a custom NSIS directory without mistaking another product for Coder', async () => {
  const registry = 'HKEY_LOCAL_MACHINE\\Software\\Uninstall\\other\n    DisplayName    REG_SZ    Not Aily Coder\n    InstallLocation    REG_SZ    C:\\Wrong\n'
    + 'HKEY_LOCAL_MACHINE\\Software\\Uninstall\\coder\n    DisplayName    REG_SZ    Aily Coder 0.9.94\n    DisplayIcon    REG_SZ    "D:\\Tools & Apps\\Aily Coder.exe",0\n';
  assert.deepEqual(windowsInstallDirectories(registry, { names: ['Aily Coder'] }), ['D:\\Tools & Apps']);
  assert.equal(await findCompanionApplication('coder', {
    platform: 'win32', env: {}, run: async () => ({ stdout: registry }),
    exists: (file) => file === 'D:\\Tools & Apps\\Aily Coder.exe',
  }), 'D:\\Tools & Apps\\Aily Coder.exe');
});

test('missing installations return null on every platform', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(await findCompanionApplication('blockly', {
      platform, env: {}, exists: () => false, run: async () => { throw new Error('not found'); },
    }), null);
  }
  await assert.rejects(findCompanionApplication('other'), /Invalid project mode/);
});

test('launch arguments preserve arbitrary project paths without a shell or inherited product identity', () => {
  const project = '/Projects/空 格 & $(touch nope) # project';
  for (const platform of ['darwin', 'win32', 'linux']) {
    const launch = companionLaunch('/Apps/Coder', project, platform, { AILY_BUILD_PRODUCT: 'blockly', NODE_OPTIONS: '--x', PATH: '/usr/bin' }, 'coder');
    assert.ok(launch.args.includes(`--open-project=${project}`));
    assert.ok(launch.args.includes('--route=main/code-editor-pro'));
    assert.deepEqual(JSON.parse(decodeURIComponent(launch.args.find(arg => arg.startsWith('--query=')).slice(8))), { path: project });
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.env.AILY_BUILD_PRODUCT, undefined);
    assert.equal(launch.options.env.NODE_OPTIONS, undefined);
    assert.equal(launch.options.env.PATH, '/usr/bin');
    if (platform === 'darwin') assert.deepEqual(launch.args.slice(0, 4), ['-n', '-a', '/Apps/Coder', '--args']);
  }
});

test('handoff validates actual project metadata, propagates failures, and never launches a mismatched project', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-companion-test-'));
  try {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ type: 'coder', entry: 'src/main.cpp' }));
    assert.equal(readProjectMode(project), 'coder');
    let spawned = false;
    await assert.rejects(openCompanionProject('blockly', project, { spawn: () => { spawned = true; } }), /does not match/);
    assert.equal(spawned, false);
    assert.equal((await openCompanionProject('coder', project, { find: async () => null })).reason, 'not_installed');
    const spawn = (_command, _args, _options) => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    };
    await assert.rejects(openCompanionProject('coder', project, { platform: 'darwin', find: async () => '/Test.app', spawn }), /launch failed/);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
