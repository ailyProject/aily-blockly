#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const connectorRoot = path.resolve(
  process.argv[2] || path.join(repositoryRoot, '..', 'aily-connector'),
);
const packagePath = path.join(connectorRoot, 'package.json');
if (!existsSync(packagePath)) {
  throw new Error(`Local aily-connector package was not found: ${packagePath}`);
}
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
if (packageJson.name !== '@aily-project/aily-connector') {
  throw new Error(`Expected @aily-project/aily-connector, received ${packageJson.name}`);
}

const appDataRoot = process.env.AILY_APPDATA_PATH || (
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'aily-project')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'aily-project')
      : path.join(os.homedir(), '.config', 'aily-project')
);
const prefix = path.resolve(process.env.AILY_NPM_PREFIX || path.join(appDataRoot, 'npm-global'));

run('npm', ['install'], connectorRoot);
run('npm', ['run', 'build'], connectorRoot);
run('npm', [
  'install',
  '--global',
  '--prefix',
  prefix,
  connectorRoot,
  '--force',
], repositoryRoot);

const entryPath = findInstalledEntry(prefix);
if (!entryPath) throw new Error(`Installed aily-connector entry was not found under ${prefix}`);
const version = run('node', [entryPath, '--version'], repositoryRoot, true).trim();
const capabilities = JSON.parse(
  run('node', [entryPath, 'capabilities', '--json'], repositoryRoot, true),
);
if (
  capabilities.protocolVersion !== 1
  || !capabilities.deviceTransports?.includes('ssh')
  || !capabilities.deviceTransports?.includes('serial')
  || !capabilities.operations?.includes('project.sync')
  || !capabilities.operations?.includes('run.file')
  || !capabilities.operations?.includes('run.stop')
) {
  throw new Error('Installed aily-connector does not provide the required protocol capabilities');
}

console.log('Local aily-connector is ready for Aily Blockly development:');
console.log(`- source: ${connectorRoot}`);
console.log(`- prefix: ${prefix}`);
console.log(`- entry: ${entryPath}`);
console.log(`- version: ${version}`);
console.log('- protocol: 1 (SSH + serial)');

function findInstalledEntry(npmPrefix) {
  const roots = process.platform === 'win32'
    ? [path.join(npmPrefix, 'node_modules', '@aily-project', 'aily-connector')]
    : [
      path.join(npmPrefix, 'lib', 'node_modules', '@aily-project', 'aily-connector'),
      path.join(npmPrefix, 'node_modules', '@aily-project', 'aily-connector'),
    ];
  for (const root of roots) {
    const candidatePackage = path.join(root, 'package.json');
    if (!existsSync(candidatePackage)) continue;
    const installed = JSON.parse(readFileSync(candidatePackage, 'utf8'));
    const bin = typeof installed.bin === 'string'
      ? installed.bin
      : installed.bin?.['aily-connector'];
    if (!bin) continue;
    const entry = path.resolve(root, bin);
    if (existsSync(entry)) return entry;
  }
  return '';
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}: `
      + String(result.stderr || result.stdout || '').trim(),
    );
  }
  return capture ? String(result.stdout || '') : '';
}
