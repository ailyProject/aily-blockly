#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const ARTIFACT_ROOT = path.join(ROOT, 'e2e', '.artifacts');
const FIXTURE_ROOT = path.join(
  ROOT,
  'e2e',
  'fixtures',
  'projects',
  'esp32s3-debug',
);
const options = parseArguments(process.argv.slice(2));
const builderRoot = path.resolve(
  options.builderRoot || path.join(ROOT, '..', 'aily-builder'),
);
const simulatorRoot = path.resolve(
  options.simulatorRoot || path.join(ROOT, '..', 'aily-simulator'),
);
const packageSandbox = path.resolve(
  options.packageSandbox
  || path.join(ARTIFACT_ROOT, 'esp32s3-package-source'),
);
const reportPath = path.resolve(
  options.report
  || path.join(ARTIFACT_ROOT, 'simulator-debug-preparation.json'),
);
const runtimeBundle = path.join(
  simulatorRoot,
  '.runtime',
  'distribution',
  'aily-simulator-runtime-win32-x64',
);
const runtimeManifestPath = path.join(
  runtimeBundle,
  'aily-simulator-runtime.json',
);
const patchedQemuPath = path.join(
  simulatorRoot,
  '.runtime',
  'build',
  'aily-qemu',
  'windows-x64',
  'install',
  'qemu',
  'bin',
  'qemu-system-xtensa.exe',
);
const requiredPackages = [
  'board-xiao_esp32s3',
  'lib-core-io',
  'lib-core-logic',
  'lib-core-loop',
  'lib-core-math',
  'lib-core-serial',
  'lib-core-text',
  'lib-core-time',
  'lib-core-variables',
];

const report = {
  schemaVersion: 1,
  kind: 'aily-simulator-debug-e2e-preparation',
  status: 'running',
  startedAt: new Date().toISOString(),
  completedAt: null,
  platform: `${process.platform}-${process.arch}`,
  paths: {
    blocklyRoot: ROOT,
    builderRoot,
    simulatorRoot,
    packageSource: packageSandbox,
    runtimeBundle,
  },
  repositories: {},
  fixture: {},
  builder: {},
  runtime: {},
  stages: [],
};

try {
  assertWindowsX64();
  assertRepository(builderRoot, '@aily-project/aily-builder');
  assertRepository(simulatorRoot, 'aily-simulator');
  assertInsideArtifactRoot(packageSandbox, 'fixture dependency sandbox');

  report.repositories = {
    blockly: await readRepositoryState(ROOT),
    builder: await readRepositoryState(builderRoot),
    simulator: await readRepositoryState(simulatorRoot),
  };

  await runStage('fixture-dependencies', async () => {
    await rm(packageSandbox, { recursive: true, force: true });
    await mkdir(packageSandbox, { recursive: true });
    for (const fileName of ['package.json', 'package-lock.json']) {
      await copyFile(
        path.join(FIXTURE_ROOT, fileName),
        path.join(packageSandbox, fileName),
      );
    }
    await run(
      process.execPath,
      [
        resolveNpmCliPath(),
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.yiyu.pro',
      ],
      packageSandbox,
    );
    const packageScope = path.join(
      packageSandbox,
      'node_modules',
      '@aily-project',
    );
    for (const packageName of requiredPackages) {
      const packageJsonPath = path.join(
        packageScope,
        packageName,
        'package.json',
      );
      if (!existsSync(packageJsonPath)) {
        throw new Error(
          `Fixture dependency was not installed: ${packageJsonPath}`,
        );
      }
    }
    report.fixture = {
      lockSha256: await sha256File(
        path.join(FIXTURE_ROOT, 'package-lock.json'),
      ),
      packageCount: requiredPackages.length,
      registry: 'https://registry.yiyu.pro',
    };
  });

  if (!options.skipBuilder) {
    await runStage('local-builder', async () => {
      await run(
        process.execPath,
        [path.join(ROOT, 'scripts', 'use-local-builder.mjs'), builderRoot],
        ROOT,
      );
    });
  }

  await runStage('builder-capabilities', async () => {
    const builderCommand = getBuilderCommand();
    const [versionResult, capabilitiesResult] = await Promise.all([
      capture(builderCommand, ['--version'], ROOT),
      capture(builderCommand, ['capabilities', '--json'], ROOT),
    ]);
    const capabilities = JSON.parse(capabilitiesResult.stdout);
    if (
      capabilities?.schemaVersion !== 1
      || capabilities?.capabilities?.simulationArtifactManifest
        ?.schemaVersion !== 1
      || capabilities?.capabilities?.blockSourceMap?.schemaVersion !== 1
      || capabilities?.capabilities?.debugSourceSnapshot?.artifactRole
        !== 'debug-source'
    ) {
      throw new Error(
        'Installed Builder does not expose the required simulation capabilities.',
      );
    }
    report.builder = {
      command: builderCommand,
      version: versionResult.stdout.trim(),
      source: await realpath(builderRoot),
      capabilities: {
        simulationArtifactManifest:
          capabilities.capabilities.simulationArtifactManifest,
        blockSourceMap: capabilities.capabilities.blockSourceMap,
        debugSourceSnapshot:
          capabilities.capabilities.debugSourceSnapshot,
      },
    };
  });

  await prepareRuntime();

  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  await writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed';
  report.completedAt = new Date().toISOString();
  report.error = error instanceof Error
    ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
      }
    : { message: String(error) };
  await writeJsonAtomic(reportPath, report).catch(() => undefined);
  throw error;
}

async function prepareRuntime() {
  const packageScript = path.join(
    simulatorRoot,
    'scripts',
    'package-aily-simulator-runtime.mjs',
  );
  let reusable = false;
  let alreadyVerified = false;
  if (!options.refreshRuntime && existsSync(runtimeManifestPath)) {
    const reuseStage = await runStage('runtime-bundle-reuse-probe', async () => {
      reusable = await capture(
        process.execPath,
        [packageScript, '--verify', runtimeBundle],
        simulatorRoot,
        { reject: false },
      ).then((result) => result.code === 0);
      alreadyVerified = reusable;
    });
    reuseStage.reusable = reusable;
  }

  if (!reusable) {
    if (!existsSync(patchedQemuPath)) {
      if (!options.buildPatchedQemu) {
        throw new Error(
          `Patched QEMU is unavailable: ${patchedQemuPath}. `
          + 'Build it with Docker using '
          + '`npm run test:e2e:simulator-debug -- --build-patched-qemu`, '
          + 'or provide a previously verified runtime bundle.',
        );
      }
      await runStage('patched-qemu-build', async () => {
        await run(
          process.execPath,
          [
            path.join(
              simulatorRoot,
              'native',
              'aily-qemu',
              'scripts',
              'build-windows.mjs',
            ),
          ],
          simulatorRoot,
        );
      });
    }

    await runStage('official-runtime-dependencies', async () => {
      await run(
        process.execPath,
        [path.join(simulatorRoot, 'scripts', 'setup-qemu-runtime.mjs')],
        simulatorRoot,
      );
    });
    await runStage('runtime-bundle-package', async () => {
      await runNpm(
        ['run', 'runtime:package:windows'],
        simulatorRoot,
      );
    });
  }

  if (!alreadyVerified) {
    await runStage('runtime-bundle-verify', async () => {
      await run(
        process.execPath,
        [packageScript, '--verify', runtimeBundle],
        simulatorRoot,
      );
    });
  }
  const manifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
  report.runtime = {
    id: manifest.id,
    mode: manifest.mode,
    redistributionReady: manifest.redistributionReady,
    platform: manifest.platform,
    upstreamCommit: manifest.integrity?.upstreamCommit,
    patchSetId: manifest.integrity?.patchSetId,
    qemuExecutableSha256:
      manifest.integrity?.qemuExecutableSha256,
    gdbExecutableSha256:
      manifest.integrity?.gdbExecutableSha256,
    reused: reusable,
  };
}

async function runStage(name, operation) {
  const stage = {
    name,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
  report.stages.push(stage);
  try {
    await operation();
    stage.status = 'passed';
  } catch (error) {
    stage.status = 'failed';
    stage.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    stage.completedAt = new Date().toISOString();
  }
  return stage;
}

function parseArguments(values) {
  const parsed = {
    builderRoot: '',
    simulatorRoot: '',
    packageSandbox: '',
    report: '',
    skipBuilder: false,
    refreshRuntime: false,
    buildPatchedQemu: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--skip-builder') {
      parsed.skipBuilder = true;
      continue;
    }
    if (value === '--refresh-runtime') {
      parsed.refreshRuntime = true;
      continue;
    }
    if (value === '--build-patched-qemu') {
      parsed.buildPatchedQemu = true;
      continue;
    }
    const keyByOption = {
      '--builder-root': 'builderRoot',
      '--simulator-root': 'simulatorRoot',
      '--package-sandbox': 'packageSandbox',
      '--report': 'report',
    };
    const key = keyByOption[value];
    if (key) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a path.`);
      parsed[key] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown preparation option: ${value}`);
  }
  return parsed;
}

function assertWindowsX64() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(
      'The desktop ESP32-S3 E2E currently requires win32-x64.',
    );
  }
}

function assertRepository(root, expectedName) {
  const packagePath = path.join(root, 'package.json');
  if (!existsSync(packagePath)) {
    throw new Error(`Repository package.json is unavailable: ${packagePath}`);
  }
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.name !== expectedName) {
    throw new Error(
      `Expected ${expectedName} at ${root}, received ${packageJson.name}.`,
    );
  }
}

function assertInsideArtifactRoot(target, label) {
  const relative = path.relative(ARTIFACT_ROOT, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe ${label}: ${target}`);
  }
}

async function readRepositoryState(root) {
  const [commit, branch, status] = await Promise.all([
    capture('git', ['-C', root, 'rev-parse', 'HEAD'], root),
    capture('git', ['-C', root, 'branch', '--show-current'], root),
    capture(
      'git',
      ['-C', root, 'status', '--porcelain', '--untracked-files=no'],
      root,
    ),
  ]);
  return {
    commit: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  };
}

function getBuilderCommand() {
  const appDataRoot = process.env.AILY_APPDATA_PATH
    || path.join(process.env.LOCALAPPDATA || os.homedir(), 'aily-project');
  const prefix = path.resolve(
    process.env.AILY_NPM_PREFIX
    || path.join(appDataRoot, 'npm-global'),
  );
  return path.join(prefix, 'aily-builder.cmd');
}

function resolveNpmCliPath() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) return npmExecPath;
  const candidate = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (existsSync(candidate)) return candidate;
  throw new Error(`Unable to resolve npm CLI beside Node: ${process.execPath}`);
}

function runNpm(args, cwd) {
  return run(process.execPath, [resolveNpmCliPath(), ...args], cwd);
}

async function run(command, args, cwd) {
  const result = await capture(command, args, cwd, {
    inherit: true,
    reject: false,
  });
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${result.code}.`,
    );
  }
}

function capture(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32'
        && /\.(?:cmd|bat)$/i.test(command),
      windowsHide: true,
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (options.inherit) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.inherit) process.stderr.write(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      };
      if (result.code !== 0 && options.reject !== false) {
        reject(new Error(
          `${command} ${args.join(' ')} exited with ${result.code}`
          + `${signal ? ` (${signal})` : ''}:\n${stderr || stdout}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function sha256File(filePath) {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8',
  );
  await rm(filePath, { force: true });
  await rename(temporaryPath, filePath);
}
