#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const args = process.argv.slice(2);
const skipPrepareIndex = args.indexOf('--skip-prepare');
const skipPrepare = skipPrepareIndex >= 0;
if (skipPrepare) args.splice(skipPrepareIndex, 1);
const headedIndex = args.indexOf('--headed');
const headed = headedIndex >= 0;
if (headed) args.splice(headedIndex, 1);

const simulatorRoot = readPathOption(
  args,
  '--simulator-root',
  path.join(ROOT, '..', 'aily-simulator'),
);
const packageSource = readPathOption(
  args,
  '--package-sandbox',
  path.join(ROOT, 'e2e', '.artifacts', 'esp32s3-package-source'),
);

if (!skipPrepare) {
  await run(
    process.execPath,
    [
      path.join(ROOT, 'scripts', 'prepare-simulator-debug-e2e.mjs'),
      ...args,
    ],
    process.env,
  );
} else if (!existsSync(path.join(packageSource, 'node_modules'))) {
  throw new Error(
    `Prepared fixture dependencies are unavailable: ${packageSource}`,
  );
}

const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) {
  throw new Error(
    'npm CLI path is unavailable for the simulator iframe build.',
  );
}
await run(
  process.execPath,
  [npmCli, 'run', 'build:iframe:e2e'],
  process.env,
  path.resolve(simulatorRoot),
);

await run(
  process.execPath,
  [
    path.join(ROOT, 'scripts', 'run-e2e.mjs'),
    headed ? 'headed' : 'test',
    'simulator-debug.spec.ts',
  ],
  {
    ...process.env,
    AILY_E2E_SIMULATOR_DEBUG: '1',
    AILY_E2E_ESP32S3_PACKAGE_SOURCE: path.resolve(packageSource),
    AILY_SIMULATOR_ROOT: path.resolve(simulatorRoot),
    AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE: '1',
  },
);

function readPathOption(values, option, fallback) {
  const index = values.indexOf(option);
  if (index < 0) return path.resolve(fallback);
  const value = values[index + 1];
  if (!value) throw new Error(`${option} requires a path.`);
  return path.resolve(value);
}

function run(command, commandArgs, env, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
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
        `${command} ${commandArgs.join(' ')} exited with ${String(code)}`
        + `${signal ? ` (${signal})` : ''}.`,
      ));
    });
  });
}
