#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const blocklyRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const simulatorRoot = path.resolve(
  process.env.AILY_SIMULATOR_ROOT
    || path.join(blocklyRoot, '..', 'aily-simulator'),
);
const runtimeDataRoot = path.join(os.tmpdir(), 'aily-simulator');
const providerNames = [
  'project',
  'build',
  'editor',
  'agent',
  'entitlement',
];

await main();

async function main() {
  requireFile(path.join(simulatorRoot, 'package.json'));
  requireFile(path.join(
    blocklyRoot,
    'node_modules',
    '@aily-project',
    'simulator-host-sdk',
    'package.json',
  ));

  const testRoot = await mkdtemp(path.join(
    os.tmpdir(),
    'aily-blockly-simulator-generic-host-',
  ));
  const installRoot = path.join(testRoot, 'npm-global', 'app');
  const packageRoot = path.join(
    installRoot,
    'node_modules',
    '@aily-project',
    'aily-simulator',
  );
  const entitlementConfigPath = path.join(
    testRoot,
    'entitlement-trust.json',
  );
  const dispatcherBundlePath = path.join(testRoot, 'provider-dispatcher.cjs');
  const ownedProcesses = new Set();

  try {
    phase('build:start');
    await runNpm(['run', 'gateway:build'], simulatorRoot);
    phase('package:start');
    await mkdir(path.dirname(packageRoot), { recursive: true });
    await writeFile(
      entitlementConfigPath,
      `${JSON.stringify(createEntitlementConfig(), null, 2)}\n`,
      'utf8',
    );
    await run(process.execPath, [
      path.join(simulatorRoot, 'scripts', 'package-aily-simulator-runtime.mjs'),
      '--output', packageRoot,
      '--entitlement-config', entitlementConfigPath,
    ], simulatorRoot);
    phase('package:ready');

    const manifest = JSON.parse(await readFile(
      path.join(packageRoot, 'package.json'),
      'utf8',
    ));
    assert.equal(manifest.name, '@aily-project/aily-simulator');
    assert.equal(manifest.main, 'index.js');

    const config = await readInstalledSimulatorConfig({
      installRoot,
      version: manifest.version,
    });
    assert.equal(config.id, 'simulator');
    assert.equal(config.packagePath, packageRoot);
    assert.deepEqual(config.runtime?.processMessagePort, {
      transport: 'node-ipc-v1',
      maxMessageBytes: 4210688,
    });
    assert.equal(config.ui?.surfaces?.full?.entry, 'ui/index.html');

    await esbuild.build({
      entryPoints: [path.join(
        blocklyRoot,
        'src',
        'app',
        'services',
        'subapp-host-provider-dispatcher.ts',
      )],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile: dispatcherBundlePath,
      logLevel: 'silent',
    });
    const { SubappHostProviderDispatcher } = require(dispatcherBundlePath);
    const sdk = await import(
      `${pathToFileURL(path.join(
        blocklyRoot,
        'node_modules',
        '@aily-project',
        'simulator-host-sdk',
        'dist',
        'index.js',
      )).href}?e2e=${Date.now()}`
    );

    phase('standalone:start');
    const standalone = await startInstalledSimulator({
      config,
      adapters: [],
      SubappHostProviderDispatcher,
      ownedProcesses,
    });
    const standaloneSnapshot = await waitForProviderSnapshot(
      standalone.ready.origin,
      snapshot => snapshot.negotiation?.mode !== 'negotiating',
    );
    assert.equal(
      standaloneSnapshot.negotiation.providers.some(
        provider => provider.availability === 'available',
      ),
      false,
    );
    await assertSurface(config, standalone.ready);
    await stopInstalledSimulator(standalone);
    phase('standalone:complete');

    phase('all-providers:start');
    const allProviderBundle = createAllProviderBundle(sdk);
    const integrated = await startInstalledSimulator({
      config,
      adapters: allProviderBundle.adapters,
      SubappHostProviderDispatcher,
      ownedProcesses,
      closeAdapters: () => allProviderBundle.close(),
    });
    const integratedSnapshot = await waitForProviderSnapshot(
      integrated.ready.origin,
      snapshot => providerAvailability(snapshot, 'project') === 'available'
        && providerAvailability(snapshot, 'build') === 'available'
        && providerAvailability(snapshot, 'editor') === 'available'
        && providerAvailability(snapshot, 'agent') === 'available'
        && providerAvailability(snapshot, 'entitlement') === 'available',
    );
    assert.equal(integratedSnapshot.negotiation.mode, 'integrated');
    assert.deepEqual(
      providerNames.filter(
        provider => providerAvailability(integratedSnapshot, provider) === 'available',
      ),
      ['project', 'build', 'editor', 'agent', 'entitlement'],
    );
    assert.deepEqual(
      providerNames.filter(
        provider => providerAvailability(integratedSnapshot, provider) !== 'available',
      ),
      [],
    );
    await assertSurface(config, integrated.ready);

    const firstOwner = integrated.acquireOwner(101, 'renderer-a');
    assert.equal(firstOwner.success, true);
    assert.equal(firstOwner.refCount, 1);
    const idempotentOwner = integrated.acquireOwner(101, 'renderer-a');
    assert.equal(idempotentOwner.added, false);
    assert.equal(idempotentOwner.refCount, 1);
    const secondOwner = integrated.acquireOwner(202, 'renderer-b');
    assert.equal(secondOwner.refCount, 2);
    assert.equal(integrated.authorizeOwner(202, 'renderer-b').success, false);
    assert.equal(integrated.authorizeOwner(101, 'renderer-a').success, true);
    assert.equal(integrated.releaseOwner(101, 'renderer-a').refCount, 1);
    assert.equal(integrated.releaseOwner(202, 'renderer-b').refCount, 0);

    await stopInstalledSimulator(integrated);
    phase('all-providers:complete');

    assert.equal(ownedProcesses.size, 0);
    console.log(JSON.stringify({
      status: 'passed',
      kind: 'aily-simulator-generic-child-tool-host-local-e2e-result',
      packageName: manifest.name,
      packageVersion: manifest.version,
      subappManagerConfig: true,
      standardServe: true,
      fixedSurface: config.ui.surfaces.full.entry,
      processMessagePort: config.runtime.processMessagePort,
      providerCatalogs: {
        standalone: [],
        activeBlocklyProject: [
          'project',
          'build',
          'editor',
          'agent',
          'entitlement',
        ],
        pending: [],
      },
      lifecycle: {
        ownerLease: true,
        controllerAuthorization: true,
        gracefulShutdown: true,
        restartByFreshAcquire: true,
        processesZero: true,
        runtimeDirectoriesZero: true,
      },
      privateRegistryUsed: false,
      dedicatedSimulatorHostUsed: false,
    }, null, 2));
  } finally {
    for (const processRecord of [...ownedProcesses]) {
      await forceStop(processRecord.child);
    }
    await removeOwnedTestRoot(testRoot);
  }
}

async function readInstalledSimulatorConfig({ installRoot, version }) {
  const { createSubappManager } = require('../electron/subapp-manager');
  const index = {
    'aily-simulator': {
      id: 'aily-simulator',
      titleKey: 'AILY_SIMULATOR.TITLE',
      namespace: 'AILY_SIMULATOR',
      package: '@aily-project/aily-simulator',
      version,
      app: {
        name: 'AILY_SIMULATOR.TITLE',
        description: 'AILY_SIMULATOR.DESCRIPTION',
        icon: 'fa-light fa-waveform',
        enabled: true,
      },
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: {
            TITLE: 'Aily Simulator',
            DESCRIPTION: 'Local simulator',
          },
        },
      },
    },
  };
  const manager = createSubappManager({
    rootDir: installRoot,
    fetchImpl: async () => ({
      ok: true,
      text: async () => JSON.stringify(index),
    }),
  });
  const state = await manager.list({ locale: 'en', refresh: true });
  assert.equal(state.apps.length, 1);
  assert.equal(state.apps[0].installed, true);
  assert.equal(state.apps[0].installError, undefined);
  assert.ok(state.apps[0].config);
  return state.apps[0].config;
}

async function startInstalledSimulator(options) {
  const {
    acquireOwner,
    authorizeMessagePortSend,
    releaseOwner,
  } = require('../electron/child-tool-session-leases');
  const scriptPath = path.join(
    options.config.packagePath,
    options.config.entry,
  );
  const streamId = `child_tool_simulator_${randomUUID()}`;
  const child = spawn(process.execPath, [
    scriptPath,
    'serve',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ], {
    cwd: options.config.packagePath,
    env: {
      ...process.env,
      AILY_CHILD_TOOL: '1',
      AILY_CHILD_TOOL_ID: 'simulator',
    },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const processRecord = {
    child,
    exit: waitForExit(child),
    ready: null,
    stderr: [],
  };
  options.ownedProcesses.add(processRecord);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => processRecord.stderr.push(chunk));

  const transport = createChildProcessTransport(child);
  const dispatcher = new options.SubappHostProviderDispatcher({
    hostInstanceId: `simulator-e2e-${randomUUID()}`,
    adapters: options.adapters,
    maxMessageBytes: options.config.runtime.processMessagePort.maxMessageBytes,
  });
  const unbind = dispatcher.bindTransport(transport);
  try {
    processRecord.ready = await waitForReady(processRecord);
  } catch (error) {
    unbind();
    await dispatcher.close();
    await options.closeAdapters?.();
    await forceStop(child);
    options.ownedProcesses.delete(processRecord);
    throw error;
  }

  const session = {
    streamId,
    hostInfo: processRecord.ready,
    messagePort: {
      send: message => child.send(message),
    },
    owners: new Map(),
  };
  Object.assign(processRecord, {
    streamId,
    dispatcher,
    unbind,
    closeAdapters: options.closeAdapters,
    ownedProcesses: options.ownedProcesses,
    session,
    acquireOwner: (ownerId, leaseId) => acquireOwner(session, ownerId, leaseId),
    releaseOwner: (ownerId, leaseId) => releaseOwner(session, ownerId, leaseId),
    authorizeOwner: (ownerId, leaseId) => authorizeMessagePortSend(
      session,
      ownerId,
      { streamId, leaseId, message: { type: 'fixture' } },
    ),
  });
  return processRecord;
}

async function stopInstalledSimulator(record) {
  const { stopChildToolSessionProcess } = require(
    '../electron/child-tool-session-process'
  );
  const wrapperPid = record.child.pid;
  const productionPid = record.ready.pid;
  record.unbind();
  await record.dispatcher.close();
  await record.closeAdapters?.();
  const stopped = await stopChildToolSessionProcess(record.session, {
    getActiveProcesses: () => isChildAlive(record.child)
      ? [{ streamId: record.streamId }]
      : [],
    isPidAlive,
    killStream: () => {
      record.child.kill('SIGTERM');
      return true;
    },
    killProcessTree: async pid => killProcessTree(pid),
    gracefulShutdownWaitMs: 20_000,
    pollIntervalMs: 25,
    shutdownRequestTimeoutMs: 5_000,
  });
  assert.equal(stopped, true);
  await withTimeout(
    record.exit,
    20_000,
    'Installed Simulator wrapper did not exit.',
  );
  await waitForProcessGone(wrapperPid);
  await waitForProcessGone(productionPid);
  await waitForRuntimeDirectoriesGone(`runtime-${wrapperPid}-`);
  record.ownedProcesses.delete(record);
}

function createChildProcessTransport(child) {
  let listener = null;
  const onMessage = message => listener?.(message);
  child.on('message', onMessage);
  return {
    onMessage(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
        child.off('message', onMessage);
      };
    },
    async send(message) {
      if (!isChildAlive(child)) {
        throw new Error('Simulator child process message port is closed.');
      }
      await new Promise((resolve, reject) => {
        child.send(message, error => error ? reject(error) : resolve());
      });
    },
  };
}

function createAllProviderBundle(sdk) {
  const artifactRevision = '7'.repeat(64);
  return sdk.createSimulatorHostProviderDispatcherAdapterBundle({
    project: {
      readContext(request) {
        return {
          schemaVersion: 1,
          kind: 'aily-simulator-host-project-context-snapshot',
          projectIdentity: request.projectIdentity ?? 'project-local-e2e',
          workspaceIdentity: 'workspace-local-e2e',
          activeSceneId: 'main',
          activeArtifactRevision: artifactRevision,
        };
      },
      readScene() {
        throw new Error('Scene read is outside the negotiation E2E.');
      },
      writeScene() {
        throw new Error('Scene write is outside the negotiation E2E.');
      },
      inspectLegacyScene(request) {
        return {
          schemaVersion: 1,
          kind: 'aily-simulator-host-project-legacy-scene-snapshot',
          projectIdentity: request.projectIdentity,
          sceneId: request.sceneId,
          legacySource: null,
        };
      },
      readArtifact() {
        throw new Error('Artifact read is outside the negotiation E2E.');
      },
      readArtifactChunk() {
        return { data: new Uint8Array(), eof: true };
      },
      readDebugConfiguration() {
        throw new Error(
          'Debug configuration read is outside the negotiation E2E.',
        );
      },
    },
    build: {
      requestArtifact() {
        throw new Error('Build execution is covered by the callback authority E2E.');
      },
      subscribeProgress() {
        return { acceptedFromSequence: 0 };
      },
    },
    editor: {
      publishDebugLocation() {
        return 'applied';
      },
      revealSourceLocation() {
        return 'revealed';
      },
    },
    agent: {
      proposeScene(request) {
        return {
          schemaVersion: 1,
          kind: 'aily-agent-scene-change-proposal',
          proposalId: 'proposal-local-e2e',
          agentRunId: 'agent-run-local-e2e',
          reason: request.reason === 'legacy-detected'
            ? 'legacy-regeneration'
            : 'user-requested-change',
          summary: 'Local installed-package Agent provider fixture.',
          target: {
            projectIdentity: request.projectIdentity,
            sceneId: request.sceneId,
          },
          base: { ...request.base },
          componentMutations: [],
          batch: null,
        };
      },
      approveSceneProposal() {
        return {
          disposition: 'approved',
          approvalId: 'approval-local-e2e',
        };
      },
    },
    entitlement: {
      requestLease() {
        return {
          disposition: 'unavailable',
          unavailableReason: 'sign-in-required',
          lease: null,
          revocations: null,
        };
      },
      subscribeStatus(request) {
        return {
          acceptedFromSequence: request.afterSequence ?? 0,
          status: {
            schemaVersion: 1,
            kind: 'aily-simulator-host-entitlement-status',
            product: 'aily-simulator',
            accountState: 'sign-in-required',
            connectivity: 'online',
            leaseExpiresAtUnixMs: null,
            observedAtUnixMs: Date.now(),
          },
        };
      },
    },
  });
}

async function assertSurface(config, ready) {
  const surfaceUrl = new URL(
    config.ui.surfaces.full.entry,
    `${ready.origin}/`,
  ).toString();
  assert.equal(surfaceUrl, ready.url);
  const response = await fetch(surfaceUrl, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/html\b/u);
}

function providerAvailability(snapshot, providerName) {
  return snapshot.negotiation.providers.find(
    provider => provider.provider === providerName,
  )?.availability || 'missing';
}

async function waitForProviderSnapshot(baseUrl, predicate) {
  const deadline = Date.now() + 15_000;
  const origin = new URL(baseUrl).origin;
  let lastObservation = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/subapp/internal/host-providers`, {
        headers: { Origin: origin },
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json().catch(() => null);
      lastObservation = { status: response.status, body };
      if (response.status === 200 && body && predicate(body)) return body;
    } catch (error) {
      lastObservation = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await delay(25);
  }
  throw new Error(
    `Host Provider projection did not reach the expected state: ${JSON.stringify(lastObservation)}`,
  );
}

function waitForReady(record) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => finish(new Error(
      `Installed Simulator startup timed out: ${record.stderr.join('').trim()}`,
    )), 30_000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      record.child.stdout.off('data', onData);
      record.child.off('exit', onExit);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.event === 'fatal') {
          finish(new Error(message.data?.message || 'Simulator startup failed.'));
          return;
        }
        if (message.event === 'ready') {
          finish(null, message.data);
          return;
        }
      }
    };
    const onExit = (code, signal) => finish(new Error(
      `Installed Simulator exited before ready (${code}/${signal}): `
      + record.stderr.join('').trim(),
    ));
    record.child.stdout.on('data', onData);
    record.child.once('exit', onExit);
  });
}

function createEntitlementConfig() {
  const leaseKeys = generateKeyPairSync('ed25519');
  const revocationKeys = generateKeyPairSync('ed25519');
  return {
    schemaVersion: 1,
    kind: 'aily-simulator-production-entitlement-config',
    refreshEndpoint:
      'https://api.example.test/v1/simulator/entitlements/refresh',
    credentialService: 'pro.aily.simulator.blockly-local-e2e',
    credentialAccount: 'refresh-v1',
    leasePublicKeys: {
      'lease-local-e2e': leaseKeys.publicKey.export({
        format: 'pem',
        type: 'spki',
      }).toString(),
    },
    revocationPublicKeys: {
      'revocation-local-e2e': revocationKeys.publicKey.export({
        format: 'pem',
        type: 'spki',
      }).toString(),
    },
    bundledCapabilities: { 'simulation.basic': true },
    runtimeCapabilities: { 'simulation.basic': true },
  };
}

async function runNpm(args, cwd) {
  const npmCli = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ].find(candidate => candidate && /\.[cm]?js$/iu.test(candidate)
    && existsSync(candidate));
  if (!npmCli) throw new Error('Unable to locate npm-cli.js.');
  await run(process.execPath, [npmCli, ...args], cwd);
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${path.basename(command)} exited with ${code}/${signal}.`,
      ));
    });
  });
}

function waitForExit(child) {
  if (!isChildAlive(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function isChildAlive(child) {
  return child.exitCode === null && child.signalCode === null;
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGone(pid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await delay(50);
  }
  throw new Error(`Process ${pid} did not exit.`);
}

async function waitForRuntimeDirectoriesGone(prefix) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entries = await readdir(runtimeDataRoot, { withFileTypes: true })
      .catch(() => []);
    if (!entries.some(entry => entry.isDirectory()
      && entry.name.startsWith(prefix))) return;
    await delay(50);
  }
  throw new Error(`Runtime directories with prefix ${prefix} remain.`);
}

async function killProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () => resolve());
      child.once('exit', () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already stopped.
  }
}

async function forceStop(child) {
  if (!isChildAlive(child)) return;
  await killProcessTree(child.pid);
  await withTimeout(waitForExit(child), 5_000, 'Forced child stop timed out.')
    .catch(() => undefined);
}

async function removeOwnedTestRoot(root) {
  const resolved = path.resolve(root);
  const relative = path.relative(os.tmpdir(), resolved);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || !path.basename(resolved).startsWith(
      'aily-blockly-simulator-generic-host-',
    )
  ) {
    throw new Error(`Refusing to remove unexpected E2E root: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function requireFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Local E2E dependency is missing: ${filePath}`);
  }
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timeout));
}

function phase(name) {
  process.stderr.write(`[simulator-generic-host-local-e2e] ${name}\n`);
}
