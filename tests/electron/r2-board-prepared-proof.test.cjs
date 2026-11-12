const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const vm = require("node:vm");
const { test } = require("node:test");

const repo = path.resolve(__dirname, "../.."),
  hash = (value) =>
    "sha256:" + createHash("sha256").update(value).digest("hex");
const rawFile =
  process.env.AILY_R2_BOARD_PREPARED_RESULT ??
  path.join(
    repo,
    "e2e/test-results/baseline-r2-20261108/board-cold-04/result.json",
  );
const ready = (async () => {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(rawFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const reference = raw.preDispatchCheckpoint.reference;
  const bytes = await fs.readFile(
    path.join(
      raw.project,
      ".workspace-history/abs-candidate-handoffs",
      reference.recordHash.slice(7) + ".json",
    ),
  );
  const exported = raw.tools.find((value) => value.id === "export-g0").result;
  const context = {
    bytes,
    reference,
    project: raw.project,
    generation: raw.g0.generation,
    mirrors: raw.g0.mirrors,
    baseSource: exported.abs,
    source: exported.abs.replace(
      "e2e_build_log_probe_field_edit(100)",
      "e2e_build_log_probe_field_edit(101)",
    ),
    requestId: raw.lostBoardAck.requestId,
    input: raw.preDispatchCheckpoint.saveRequest.input,
    targetPid: raw.launches[0].hostPid,
    attachment: raw.lostBoardAck.terminals[0].attachment,
  };
  const { assertBoardPreparedProof } = await import(
    pathToFileURL(
      path.join(repo, "e2e/electron/fixtures/r2-board-prepared-proof.mjs"),
    )
  );
  return {
    raw,
    context,
    record: JSON.parse(bytes),
    check: assertBoardPreparedProof,
  };
})();
async function fixture(t) {
  const f = await ready;
  if (!f)
    t.skip(
      "Requires the preserved actual Board04 record; no native proof is fabricated",
    );
  return f;
}
function changed(f, mutate) {
  const record = structuredClone(f.record);
  mutate(record);
  const bytes = Buffer.from(JSON.stringify(record));
  // Recomputed checksum isolates semantic validation; actual driver still uses
  // its unchanged trusted workflow reference, not this synthetic test packet.
  return {
    ...f.context,
    bytes,
    reference: { version: 1, recordHash: hash(bytes) },
  };
}

test("the actual driver preStop map assertion accepts the actual serialized Board04 origin", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const driver = await fs.readFile(
    path.join(repo, "e2e/electron/r2-board-publication-cold.acceptance.mjs"),
    "utf8",
  );
  const statement = driver.match(
    /assert\.equal\(\s*handoff\.editProof\.origin\.(?:acceptedMapHash|mapHash),\s*evidence\.g0\.mirrors\["project\.abs\.map\.json"\]\.slice\(7\),\s*\);/,
  );
  assert.ok(
    statement,
    "Keep the explicit original-map assertion in the actual driver",
  );
  vm.runInNewContext(statement[0], {
    assert,
    handoff: f.record,
    evidence: f.raw,
  });
});
test("actual immutable Board04 prepared proof binds complete bytes, G0, map, input and replayable edit chain", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const result = f.check(f.context);
  assert.equal(result.steps, 1);
  assert.equal(result.intentGeneration, f.raw.g0.generation);
  assert.equal(result.candidateHash, f.record.candidateHash);
});
test("different generation, root, origin source and native request binding fail even with a coherent packet checksum", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  for (const mutate of [
    (record) => {
      record.intentGeneration = "foreign-generation";
    },
    (record) => {
      record.editProof.origin.generation = "foreign-generation";
    },
    (record) => {
      record.workspaceRoot = path.join(f.raw.project, "foreign");
    },
    (record) => {
      record.editProof.origin.sourceKey = path.join(
        f.raw.project,
        "foreign.abs",
      );
    },
    (record) => {
      record.editProof.origin.rootIdentity = "other:root";
    },
    (record) => {
      record.saveRequest.requestId = "pub2-foreign";
    },
    (record) => {
      record.saveRequest.input.configValue = "different";
    },
    (record) => {
      record.saveRequest.targetPid++;
    },
  ])
    assert.throws(() => f.check(changed(f, mutate)));
});
test("source-byte counts, immutable checksum, proof hash and replayed edit content cannot be substituted", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.throws(() =>
    f.check({ ...f.context, source: f.context.source + "x" }),
  );
  assert.throws(() =>
    f.check({
      ...f.context,
      bytes: Buffer.concat([f.context.bytes, Buffer.from(" ")]),
    }),
  );
  for (const mutate of [
    (record) => {
      record.sourceBytes++;
    },
    (record) => {
      record.editProof.hash = "sha256:" + "0".repeat(64);
    },
    (record) => {
      record.editProof.steps[0].edits[0].text = "wrong";
    },
    (record) => {
      record.editProof.steps[0].before = record.candidateHash;
    },
    (record) => {
      record.editProof.steps = [];
    },
    (record) => {
      record.editProof.steps[0].edits[0].end = 1e9;
    },
  ])
    assert.throws(() => f.check(changed(f, mutate)));
});
test("a current/successor map cannot replace the prepared original G0 map or its three saved hashes", async (t) => {
  const f = await fixture(t);
  if (!f) return;
  for (const mutate of [
    (record) => {
      record.editProof.origin.mapHash = "0".repeat(64);
    },
    (record) => {
      record.editProof.origin.acceptedMapHash =
        f.raw.lostBoardAck.terminals[0].binding.mapHash.slice(7);
    },
    (record) => {
      record.hashes.abs = f.raw.lostBoardAck.terminals[0].binding.absHash;
    },
  ])
    assert.throws(() => f.check(changed(f, mutate)));
});
