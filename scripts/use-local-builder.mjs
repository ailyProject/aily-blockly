#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const builderRoot = path.resolve(
  process.argv[2] || path.join(repositoryRoot, '..', 'aily-builder'),
);
const appDataRoot = process.env.AILY_APPDATA_PATH || (
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'aily-project')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'aily-project')
      : path.join(os.homedir(), '.config', 'aily-project')
);
const prefix = path.resolve(
  process.env.AILY_NPM_PREFIX || path.join(appDataRoot, 'npm-global'),
);
const sourcePackagePath = path.join(builderRoot, 'package.json');

if (!existsSync(sourcePackagePath)) {
  throw new Error(`未找到本地 aily-builder：${sourcePackagePath}`);
}
const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8'));
if (sourcePackage.name !== '@aily-project/aily-builder') {
  throw new Error(
    `本地包名必须是 @aily-project/aily-builder，实际为 ${sourcePackage.name}`,
  );
}

run('npm', ['run', 'build'], { cwd: builderRoot });
const cliSource = readFileSync(
  path.join(builderRoot, 'dist', 'main.js'),
  'utf8',
);
if (!cliSource.startsWith('#!/usr/bin/env node\n')) {
  throw new Error('dist/main.js 缺少 Node shebang，npm CLI shim 将无法可靠执行。');
}

run('npm', [
  'install',
  '--global',
  '--prefix',
  prefix,
  builderRoot,
  '--force',
]);

const installedPackageRoot = findInstalledPackageRoot(prefix);
if (!installedPackageRoot) {
  throw new Error(`未在 ${prefix} 找到已安装的 @aily-project/aily-builder。`);
}
if (realpathSync(installedPackageRoot) !== realpathSync(builderRoot)) {
  throw new Error(
    `Builder 未链接到本地源码：${installedPackageRoot} -> `
    + realpathSync(installedPackageRoot),
  );
}

const commandPath = process.platform === 'win32'
  ? path.join(prefix, 'aily-builder.cmd')
  : path.join(prefix, 'bin', 'aily-builder');
const version = run(commandPath, ['--version'], { capture: true }).trim();
const capabilities = JSON.parse(
  run(commandPath, ['capabilities', '--json'], { capture: true }),
);
if (
  capabilities?.schemaVersion !== 1
  || capabilities?.capabilities?.simulationArtifactManifest
    ?.cliOption !== '--emit-artifact-manifest'
  || capabilities?.capabilities?.blockSourceMap?.artifactRole !== 'source-map'
  || capabilities?.capabilities?.debugSourceSnapshot?.artifactRole
    !== 'debug-source'
  || capabilities?.capabilities?.debugSourceSnapshot?.maxSizeBytes
    !== 2 * 1024 * 1024
) {
  throw new Error('本地 Builder 未提供 Blockly 仿真 Artifact 所需能力。');
}

console.log('Local aily-builder is ready for Blockly development:');
console.log(`- source: ${realpathSync(builderRoot)}`);
console.log(`- prefix: ${prefix}`);
console.log(`- command: ${commandPath}`);
console.log(`- version: ${version}`);
console.log('- simulation Artifact capability: ok');

function findInstalledPackageRoot(npmPrefix) {
  const candidates = process.platform === 'win32'
    ? [
        path.join(
          npmPrefix,
          'node_modules',
          '@aily-project',
          'aily-builder',
        ),
      ]
    : [
        path.join(
          npmPrefix,
          'lib',
          'node_modules',
          '@aily-project',
          'aily-builder',
        ),
        path.join(
          npmPrefix,
          'node_modules',
          '@aily-project',
          'aily-builder',
        ),
      ];
  return candidates.find((candidate) => existsSync(candidate)) || '';
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    shell: process.platform === 'win32',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.status}: `
      + `${result.stderr || result.stdout || ''}`.trim(),
    );
  }
  return options.capture ? String(result.stdout || '') : '';
}
