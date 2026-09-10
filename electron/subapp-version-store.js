// Immutable, per-version subapp installations selected by a small atomic manifest.
// Layout: store/<package-basename>/<version>/source and store/<package-basename>/active.json.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const semver = require('semver');

const SCHEMA_VERSION = 2;
const READY_FILE = 'ready.json';
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateSegment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)
    || WINDOWS_RESERVED.test(value) || Buffer.byteLength(value, 'utf8') > 255) {
    throw new Error(`Unsafe version-store path component: ${String(value)}`);
  }
  return value;
}

function validateVersion(value) {
  if (typeof value !== 'string' || semver.valid(value) !== value) {
    throw new Error(`Invalid version-store version: ${String(value)}`);
  }
  return validateSegment(value);
}

function validateEntry(entry, requireVersion = true) {
  if (!isObject(entry) || typeof entry.id !== 'string'
    || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(entry.id)) {
    throw new Error('Invalid version-store catalog id');
  }
  validateSegment(entry.id);
  if (typeof entry.package !== 'string' || entry.package.length > 214
    || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(entry.package)) {
    throw new Error('Invalid version-store package name');
  }
  entry.package.split('/').forEach(validateSegment);
  if (requireVersion) validateVersion(entry.version);
}

function storeKeyForPackage(packageName) {
  const parts = String(packageName || '').split('/');
  return validateSegment(parts[parts.length - 1]);
}

function validateDistribution(value) {
  if (value === null || value === undefined) return null;
  if (!isObject(value) || typeof value.tarball !== 'string'
    || !/^https?:\/\//i.test(value.tarball) || typeof value.integrity !== 'string'
    || !/^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity)) {
    throw new Error('Invalid version-store distribution');
  }
  const url = new URL(value.tarball);
  if (!url.hostname || url.username || url.password) throw new Error('Invalid version-store distribution URL');
  return { tarball: value.tarball, integrity: value.integrity };
}

function directory(rootDir, segments, { create = false, optional = false } = {}) {
  let current = path.resolve(rootDir);
  if (create) fs.mkdirSync(current, { recursive: true });
  try {
    if (!fs.statSync(current).isDirectory()) throw new Error('Version-store root is not a directory');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  for (const segment of segments) {
    current = path.join(current, validateSegment(segment));
    if (create) {
      try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (optional && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe version-store directory: ${current}`);
    }
  }
  return current;
}

function readJson(file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe version-store manifest: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporary, file);
        break;
      } catch (error) {
        if (process.platform !== 'win32' || attempt >= 4
          || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (2 ** attempt));
      }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function storeRoot(rootDir, entry, options = {}) {
  validateEntry(entry, false);
  return directory(rootDir, ['store', storeKeyForPackage(entry.package)], options);
}

function versionRoot(rootDir, entry, options = {}) {
  validateEntry(entry);
  return directory(rootDir, [
    'store', storeKeyForPackage(entry.package), validateVersion(entry.version),
  ], options);
}

function validateRelativeSource(value, version) {
  const normalized = `${validateVersion(version)}/source`;
  if (value !== normalized) throw new Error(`Invalid version-store source path: ${String(value)}`);
  return normalized;
}

function validateLocator(value, entry) {
  if (!isObject(value) || value.version === undefined || value.path === undefined) {
    throw new Error(`Invalid version-store locator: ${entry.id}`);
  }
  const version = validateVersion(value.version);
  const locator = { version, path: validateRelativeSource(value.path, version) };
  if (value.integrity !== null && value.integrity !== undefined) {
    if (typeof value.integrity !== 'string'
      || !/^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(value.integrity)) {
      throw new Error(`Invalid version-store integrity: ${entry.id}`);
    }
    locator.integrity = value.integrity;
  }
  return locator;
}

function inspectVersion(rootDir, entry, locator) {
  const storeKey = storeKeyForPackage(entry.package);
  const versionDirectory = directory(rootDir, ['store', storeKey, locator.version]);
  const source = directory(rootDir, ['store', storeKey, locator.version, 'source']);
  const ready = readJson(path.join(versionDirectory, READY_FILE));
  if (!isObject(ready) || ready.schemaVersion !== SCHEMA_VERSION || ready.complete !== true
    || ready.packageName !== entry.package || ready.storeKey !== storeKey
    || ready.version !== locator.version || ready.path !== locator.path
    || typeof ready.installedAt !== 'string' || !Number.isFinite(Date.parse(ready.installedAt))) {
    throw new Error(`Invalid version-store completion receipt: ${entry.id}@${locator.version}`);
  }
  const distribution = validateDistribution(ready.distribution);
  const integrity = distribution?.integrity || (typeof ready.integrity === 'string' ? ready.integrity : null);
  if ((locator.integrity || null) !== (integrity || null)) {
    throw new Error(`Version-store integrity does not match: ${entry.id}@${locator.version}`);
  }
  const manifest = readJson(path.join(source, 'package.json'));
  if (!isObject(manifest) || manifest.name !== entry.package || manifest.version !== locator.version) {
    throw new Error(`Version-store installed package does not match: ${entry.id}@${locator.version}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    id: entry.id,
    packageName: entry.package,
    storeKey,
    version: locator.version,
    path: locator.path,
    ...(integrity ? { integrity } : {}),
    distribution,
    installedAt: ready.installedAt,
    installMode: ready.installMode,
    project: versionDirectory,
    packagePath: source,
    source: 'version-store',
  };
}

function createCandidate(rootDir, entry) {
  validateEntry(entry);
  const parent = storeRoot(rootDir, entry, { create: true });
  const active = readJson(path.join(parent, 'active.json'), true);
  if (active && active.packageName !== entry.package) {
    throw new Error(`Version-store key belongs to another package: ${storeKeyForPackage(entry.package)}`);
  }
  for (const item of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!item.isDirectory() || !semver.valid(item.name)) continue;
    const ready = readJson(path.join(parent, item.name, READY_FILE), true);
    if (ready && ready.packageName !== entry.package) {
      throw new Error(`Version-store key belongs to another package: ${storeKeyForPackage(entry.package)}`);
    }
  }
  const token = `.staging-${entry.version}-${randomUUID()}`;
  const project = path.join(parent, token);
  fs.mkdirSync(project);
  const source = path.join(project, 'source');
  fs.mkdirSync(source);
  return { token, project, source, tarball: path.join(project, 'package.tgz') };
}

function publishCandidate(rootDir, entry, candidate, options = {}) {
  validateEntry(entry);
  const parent = storeRoot(rootDir, entry, { create: true });
  const candidateName = typeof candidate?.token === 'string' ? candidate.token : '';
  const candidatePrefix = `.staging-${entry.version}-`;
  const candidateToken = candidateName.startsWith(candidatePrefix)
    ? candidateName.slice(candidatePrefix.length) : '';
  if (!candidate || typeof candidate.project !== 'string'
    || path.dirname(path.resolve(candidate.project)) !== path.resolve(parent)
    || path.basename(candidate.project) !== candidateName
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidateToken)
    || path.resolve(candidate.source) !== path.resolve(candidate.project, 'source')) {
    throw new Error('Version-store candidate path is invalid');
  }
  const manifest = readJson(path.join(candidate.source, 'package.json'));
  if (!isObject(manifest) || manifest.name !== entry.package || manifest.version !== entry.version) {
    throw new Error(`Version-store installed package does not match: ${entry.id}@${entry.version}`);
  }
  const distribution = validateDistribution(options.distribution);
  const integrity = distribution?.integrity || options.integrity || null;
  if (integrity && !/^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error('Invalid version-store integrity');
  }
  const relativePath = `${entry.version}/source`;
  writeJsonAtomic(path.join(candidate.project, READY_FILE), {
    schemaVersion: SCHEMA_VERSION,
    complete: true,
    packageName: entry.package,
    storeKey: storeKeyForPackage(entry.package),
    version: entry.version,
    path: relativePath,
    ...(integrity ? { integrity } : {}),
    distribution,
    installMode: options.installMode === 'legacy-npm' ? 'legacy-npm' : 'portable',
    installedAt: new Date().toISOString(),
  });

  const destination = path.join(parent, entry.version);
  if (fs.existsSync(destination)) {
    if (!options.replace) {
      const existing = inspectVersion(rootDir, entry, {
        version: entry.version, path: relativePath, ...(integrity ? { integrity } : {}),
      });
      fs.rmSync(candidate.project, { recursive: true, force: true });
      return existing;
    }
    const replaced = path.join(parent, `.replaced-${entry.version}-${randomUUID()}`);
    fs.renameSync(destination, replaced);
    try {
      fs.renameSync(candidate.project, destination);
      fs.rmSync(replaced, { recursive: true, force: true });
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(replaced)) fs.renameSync(replaced, destination);
      throw error;
    }
  } else {
    fs.renameSync(candidate.project, destination);
  }
  return inspectVersion(rootDir, entry, {
    version: entry.version, path: relativePath, ...(integrity ? { integrity } : {}),
  });
}

function readPrepared(rootDir, entry) {
  validateEntry(entry);
  const parent = versionRoot(rootDir, entry, { optional: true });
  if (!parent) return null;
  const ready = readJson(path.join(parent, READY_FILE), true);
  if (!ready) return null;
  return inspectVersion(rootDir, entry, {
    version: entry.version,
    path: `${entry.version}/source`,
    ...(ready.integrity ? { integrity: ready.integrity } : {}),
  });
}

function activePath(rootDir, entry, create = false) {
  const parent = storeRoot(rootDir, entry, { create, optional: !create });
  return parent ? path.join(parent, 'active.json') : null;
}

function readActiveManifest(rootDir, entry) {
  const file = activePath(rootDir, entry);
  if (!file) return null;
  const manifest = readJson(file, true);
  if (manifest === undefined) return null;
  const storeKey = storeKeyForPackage(entry.package);
  if (!isObject(manifest) || manifest.schemaVersion !== SCHEMA_VERSION
    || manifest.packageName !== entry.package || manifest.storeKey !== storeKey
    || manifest.disabled !== false || !['auto', 'pinned'].includes(manifest.mode)) {
    throw new Error(`Invalid active version-store manifest: ${entry.id}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    packageName: entry.package,
    storeKey,
    disabled: false,
    mode: manifest.mode,
    selected: validateLocator(manifest.selected, entry),
    previous: manifest.previous ? validateLocator(manifest.previous, entry) : null,
  };
}

function readSelection(rootDir, entry, validatePrepared = () => {}) {
  validateEntry(entry, false);
  const manifest = readActiveManifest(rootDir, entry);
  if (!manifest) return null;
  let selected;
  try {
    selected = inspectVersion(rootDir, entry, manifest.selected);
    validatePrepared(selected);
  } catch (error) {
    if (!manifest.previous) throw error;
    const previous = inspectVersion(rootDir, entry, manifest.previous);
    validatePrepared(previous);
    return {
      ...previous,
      selectionMode: manifest.mode,
      fallback: true,
      selectionError: error.message,
    };
  }
  if (manifest.mode === 'auto' && manifest.previous) {
    try {
      const previous = inspectVersion(rootDir, entry, manifest.previous);
      validatePrepared(previous);
      if (semver.gt(previous.version, selected.version)) {
        return { ...previous, selectionMode: manifest.mode, fallback: true };
      }
    } catch {
      // A valid selected version must not be hidden by damaged historical metadata.
    }
  }
  return { ...selected, selectionMode: manifest.mode };
}

function activate(rootDir, entry, prepared, options = {}) {
  validateEntry(entry, false);
  const selected = inspectVersion(rootDir, entry, validateLocator(prepared, entry));
  let previous = null;
  try {
    const active = readActiveManifest(rootDir, entry);
    if (active) {
      if (active.selected.version === selected.version && active.selected.path === selected.path
        && (active.selected.integrity || null) === (selected.integrity || null)
        && active.mode === (options.mode === 'pinned' ? 'pinned' : 'auto')) return selected;
      previous = active.selected;
    }
  } catch {
    // A verified version repairs an invalid selector without retaining the corrupt locator.
  }
  const locator = {
    version: selected.version,
    path: selected.path,
    ...(selected.integrity ? { integrity: selected.integrity } : {}),
  };
  writeJsonAtomic(activePath(rootDir, entry, true), {
    schemaVersion: SCHEMA_VERSION,
    packageName: entry.package,
    storeKey: storeKeyForPackage(entry.package),
    disabled: false,
    mode: options.mode === 'pinned' ? 'pinned' : 'auto',
    selected: locator,
    previous,
    activatedAt: new Date().toISOString(),
  });
  return selected;
}

function uninstallMarkerPath(rootDir, entry, create = false) {
  validateEntry(entry, false);
  const parent = directory(rootDir, ['store', '.uninstalling'], { create, optional: !create });
  return parent ? path.join(parent, `${storeKeyForPackage(entry.package)}.json`) : null;
}

function beginUninstall(rootDir, entry) {
  writeJsonAtomic(uninstallMarkerPath(rootDir, entry, true), {
    schemaVersion: 1,
    packageName: entry.package,
    storeKey: storeKeyForPackage(entry.package),
    startedAt: new Date().toISOString(),
  });
}

function isUninstalling(rootDir, entry) {
  const file = uninstallMarkerPath(rootDir, entry);
  if (!file) return false;
  const value = readJson(file, true);
  if (!value) return false;
  return value.schemaVersion === 1 && value.packageName === entry.package
    && value.storeKey === storeKeyForPackage(entry.package);
}

function removeAllVersions(rootDir, entry) {
  validateEntry(entry, false);
  const target = path.join(path.resolve(rootDir), 'store', storeKeyForPackage(entry.package));
  fs.rmSync(target, { recursive: true, force: true });
}

function finishUninstall(rootDir, entry) {
  const file = uninstallMarkerPath(rootDir, entry);
  if (file) fs.rmSync(file, { force: true });
}

module.exports = {
  SCHEMA_VERSION,
  activePath,
  activate,
  beginUninstall,
  createCandidate,
  finishUninstall,
  isUninstalling,
  publishCandidate,
  readActiveManifest,
  readPrepared,
  readSelection,
  removeAllVersions,
  storeKeyForPackage,
  storeRoot,
  versionRoot,
};
