import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";

const hash = (value) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
const same = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

/** Test oracle for the original pre-dispatch record. A prepared proof binds
 * origin.mapHash to G0; only a later verified adoption may add acceptedMapHash. */
export function assertBoardPreparedProof({
  bytes,
  reference,
  project,
  generation,
  baseSource,
  source,
  mirrors,
  requestId,
  input,
  targetPid,
  attachment,
}) {
  assert.equal(reference.version, 1);
  assert.equal(hash(bytes), reference.recordHash);
  const record = JSON.parse(bytes.toString("utf8")),
    proof = record.editProof,
    origin = proof?.origin,
    save = record.saveRequest;
  assert.equal(record.version, 1);
  assert.equal(record.adopted, false);
  assert.ok(same(record.workspaceRoot, project));
  assert.ok(same(attachment.root, project));
  assert.equal(
    record.rootIdentity,
    attachment.identity.dev + ":" + attachment.identity.ino,
  );
  assert.equal(record.candidateHash, hash(source));
  assert.equal(record.sourceBytes, Buffer.byteLength(source));
  assert.equal(record.intentGeneration, generation);
  for (const [key, file] of [
    ["abi", "project.abi"],
    ["abs", "project.abs"],
    ["map", "project.abs.map.json"],
  ])
    assert.equal(record.hashes[key], mirrors[file]);
  assert.equal(hash(baseSource), mirrors["project.abs"]);
  assert.equal(proof.version, 2);
  assert.equal(proof.hash, record.candidateHash);
  assert.ok(typeof proof.key === "string" && path.isAbsolute(proof.key));
  const relative = path.relative(
    path.join(project, ".workspace-history/overlays").toLowerCase(),
    proof.key.toLowerCase(),
  );
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  assert.ok(
    proof.key
      .toLowerCase()
      .endsWith(path.join("view", "project.abs").toLowerCase()),
  );
  assert.match(proof.identity, /^-?\d+:\d+:\d+:\d+:\d+:\d+$/);
  assert.equal(Number(proof.identity.split(":")[2]), record.sourceBytes);
  assert.equal(origin.version, 1);
  assert.equal(origin.generation, generation);
  assert.ok(same(origin.sourceKey, path.join(project, "project.abs")));
  assert.equal(origin.rootIdentity, record.rootIdentity);
  assert.equal(origin.baseAbsHash, hash(baseSource));
  assert.equal(origin.mapHash, mirrors["project.abs.map.json"].slice(7));
  assert.equal(proof.mapHash, origin.mapHash);
  if (Object.hasOwn(origin, "acceptedMapHash"))
    assert.equal(origin.acceptedMapHash, origin.mapHash);
  assert.ok(Array.isArray(proof.steps) && proof.steps.length > 0);
  let replay = baseSource;
  for (const step of proof.steps) {
    assert.equal(step.before, hash(replay));
    assert.ok(Array.isArray(step.edits) && step.edits.length > 0);
    let previousStart = replay.length + 1;
    for (const edit of [...step.edits].sort((a, b) => b.start - a.start)) {
      assert.ok(
        Number.isSafeInteger(edit.start) &&
          Number.isSafeInteger(edit.end) &&
          typeof edit.text === "string",
      );
      assert.ok(
        edit.start >= 0 &&
          edit.end >= edit.start &&
          edit.end <= replay.length &&
          edit.end <= previousStart,
      );
      previousStart = edit.start;
      replay = replay.slice(0, edit.start) + edit.text + replay.slice(edit.end);
    }
    assert.equal(step.after, hash(replay));
  }
  assert.equal(replay, source);
  assert.equal(save.version, 2);
  assert.equal(save.state, "prepared");
  assert.equal(save.operation, "project_save");
  assert.equal(save.requestId, requestId);
  assert.equal(save.targetPid, targetPid);
  assert.deepEqual(save.input, input);
  assert.deepEqual(save.attachment, attachment);
  assert.equal(save.candidateHash, record.candidateHash);
  assert.equal(save.intentGeneration, generation);
  assert.ok(record.owner?.sessionId && record.owner?.turnId);
  return {
    candidateHash: record.candidateHash,
    intentGeneration: generation,
    originMapHash: origin.mapHash,
    steps: proof.steps.length,
  };
}
