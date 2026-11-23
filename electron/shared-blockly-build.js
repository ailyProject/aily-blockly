'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { childScriptPath } = require('./child-script-path');
const { normalizeBuildProduct } = require('./build-product');

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const same = (first, second) => first.toLowerCase() === second.toLowerCase();
const fault = (code, message) => Object.assign(new Error(message), { code });
const source = filename => require(childScriptPath(filename));

function sharedBlocklyBuildEnabled() {
  return process.platform === 'win32' && process.arch === 'x64'
    && normalizeBuildProduct(process.env.AILY_BUILD_PRODUCT) === 'blockly';
}

function sharedBuildCommand(options) {
  if (!sharedBlocklyBuildEnabled() || !options.buildWorkspace || !Array.isArray(options.args) || options.args.length !== 2) return;
  const [script, request] = options.args;
  if (typeof script !== 'string' || typeof request !== 'string' || !path.isAbsolute(request)) return;
  const operation = { 'compile.js': 'compile', 'preprocess.js': 'preprocess', 'upload.js': 'upload' }[path.basename(script)];
  const name = path.basename(request);
  const expectedName = operation === 'upload' ? name.startsWith('upload-request-') && name.endsWith('.json')
    && UUID.test(name.slice(15, -5)) : name === 'config.json';
  if (!operation || !expectedName || !UUID.test(path.basename(path.dirname(request)))
    || !path.isAbsolute(options.buildWorkspace)) return;
  const project = fs.realpathSync(options.buildWorkspace);
  if (!same(path.dirname(path.dirname(request)), path.join(project, '.aily', 'build-executions'))) return;
  if (!options.projectPath || !same(fs.realpathSync(options.projectPath), project) || options.shellProfile !== false
    || !['node', process.execPath].includes(options.command)
    || !same(fs.realpathSync(script), fs.realpathSync(childScriptPath(operation + '.js')))) {
    throw fault('BUILD_WORKSPACE_INVALID', 'Shared build must run the original prepared command for this project.');
  }
  if (operation !== 'upload') return source('build-execution-workspace.js').validateSharedBuildLaunch(request, project, operation);
  if (!same(fs.realpathSync(request), request)) throw fault('BUILD_WORKSPACE_INVALID', 'The upload request is linked.');
  const stat = fs.lstatSync(request);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) {
    throw fault('BUILD_WORKSPACE_INVALID', 'The upload request is invalid.');
  }
  const config = JSON.parse(fs.readFileSync(request, 'utf8')), reference = config.buildExecution;
  if (reference?.layout !== 'shared' || reference.executionId !== path.basename(path.dirname(request))
    || typeof reference.buildRequestId !== 'string' || !same(reference.logicalProjectPath || '', project)
    || !same(config.currentProjectPath || '', project)) {
    throw fault('BUILD_WORKSPACE_INVALID', 'The upload request does not identify the shared build.');
  }
  return { execution: { id: reference.executionId, buildRequestId: reference.buildRequestId, operation } };
}

function storePath(project) {
  const data = process.env.AILY_APPDATA_PATH;
  if (!data || !path.isAbsolute(data)) throw fault('BUILD_WORKSPACE_INVALID', 'The build supervisor storage is unavailable.');
  const directory = path.join(fs.realpathSync(data), '.lock', 'shared-blockly-build');
  fs.mkdirSync(directory, { recursive: true });
  if (!same(fs.realpathSync(directory), directory)) throw fault('BUILD_WORKSPACE_INVALID', 'The build supervisor storage is linked.');
  const name = createHash('sha256').update(project.toLowerCase()).digest('hex');
  return { directory, name, record: path.join(directory, name + '.json'), guard: path.join(directory, name + '.guard') };
}

function readBinding(store, project) {
  const stat = fs.lstatSync(store.record, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192)
    throw fault('BUILD_WORKSPACE_INVALID', 'The original build owner record is invalid.');
  const entry = JSON.parse(fs.readFileSync(store.record, 'utf8'));
  if (entry.version !== 1 || typeof entry.project !== 'string' || !same(entry.project, project)
    || !UUID.test(entry.supervisor) || !UUID.test(entry.execution?.id) || typeof entry.execution?.buildRequestId !== 'string'
    || !['compile', 'preprocess', 'upload'].includes(entry.execution.operation)
    || entry.proof?.receiptPath !== receiptPath(store, entry.supervisor)) {
    throw fault('BUILD_WORKSPACE_INVALID', 'The original build owner does not match this project.');
  }
  return entry;
}

function receiptPath(store, supervisor) {
  return path.join(store.directory, store.name + '-' + supervisor + '.drained.json');
}

function publishBinding(store, entry) {
  const temporary = store.record + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(entry)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    source('atomic-replace.js').renameForAtomicReplace(temporary, store.record);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function pruneDrainedProofFiles({ receiptPath, job }) {
  const { isWindowsSharingError, retryDeferredWindowsFile } = source('atomic-replace.js');
  for (const suffix of ['', '.admitted', '.stop']) {
    const filename = receiptPath + suffix;
    try { fs.rmSync(filename, { force: true }); }
    catch (error) {
      if (!isWindowsSharingError(error)) throw error;
      const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw error;
      if (!stat) continue;
      const matches = () => {
        const current = fs.lstatSync(filename, { throwIfNoEntry: false });
        return current?.isFile() && current.nlink === 1 && current.dev === stat.dev && current.ino === stat.ino
          && current.size === job.length && current.ctimeMs === stat.ctimeMs;
      };
      retryDeferredWindowsFile(() => {
        if (matches() && fs.readFileSync(filename, 'utf8') === job && matches()) fs.unlinkSync(filename);
      });
    }
  }
}

async function withSharedBuildAdmission(projectPath, { signal, assertCurrent, beforeStop, operation }, run) {
  const project = fs.realpathSync(projectPath);
  const store = storePath(project);
  const { tryAcquireFileLock } = source('native-file-lock.js');
  const deadline = Date.now() + 12000;
  let guard;
  try {
    while (!guard) {
      signal?.throwIfAborted();
      guard = tryAcquireFileLock(store.guard);
      if (guard) break;
      if (Date.now() >= deadline) throw fault('BUILD_WORKSPACE_BUSY', 'Another build is still settling this project.');
      await delay(50, undefined, { signal });
    }
    guard.assertHeld();
    signal?.throwIfAborted();
    assertCurrent?.();
    const bootId = source('system-boot-id.js').getSystemBootId();
    const previous = readBinding(store, project);
    if (!bootId && (previous || operation !== 'clean')) {
      throw fault('BUILD_BOOT_ID_UNAVAILABLE', 'The current Windows boot identity could not be verified. No managed build was dispatched.');
    }
    if (previous) {
      const observeOnly = operation === 'preprocess' || operation === 'upload' || previous.execution.operation === 'upload';
      if (!observeOnly) beforeStop?.(previous);
      if (!await require('./owned-process').stopManagedBuild(previous.proof, bootId, { observeOnly })) {
        throw fault('BUILD_WORKSPACE_RECOVERY_REQUIRED', 'Could not verify that the original build process tree has stopped.');
      }
      guard.assertHeld();
      if (!source('build-workspace-lease.js').releaseManagedBuildWorkspace(project, previous.supervisor)) {
        throw fault('BUILD_WORKSPACE_BUSY', 'The original build ownership is still settling.');
      }
      if (previous.execution.operation !== 'upload') {
        source('build-execution-workspace.js').settleStoppedSharedBuild(project, previous.execution);
      }
      fs.unlinkSync(store.record);
      // The released supervisor's exact proof files are no longer authority.
      pruneDrainedProofFiles(previous.proof);
    }
    signal?.throwIfAborted();
    return await run({
      project, bootId,
      bind(supervisor, streamId, execution) {
        if (!UUID.test(supervisor)) throw fault('BUILD_WORKSPACE_INVALID', 'The build supervisor is missing.');
        const { id, buildRequestId, operation } = execution;
        return { bootId, receiptPath: receiptPath(store, supervisor),
          publish(proof) {
            guard.assertHeld();
            if (proof.receiptPath !== receiptPath(store, supervisor)) {
              throw fault('BUILD_WORKSPACE_INVALID', 'The native build owner did not retain its original receipt path.');
            }
            publishBinding(store, { version: 1, project, supervisor, streamId, execution: { id, buildRequestId, operation }, proof });
          } };
      },
    });
  } finally { guard?.close(); }
}

module.exports = { sharedBlocklyBuildEnabled, sharedBuildCommand, withSharedBuildAdmission };
