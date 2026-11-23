'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: wait } = require('node:timers/promises');
const records = new Set();
const byProcess = new WeakMap();
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const buildBoot = new RegExp('^win32:' + uuid + '$');
const buildName = new RegExp('^Global\\\\AilyBuild-' + uuid + '$');
const buildStopTimeout = 5000;
let native, unavailable = false;
function runtime() {
  if (process.platform !== 'win32' || unavailable) return null;
  if (!native) {
    try {
      const directory = path.join(__dirname, 'native/windows-process', process.arch).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
      native = { binding: require(path.join(directory, 'aily-job.node')), launcher: path.join(directory, 'aily-job-launcher.exe') };
    } catch (error) {
      unavailable = true;
      console.warn('[PROC_TRACE][JOB_UNAVAILABLE]', { error: error.message });
    }
  }
  return native;
}
function normalize(file, args, options) {
  if (!Array.isArray(args)) { options = args || {}; args = []; }
  options = { ...(options || {}) };args = [...args];
  let verbatim = options.windowsVerbatimArguments === true;
  if (options.shell) {
    const command = [file, ...args].join(' ');
    file = typeof options.shell === 'string' ? options.shell : process.env.comspec || 'cmd.exe';
    if (/^(?:.*\\)?cmd(?:\.exe)?$/i.test(file)) { args = ['/d', '/s', '/c', `"${command}"`]; verbatim = true; }
    else args = ['-c', command];
  }
  return { file, args, verbatim, options: { ...options, shell: false, windowsVerbatimArguments: false, detached: false } };
}
function prepare(file, args, options) {
  const rt = runtime();if (!rt) return null;
  const name = 'Local\\AilyTask-' + randomUUID();
  // If creation fails, no launcher or user command has run: the original spawn
  // can safely be used once. Once the gate starts, failures are never replayed.
  let handle;
  try { handle = rt.binding.create(name); }
  catch (error) { console.warn('[PROC_TRACE][JOB_CREATE_FALLBACK]', { error: error.message }); return null; }
  const normalized = normalize(file, args, options);
  return { ...normalized, ...rt, handle, name, released: false, stopPromise: null };
}
function register(child, record, pty = false) {
  if (!child?.pid) { record.binding.release(record.handle); return child; }
  record.child = child;record.pty = pty;records.add(record);byProcess.set(child, record);
  let resolveExit;
  record.exitAcknowledged = new Promise(resolve => { resolveExit = resolve; });
  const completed = () => {
    record.exited = true;resolveExit();
    // Even a failed launcher must not cause its still-owned descendants to be
    // forgotten. Native accounting, rather than a recycled PID, owns cleanup.
    void stopOwnedProcess(child).catch(error => console.warn('[PROC_TRACE][JOB_CLEANUP_FAILED]', { pid: child.pid, error: error.message }));
  };
  if (pty) child.onExit(completed);else child.once('exit', completed);
  console.info('[PROC_TRACE][JOB_SPAWN]', { pid: child.pid, command: record.file });
  return child;
}
function spawn(file, args, options) {
  if (!Array.isArray(args)) { options = args || {}; args = []; }
  const record = prepare(file, args, options);
  if (!record) return childProcess.spawn(file, args, options);
  try { return register(childProcess.spawn(record.launcher, [record.name, String((record.verbatim ? 1 : 0) | (record.options.windowsHide ? 2 : 0)), record.file, record.options.argv0 || record.file, ...record.args], record.options), record); }
  catch (error) { record.binding.release(record.handle);throw error; }
}
function managedBuildRuntime() {
  const rt = runtime();
  if (typeof rt?.binding.openBuildJob !== 'function' || typeof rt.binding.buildHostState !== 'function') {
    throw Object.assign(new Error('Windows build Job supervision is unavailable.'), { code: 'BUILD_SUPERVISOR_UNAVAILABLE' });
  }
  return rt;
}
function validBuildProof(proof) {
  return proof?.version === 1 && proof.kind === 'windows-build-job'
    && typeof proof.job === 'string' && buildName.test(proof.job)
    && Number.isInteger(proof.hostPid) && proof.hostPid > 0 && proof.hostPid <= 0xffffffff
    && typeof proof.hostCreation === 'string' && /^\d{1,20}$/.test(proof.hostCreation)
    && buildBoot.test(proof.bootId) && typeof proof.receiptPath === 'string'
    && path.isAbsolute(proof.receiptPath) && !proof.receiptPath.includes('\0');
}
function writeBuildTag(filename, job) {
  let fd;
  try {
    fd = fs.openSync(filename, 'wx', 0o600);
    fs.writeFileSync(fd, job);
    fs.fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function readBuildReceipt(proof) {
  try {
    const stat = fs.lstatSync(proof.receiptPath);
    return stat.isFile() && stat.nlink === 1 && stat.size === proof.job.length
      && fs.readFileSync(proof.receiptPath, 'utf8') === proof.job;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}
function publishBuildReceipt(proof) {
  if (readBuildReceipt(proof)) return true;
  const temporary = proof.receiptPath + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, proof.job); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const { childScriptPath } = require('./child-script-path');
    const { renameForAtomicReplace } = require(childScriptPath('atomic-replace.js'));
    // A crashed monitor may have left a partial receipt. Publish only after
    // the original Job is known stopped, then replace the incomplete file.
    renameForAtomicReplace(temporary, proof.receiptPath);
    return true;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function spawnManagedBuild(file, args, options, { bootId, receiptPath, publish }) {
  const rt = managedBuildRuntime();
  const name = 'Global\\AilyBuild-' + randomUUID();
  const proof = { version: 1, kind: 'windows-build-job', job: name, hostPid: process.pid,
    hostCreation: rt.binding.identity(), bootId, receiptPath };
  if (!validBuildProof(proof) || typeof publish !== 'function') throw new Error('Invalid managed build Job publication.');
  const normalized = normalize(file, args, options);
  const handle = rt.binding.create(name);
  const record = { ...normalized, ...rt, handle, name, durable: proof, released: false, stopPromise: null };
  let child;
  try {
    // The compiler's native gate starts only after the original authority is
    // on disk. This path must not fall back to an unowned compiler.
    publish(proof);
    const flags = (record.verbatim ? 1 : 0) | (record.options.windowsHide ? 2 : 0);
    // The monitor must outlive libuv's host-owned Job long enough to prove
    // that the compiler Job is empty. It still exits when the host disappears.
    child = childProcess.spawn(record.launcher, ['--monitor-build', String(proof.hostPid),
      proof.hostCreation, receiptPath, name, String(flags), record.file, record.options.argv0 || record.file,
      ...record.args], { ...record.options, detached: true });
  } catch (error) {
    try { publishBuildReceipt(proof); } finally { rt.binding.release(handle); }
    throw error;
  }
  if (!child.pid) {
    try { publishBuildReceipt(proof); } finally { rt.binding.release(handle); }
    return child;
  }
  return register(child, record);
}
async function stopManagedBuild(proof, currentBootId, { observeOnly = false } = {}) {
  if (!validBuildProof(proof) || typeof currentBootId !== 'string' || !buildBoot.test(currentBootId)) return false;
  if (proof.bootId !== currentBootId) return true;
  const { binding } = managedBuildRuntime();
  const local = [...records].find(record => record.durable?.job === proof.job
    && record.durable.receiptPath === proof.receiptPath && record.durable.hostCreation === proof.hostCreation
    && record.durable.hostPid === proof.hostPid);
  if (readBuildReceipt(proof)) return true;
  if (local) {
    if (observeOnly) {
      return local.exited === true && (local.jobReleased || binding.query(local.handle).active === 0)
        && publishBuildReceipt(proof);
    }
    return stopOwnedProcess(local.child);
  }

  // A replaced PID identifies neither a live old host nor any stop target.
  // A foreign live host retains its original admission authority.
  const state = binding.buildHostState(proof.hostPid, proof.hostCreation);
  if (state !== 'exited' && state !== 'different') return false;
  if (!observeOnly) writeBuildTag(proof.receiptPath + '.stop', proof.job);
  const handle = binding.openBuildJob(proof.job);
  if (!handle) {
    if (readBuildReceipt(proof)) return true;
    // A named kernel object's entry can disappear when its last handle is
    // closed, before all pointer references are gone. Missing is definitive
    // here only when the stopped host's monitor never admitted a writer.
    try { fs.lstatSync(proof.receiptPath + '.admitted'); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return publishBuildReceipt(proof);
  }
  try {
    if (observeOnly) return binding.query(handle).active === 0 && publishBuildReceipt(proof);
    binding.terminate(handle);
    const deadline = Date.now() + buildStopTimeout;
    while (binding.query(handle).active !== 0) {
      if (Date.now() >= deadline) return false;
      await wait(5);
    }
    return publishBuildReceipt(proof);
  } finally {
    binding.release(handle);
  }
}
function fork(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args || {};args = []; }
  options = { ...(options || {}) };
  const executable = options.execPath || process.execPath;
  let execArgv = options.execArgv || process.execArgv;
  if (options.execArgv === undefined && process._eval != null) {
    const index = execArgv.lastIndexOf(process._eval);
    if (index > 0) { execArgv = [...execArgv];execArgv.splice(index - 1, 2); }
  }
  const record = prepare(executable, [], options);
  if (!record) return childProcess.fork(modulePath, args, options);
  try {
    return register(childProcess.fork(modulePath, args, { ...options, detached: false, execPath: record.launcher,
      execArgv: [record.name, options.windowsHide ? '2' : '0', executable, executable, ...execArgv] }), record);
  } catch (error) { record.binding.release(record.handle);throw error; }
}
function spawnPty(pty, file, args, options) {
  const record = prepare(file, args, options);if (!record) return pty.spawn(file, args, options);
  try { return register(pty.spawn(record.launcher, [record.name, '0', record.file, record.file, ...record.args], options), record, true); }
  catch (error) { record.binding.release(record.handle);throw error; }
}
async function stopOwnedProcess(child) {
  const record = byProcess.get(child);if (!record) return null;
  if (record.released) return true;
  if (record.stopPromise) return record.stopPromise;
  record.stopPromise = (async () => {
    const started = Date.now();
    const drained = record.durable && record.exited && readBuildReceipt(record.durable);
    if (record.durable && !drained) writeBuildTag(record.durable.receiptPath + '.stop', record.name);
    // Terminating an empty/new Job also seals it: a gate that has not bound yet
    // cannot execute a target after cancellation returned successfully.
    if (!record.jobReleased && !drained) record.binding.terminate(record.handle);
    // A gate still outside the Job is killed through its original process
    // handle. Never send a signal using a guessed root PID.
    if (!record.durable && !record.pty && child.exitCode === null && child.signalCode === null) child.kill();
    if (record.durable && !record.exited && !await waitForChildExit(record)) return false;
    while (!record.jobReleased && record.binding.query(record.handle).active !== 0) {
      if (Date.now() - started > 5000) return false;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    if (record.durable && !drained) publishBuildReceipt(record.durable);
    if (!record.jobReleased) { record.binding.release(record.handle);record.jobReleased = true; }
    if (record.pty && !record.ptyDisposed) {
      await require('./windows-pty-disposal').disposeStoppedPty(child);record.ptyDisposed = true;
    }
    if (!record.exited) {
      if (!await waitForChildExit(record)) return false;
    }
    record.released = true;records.delete(record);
    console.info('[PROC_TRACE][JOB_STOP]', { pid: child.pid, success: true, durationMs: Date.now() - started });
    return true;
  })().finally(() => { record.stopPromise = null; });
  return record.stopPromise;
}
function waitForChildExit(record) {
  let timer;
  return Promise.race([record.exitAcknowledged.then(() => true),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
}
async function stopAllOwnedProcesses() { return (await Promise.all([...records].map(record => stopOwnedProcess(record.child)))).every(Boolean); }
function getOwnedProcessInfo(child) {
  const record = byProcess.get(child);if (!record) return null;
  let accounting;
  try { accounting = record.jobReleased || record.released ? { active: 0, pids: [] } : record.binding.query(record.handle); }
  catch (error) { accounting = { active: null, pids: [], error: error.message }; }
  return { pid: child.pid, released: record.released, ...accounting };
}
module.exports = { spawn, spawnManagedBuild, stopManagedBuild, fork, spawnPty, stopOwnedProcess, stopAllOwnedProcesses, getOwnedProcessInfo, runtime };
