// Lamport bakery lock for local macOS/Windows processes, without a shared file to unlink.
// Each attempt owns one UUID directory. Dead owners are ignored, never removed by another
// process; therefore stale recovery cannot accidentally delete a newly acquired lock.
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

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
  fs.rmSync(own.directory, { recursive: true, force: true });
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
  fs.mkdirSync(own.directory);
  const identity = fs.lstatSync(own.directory);
  let acquired = false;
  try {
    options.onPhase?.('choosing', { ...own });
    let maximum = 0;
    for (const other of contenders(root)) {
      if (other.directory === own.directory || !processIsAlive(other.pid)) continue;
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
      if (other.directory === own.directory || !processIsAlive(other.pid)) continue;
      const state = readTicket(other);
      const otherFirst = other.token < token || (other.token === token && other.pid < own.pid);
      if (state.choosing || (state.ticket
        && (state.ticket < ticket || (state.ticket === ticket && otherFirst)))) {
        return null;
      }
    }
    options.onPhase?.('acquired', { ...own, ticket });
    acquired = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      removeOwnContender(own, identity, true);
    };
  } finally {
    if (!acquired) removeOwnContender(own, identity, false);
  }
}

module.exports = { acquireInstallLock };
