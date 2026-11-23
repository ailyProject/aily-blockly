'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const semver = require('semver');
const versions = require('./subapp-version-store');
const { readInstalledState } = require('./subapp-manager');

const RETIRED_DIRECTORY = /^\.retired-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const LOCK_CONTENDER = /^([1-9]\d*)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const INDEX_MAX_BYTES = 2 * 1024 * 1024;

const { rootDir, entry, platform, profiles = [], hostPid, customProcessInventory } = workerData;
const windows = platform === 'win32';

function directoryEntries(directory) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe cleanup directory');
  return fs.readdirSync(directory, { withFileTypes: true });
}

function readOwnedJson(filename, maxBytes) {
  const original = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!original) return undefined;
  if (!original.isFile() || original.isSymbolicLink() || original.size > maxBytes) throw new Error('Unsafe cleanup metadata');
  const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
  const descriptor = fs.openSync(filename, O_RDONLY | (O_NONBLOCK || 0) | (O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== original.ino || opened.size > maxBytes) throw new Error('Cleanup metadata changed');
    const bytes = Buffer.alloc(opened.size + 1);
    const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length !== opened.size) throw new Error('Cleanup metadata changed');
    return JSON.parse(bytes.toString('utf8', 0, length));
  } finally {
    fs.closeSync(descriptor);
  }
}

function fileIdentity(filename) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}` : null;
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process identity');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function otherHostIsRunning() {
  for (const directory of profiles) {
    for (const item of directoryEntries(directory)) {
      if (!/^instance-\d+$/.test(item.name)) continue;
      if (!item.isDirectory()) return true;
      const lock = readOwnedJson(path.join(directory, item.name, 'instance.lock'), 4096);
      if (lock !== undefined && (lock?.pid !== hostPid && isAlive(lock?.pid))) return true;
    }
  }
  return false;
}

function hasActiveContender(directory) {
  return directoryEntries(path.join(directory, '.contenders')).some(item => {
    const match = LOCK_CONTENDER.exec(item.name);
    return match && (!item.isDirectory() || isAlive(Number(match[1])));
  });
}

function storeIsBusy() {
  const locks = path.join(rootDir, 'store', '.locks');
  return otherHostIsRunning()
    || hasActiveContender(locks)
    || hasActiveContender(path.join(locks, versions.storeKeyForPackage(entry.package)))
    || versions.isUninstalling(rootDir, entry);
}

function normalize(value) {
  return windows ? value.toLowerCase().replaceAll('/', '\\') : value;
}

function readProcessCommands() {
  const command = windows ? 'powershell.exe' : 'ps';
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress']
    : ['-ww', '-axo', 'pid=,command='];
  const output = execFileSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
  }).trim();
  if (!output) throw new Error('Empty process inventory');
  if (windows) {
    return [JSON.parse(output)].flat().map(row => {
      if (!Number.isSafeInteger(row?.ProcessId)) throw new Error('Invalid process inventory');
      return normalize(row.CommandLine || '');
    });
  }
  return output.split('\n').map(line => {
    const item = /^\s*\d+\s+(.*)$/.exec(line);
    if (!item) throw new Error('Invalid process inventory');
    return item[1];
  });
}

function askHost(message, expectedResponse) {
  return new Promise((resolve, reject) => {
    parentPort.once('message', response => {
      if (response?.type !== expectedResponse || typeof response.busy !== 'boolean') {
        reject(new Error('Invalid cleanup worker response'));
        return;
      }
      resolve(response.busy);
    });
    parentPort.postMessage(message);
  });
}

function verifiedActive() {
  const active = versions.readActiveManifest(rootDir, entry);
  if (active?.mode !== 'auto') return null;
  for (const locator of [active.selected, active.previous].filter(Boolean)) {
    const prepared = versions.readPrepared(rootDir, { ...entry, version: locator.version });
    if (!prepared || !['portable', 'legacy-npm'].includes(prepared.installMode)
      || prepared.path !== locator.path || (prepared.integrity || null) !== (locator.integrity || null)) return null;
    if (!readInstalledState(rootDir, entry, prepared).installed) return null;
  }
  const installed = readInstalledState(rootDir, entry);
  if (!installed.installed || installed.config?.env?.AILY_SUBAPP_SOURCE !== 'version-store'
    || ![active.selected.version, active.previous?.version].includes(installed.installedVersion)) return null;
  return active;
}

function cachedVersion() {
  const cache = readOwnedJson(path.join(rootDir, 'subapp-index.json'), INDEX_MAX_BYTES);
  if (cache === undefined) return null;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('Invalid cleanup catalog');
  const cached = cache[entry.id];
  if (cached === undefined) return null;
  if (typeof cached?.package !== 'string' || typeof cached.version !== 'string'
    || semver.valid(cached.version) !== cached.version) throw new Error('Invalid cleanup catalog entry');
  return cached.package === entry.package ? cached.version : null;
}

async function run() {
  const parent = versions.storeRoot(rootDir, entry, { optional: true });
  if (!parent) return false;

  let retry = false;
  const retired = directoryEntries(parent)
    .filter(item => item.isDirectory() && RETIRED_DIRECTORY.test(item.name))
    .map(item => path.join(parent, item.name));
  for (const directory of retired) {
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch { retry = true; }
  }

  const selector = path.join(parent, 'active.json');
  const selectionIdentity = fileIdentity(selector);
  const active = verifiedActive();
  if (!active) return retry;
  // An older catalog may still be open in another host. Only retire releases
  // below both verified launch choices, where they cannot qualify as updates.
  const allowed = version => version !== entry.version
    && semver.lt(version, active.selected.version)
    && (!active.previous || semver.lt(version, active.previous.version));
  const previousCache = cachedVersion();
  const candidates = versions.collectObsoleteVersions(rootDir, entry)
    .filter(item => allowed(item.version) && item.version !== previousCache)
    .map(item => ({ ...item, identity: fileIdentity(item.directory) }));
  if (!candidates.length) return retry;
  if (storeIsBusy() || fileIdentity(selector) !== selectionIdentity) return true;

  const commands = customProcessInventory ? [] : readProcessCommands();
  const router = normalize('subapp-bin-router.cjs');
  if (commands.some(command => command.includes(router) && command.includes(normalize(entry.package)))) return true;

  const available = [];
  for (const item of candidates) {
    if (!item.identity || fileIdentity(item.directory) !== item.identity) {
      retry = true;
      continue;
    }
    const locations = [...new Set([item.directory, fs.realpathSync(item.directory)].map(normalize))];
    const busy = customProcessInventory
      ? await askHost({ type: 'process-query', directory: item.directory }, 'process-result')
      : commands.some(command => locations.some(directory => command.includes(directory)));
    if (busy) retry = true;
    else available.push(item);
  }
  if (!available.length) return retry;
  if (await askHost({ type: 'ready' }, 'decision')) return true;

  const detached = [];
  for (const item of available) {
    if (storeIsBusy() || !verifiedActive()) {
      retry = true;
      break;
    }
    const referenced = versions.referencedVersions(rootDir, entry);
    const currentCache = cachedVersion();
    if (referenced.has(item.version) || item.version === currentCache
      || fileIdentity(item.directory) !== item.identity) {
      retry = true;
      continue;
    }
    if (fileIdentity(selector) !== selectionIdentity) {
      retry = true;
      break;
    }
    const destination = path.join(parent, `.retired-${randomUUID()}`);
    try {
      fs.renameSync(item.directory, destination);
      detached.push(destination);
    } catch {
      retry = true;
    }
  }
  for (const directory of detached) {
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch { retry = true; }
  }
  return retry;
}

function finish(retry) {
  parentPort.postMessage({ type: 'complete', retry });
  parentPort.close();
}

run().then(finish, () => finish(true));
