// Stable, host-owned launcher for versioned subapp command-line entry points.
// A copy is installed at <subapp-root>/bin/subapp-bin-router.cjs so external
// tools never need to persist store/<package>/<version>/source paths.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const ACTIVE_SCHEMA_VERSION = 2;
const READY_SCHEMA_VERSION = 2;
const ROUTER_FILE = 'subapp-bin-router.cjs';
const MAX_JSON_BYTES = 1024 * 1024;
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const BIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateSegment(value, label) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)
    || WINDOWS_RESERVED.test(value) || Buffer.byteLength(value, 'utf8') > 255) {
    throw new Error(`Unsafe ${label}: ${String(value)}`);
  }
  return value;
}

function validatePackageName(value) {
  if (typeof value !== 'string' || value.length > 214 || !PACKAGE_PATTERN.test(value)) {
    throw new Error(`Invalid subapp package name: ${String(value)}`);
  }
  value.split('/').forEach(segment => validateSegment(segment, 'package path component'));
  return value;
}

function validateBinName(value) {
  if (typeof value !== 'string' || !BIN_PATTERN.test(value)) {
    throw new Error(`Invalid subapp bin name: ${String(value)}`);
  }
  return value;
}

function storeKeyForPackage(packageName) {
  return validateSegment(validatePackageName(packageName).split('/').at(-1), 'version-store key');
}

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
  );
  if (!match) return null;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`Invalid semantic version comparison: ${left}, ${right}`);
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] > b.core[index]) return 1;
    if (a.core[index] < b.core[index]) return -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const aNumeric = /^\d+$/.test(a.prerelease[index]);
    const bNumeric = /^\d+$/.test(b.prerelease[index]);
    if (aNumeric && bNumeric) {
      const aValue = BigInt(a.prerelease[index]);
      const bValue = BigInt(b.prerelease[index]);
      if (aValue > bValue) return 1;
      if (aValue < bValue) return -1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a.prerelease[index] !== b.prerelease[index]) {
      return a.prerelease[index] > b.prerelease[index] ? 1 : -1;
    }
  }
  return 0;
}

function readJson(file, optional = false) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JSON_BYTES) {
    throw new Error(`Unsafe subapp manifest: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe stable subapp bin directory: ${directory}`);
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function stableRouterPath(rootDir) {
  return path.join(path.resolve(rootDir), 'bin', ROUTER_FILE);
}

function isStableRouterReady(rootDir) {
  const target = stableRouterPath(rootDir);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  try {
    return fs.readFileSync(target).equals(fs.readFileSync(__filename));
  } catch {
    return false;
  }
}

function replaceFileAtomic(file, bytes) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${file}.${process.pid}.${randomUUID()}.old`;
  let backedUp = false;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)
        || !fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw error;
      fs.renameSync(file, backup);
      backedUp = true;
      try {
        fs.renameSync(temporary, file);
      } catch (replaceError) {
        if (!fs.existsSync(file) && fs.existsSync(backup)) {
          try {
            fs.renameSync(backup, file);
            backedUp = false;
          } catch (restoreError) {
            replaceError.message += `; previous router preserved at ${backup}: ${restoreError.message}`;
          }
        }
        throw replaceError;
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
    if (backedUp && fs.existsSync(file)) fs.rmSync(backup, { force: true });
  }
}

function ensureStableRouter(rootDir) {
  const target = stableRouterPath(rootDir);
  ensureDirectory(path.dirname(target));
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`Unsafe stable subapp bin router: ${target}`);
  }
  const source = fs.readFileSync(__filename);
  if (!existing || !fs.readFileSync(target).equals(source)) replaceFileAtomic(target, source);
  return target;
}

function validateLocator(value, packageName, storeKey) {
  if (!isObject(value) || typeof value.version !== 'string' || !parseSemver(value.version)) {
    throw new Error(`Invalid version-store locator for ${packageName}`);
  }
  validateSegment(value.version, 'version-store version');
  if (value.path !== `${value.version}/source`) {
    throw new Error(`Invalid version-store source path for ${packageName}`);
  }
  if (value.integrity !== undefined && value.integrity !== null
    && (typeof value.integrity !== 'string'
      || !/^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity))) {
    throw new Error(`Invalid version-store integrity for ${packageName}`);
  }
  return {
    version: value.version,
    path: value.path,
    ...(value.integrity ? { integrity: value.integrity } : {}),
    storeKey,
  };
}

function resolvePackageBin(packagePath, packageName, binName, source, expectedVersion = null) {
  const packageStat = fs.lstatSync(packagePath);
  if (!packageStat.isDirectory() && !packageStat.isSymbolicLink()) {
    throw new Error(`Subapp package root is not a directory: ${packagePath}`);
  }
  const realPackagePath = fs.realpathSync(packagePath);
  const manifest = readJson(path.join(realPackagePath, 'package.json'));
  const identityMatches = isObject(manifest) && (
    manifest.name === packageName
    || (source === 'development' && manifest.ailySubapp?.package === packageName)
  );
  if (!identityMatches || !parseSemver(manifest.version)
    || (expectedVersion && manifest.version !== expectedVersion)) {
    throw new Error(`Subapp package manifest does not match: ${packageName}`);
  }
  let declaredBin = null;
  if (typeof manifest.bin === 'string' && binName === packageName.split('/').at(-1)) {
    declaredBin = manifest.bin;
  } else if (isObject(manifest.bin) && typeof manifest.bin[binName] === 'string') {
    declaredBin = manifest.bin[binName];
  }
  if (!declaredBin || path.isAbsolute(declaredBin)) {
    throw new Error(`Subapp bin is not declared: ${packageName}#${binName}`);
  }
  const targetPath = path.resolve(realPackagePath, declaredBin);
  if (!isInside(realPackagePath, targetPath)) {
    throw new Error(`Unsafe subapp bin path: ${packageName}#${binName}`);
  }
  const targetStat = fs.lstatSync(targetPath);
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error(`Subapp bin target is not a regular file: ${packageName}#${binName}`);
  }
  return {
    packagePath: realPackagePath,
    targetPath,
    version: manifest.version,
    source,
  };
}

function inspectVersion(rootDir, packageName, binName, storeKey, locator) {
  const storeRoot = path.join(rootDir, 'store', storeKey);
  const versionRoot = path.join(storeRoot, locator.version);
  const sourceRoot = path.join(versionRoot, 'source');
  for (const directory of [storeRoot, versionRoot, sourceRoot]) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe version-store directory: ${directory}`);
    }
  }
  const ready = readJson(path.join(versionRoot, 'ready.json'));
  if (!isObject(ready)) {
    throw new Error(`Invalid version-store completion receipt: ${packageName}@${locator.version}`);
  }
  const readyIntegrity = isObject(ready.distribution) && typeof ready.distribution.integrity === 'string'
    ? ready.distribution.integrity
    : typeof ready.integrity === 'string' ? ready.integrity : null;
  if (ready.schemaVersion !== READY_SCHEMA_VERSION || ready.complete !== true
    || ready.packageName !== packageName || ready.storeKey !== storeKey
    || ready.version !== locator.version || ready.path !== locator.path
    || typeof ready.installedAt !== 'string' || !Number.isFinite(Date.parse(ready.installedAt))
    || (locator.integrity || null) !== readyIntegrity) {
    throw new Error(`Invalid version-store completion receipt: ${packageName}@${locator.version}`);
  }
  return resolvePackageBin(sourceRoot, packageName, binName, 'version-store', locator.version);
}

function readVersionSelection(rootDir, packageName, binName, storeKey) {
  const activeFile = path.join(rootDir, 'store', storeKey, 'active.json');
  const active = readJson(activeFile, true);
  if (active === undefined) return null;
  if (!isObject(active) || active.schemaVersion !== ACTIVE_SCHEMA_VERSION
    || active.packageName !== packageName || active.storeKey !== storeKey
    || active.disabled !== false || !['auto', 'pinned'].includes(active.mode)) {
    throw new Error(`Invalid active version-store manifest: ${packageName}`);
  }
  const selectedLocator = validateLocator(active.selected, packageName, storeKey);
  const previousLocator = active.previous
    ? validateLocator(active.previous, packageName, storeKey)
    : null;
  let selected;
  try {
    selected = inspectVersion(rootDir, packageName, binName, storeKey, selectedLocator);
  } catch (error) {
    if (!previousLocator) throw error;
    return {
      ...inspectVersion(rootDir, packageName, binName, storeKey, previousLocator),
      selectionMode: active.mode,
      fallback: true,
    };
  }
  if (active.mode === 'auto' && previousLocator) {
    try {
      const previous = inspectVersion(rootDir, packageName, binName, storeKey, previousLocator);
      if (compareSemver(previous.version, selected.version) > 0) {
        return { ...previous, selectionMode: active.mode, fallback: true };
      }
    } catch {
      // A damaged historical version cannot hide the selected working version.
    }
  }
  return { ...selected, selectionMode: active.mode };
}

function resolveStableBin(rootDir, packageNameValue, binNameValue) {
  const root = path.resolve(rootDir);
  const packageName = validatePackageName(packageNameValue);
  const binName = validateBinName(binNameValue);
  const storeKey = storeKeyForPackage(packageName);
  const uninstallMarker = readJson(
    path.join(root, 'store', '.uninstalling', `${storeKey}.json`),
    true,
  );
  if (isObject(uninstallMarker) && uninstallMarker.schemaVersion === 1
    && uninstallMarker.packageName === packageName && uninstallMarker.storeKey === storeKey) {
    throw new Error(`Subapp uninstall is in progress: ${packageName}`);
  }

  const legacyPath = path.resolve(root, 'node_modules', ...packageName.split('/'));
  const modulesRoot = path.resolve(root, 'node_modules');
  if (!isInside(modulesRoot, legacyPath)) throw new Error(`Unsafe legacy subapp path: ${packageName}`);
  const legacyStat = fs.lstatSync(legacyPath, { throwIfNoEntry: false });
  if (legacyStat?.isSymbolicLink()) {
    return resolvePackageBin(legacyPath, packageName, binName, 'development');
  }

  let selection = null;
  let selectionError = null;
  try {
    selection = readVersionSelection(root, packageName, binName, storeKey);
  } catch (error) {
    selectionError = error;
  }
  if (selection?.selectionMode === 'pinned') return selection;

  let legacy = null;
  if (legacyStat) {
    try {
      legacy = resolvePackageBin(legacyPath, packageName, binName, 'legacy-npm');
    } catch (error) {
      if (!selectionError) selectionError = error;
    }
  }
  if (legacy && (!selection || compareSemver(legacy.version, selection.version) > 0)) return legacy;
  if (selection) return selection;
  if (legacy) return legacy;
  throw selectionError || new Error(`Subapp bin is not installed: ${packageName}#${binName}`);
}

function runRouter(argv = process.argv) {
  const packageName = argv[2];
  const binName = argv[3];
  const forwardedArgs = argv.slice(4);
  let resolved;
  try {
    resolved = resolveStableBin(path.resolve(__dirname, '..'), packageName, binName);
  } catch (error) {
    console.error(`[subapp-bin-router] ${error.message || String(error)}`);
    process.exitCode = 1;
    return null;
  }
  const child = spawn(process.execPath, [resolved.targetPath, ...forwardedArgs], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AILY_SUBAPP_INSTALL_ROOT: path.resolve(__dirname, '..'),
      AILY_SUBAPP_PACKAGE_PATH: resolved.packagePath,
      AILY_SUBAPP_VERSION: resolved.version,
      AILY_SUBAPP_SOURCE: resolved.source,
    },
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  const forwardSignal = signal => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  child.once('error', error => {
    console.error(`[subapp-bin-router] Failed to start ${packageName}#${binName}: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    if (typeof code === 'number') process.exitCode = code;
    else if (signal) process.exitCode = 1;
  });
  return child;
}

if (require.main === module) runRouter();

module.exports = {
  compareSemver,
  ensureStableRouter,
  isStableRouterReady,
  resolveStableBin,
  runRouter,
  stableRouterPath,
};
