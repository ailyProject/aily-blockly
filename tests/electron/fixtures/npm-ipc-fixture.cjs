'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

function npmIpcFixture({ acquireNpmMutation, native = false } = {}) {
  const handlers = new Map(), children = [], logs = [], kills = [];
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    send: (channel, payload) => logs.push({ channel, payload }) });
  const state = { kill: async () => true };
  const mainWindow = { isDestroyed: () => false, webContents: owner };
  const spawn = (...args) => {
    const child = native ? require('node:child_process').spawn(...args)
      : Object.assign(new EventEmitter(), { pid: 40000 + children.length,
        stdout: new EventEmitter(), stderr: new EventEmitter() });
    children.push(child);
    return child;
  };
  function load(file) {
    const filename = path.resolve(__dirname, '../../../electron', file);
    const requireFromSource = createRequire(filename);
    const dependencies = {
      electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
      child_process: { ...require('node:child_process'), spawn },
      './process-tree': { killRegisteredProcessTree: async pid => { kills.push(pid); return state.kill(pid); } },
      './npm-mutation-queue': { acquireNpmMutation },
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, __dirname: path.dirname(filename), process,
      require: name => dependencies[name] || requireFromSource(name),
      Buffer, AbortController, setTimeout, clearTimeout,
      console: { log() {}, info() {}, warn() {}, error() {} },
    }, { filename });
    return module.exports;
  }
  const npm = load('npm.js'), cmd = load('cmd.js');
  npm.registerNpmHandlers(mainWindow); cmd.registerCmdHandlers(mainWindow);
  return { npm, cmd, owner, state, children, logs, kills,
    runNpm: (options, sender = owner) => handlers.get('npm-run')({ sender }, options),
    runCmd: (options, sender = owner) => handlers.get('cmd-run')({ sender }, options),
  };
}
module.exports = { npmIpcFixture };
