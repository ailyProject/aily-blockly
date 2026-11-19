import assert from "node:assert/strict";
import fs from "node:fs/promises";
import nativeFs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import { installR2BoardPublicationFault } from "./r2-board-publication-fault.mjs";

// Controlled HTTP/native-shaped facts qualify the passive hook only. They do
// not qualify the actual native publisher or the packaged Chat acceptance run.
const hash = (value) =>
  "sha256:" + crypto.createHash("sha256").update(value).digest("hex");
async function fixture(
  t,
  { cold = false, badReceipt = false, badDisk = false, actualBridge = false } = {},
) {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), "r2-board-fault-"));
  const project = path.join(suite, "aily-project/dev-tests/owned/project"),
    appData = path.join(suite, "appdata");
  await fs.mkdir(path.join(project, ".aily/abs-sync/baselines"), {
    recursive: true,
  });
  const document = {
    schemaVersion: 3,
    activePageId: "page",
    pages: [
      {
        id: "page",
        content: {
          blocks: {
            blocks: [{ id: "C", type: "math_number", fields: { NUM: 201 } }],
          },
        },
      },
    ],
    sharedModel: { procedureBlocks: [] },
  };
  const abi = JSON.stringify(document),
    abs = "number(201)",
    generation = "new-board-g1";
  const map = JSON.stringify({ generation, baseAbsHash: hash(abs) }),
    baseline = JSON.stringify({ controlled: "immutable" });
  for (const [name, body] of [
    ["project.abi", abi],
    ["project.abs", abs],
    ["project.abs.map.json", map],
    ["package.json", JSON.stringify({ projectConfig: { R2Mode: "two" } })],
    [".aily/abs-sync/baselines/" + generation + ".json", baseline],
    [
      ".aily/abs-sync/committed.json",
      JSON.stringify({ schemaVersion: 1, generation, hash: hash(baseline) }),
    ],
  ])
    await fs.writeFile(path.join(project, name), body);
  const requestId = "pub2-" + crypto.randomUUID(),
    input = { kind: "board-config", configKey: "R2Mode", configValue: "two" };
  const pid = cold ? 61002 : 61001,
    originalPid = 61001,
    binding = {
      generation,
      scope: { projectKey: project, pageId: "page" },
      abiHash: hash(abi),
      absHash: hash(abs),
      mapHash: hash(map),
    };
  const fd = nativeFs.openSync(project, "r"),
    identity = nativeFs.fstatSync(fd, { bigint: true });
  nativeFs.closeSync(fd);
  const attachment = {
    version: 1,
    root: project,
    identity: {
      dev: String(identity.dev),
      ino: String(identity.ino),
      birthtimeNs: String(identity.birthtimeNs),
    },
  };
  const received = [],
    handles = { open: 0, close: 0 };
  let token = "owned-original-authentication", bridge;
  const appInfo = { ok: true, operation: "app_info", settings: { developmentMode: "blockly" },
    runtime: { absProtocol: { version: 2 } }, untouched: "original-renderer-result" };
  const publication = (body) => {
      const result = {
        ok: true,
        project,
        operation:
          body.operation === "set_board_config"
            ? "set_board_config"
            : "project_save",
        projectSaved: true,
        config_key: "R2Mode",
        new_value: "two",
        partial: false,
        requiresReload: false,
        generation,
        publication: { status: "COMMITTED", generation },
        projectionReceipt: {
          version: 2,
          requestId: badReceipt ? "pub2-" + crypto.randomUUID() : requestId,
          persisted: true,
          validation: { ok: true, scope: "generation-projection" },
          base: binding,
          output: { binding },
        },
        absPersistence: { verified: true },
        finalValidation: { ok: true },
      };
      const outer = {
        ok: true,
        saveReceipt: {
          version: 2,
          requestId,
          operation: "project_save",
          input: badReceipt ? { ...input, configValue: "foreign" } : input,
          project,
          state: "completed",
        },
        publicationObservation: {
          version: 1,
          durable: true,
          requestId,
          operation: "project_save",
          current: true,
          attachment,
          executor: {
            version: 1,
            hostPid: originalPid,
            storagePid: 62001,
            instanceId: "original-executor",
          },
          observer: { version: 1, hostPid: pid },
        },
      };
      if (actualBridge && body.operation === "set_board_config") return {
        ...result, candidateApplied: false, persisted: true,
        requestId: "ipc-correlation-id-is-not-the-native-save-id", rendererGeneration: 1,
        environment: { version: 1, requestId: "original-environment", status: "completed", current: true,
          project, attachment, executor: outer.publicationObservation.executor,
          observer: outer.publicationObservation.observer, candidateApplied: false,
          hashes: { package: hash(nativeFs.readFileSync(path.join(project, "package.json"))),
            lock: null, npmrc: null, shrinkwrap: null, yarn: null } },
      };
      return body.operation === "set_board_config" ? { ...result, ...outer } : { ...outer, result };
  };
  let server;
  if (actualBridge) {
    // Execute the actual Main CLI handler, including body-token auth, asynchronous
    // handleCommand completion, writeHead/end and discovery updates. Only its
    // renderer publication facts are controlled, not a packaged product oracle.
    const source = await fs.readFile(new URL("../../../electron/cli-bridge.js", import.meta.url), "utf8");
    const module = { exports: {} };
    vm.runInThisContext("(function(require,module,process,console){" + source + "\n})")(
      (name) => name === "os" ? { ...os, homedir: () => suite } : process.getBuiltinModule(name),
      module, { pid, on() {} }, console,
    );
    bridge = module.exports.startCliBridge({
      handleCommand: async (_action, body) => {
        received.push({ body, authorization: body.token });
        await new Promise(setImmediate);
        return body.operation === "app_info" ? appInfo : publication(body);
      },
      getStatus: () => ({ project, serve: false }),
      logger: { log() {}, warn() {}, error() {} },
    });
    while (!bridge.getPort()) await new Promise(setImmediate);
    const descriptor = JSON.parse(await fs.readFile(path.join(suite, ".aily-blockly/cli-bridge", pid + ".json"), "utf8"));
    token = descriptor.token;
    server = process._getActiveHandles().find((value) => value instanceof http.Server && value.address()?.port === bridge.getPort());
    assert.ok(server);
  } else server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks));
      received.push({ body, authorization: req.headers.authorization });
      if (req.headers.authorization !== token) {
        res.statusCode = 401;
        res.end('{"ok":false}');
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(publication(body)));
    });
  });
  if (!actualBridge) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const observedFs = {
    ...nativeFs,
    openSync: (...args) => {
      handles.open++;
      return nativeFs.openSync(...args);
    },
    closeSync: (fd) => {
      handles.close++;
      nativeFs.closeSync(fd);
    },
  };
  const context = vm.createContext({
    process: {
      pid,
      env: { AILY_APPDATA_PATH: appData },
      _getActiveHandles: () => [server],
      getBuiltinModule: (name) =>
        name === "fs" ? observedFs : process.getBuiltinModule(name),
    },
  });
  const config = {
    pid,
    project,
    appData,
    port: server.address().port,
    expectedDocument: document,
    previousGeneration: "original-g0",
    input,
    ...(cold
      ? { observationOnly: true, requestId, originalTargetPid: originalPid }
      : {}),
  };
  const install = vm.runInContext(
    "(" + installR2BoardPublicationFault.toString() + ")",
    context,
  )(null, JSON.stringify(config));
  assert.equal(install.available, true);
  if (badDisk)
    await fs.writeFile(path.join(project, "project.abs"), "replacement");
  const send = (operation, changedInput = input, authorization = token) =>
    new Promise((resolve, reject) => {
      const body = {
        ...(actualBridge ? { token: authorization } : {}),
        action: "blockly-live-operation",
        path: project,
        operation,
        params: {
          saveRequest: {
            version: 2,
            requestId,
            operation: "project_save",
            input: changedInput,
          },
          ...(operation === "set_board_config"
            ? { config_key: input.configKey, config_value: input.configValue }
            : { originalTargetPid: originalPid }),
        },
      };
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: "/command",
          method: "POST",
          headers: { authorization },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks)), raw: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify(body));
    });
  t.after(async () => {
    context.__ailyR2BoardPublicationFault.restore();
    bridge?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(suite), path.resolve(os.tmpdir()));
    assert.ok(path.basename(suite).startsWith("r2-board-fault-"));
    await fs.rm(suite, { recursive: true, force: true });
  });
  return {
    send,
    received,
    handles,
    input,
    requestId,
    appInfo,
    snapshot: () =>
      structuredClone(context.__ailyR2BoardPublicationFault.snapshot()),
  };
}

test("only exact original flat board ACK and readonly terminal ACK are disconnected; auth and bytes delegate unchanged", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.send("set_board_config"),
    (error) => error.code === "ECONNRESET",
  );
  await assert.rejects(
    f.send("project_publication_status"),
    (error) => error.code === "ECONNRESET",
  );
  const denied = await f.send(
    "project_publication_status",
    f.input,
    "foreign-token",
  );
  assert.equal(denied.status, 401);
  const state = f.snapshot();
  assert.equal(state.drops, 2);
  assert.equal(state.terminals.length, 2);
  assert.equal(
    state.commands.filter((value) => value.operation === "set_board_config")
      .length,
    1,
  );
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.unverifiedTerminalReplies, []);
  assert.equal(f.received.length, 3);
  assert.equal(f.received[0].authorization, "owned-original-authentication");
  assert.deepEqual(f.received[0].body.params.saveRequest.input, f.input);
  assert.equal(f.handles.open, f.handles.close);
});
test("cold new reader delegates the same original project_save/input terminal without repeating board mutation", async (t) => {
  const f = await fixture(t, { cold: true });
  const result = await f.send("project_publication_status", {
    configValue: "two",
    configKey: "R2Mode",
    kind: "board-config",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.publicationObservation.executor.hostPid, 61001);
  assert.equal(result.body.publicationObservation.observer.hostPid, 61002);
  assert.equal(f.snapshot().drops, 0);
  assert.equal(f.snapshot().terminals.length, 1);
  assert.deepEqual(f.snapshot().failures, []);
});
for (const option of ["badReceipt", "badDisk"])
  test(`unverified ${option} is preserved as a failure and never disconnected`, async (t) => {
    const f = await fixture(t, { [option]: true });
    const result = await f.send("set_board_config");
    assert.equal(result.status, 200);
    assert.equal(f.snapshot().drops, 0);
    assert.equal(f.snapshot().terminals.length, 0);
    assert.equal(f.snapshot().failures[0].code, "board-terminal-unverified");
  });
test("changed readonly input is recorded and not treated as the original terminal", async (t) => {
  const f = await fixture(t, { cold: true });
  assert.equal(
    (
      await f.send("project_publication_status", {
        ...f.input,
        configValue: "foreign",
      })
    ).status,
    200,
  );
  assert.equal(f.snapshot().terminals.length, 0);
  assert.equal(f.snapshot().failures[0].code, "board-input-changed");
});

test("actual Main async flat board ACK without a synthesized saveReceipt is verified then disconnected", async (t) => {
  const f = await fixture(t, { actualBridge: true });
  await assert.rejects(f.send("set_board_config"), (error) => error.code === "ECONNRESET");
  const state = f.snapshot();
  assert.equal(state.drops, 1);
  assert.equal(state.terminals[0].requestId, f.requestId);
  assert.equal(state.terminals[0].completeGuiCVerified, true);
  assert.equal(state.terminals[0].responseShape, "original-board-publication");
  assert.equal(state.responseMetadata[0].hasSaveReceipt, false);
  assert.equal(state.responseMetadata[0].projectionRequestId, f.requestId);
  assert.deepEqual(state.failures, []);
  assert.equal(f.received[0].body.params.saveRequest.requestId, f.requestId);
});

test("actual Main app_info and rejected authentication remain byte-exact passthrough before and after a board drop", async (t) => {
  const f = await fixture(t, { actualBridge: true });
  for (const at of ["before", "after"]) {
    const info = await f.send("app_info");
    assert.equal(info.status, 200, at);
    assert.equal(info.raw.toString("utf8"), JSON.stringify(f.appInfo));
    assert.deepEqual(info.body, f.appInfo);
    const denied = await f.send("app_info", f.input, "not-the-original-body-token");
    assert.equal(denied.status, 401);
    assert.equal(denied.raw.toString("utf8"), JSON.stringify({ ok: false, message: "Unauthorized (token mismatch)" }));
    if (at === "before") await assert.rejects(f.send("set_board_config"), (error) => error.code === "ECONNRESET");
  }
  assert.equal(f.snapshot().commands.length, 1);
  assert.equal(f.snapshot().discoveryRewritten, false);
  assert.equal(f.snapshot().authenticatedHandlerReplaced, false);
  assert.equal(f.snapshot().discoveryInspections.length, 4);
  assert.ok(f.snapshot().discoveryInspections.every((value) => value.delegatedUnchanged === true));
  assert.equal(f.snapshot().discoveryInspections.filter((value) => value.ok && value.developmentMode === "blockly").length, 2);
});

for (const option of ["badReceipt", "badDisk"])
  test(`actual Main direct ACK ${option} cannot bypass the original ID and physical three-hash checks`, async (t) => {
    const f = await fixture(t, { actualBridge: true, [option]: true });
    const result = await f.send("set_board_config");
    assert.equal(result.status, 200);
    assert.equal(result.body.saveReceipt, undefined);
    assert.equal(f.snapshot().drops, 0);
    assert.equal(f.snapshot().terminals.length, 0);
    assert.equal(f.snapshot().failures[0].code, "board-terminal-unverified");
  });
