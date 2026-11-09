"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(snapshot) {
  const handlers = new Map(),
    snapshots = [],
    taskkills = [],
    logs = [];
  let snapshotCalls = 0;
  const original = Object.assign(new EventEmitter(), {
    pid: 100,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  const treeModule = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "electron/process-tree.js"), "utf8"),
    {
      module: treeModule,
      process: { env: { SystemRoot: "C:\\Windows" } },
      console: {
        info: (_tag, value) => logs.push(value),
        warn: (_tag, value) => logs.push(value),
      },
      setTimeout: (callback) => setImmediate(callback),
      require(name) {
        if (name === "./platform") return { isWin32: true };
        if (name === "node:path") return path;
        if (name === "child_process")
          return {
            exec(command, _options, callback) {
              taskkills.push(command);
              callback(
                new Error("The process was not found."),
                "",
                "The process was not found.",
              );
            },
            execFile(_exe, _args, _options, callback) {
              if (++snapshotCalls === 1) snapshots.push(callback);
              else if (snapshot instanceof Error) callback(snapshot, "");
              else callback(null, JSON.stringify(snapshot));
            },
          };
        throw new Error(name);
      },
    },
  );
  const npmModule = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(root, "electron/npm.js"), "utf8"),
    {
      module: npmModule,
      process,
      AbortController,
      setTimeout,
      clearTimeout,
      console: { info() {}, log() {}, warn() {}, error() {} },
      require(name) {
        if (name === "electron")
          return {
            ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
          };
        if (name === "child_process") return { spawn: () => original };
        if (name === "./process-tree") return treeModule.exports;
        if (name === "./project-task-scope")
          return require("../../electron/project-task-scope");
        throw new Error(name);
      },
    },
  );
  npmModule.exports.registerNpmHandlers();
  const scope = {
    projectPath: path.resolve("bootstrap-owned-project"),
    projectSessionId: "original-session",
  };
  const run = handlers.get("npm-run")(
    { sender: owner },
    { cmd: "npm install fixture", ...scope },
  );
  // Stop observes the actual original registration; the fixture changes only
  // the OS ports and original ChildProcess close event, never its return value.
  const outcome = run.then(
    () => null,
    (error) => error,
  );
  const stopping = npmModule.exports.killOwnerProjectNpmProcesses(
    owner,
    scope.projectPath,
    scope.projectSessionId,
  );
  const releaseSnapshot = () => {
    assert.equal(snapshots.length, 1);
    const callback = snapshots.shift();
    if (snapshot instanceof Error) callback(snapshot, "");
    else callback(null, JSON.stringify(snapshot));
  };
  return {
    api: npmModule.exports,
    original,
    outcome,
    stopping,
    releaseSnapshot,
    taskkills,
    logs,
  };
}

test("an original npm normal close during Windows inspection settles without killing an absent PID", async () => {
  const f = fixture([]);
  f.original.emit("close", 0, null);
  await tick();
  assert.match((await f.outcome).message, /NPM_COMMAND_CANCELLED/);
  assert.equal(f.api.getActiveNpmProcesses().length, 1);
  f.releaseSnapshot();
  assert.equal(
    await f.stopping,
    true,
    "the original normal completion must not become a sticky unconfirmed kill",
  );
  assert.equal(
    f.taskkills.length,
    0,
    "a closed original PID must never be killed later",
  );
  assert.equal(f.api.getActiveNpmProcesses().length, 0);
});

for (const [name, snapshot, close] of [
  ["no original completion witness", [], undefined],
  ["an abnormal original close", [], [null, "SIGTERM"]],
  ["an unavailable process snapshot", new Error("CIM unavailable"), [0, null]],
  [
    "a PID now occupied by an unverifiable process",
    [{ pid: 100, parent: 1, created: "200" }],
    [0, null],
  ],
  [
    "an orphan that could still belong to the original command",
    [{ pid: 101, parent: 100, created: "101" }],
    [0, null],
  ],
])
  test(`Windows stop stays unresolved with ${name}`, async () => {
    const f = fixture(snapshot);
    if (close) f.original.emit("close", ...close);
    await tick();
    f.releaseSnapshot();
    assert.equal(await f.stopping, false);
    assert.equal(f.api.getActiveNpmProcesses().length, 1);
    if (close?.[0] === 0)
      assert.equal(
        f.taskkills.length,
        0,
        "do not retarget a PID after the original normal close",
      );
    if (!close) f.original.emit("close", null, "SIGTERM");
    assert.match((await f.outcome).message, /NPM_COMMAND_CANCELLED/);
  });
