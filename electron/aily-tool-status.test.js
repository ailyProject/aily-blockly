const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("Windows settings status handlers do not synchronously spawn tool probes", async (t) => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "aily-tool-status-"));
  fs.writeFileSync(path.join(prefix, "aily-builder.cmd"), "");
  fs.writeFileSync(path.join(prefix, "aily-linter.cmd"), "");
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }));

  const previousPrefix = process.env.AILY_NPM_PREFIX;
  const previousChildPath = process.env.AILY_CHILD_PATH;
  process.env.AILY_NPM_PREFIX = prefix;
  process.env.AILY_CHILD_PATH = prefix;
  t.after(() => {
    if (previousPrefix === undefined) {
      delete process.env.AILY_NPM_PREFIX;
    } else {
      process.env.AILY_NPM_PREFIX = previousPrefix;
    }
    if (previousChildPath === undefined) {
      delete process.env.AILY_CHILD_PATH;
    } else {
      process.env.AILY_CHILD_PATH = previousChildPath;
    }
  });

  const handlers = new Map();
  let spawnSyncCalls = 0;
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: {
          handle(channel, handler) {
            handlers.set(channel, handler);
          },
        },
      };
    }
    if (request === "./platform") {
      return { isWin32: true };
    }
    if (request === "child_process") {
      return {
        ...childProcess,
        spawnSync() {
          spawnSyncCalls++;
          return { status: 0, stdout: "1.0.0", stderr: "" };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = originalLoad;
  });

  const builderPath = path.resolve(__dirname, "builder.js");
  const linterPath = path.resolve(__dirname, "linter.js");
  const connectorPath = path.resolve(__dirname, "connector.js");
  delete require.cache[builderPath];
  delete require.cache[linterPath];
  delete require.cache[connectorPath];
  const builder = require(builderPath);
  const linter = require(linterPath);
  const connector = require(connectorPath);
  builder.registerHandlers(() => null);
  linter.registerHandlers(() => null);
  connector.registerHandlers();

  const builderStatus = await handlers.get("aily-builder-status")();
  const linterStatus = await handlers.get("aily-linter-status")();
  const connectorStatus = await handlers.get("aily-connector-status")();

  assert.equal(spawnSyncCalls, 0);
  assert.equal(builderStatus.key, "aily-builder");
  assert.equal(linterStatus.key, "aily-linter");
  assert.equal(connectorStatus.key, "aily-connector");
});
