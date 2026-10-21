import { expect, test } from '@playwright/test';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { markToolRefreshedForAppVersion, shouldRefreshToolForAppVersion } = require('../../electron/tools/aily-tools-install-state');
const { createManagedToolLifecycle } = require('../../electron/tools/managed-npm-cli');

test.describe('aily tools startup install policy', () => {
  let fixtureRoot: string;
  let configPath: string;

  test.beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-tools-policy-'));
    configPath = path.join(fixtureRoot, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ installed: '1.1.0', untouched: true }));
  });

  test.afterEach(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  function createTool(toolKey = 'aily-builder', ready = false) {
    let installed = ready;
    let attempts = 0;
    let probes = 0;
    let failures = 0;
    let gate = Promise.resolve();
    const tool = createManagedToolLifecycle({
      toolKey, packageName: `@aily-project/${toolKey}`, requireChildPath: false,
      getPrefix: () => fixtureRoot,
      probe: () => {
        probes++;
        return { ok: installed, version: installed ? '1.0.0' : null, error: installed ? '' : 'missing CLI' };
      },
    }, {
      installPackage: async () => {
        attempts++;
        await gate;
        if (failures-- > 0) throw new Error('offline');
        installed = true;
      },
    });
    const policy = { configPath, appVersion: '1.1.0', refreshEnabled: true };
    tool.configure('', policy);
    return { tool, policy, attempts: () => attempts, probes: () => probes, failNext: () => failures++,
      removeCli: () => installed = false, setGate: (next: Promise<void>) => gate = next };
  }

  test('tracks successful refreshes per tool and app version', () => {
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0')).toBe(true);
    markToolRefreshedForAppVersion(configPath, 'aily-builder', '1.1.0');
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0')).toBe(false);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-linter', '1.1.0')).toBe(true);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.2.0')).toBe(true);
    markToolRefreshedForAppVersion(configPath, 'aily-linter', '1.1.0');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      installed: '1.1.0', untouched: true, toolVersions: { 'aily-builder': '1.1.0', 'aily-linter': '1.1.0' },
    });
  });

  test('E2E can suppress automatic version refresh without marking tools complete', () => {
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0', { refreshEnabled: false })).toBe(false);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0', { refreshEnabled: true })).toBe(true);
  });

  test('a damaged config does not break installed tools or get overwritten', async () => {
    const fixture = createTool('aily-builder', true);
    fs.writeFileSync(configPath, '{ damaged config');
    expect((await fixture.tool.ensureReady()).ok).toBe(true);
    expect(fixture.attempts()).toBe(0);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ damaged config');
    expect(() => markToolRefreshedForAppVersion(configPath, 'aily-builder', '1.1.0')).toThrow();
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{ damaged config');
  });

  test('configuration and status probing do not install or consume refresh markers', () => {
    const fixture = createTool('aily-builder', true);
    expect(fixture.tool.getStatus().installed).toBe(true);
    expect(fixture.tool.getStatus().installed).toBe(true);
    expect(fixture.probes()).toBe(1);
    expect(fixture.attempts()).toBe(0);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0')).toBe(true);
  });

  test('deduplicates simultaneous readiness requests and reuses a successful refresh', async () => {
    const fixture = createTool();
    const results = await Promise.all(Array.from({ length: 8 }, () => fixture.tool.ensureReady()));
    expect(results.every(result => result.ok)).toBe(true);
    expect(fixture.attempts()).toBe(1);
    await fixture.tool.ensureReady();
    expect(fixture.attempts()).toBe(1);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0')).toBe(false);
  });

  test('retries a failed installation on the next request only', async () => {
    const fixture = createTool();
    fixture.failNext();
    expect((await fixture.tool.ensureReady()).ok).toBe(false);
    expect(fixture.attempts()).toBe(1);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0')).toBe(true);
    expect((await fixture.tool.ensureReady()).ok).toBe(true);
    expect(fixture.attempts()).toBe(2);
  });

  test('readiness can repair a failed legacy startup without restarting the app', async () => {
    const fixture = createTool();
    fixture.failNext();
    expect((await fixture.tool.initialize('', null, { installLatest: true })).ok).toBe(false);
    expect((await fixture.tool.ensureReady()).ok).toBe(true);
    expect(fixture.attempts()).toBe(2);
  });

  test('retains a usable installed version after a failed version refresh', async () => {
    const fixture = createTool('aily-builder', true);
    fixture.failNext();
    const result = await fixture.tool.ensureReady();
    expect(result.ok).toBe(true);
    expect(result.startupInstallSucceeded).toBe(false);
    expect(fixture.attempts()).toBe(1);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0')).toBe(true);
  });

  test('repairs a missing CLI even when its app-version marker is already current', async () => {
    const fixture = createTool('aily-builder', true);
    await fixture.tool.ensureReady();
    fixture.removeCli();
    expect((await fixture.tool.ensureReady()).ok).toBe(true);
    expect(fixture.attempts()).toBe(2);
  });

  test('can disable E2E installation for missing tools', async () => {
    const fixture = createTool();
    fixture.tool.configure('', { ...fixture.policy, refreshEnabled: false, installIfMissing: false });
    expect((await fixture.tool.ensureReady()).ok).toBe(false);
    expect(fixture.attempts()).toBe(0);
  });

  test('manual installations also mark the actual successful tool refresh', async () => {
    const fixture = createTool();
    expect((await fixture.tool.performInstallMutation({ force: true })).readyResult.ok).toBe(true);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.1.0')).toBe(false);
    await fixture.tool.ensureReady();
    expect(fixture.attempts()).toBe(1);
  });

  test('an old in-flight install cannot mark a newly configured app version complete', async () => {
    const fixture = createTool();
    let releasePrevious!: () => void;
    let releaseNext!: () => void;
    fixture.setGate(new Promise<void>(resolve => releasePrevious = resolve));
    const previous = fixture.tool.ensureReady();
    await expect.poll(fixture.attempts).toBe(1);
    fixture.tool.configure('', { ...fixture.policy, appVersion: '1.2.0' });
    fixture.setGate(new Promise<void>(resolve => releaseNext = resolve));
    const next = fixture.tool.ensureReady();
    releasePrevious();
    await previous;
    await expect.poll(fixture.attempts).toBe(2);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.2.0')).toBe(true);
    releaseNext();
    expect((await next).ok).toBe(true);
    expect(fixture.attempts()).toBe(2);
    expect(shouldRefreshToolForAppVersion(configPath, 'aily-builder', '1.2.0')).toBe(false);
  });

  test('version A to B to A cannot make a readiness flight wait on itself', async () => {
    test.setTimeout(5_000);
    const fixture = createTool();
    const previous = fixture.tool.ensureReady();
    fixture.tool.configure('', { ...fixture.policy, appVersion: '1.2.0' });
    fixture.tool.configure('', fixture.policy);
    const current = fixture.tool.ensureReady();
    expect((await Promise.all([previous, current])).every(result => result.ok)).toBe(true);
    expect(fixture.attempts()).toBe(1);
  });

  test('runtime directory A to B to A also receives a fresh readiness generation', async () => {
    test.setTimeout(5_000);
    const fixture = createTool();
    fixture.tool.configure('child-a', fixture.policy);
    const previous = fixture.tool.ensureReady();
    fixture.tool.configure('child-b', fixture.policy);
    fixture.tool.configure('child-a', fixture.policy);
    expect((await Promise.all([previous, fixture.tool.ensureReady()])).every(result => result.ok)).toBe(true);
    expect(fixture.attempts()).toBe(1);
  });

  test('different tools still serialize installations on the same npm prefix', async () => {
    let active = 0;
    let peak = 0;
    const tools = ['aily-builder', 'aily-linter'].map(toolKey => {
      let installed = false;
      const tool = createManagedToolLifecycle({
        toolKey, packageName: `@aily-project/${toolKey}`, requireChildPath: false,
        getPrefix: () => fixtureRoot, probe: () => ({ ok: installed }),
      }, {
        installPackage: async () => {
          peak = Math.max(peak, ++active);
          await new Promise(resolve => setTimeout(resolve, 10));
          installed = true;
          active--;
        },
      });
      tool.configure('', { configPath, appVersion: '1.1.0' });
      return tool;
    });
    expect((await Promise.all(tools.map(tool => tool.ensureReady()))).every(result => result.ok)).toBe(true);
    expect(peak).toBe(1);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).toolVersions).toEqual({
      'aily-builder': '1.1.0', 'aily-linter': '1.1.0',
    });
  });

  test('Unix probing uses lib/node_modules and repairs a missing CLI entry', async () => {
    const sourcePath = require.resolve('../../electron/tools/managed-npm-cli');
    const sourceRequire = require('node:module').createRequire(sourcePath);
    const sandbox = { module: { exports: {} as any }, console, process,
      require: (id: string) => id === '../platform' ? { isWin32: false }
        : id === 'node:child_process' ? { spawnSync: () => ({ status: 0, stdout: '1.0.0' }) }
        : sourceRequire(id) };
    require('node:vm').runInNewContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, { filename: sourcePath });
    const { probeManagedCommand, createManagedToolLifecycle: createUnixLifecycle } = sandbox.module.exports;
    const packageRoot = path.join(fixtureRoot, 'lib', 'node_modules', '@aily-project', 'aily-builder');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, 'bin'));
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@aily-project/aily-builder', version: '1.0.0', bin: { 'aily-builder': 'cli.js' } }));
    fs.writeFileSync(path.join(packageRoot, 'cli.js'), '// CLI');
    fs.writeFileSync(path.join(fixtureRoot, 'bin', 'aily-builder'), '#!/bin/sh');
    let attempts = 0;
    const tool = createUnixLifecycle({
      toolKey: 'aily-builder', packageName: '@aily-project/aily-builder', requireChildPath: false,
      getPrefix: () => fixtureRoot,
      probe: ({ prefix }: { prefix: string }) => probeManagedCommand({ prefix, packageName: '@aily-project/aily-builder', binKey: 'aily-builder' }),
    }, { installPackage: async () => { attempts++; fs.writeFileSync(path.join(packageRoot, 'cli.js'), '// CLI repaired'); } });
    tool.configure('', { configPath, appVersion: '1.1.0', refreshEnabled: false });
    expect((await tool.ensureReady()).ok).toBe(true);
    expect(attempts).toBe(0);
    fs.unlinkSync(path.join(packageRoot, 'cli.js'));
    expect((await tool.ensureReady()).ok).toBe(true);
    expect(attempts).toBe(1);
  });
});
