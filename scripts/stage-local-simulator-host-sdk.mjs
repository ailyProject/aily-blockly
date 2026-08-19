import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const blocklyRoot = path.resolve(scriptDirectory, '..');
const simulatorRoot = path.resolve(
  process.env.AILY_SIMULATOR_SOURCE_ROOT
    || path.join(blocklyRoot, '..', 'aily-simulator'),
);
const stageRoot = path.join(blocklyRoot, 'node_modules', '@aily-project');
const reportPath = path.join(
  blocklyRoot,
  '.temp',
  'local-simulator-host-sdk-stage.json',
);
const packages = Object.freeze([
  {
    name: '@aily-project/scene-model',
    version: '0.1.0',
    source: 'packages/scene-model',
  },
  {
    name: '@aily-project/simulator-protocol',
    version: '0.1.0',
    source: 'packages/simulator-protocol',
  },
  {
    name: '@aily-project/simulator-host-sdk',
    version: '0.1.0',
    source: 'packages/simulator-embed-host',
  },
]);

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), 'aily-simulator-host-sdk-stage-'),
);

try {
  await requireDirectory(simulatorRoot, 'Aily Simulator source root');
  await runNpm(['run', 'embed-host:build'], simulatorRoot);
  await mkdir(stageRoot, { recursive: true });

  const staged = [];
  for (const descriptor of packages) {
    const packageRoot = path.join(simulatorRoot, descriptor.source);
    const packResult = await runNpm(
      ['pack', packageRoot, '--pack-destination', temporaryRoot, '--json'],
      simulatorRoot,
    );
    const packed = parsePackResult(packResult.stdout, descriptor.name);
    const tarballPath = path.join(temporaryRoot, packed.filename);
    const bytes = await readFile(tarballPath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const target = packageTarget(descriptor.name);
    await replacePackage(target, tarballPath);
    const manifest = JSON.parse(
      await readFile(path.join(target, 'package.json'), 'utf8'),
    );
    if (
      manifest.name !== descriptor.name
      || manifest.version !== descriptor.version
    ) {
      throw new Error(
        `Staged package identity mismatch: ${descriptor.name}@${descriptor.version}`,
      );
    }
    await access(path.join(target, 'dist', 'index.js'));
    await access(path.join(target, 'dist', 'index.d.ts'));
    staged.push(Object.freeze({
      name: descriptor.name,
      version: descriptor.version,
      tarball: packed.filename,
      sha256,
      sizeBytes: bytes.byteLength,
    }));
  }

  const sdkTarget = packageTarget('@aily-project/simulator-host-sdk');
  const imported = await import(
    `${pathToFileURL(path.join(sdkTarget, 'dist', 'index.js')).href}?stage=${Date.now()}`
  );
  const report = Object.freeze({
    schemaVersion: 1,
    kind: 'aily-blockly-local-simulator-host-sdk-stage',
    sourceRoot: simulatorRoot,
    packageManagerMutation: false,
    packages: staged,
    import: {
      status: 'imported',
      exports: Object.keys(imported).length,
    },
  });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function packageTarget(packageName) {
  const unscopedName = packageName.replace(/^@aily-project\//u, '');
  const target = path.resolve(stageRoot, unscopedName);
  const expectedPrefix = `${path.resolve(stageRoot)}${path.sep}`;
  if (!target.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to stage outside ${stageRoot}.`);
  }
  return target;
}

async function replacePackage(target, tarballPath) {
  const expectedPrefix = `${path.resolve(stageRoot)}${path.sep}`;
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to replace package outside ${stageRoot}.`);
  }
  await rm(resolvedTarget, { recursive: true, force: true });
  await mkdir(resolvedTarget, { recursive: true });
  await run(
    'tar',
    ['-xzf', tarballPath, '-C', resolvedTarget, '--strip-components=1'],
    blocklyRoot,
  );
}

async function requireDirectory(directory, label) {
  try {
    await realpath(directory);
  } catch {
    throw new Error(`${label} is unavailable: ${directory}`);
  }
}

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : '.'}`,
      { cause: error },
    );
  }
}

function parsePackResult(stdout, expectedName) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`npm pack did not return JSON for ${expectedName}.`);
  }
  const record = Array.isArray(value) ? value[0] : null;
  if (
    !record
    || record.name !== expectedName
    || typeof record.filename !== 'string'
    || record.filename.length < 1
  ) {
    throw new Error(`npm pack returned an invalid result for ${expectedName}.`);
  }
  return record;
}

async function runNpm(args, cwd) {
  const npmCli = String(process.env.npm_execpath || '').trim();
  if (npmCli) {
    return run(process.execPath, [npmCli, ...args], cwd);
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd);
}
