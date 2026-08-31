'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { isWin32 } = require('./platform');

function getManagedNpmPrefix() {
  return process.env.AILY_NPM_PREFIX
    || (process.env.AILY_APPDATA_PATH
      ? path.join(process.env.AILY_APPDATA_PATH, 'npm-global')
      : '');
}

function getChildNodeExecutable(childPath) {
  const candidate = isWin32
    ? path.join(childPath || '', 'node', 'node.exe')
    : path.join(childPath || '', 'node', 'bin', 'node');
  return candidate && fs.existsSync(candidate) ? candidate : 'node';
}

function getChildNpmExecutable(childPath) {
  const candidate = isWin32
    ? path.join(childPath || '', 'node', 'npm.cmd')
    : path.join(childPath || '', 'node', 'bin', 'npm');
  return candidate && fs.existsSync(candidate) ? candidate : 'npm';
}

function packageRootCandidates(prefix, packageName) {
  if (!prefix || typeof packageName !== 'string' || !packageName) return [];
  const packageParts = packageName.split('/');
  return isWin32
    ? [path.join(prefix, 'node_modules', ...packageParts)]
    : [
      path.join(prefix, 'lib', 'node_modules', ...packageParts),
      path.join(prefix, 'node_modules', ...packageParts),
    ];
}

function resolvePackageAtRoot(packageRoot, binKey, source = 'managed') {
  try {
    const packageJsonPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return null;
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const binEntry = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.[binKey];
    const entry = binEntry || packageJson.main;
    if (!entry) return null;
    const entryPath = path.resolve(packageRoot, entry);
    if (!isPathInside(packageRoot, entryPath) || !fs.existsSync(entryPath)) return null;
    return {
      packageRoot,
      entryPath,
      version: typeof packageJson.version === 'string' ? packageJson.version : null,
      packageName: packageJson.name,
      source,
    };
  } catch {
    return null;
  }
}

function resolveManagedPackage({ packageName, binKey, prefix = getManagedNpmPrefix() }) {
  for (const packageRoot of packageRootCandidates(prefix, packageName)) {
    const resolved = resolvePackageAtRoot(packageRoot, binKey, 'managed');
    if (resolved?.packageName === packageName) return resolved;
  }
  return null;
}

function resolveLocalPackage({ packageName, binKey, projectPath }) {
  if (!projectPath) return null;
  const packageRoot = path.resolve(projectPath);
  const resolved = resolvePackageAtRoot(packageRoot, binKey, 'local');
  if (resolved?.packageName === packageName) return resolved;
  return null;
}

function probeManagedCli({
  resolved,
  childPath,
  capabilityArgs = ['capabilities', '--json'],
  expectedProtocolVersion,
  timeoutMs = 8_000,
}) {
  if (!resolved?.entryPath) {
    return { ok: false, error: 'Managed CLI package entry was not found' };
  }
  const nodeExecutable = getChildNodeExecutable(childPath);
  const versionResult = spawnSync(nodeExecutable, [resolved.entryPath, '--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: process.env,
  });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      ok: false,
      error: versionResult.error?.message
        || String(versionResult.stderr || versionResult.stdout || `CLI exited with ${versionResult.status}`).trim(),
    };
  }
  const capabilitiesResult = spawnSync(nodeExecutable, [resolved.entryPath, ...capabilityArgs], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: process.env,
  });
  if (capabilitiesResult.error || capabilitiesResult.status !== 0) {
    return {
      ok: false,
      error: capabilitiesResult.error?.message
        || String(capabilitiesResult.stderr || capabilitiesResult.stdout || `capabilities exited with ${capabilitiesResult.status}`).trim(),
    };
  }
  try {
    const capabilities = JSON.parse(String(capabilitiesResult.stdout || '').trim());
    if (
      expectedProtocolVersion !== undefined
      && capabilities.protocolVersion !== expectedProtocolVersion
    ) {
      return {
        ok: false,
        error: `Managed CLI protocol ${String(capabilities.protocolVersion)} is incompatible with ${expectedProtocolVersion}`,
      };
    }
    return {
      ok: true,
      ...resolved,
      nodeExecutable,
      version: String(versionResult.stdout || '').trim() || resolved.version,
      capabilities,
    };
  } catch (error) {
    return { ok: false, error: `Managed CLI returned invalid capabilities JSON: ${error.message}` };
  }
}

function installManagedPackage({
  packageSpec,
  childPath,
  prefix = getManagedNpmPrefix(),
  force = false,
}) {
  const args = [
    'install',
    '--global',
    '--prefix',
    prefix,
    '--no-audit',
    '--no-fund',
  ];
  if (force) args.push('--force');
  args.push(packageSpec);
  return runManagedNpm({
    args,
    childPath,
    prefix,
  });
}

function runManagedNpm({
  args,
  childPath,
  prefix = getManagedNpmPrefix(),
}) {
  if (!prefix) return Promise.reject(new Error('AILY_NPM_PREFIX is not configured'));
  const npm = getChildNpmExecutable(childPath);
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, {
      env: { ...process.env, npm_config_prefix: prefix },
      windowsHide: true,
      shell: isWin32,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) {
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
        return;
      }
      reject(new Error(
        Buffer.concat(stderr).toString('utf8').trim()
        || Buffer.concat(stdout).toString('utf8').trim()
        || `npm ${args[0] || 'command'} exited with ${code}`,
      ));
    });
  });
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

module.exports = {
  getChildNodeExecutable,
  getManagedNpmPrefix,
  installManagedPackage,
  packageRootCandidates,
  probeManagedCli,
  resolveLocalPackage,
  resolveManagedPackage,
  runManagedNpm,
};
