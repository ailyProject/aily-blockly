#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const blocklyRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const simulatorRoot = path.resolve(
  process.env.AILY_SIMULATOR_ROOT
    || path.join(blocklyRoot, '..', 'aily-simulator'),
);
const args = process.argv.slice(2);
const fast = args.includes('--fast');
const agentLive = args.includes('--agent-live');
const agentDependencyRepair = args.includes('--agent-dependency-repair');
const agentLibraryRepair = args.includes('--agent-library-repair');
const agentBidirectionalCore = args.includes('--agent-bidirectional-core');
const agentBidirectionalBlankCore = args.includes(
  '--agent-bidirectional-blank-core',
);
const unsupported = args.filter((value) => (
  value !== '--fast'
  && value !== '--agent-live'
  && value !== '--agent-dependency-repair'
  && value !== '--agent-library-repair'
  && value !== '--agent-bidirectional-core'
  && value !== '--agent-bidirectional-blank-core'
));
if (unsupported.length) {
  throw new Error(`Unsupported argument: ${unsupported[0]}`);
}

if (agentDependencyRepair && !agentLive) {
  throw new Error('--agent-dependency-repair requires --agent-live.');
}
if (agentLibraryRepair && !agentLive) {
  throw new Error('--agent-library-repair requires --agent-live.');
}
if (agentBidirectionalCore && !agentLive) {
  throw new Error('--agent-bidirectional-core requires --agent-live.');
}
if (agentBidirectionalBlankCore && !agentLive) {
  throw new Error('--agent-bidirectional-blank-core requires --agent-live.');
}
if (agentDependencyRepair && agentLibraryRepair) {
  throw new Error(
    '--agent-dependency-repair and --agent-library-repair are separate focused scenarios.',
  );
}
if (
  (agentBidirectionalCore || agentBidirectionalBlankCore)
  && (agentDependencyRepair || agentLibraryRepair)
) {
  throw new Error(
    'Bidirectional core scenarios cannot be combined with dependency repair.',
  );
}
if (agentBidirectionalCore && agentBidirectionalBlankCore) {
  throw new Error('Bidirectional Project and blank-Scene scenarios must run separately.');
}

if (agentLive && !hasLiveAgentCredential(process.env)) {
  console.error(JSON.stringify({
    status: 'not-run',
    kind: 'aily-simulator-main-agent-scene-build-live-e2e',
    reason: 'missing-live-agent-credential',
    acceptedEnvironmentVariables: [
      'AILY_EXECUTION_HOST_AUTH_TOKEN',
      'AILY_AUTH_TOKEN',
      'AILY_SERVICES_AUTH_TOKEN',
      'AILY_API_TOKEN',
      'AILY_E2E_AUTH_PROFILE_APPDATA',
    ],
    defaultDesktopProfile: process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'aily-project')
      : null,
  }));
  process.exit(2);
}

const packageOutput = path.join(
  simulatorRoot,
  '.runtime',
  'distribution',
  `aily-simulator-runtime-${process.platform}-${process.arch}`,
);
const entitlementConfig = path.join(
  blocklyRoot,
  'e2e',
  'fixtures',
  'simulator-entitlement-config.json',
);
const entitlementStateSeed = path.join(
  blocklyRoot,
  'e2e',
  'fixtures',
  'simulator-entitlement-state',
);
const defaultRealProject = path.join(
  blocklyRoot,
  'e2e',
  '.artifacts',
  'esp32s3-simulator-subapp',
);
const realProject = path.resolve(
  process.env.AILY_E2E_SIMULATOR_REAL_PROJECT || defaultRealProject,
);
const defaultRealAppData = path.join(
  blocklyRoot,
  'e2e',
  '.artifacts',
  'appdata-simulator-mainline',
);

for (const required of [
  path.join(simulatorRoot, 'package.json'),
  path.join(simulatorRoot, 'scripts', 'package-aily-simulator-runtime.mjs'),
  entitlementConfig,
  path.join(entitlementStateSeed, 'lease.json'),
  path.join(entitlementStateSeed, 'revocations.json'),
  path.join(entitlementStateSeed, 'clock.json'),
]) {
  if (!existsSync(required)) {
    throw new Error(`Simulator route E2E dependency is unavailable: ${required}`);
  }
}

if (!fast) {
  await runNpm(['run', 'gateway:build'], simulatorRoot, process.env);
  await run(process.execPath, [
    path.join(simulatorRoot, 'scripts', 'package-aily-simulator-runtime.mjs'),
    '--entitlement-config', entitlementConfig,
  ], simulatorRoot, process.env);
} else if (!existsSync(path.join(packageOutput, 'package.json'))) {
  throw new Error(
    `--fast requires an existing packaged Simulator: ${packageOutput}`,
  );
}

await run(process.execPath, [
  path.join(blocklyRoot, 'scripts', 'run-e2e.mjs'),
  fast ? 'fast' : 'test',
  'simulator-generic-host-route.spec.ts',
], blocklyRoot, {
  ...process.env,
  AILY_E2E_SIMULATOR_GENERIC_ROUTE: '1',
  ...(agentLive
    ? {
        AILY_E2E_SIMULATOR_AGENT_LIVE: '1',
        AILY_E2E_SIMULATOR_ONLY_AGENT_LIVE: '1',
        ...(agentDependencyRepair
          ? { AILY_E2E_SIMULATOR_AGENT_DEPENDENCY_REPAIR: '1' }
          : {}),
        ...(agentLibraryRepair
          ? { AILY_E2E_SIMULATOR_AGENT_LIBRARY_REPAIR: '1' }
          : {}),
        ...(agentBidirectionalCore
          ? { AILY_E2E_SIMULATOR_AGENT_BIDIRECTIONAL_CORE: '1' }
          : {}),
        ...(agentBidirectionalBlankCore
          ? { AILY_E2E_SIMULATOR_AGENT_BIDIRECTIONAL_BLANK_CORE: '1' }
          : {}),
      }
    : {}),
  AILY_E2E_SIMULATOR_PACKAGE: packageOutput,
  AILY_SIMULATOR_ENTITLEMENT_STATE_SEED: entitlementStateSeed,
  ...(existsSync(path.join(realProject, '.build', 'aily-artifact-manifest.json'))
    && existsSync(path.join(
      realProject,
      '.aily',
      'simulator',
      'scene-network-v2.json',
    ))
      ? { AILY_E2E_SIMULATOR_REAL_PROJECT: realProject }
      : {}),
  ...(existsSync(defaultRealAppData)
    ? {
        AILY_E2E_SIMULATOR_REAL_APPDATA:
          process.env.AILY_E2E_SIMULATOR_REAL_APPDATA || defaultRealAppData,
      }
    : {}),
});

function hasLiveAgentCredential(env) {
  const hasExplicitToken = [
    env.AILY_EXECUTION_HOST_AUTH_TOKEN,
    env.AILY_AUTH_TOKEN,
    env.AILY_SERVICES_AUTH_TOKEN,
    env.AILY_API_TOKEN,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
  if (hasExplicitToken) return true;
  const profileAppData = env.AILY_E2E_AUTH_PROFILE_APPDATA
    || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'aily-project') : '');
  return !!profileAppData
    && existsSync(path.join(profileAppData, '.aily'))
    && existsSync(path.join(profileAppData, 'config.json'));
}

function runNpm(args, cwd, env) {
  const npmCli = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ].find((candidate) => (
    candidate
    && /\.[cm]?js$/i.test(candidate)
    && existsSync(candidate)
  ));
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd, env);
  if (process.platform === 'win32') {
    throw new Error('Unable to resolve npm-cli.js beside the active Windows Node runtime.');
  }
  return run('npm', args, cwd, env);
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} ${args.join(' ')} exited with ${String(code)}`
        + `${signal ? ` (${signal})` : ''}`,
      ));
    });
  });
}
