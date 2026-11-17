'use strict';
const childProcess = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const records = new Set();
const byProcess = new WeakMap();
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
    // Terminating an empty/new Job also seals it: a gate that has not bound yet
    // cannot execute a target after cancellation returned successfully.
    if (!record.jobReleased) record.binding.terminate(record.handle);
    // A gate still outside the Job is killed through its original process
    // handle. Never send a signal using a guessed root PID.
    if (!record.pty && child.exitCode === null && child.signalCode === null) child.kill();
    while (!record.jobReleased && record.binding.query(record.handle).active !== 0) {
      if (Date.now() - started > 5000) return false;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    if (!record.jobReleased) { record.binding.release(record.handle);record.jobReleased = true; }
    if (record.pty && !record.ptyDisposed) {
      await require('./windows-pty-disposal').disposeStoppedPty(child);record.ptyDisposed = true;
    }
    if (!record.exited) {
      let timer;
      const acknowledged = await Promise.race([record.exitAcknowledged.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
      if (!acknowledged) return false;
    }
    record.released = true;records.delete(record);
    console.info('[PROC_TRACE][JOB_STOP]', { pid: child.pid, success: true, durationMs: Date.now() - started });
    return true;
  })().finally(() => { record.stopPromise = null; });
  return record.stopPromise;
}
async function stopAllOwnedProcesses() { return (await Promise.all([...records].map(record => stopOwnedProcess(record.child)))).every(Boolean); }
function getOwnedProcessInfo(child) {
  const record = byProcess.get(child);if (!record) return null;
  let accounting;
  try { accounting = record.jobReleased || record.released ? { active: 0, pids: [] } : record.binding.query(record.handle); }
  catch (error) { accounting = { active: null, pids: [], error: error.message }; }
  return { pid: child.pid, released: record.released, ...accounting };
}
module.exports = { spawn, fork, spawnPty, stopOwnedProcess, stopAllOwnedProcesses, getOwnedProcessInfo, runtime };
