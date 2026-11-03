// Lamport bakery lock for local macOS/Windows processes, without a shared file to unlink.
// Each attempt owns one UUID directory. Dead owners are ignored, never removed by another
// process; therefore stale recovery cannot accidentally delete a newly acquired lock.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { processStartedAt } = require('./subapp-process-identity');

function nativeLock(filename) {
  const childRoot = process.env.AILY_CHILD_PATH || path.join(__dirname, '..', 'child');
  return require(path.join(childRoot, 'scripts/native-file-lock.js')).tryAcquireFileLock(filename);
}

const CONTENDER_PATTERN = /^([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission failures cannot authorize entering another process's critical section.
    return error.code !== 'ESRCH';
  }
}

function readTicket(contender) {
  let stat;
  try { stat = fs.lstatSync(contender.directory); } catch (error) {
    if (error.code === 'ENOENT') return { gone: true };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe subapp lock contender');
  const file = path.join(contender.directory, 'ticket.json');
  try {
    const ticketStat = fs.lstatSync(file);
    if (ticketStat.isSymbolicLink() || !ticketStat.isFile()) throw new Error('Unsafe subapp lock ticket');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.schemaVersion !== 1 || record.pid !== contender.pid || record.token !== contender.token
      || !Number.isSafeInteger(record.ticket) || record.ticket < 1) {
      throw new Error('Invalid subapp lock ticket');
    }
    return { ticket: record.ticket };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Missing ticket means this participant is still choosing (or finishing release).
    return { choosing: true };
  }
}

function guardPath(root, contender) {
  return path.join(root, '..', '.guards', `${contender.pid}-${contender.token}`);
}

function contenderIsActive(root, contender, options) {
  const guard = guardPath(root, contender);
  if (fs.existsSync(guard)) {
    // An unlocked guard proves release/crash even if the PID is now reused or
    // Windows prevented removing the old directory. Never infer this from age.
    try {
      const probe = nativeLock(guard);
      if (!probe) return true;
      probe.close();
      return false;
    } catch (error) {
      if (!fs.existsSync(contender.directory)) return false;
      throw error;
    }
  }
  if (!processIsAlive(contender.pid)) return false;
  // Old hosts did not create guards. Respect live/unknown old owners, but do
  // not confuse a newly created process with the owner of an older directory.
  const started = (options.processStartedAt || processStartedAt)(contender.pid);
  try {
    const created = fs.lstatSync(contender.directory).birthtimeMs;
    return !(Number.isFinite(started) && created > 0 && started > created + 2000);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function contenders(directory) {
  return fs.readdirSync(directory).flatMap(name => {
    const match = CONTENDER_PATTERN.exec(name);
    if (!match) return [];
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) throw new Error('Invalid subapp lock owner');
    return [{ pid, token: match[2], directory: path.join(directory, name) }];
  });
}

function ownDirectoryStillMatches(own, identity) {
  try {
    const stat = fs.lstatSync(own.directory);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeOwnContender(own, identity, requireTicket) {
  if (!ownDirectoryStillMatches(own, identity)) return false;
  let state;
  try { state = readTicket(own); } catch {
    // A replaced or corrupted token is not ours to delete.
    return false;
  }
  if (state.gone || (requireTicket && state.choosing)) return false;
  fs.rmSync(own.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  return true;
}

/**
 * Try once; return an idempotent release function or null when another process wins.
 * No synchronous sleeps. The caller can retry asynchronously with its normal deadline.
 * options.onPhase is an optional diagnostic hook used to force real process interleavings.
 */
function acquireInstallLock(directory, options = {}) {
  const root = path.join(directory, '.contenders');
  fs.mkdirSync(root, { recursive: true });
  const token = randomUUID();
  const own = { pid: process.pid, token, directory: path.join(root, `${process.pid}-${token}`) };
  fs.mkdirSync(path.join(root, '..', '.guards'), { recursive: true });
  const guard = nativeLock(guardPath(root, own));
  if (!guard) throw new Error('Unable to acquire new subapp owner guard');
  let identity;
  let acquired = false;
  const release = () => {
    // Close the OS handle before best-effort garbage collection. A failed rm
    // must not leave an active lock, and a second release can retry cleanup.
    guard.close();
    try {
      if (identity) removeOwnContender(own, identity, false);
      if (!fs.existsSync(own.directory)) fs.rmSync(guardPath(root, own), { force: true });
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      options.onCleanupError?.(error);
    }
  };
  try {
    fs.mkdirSync(own.directory);
    identity = fs.lstatSync(own.directory);
    options.onPhase?.('choosing', { ...own });
    let maximum = 0;
    for (const other of contenders(root)) {
      if (other.directory === own.directory || !contenderIsActive(root, other, options)) continue;
      const state = readTicket(other);
      if (state.ticket) maximum = Math.max(maximum, state.ticket);
    }
    if (!Number.isSafeInteger(maximum + 1)) throw new Error('Subapp lock ticket range exhausted');
    const ticket = maximum + 1;
    options.onPhase?.('numbered', { ...own, ticket });
    const temporary = path.join(own.directory, 'ticket.tmp');
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, pid: process.pid, token, ticket }), {
      flag: 'wx', mode: 0o600,
    });
    fs.renameSync(temporary, path.join(own.directory, 'ticket.json'));
    options.onPhase?.('ticket', { ...own, ticket });

    // This second snapshot must happen after publishing our ticket. A participant that
    // joins after this snapshot will see our ticket and choose a strictly larger one.
    for (const other of contenders(root)) {
      if (other.directory === own.directory || !contenderIsActive(root, other, options)) continue;
      const state = readTicket(other);
      const otherFirst = other.token < token || (other.token === token && other.pid < own.pid);
      if (state.choosing || (state.ticket
        && (state.ticket < ticket || (state.ticket === ticket && otherFirst)))) {
        return null;
      }
    }
    options.onPhase?.('acquired', { ...own, ticket });
    acquired = true;
    return release;
  } finally {
    if (!acquired) release();
  }
}

module.exports = { acquireInstallLock };
