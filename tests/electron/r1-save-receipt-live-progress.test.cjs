"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { buildSync } = require("esbuild");

const repo = path.resolve(__dirname, "../..");
const output = path.join(
  repo,
  "tests/test-results",
  `r1-save-live-progress-${randomUUID()}`,
);
fs.mkdirSync(output, { recursive: true });
const source = "src/app/services/domains/project/project-save-receipts.ts";
const sourceBytes = fs.readFileSync(path.join(repo, source));
const compiled = path.join(output, "manager.cjs");
const bundle = buildSync({
  absWorkingDir: repo,
  entryPoints: [source],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  write: false,
  logLevel: "silent",
}).outputFiles[0].contents;
fs.writeFileSync(compiled, bundle);
fs.writeFileSync(
  path.join(output, "source-manifest.json"),
  JSON.stringify(
    {
      source,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      node: process.version,
      qualification:
        "actual pure manager and deferred callback; file-backed controlled durable port, not native publication proof",
    },
    null,
    2,
  ),
);
const { ProjectSaveReceipts } = require(compiled);
const deferred = () => {
  let resolve;
  const promise = new Promise((value) => {
    resolve = value;
  });
  return { promise, resolve };
};

async function liveFixture(name) {
  const folder = path.join(output, name),
    project = path.join(folder, "project");
  fs.mkdirSync(project, { recursive: true });
  const record = path.join(project, "controlled-durable-port.json"),
    request = {
      version: 2,
      requestId: `pub2-${randomUUID()}`,
      operation: "blocks_tidy",
      waitMs: 0,
    };
  const context = [Object.freeze({ originalOwner: name })];
  let calls = 0,
    lookups = 0,
    readerLookups = 0;
  const reply = (partial, marker) => ({
    ok: true,
    operation: request.operation,
    saveReceipt: {
      version: 2,
      project,
      requestId: request.requestId,
      operation: request.operation,
      state: "completed",
    },
    result: {
      ok: !partial,
      projectSaved: true,
      generatedCodePublished: !partial,
      partial,
      publication: { status: "COMMITTED" },
      controlledPortMarker: marker,
      nativePublicationProven: false,
    },
  });
  const put = (value) =>
    value === null
      ? fs.rmSync(record, { force: true })
      : fs.writeFileSync(record, JSON.stringify(value));
  const partial = reply(true, "source-committed-post-effects-pending");
  const final = reply(false, "original-job-durable-final");
  const readerLookup = async (target, original) => {
    readerLookups++;
    assert.equal(target, project);
    assert.equal(original.requestId, request.requestId);
    assert.equal(original.operation, request.operation);
    return fs.existsSync(record)
      ? JSON.parse(fs.readFileSync(record, "utf8"))
      : null;
  };
  const manager = new ProjectSaveReceipts({
    durableOnly: true,
    durableLookup: async (target) => {
      lookups++;
      assert.equal(target, project);
      return fs.existsSync(record)
        ? JSON.parse(fs.readFileSync(record, "utf8"))
        : null;
    },
  });
  const entered = deferred(),
    release = deferred();
  const execution = manager.execute(project, request, context, async () => {
    calls++;
    put(partial);
    entered.resolve();
    await release.promise;
    return { ok: true, misleadingRamOnly: true };
  });
  await entered.promise;
  const finish = (value) => {
    put(value);
    release.resolve();
  };
  return {
    manager,
    project,
    folder,
    request,
    context,
    partial,
    final,
    execution,
    finish,
    put,
    readerLookup,
    readerLookups: () => readerLookups,
    calls: () => calls,
    lookups: () => lookups,
  };
}

function assertLive(value, request) {
  assert.equal(value.saveReceipt.requestId, request.requestId);
  assert.ok(["queued", "running"].includes(value.saveReceipt.state));
  assert.equal(
    Object.hasOwn(value, "result"),
    false,
    "Known-live progress must not expose temporary source facts as an operation terminal.",
  );
}

test("source COMMITTED does not complete a known-live original start/status or reenter its callback", async () => {
  const f = await liveFixture("known-live");
  let reentered = 0;
  try {
    assertLive(
      await f.manager.start(f.project, f.request, f.context, async () => {
        reentered++;
        return {};
      }),
      f.request,
    );
    assertLive(await f.manager.status(f.project, f.request), f.request);
    assert.equal(reentered, 0);
    assert.equal(f.calls(), 1);
  } finally {
    f.finish(f.final);
    await f.execution;
  }
});

test("readonly publication status exposes only local progress before consulting its exact-reader durable port", async () => {
  const f = await liveFixture("reader-status");
  try {
    const lookups = f.lookups();
    assertLive(
      await f.manager.status(f.project, f.request, f.readerLookup),
      f.request,
    );
    assert.equal(f.readerLookups(), 0);
    assert.equal(
      f.lookups(),
      lookups,
      "The local progress port must not invent a durable source result.",
    );
    f.finish(f.final);
    await f.execution;
    const completed = await f.manager.status(
      f.project,
      f.request,
      f.readerLookup,
    );
    assert.deepEqual(completed.result, f.final.result);
    assert.equal(f.readerLookups(), 1);
    const unknown = { ...f.request, requestId: `pub2-${randomUUID()}` };
    const absent = await f.manager.status(f.project, unknown, async () => null);
    assert.equal(absent.saveReceipt.state, "unknown");
    assert.equal(Object.hasOwn(absent, "result"), false);
  } finally {
    f.finish(f.final);
    await f.execution;
  }
});

test("start/status waitMs and the readonly publication reader wait for the original Promise, not the early source receipt", async () => {
  const f = await liveFixture("wait-original"),
    waiting = { ...f.request, waitMs: 1000 };
  const settled = [];
  try {
    const reads = [
      f.manager.start(f.project, waiting, f.context, async () =>
        assert.fail("A retry must not transform again"),
      ),
      f.manager.status(f.project, waiting),
      f.manager.status(f.project, waiting, f.readerLookup),
    ].map((promise, i) =>
      promise.then((value) => {
        settled.push(i);
        return value;
      }),
    );
    await nextTurn();
    assert.deepEqual(settled, []);
    f.finish(f.final);
    const [started, status, reader] = await Promise.all(reads);
    for (const observed of [started, status, reader]) {
      assert.equal(observed.saveReceipt.state, "completed");
      assert.deepEqual(observed.result, f.final.result);
    }
    assert.equal(f.readerLookups(), 1);
    assert.equal(f.calls(), 1);
  } finally {
    f.finish(f.final);
    await f.execution;
  }
});

test("a repeated execute stays attached to the same live task until its durable final exists", async () => {
  const f = await liveFixture("execute-waits");
  let reentered = 0,
    settled = false;
  try {
    const second = f.manager.execute(
      f.project,
      f.request,
      f.context,
      async () => {
        reentered++;
        return {};
      },
    );
    second.then(() => {
      settled = true;
    });
    await nextTurn();
    assert.equal(settled, false);
    f.finish(f.final);
    for (const observed of await Promise.all([f.execution, second]))
      assert.deepEqual(observed.result, f.final.result);
    assert.equal(reentered, 0);
    assert.equal(f.calls(), 1);
  } finally {
    f.finish(f.final);
    await f.execution;
  }
});

test("waitMs expiration returns running without relabelling committed source as operation completion", async () => {
  const f = await liveFixture("wait-expires");
  try {
    assertLive(
      await f.manager.status(
        f.project,
        { ...f.request, waitMs: 10 },
        f.readerLookup,
      ),
      f.request,
    );
    assert.equal(f.readerLookups(), 0);
    assertLive(
      await f.manager.status(f.project, { ...f.request, waitMs: 10 }),
      f.request,
    );
  } finally {
    f.finish(f.final);
    await f.execution;
  }
});

test("same-ID live progress rejects foreign project, operation and owner context before using source facts", async () => {
  const f = await liveFixture("foreign-live");
  let reentered = 0;
  try {
    for (const method of ["start", "execute"])
      await assert.rejects(
        f.manager[method](
          f.project,
          f.request,
          [{ changedOwner: true }],
          async () => {
            reentered++;
            return {};
          },
        ),
        { code: "PROJECT_SAVE_RECEIPT_CONTEXT_STALE" },
      );
    for (const observe of [
      (target, input) => f.manager.status(target, input),
      (target, input) => f.manager.status(target, input, f.readerLookup),
    ]) {
      await assert.rejects(
        observe(path.join(f.folder, "foreign-project"), f.request),
        { code: "PROJECT_SAVE_RECEIPT_CONFLICT" },
      );
      await assert.rejects(
        observe(f.project, {
          ...f.request,
          operation: "project_save",
        }),
        { code: "PROJECT_SAVE_RECEIPT_CONFLICT" },
      );
    }
    assert.equal(reentered, 0);
  } finally {
    f.finish(f.final);
    await f.execution;
  }
});

test("a settled callback without a durable result stays unknown and cannot supply RAM success", async () => {
  const f = await liveFixture("missing-final");
  f.finish(null);
  for (const observed of [
    await f.execution,
    await f.manager.status(f.project, f.request),
  ]) {
    assert.equal(observed.saveReceipt.state, "unknown");
    assert.equal(Object.hasOwn(observed, "result"), false);
  }
  const reader = await f.manager.status(f.project, f.request, f.readerLookup);
  assert.equal(reader.saveReceipt.state, "unknown");
  assert.equal(Object.hasOwn(reader, "result"), false);
  assert.equal(f.readerLookups(), 1);
  let reentered = 0;
  const retried = await f.manager.start(
    f.project,
    f.request,
    f.context,
    async () => {
      reentered++;
      return {};
    },
  );
  assert.equal(retried.saveReceipt.state, "unknown");
  assert.equal(reentered, 0);
});

test("after the local task settles a genuine durable source-only partial remains explicit rather than being upgraded", async () => {
  const f = await liveFixture("durable-partial");
  f.finish(f.partial);
  const observed = await f.execution;
  assert.equal(observed.saveReceipt.state, "completed");
  assert.deepEqual(observed.result, f.partial.result);
  assert.equal(observed.result.ok, false);
  assert.equal(observed.result.partial, true);
  assert.equal(Object.hasOwn(observed.result, "misleadingRamOnly"), false);
});

test("an initial durable read that finishes after local admission cannot bypass the now-known live task", async () => {
  const project = path.join(output, "admitted-during-lookup");
  fs.mkdirSync(project);
  const request = {
    version: 2,
    requestId: `pub2-${randomUUID()}`,
    operation: "blocks_tidy",
    waitMs: 0,
  };
  const context = [Object.freeze({ owner: "original" })];
  const record = path.join(project, "controlled-durable-port.json");
  const slowLookupEntered = deferred(),
    finishSlowLookup = deferred(),
    jobEntered = deferred(),
    finishJob = deferred();
  const partial = {
    ok: true,
    operation: "blocks_tidy",
    saveReceipt: { ...request, project, state: "completed" },
    result: {
      ok: false,
      projectSaved: true,
      partial: true,
      publication: { status: "COMMITTED" },
      nativePublicationProven: false,
    },
  };
  const final = {
    ...partial,
    result: { ...partial.result, ok: true, partial: false },
  };
  let calls = 0,
    lookups = 0;
  const manager = new ProjectSaveReceipts({
    durableOnly: true,
    durableLookup: async () => {
      if (++lookups === 1) {
        slowLookupEntered.resolve();
        await finishSlowLookup.promise;
      }
      return fs.existsSync(record)
        ? JSON.parse(fs.readFileSync(record, "utf8"))
        : null;
    },
  });
  const first = manager.start(project, request, context, async () =>
    assert.fail("Concurrent lookup must not admit another callback"),
  );
  await slowLookupEntered.promise;
  const original = manager.execute(project, request, context, async () => {
    calls++;
    fs.writeFileSync(record, JSON.stringify(partial));
    jobEntered.resolve();
    await finishJob.promise;
    return { misleadingRamOnly: true };
  });
  await jobEntered.promise;
  try {
    finishSlowLookup.resolve();
    assertLive(await first, request);
    assert.equal(calls, 1);
  } finally {
    fs.writeFileSync(record, JSON.stringify(final));
    finishJob.resolve();
    finishSlowLookup.resolve();
    await original;
  }
});

test("a durable lookup overlapping a newly completed or just-pruned task rereads its final instead of returning an old partial", async () => {
  for (const method of ["start", "execute", "status"])
    for (const completedLimit of [32, 0]) {
      const project = path.join(
        output,
        `completed-during-${method}-${completedLimit}`,
      );
      fs.mkdirSync(project);
      const request = {
        version: 2,
        requestId: `pub2-${randomUUID()}`,
        operation: "blocks_tidy",
        waitMs: 0,
      };
      const context = [Object.freeze({ owner: "original" })];
      const record = path.join(project, "controlled-durable-port.json");
      const lookupEntered = deferred(),
        capturedPartial = deferred(),
        releaseLookup = deferred();
      const jobEntered = deferred(),
        releaseJob = deferred();
      const response = (partial) => ({
        ok: true,
        operation: "blocks_tidy",
        saveReceipt: {
          version: 2,
          requestId: request.requestId,
          project,
          operation: request.operation,
          state: "completed",
        },
        result: {
          ok: !partial,
          projectSaved: true,
          partial,
          controlledPortMarker: partial
            ? "old-source-only"
            : "exact-durable-final",
          nativePublicationProven: false,
        },
      });
      const partial = response(true),
        final = response(false);
      let calls = 0,
        reads = 0;
      const lookup = async () => {
        if (++reads === 1) {
          lookupEntered.resolve();
          await jobEntered.promise;
          const old = JSON.parse(fs.readFileSync(record, "utf8"));
          capturedPartial.resolve();
          await releaseLookup.promise;
          return old;
        }
        return fs.existsSync(record)
          ? JSON.parse(fs.readFileSync(record, "utf8"))
          : null;
      };
      const manager = new ProjectSaveReceipts({
        durableOnly: true,
        durableLookup: lookup,
        completedLimit,
      });
      const first =
        method === "status"
          ? manager.status(project, request, lookup)
          : manager[method](project, request, context, async () =>
              assert.fail("Only the original task may run"),
            );
      await lookupEntered.promise;
      const original = manager.execute(project, request, context, async () => {
        calls++;
        fs.writeFileSync(record, JSON.stringify(partial));
        jobEntered.resolve();
        await releaseJob.promise;
        return { misleadingRamOnly: true };
      });
      await capturedPartial.promise;
      try {
        fs.writeFileSync(record, JSON.stringify(final));
        releaseJob.resolve();
        await original;
        releaseLookup.resolve();
        const observed = await first;
        assert.deepEqual(
          observed.result,
          final.result,
          `${method}/completedLimit=${completedLimit}`,
        );
        assert.equal(calls, 1);
      } finally {
        releaseLookup.resolve();
        releaseJob.resolve();
        await original;
      }
    }
});

process.on("exit", () => console.log(`R1_LIVE_PROGRESS_OUTPUT=${output}`));
