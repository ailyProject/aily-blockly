'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { childScriptPath } = require('./child-script-path');

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const buildToken = new RegExp('^AilyDarwinBuild-' + uuid + '$');
const buildBoot = new RegExp('^darwin:' + uuid + '$');

function runtime() {
  if (process.platform !== 'darwin') return null;
  const runner = childScriptPath('darwin-managed-build-runner.js');
  const executable = process.versions.electron
    ? require('./tools/managed-npm-cli').getChildNodeExecutable(path.dirname(path.dirname(runner)))
    : process.execPath;
  if (!path.isAbsolute(executable)) return null;
  try {
    fs.accessSync(executable, fs.constants.X_OK);
    fs.accessSync(runner, fs.constants.R_OK);
    return { executable, runner };
  } catch { return null; }
}

function validProof(proof) {
  return proof?.version === 1 && proof.kind === 'darwin-build-group'
    && typeof proof.job === 'string' && buildToken.test(proof.job)
    && typeof proof.bootId === 'string' && buildBoot.test(proof.bootId)
    && typeof proof.receiptPath === 'string' && path.isAbsolute(proof.receiptPath)
    && !proof.receiptPath.includes('\0');
}

function start(file, args, { stdio = 'pipe', ...options } = {}, { bootId, receiptPath, publish }, register) {
  const local = runtime();
  if (!local) throw Object.assign(new Error('macOS build supervision is unavailable.'), { code: 'BUILD_SUPERVISOR_UNAVAILABLE' });
  const proof = { version: 1, kind: 'darwin-build-group', job: 'AilyDarwinBuild-' + randomUUID(), bootId, receiptPath };
  if (!validProof(proof) || typeof publish !== 'function' || !Array.isArray(args) || options.shell) {
    throw new Error('Invalid macOS build supervision request.');
  }
  const streams = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
  if (streams.length > 4 || (streams.length === 4 && streams[3] !== 'ipc')) {
    throw new Error('Unsupported macOS managed build stdio.');
  }
  const monitorEnv = { ...process.env };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete monitorEnv[key];
  const child = spawn(local.executable, [local.runner, 'monitor', proof.job, proof.receiptPath], {
    cwd: options.cwd,
    env: monitorEnv,
    detached: true,
    stdio: [streams[0] ?? 'pipe', streams[1] ?? 'pipe', streams[2] ?? 'pipe', 'ipc'],
    serialization: options.serialization,
  });
  if (!child.pid) return child;

  // This process has only opened its private control channel. Its compiler
  // gate remains closed if publication fails or this host exits at this point.
  try { publish(proof); }
  catch (error) {
    if (child.connected) child.disconnect();
    throw error;
  }
  register(child, proof);
  child.send({ file, args, env: options.env ?? process.env, argv0: options.argv0,
    relay: streams[3] === 'ipc', serialization: options.serialization }, error => {
    if (error && child.connected) child.disconnect();
  });
  return child;
}

module.exports = { runtime, validProof, validBoot: value => typeof value === 'string' && buildBoot.test(value), start };
