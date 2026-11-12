import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import * as nativeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import vm from "node:vm";
import { Buffer } from "node:buffer";
import { installR2StateObservationFault } from "./r2-state-observation-fault.mjs";

// These controlled HTTP facts qualify the passive test hook, not the native
// publisher. Real HOST/Chat completion remains a separate acceptance run.
const hash = (bytes) =>
  "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
async function fixture(t, options = {}) {
  const suite = await fs.mkdtemp(path.join(os.tmpdir(), "r2-state-fault-"));
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
            blocks: [
              {
                id: "exact-root",
                type: "text",
                collapsed: true,
                fields: { TEXT: "whole original document" },
              },
            ],
          },
        },
      },
    ],
    sharedModel: { procedureBlocks: [] },
  };
  const abi = JSON.stringify(document),
    abs = 'text("whole original document")\n',
    generation = "native-g1";
  const map = JSON.stringify({ generation, baseAbsHash: hash(abs) }),
    baseline = JSON.stringify({ unitControlled: generation });
  for (const [name, body] of [
    ["project.abi", abi],
    ["project.abs", abs],
    ["project.abs.map.json", map],
    [".aily/abs-sync/baselines/native-g1.json", baseline],
    [
      ".aily/abs-sync/committed.json",
      JSON.stringify({ schemaVersion: 1, generation, hash: hash(baseline) }),
    ],
  ])
    await fs.writeFile(path.join(project, name), body);
  const raw = {
    version: 2,
    requestId: crypto.randomUUID(),
    action: "update",
    expectedGeneration: "original-g0",
    changes: [{ blockId: "exact-root", collapsed: true }],
  };
  const binding = {
    generation,
    scope: { projectKey: project, pageId: "page" },
    abiHash: hash(abi),
    absHash: hash(abs),
    mapHash: hash(map),
  };
  const token = "unit-auth-original-must-not-be-rewritten",
    handled = [],
    handles = { opened: 0, closed: 0, active: new Set() };
  let hadFd = false;
  const observedFs = {
    ...nativeFs,
    openSync: (...args) => {
      const fd = nativeFs.openSync(...args);
      handles.opened++;
      handles.active.add(fd);
      return fd;
    },
    closeSync: (fd) => {
      try {
        return nativeFs.closeSync(fd);
      } finally {
        handles.closed++;
        handles.active.delete(fd);
      }
    },
    fstatSync: (...args) => {
      const stat = nativeFs.fstatSync(...args);
      hadFd = true;
      return stat;
    },
    lstatSync: (...args) => {
      const stat = nativeFs.lstatSync(...args);
      if (args[0] !== project || !args[1]?.bigint) return stat;
      if (options.failPostFd && hadFd)
        throw Object.assign(new Error("Controlled FD tail failure"), {
          code: "EIO",
        });
      return options.pathDevZero
        ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
            dev: 0n,
          })
        : stat;
    },
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const part of request) chunks.push(part);
    const original = JSON.parse(Buffer.concat(chunks));
    assert.equal(original.token, token);
    handled.push(original);
    const fd = await fs.open(
      project,
      nativeFs.constants.O_RDONLY | (nativeFs.constants.O_DIRECTORY ?? 0),
    );
    let identity;
    try {
      const value = await fd.stat({ bigint: true });
      identity = Object.fromEntries(
        ["dev", "ino", "birthtimeNs"].map((key) => [key, String(value[key])]),
      );
    } finally {
      await fd.close();
    }
    const normalized = project.replace(/\\/g, "/").replace(/\/+$/, "");
    const key =
      /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
        ? normalized.toLowerCase()
        : normalized;
    const inputDigest = hash(
      canonical({
        version: 2,
        project: key,
        operation: "blocks_set_state",
        request: raw,
      }),
    );
    const result = {
      ok: true,
      operation: "blocks_set_state",
      project,
      requiresReload: false,
      publication: { status: "COMMITTED", generation },
      receipt: {
        version: 2,
        requestId: raw.requestId,
        action: "update",
        expectedGeneration: raw.expectedGeneration,
        changes: raw.changes,
        inputAbiHash: hash("saved-s0-abi"),
        beforeStates: [],
        states: [],
        output: { binding, absBytes: Buffer.byteLength(abs) },
      },
      projectionReceipt: {
        version: 2,
        requestId: "pub2-" + raw.requestId,
        persisted: true,
        validation: { scope: "generation-projection" },
        output: { binding },
      },
      absPersistence: { verified: true },
      finalValidation: { ok: true },
    };
    if (options.badProjection) delete result.projectionReceipt;
    const metadata = {
      saveReceipt: {
        version: 2,
        requestId: "pub2-" + raw.requestId,
        operation: "blocks_set_state",
        project,
        state: "completed",
      },
      statePublication: {
        version: 1,
        requestId: raw.requestId,
        nativeRequestId: "pub2-" + raw.requestId,
        inputDigest,
      },
      publicationObservation: {
        version: 1,
        requestId: "pub2-" + raw.requestId,
        operation: "blocks_set_state",
        durable: true,
        current: true,
        attachment: { root: project, identity },
        executor: { hostPid: options.observationOnly ? 4567 : 1234 },
        observer: { hostPid: 1234 },
      },
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        options.observationOnly
          ? { ok: true, operation: "abs_recovery", result, ...metadata }
          : { ...result, ...metadata },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const context = vm.createContext({
    process: {
      pid: 1234,
      env: { AILY_APPDATA_PATH: appData },
      _getActiveHandles: () => [server],
      getBuiltinModule: (name) =>
        ({ fs: observedFs, path, http, crypto, buffer: { Buffer } })[name],
    },
  });
  const config = {
    pid: 1234,
    appData,
    project,
    port: server.address().port,
    previousGeneration: "original-g0",
    inputAbiHash: hash("saved-s0-abi"),
    expectedDocument: document,
    ...(options.observationOnly
      ? { observationOnly: true, originalState: raw, originalTargetPid: 4567 }
      : {}),
  };
  const installed = vm.runInContext(
    "(" +
      installR2StateObservationFault.toString() +
      ")(undefined," +
      JSON.stringify(JSON.stringify(config)) +
      ")",
    context,
  );
  assert.equal(installed.available, true);
  t.after(async () => {
    context.__ailyR2StateObservationFault.restore();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(suite, { recursive: true, force: true });
  });
  const command = {
    token,
    action: "blockly-live-operation",
    path: project,
    operation: options.observationOnly ? "abs_recovery" : "blocks_set_state",
    params: options.observationOnly
      ? {
          version: 2,
          requestId: crypto.randomUUID(),
          action: "observe_state",
          state: raw,
          originalTargetPid: 4567,
        }
      : raw,
  };
  const invoke = () =>
    fetch("http://127.0.0.1:" + server.address().port + "/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  return {
    invoke,
    command,
    raw,
    handled,
    handles,
    snapshot: () =>
      JSON.parse(
        JSON.stringify(context.__ailyR2StateObservationFault.snapshot()),
      ),
  };
}

test("passive state hook drops only a fully verified flat terminal ACK and preserves original auth/wire", async (t) => {
  const f = await fixture(t, { pathDevZero: true });
  await assert.rejects(f.invoke(), /fetch failed|socket|closed/i);
  const proof = f.snapshot();
  assert.equal(proof.drops, 1);
  assert.equal(proof.commands.length, 1);
  assert.deepEqual(proof.state, f.raw);
  assert.deepEqual(f.handled, [f.command]);
  assert.deepEqual(proof.failures, []);
  assert.equal(proof.terminals[0].nativeRequestId, "pub2-" + f.raw.requestId);
  assert.equal(f.handles.opened, 1);
  assert.equal(f.handles.closed, 1);
  assert.equal(f.handles.active.size, 0);
});

test("cold hook passes the exact readonly original state result from old executor to new reader", async (t) => {
  const f = await fixture(t, { observationOnly: true }),
    result = await (await f.invoke()).json(),
    proof = f.snapshot();
  assert.equal(result.result.ok, true);
  assert.equal(proof.drops, 0);
  assert.equal(proof.delegatedResponses, 1);
  assert.deepEqual(proof.failures, []);
  assert.deepEqual(f.handled, [f.command]);
  assert.equal(proof.commands[0].action, "observe_state");
  assert.equal(proof.terminals[0].originalExecutor.hostPid, 4567);
  assert.equal(proof.terminals[0].observer.hostPid, 1234);
});

test("missing native projection is passed unchanged as uncovered and never counted as a real ACK loss", async (t) => {
  const f = await fixture(t, { badProjection: true }),
    result = await (await f.invoke()).json(),
    proof = f.snapshot();
  assert.equal(result.ok, true);
  assert.equal(result.projectionReceipt, undefined);
  assert.equal(proof.drops, 0);
  assert.equal(proof.terminals.length, 0);
  assert.equal(proof.unverifiedTerminalReplies.length, 1);
  assert.equal(proof.failures[0].code, "state-reply-verification-failed");
  assert.equal(f.handles.opened, 0);
});

test("FD verification tail failure closes the handle and preserves the original real response", async (t) => {
  const f = await fixture(t, { failPostFd: true }),
    result = await (await f.invoke()).json(),
    proof = f.snapshot();
  assert.equal(result.ok, true);
  assert.equal(proof.drops, 0);
  assert.equal(proof.terminals.length, 0);
  assert.match(proof.failures[0].message, /Controlled FD tail failure/);
  assert.equal(f.handles.opened, 1);
  assert.equal(f.handles.closed, 1);
  assert.equal(f.handles.active.size, 0);
});
