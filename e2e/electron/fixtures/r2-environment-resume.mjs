import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  sourceHash,
  assertColdCandidateProof,
} from "./abs-cold-continuity.mjs";
import { singleFieldExpectedDocument } from "./online-comparison.mjs";
import { assertEnvironmentApplyCall } from "./r2-environment-apply-call.mjs";

const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const hashPattern = /^sha256:[a-f0-9]{64}$/;
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
async function physical(directory) {
  const stat = await fs.lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.ok(same(await fs.realpath(directory), directory));
}
async function json(file) {
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const bytes = await fs.readFile(file);
  return { bytes, value: JSON.parse(bytes) };
}

/** Exact original suite continuation only. No project writes, metadata repair,
 * refresh, candidate binding or execution of the prior two user tasks occurs. */
export async function loadEnvironmentResume({
  resultFile,
  testRoot,
  artifact,
  hostHash,
  capturePublicationAttachment,
  samePublicationAttachment,
  captureDependencyEnvironmentTree,
  dependencyEnvironmentFiles,
}) {
  assert.ok(path.isAbsolute(resultFile));
  const original = await json(resultFile),
    previous = original.value;
  assert.equal(previous.ok, false);
  assert.match(
    previous.error?.message ?? "",
    /did not settle the exact requested user turn/,
  );
  assert.equal(previous.hostHash, hostHash);
  assert.deepEqual(previous.artifact, artifact);
  assert.equal(
    previous.phases.at(-1)?.name,
    "real-board-tool-publisher-then-full-A-B-C",
  );
  assert.equal(previous.transport.createCount, 2);
  assert.deepEqual(previous.transport.failures, []);
  const suite = path.resolve(previous.suite),
    project = path.join(suite, "project");
  assert.ok(same(path.dirname(suite), testRoot));
  assert.ok(path.basename(suite).startsWith("r2-environment-"));
  assert.ok(same(project, previous.project));
  for (const directory of [
    suite,
    project,
    path.join(suite, "home"),
    path.join(suite, "appdata"),
    path.join(suite, "electron-profile"),
    path.join(project, ".workspace-history"),
  ])
    await physical(directory);
  const libraryTool = previous.tools.find(
    (tool) => tool.id === "env-install-library",
  )?.result;
  const boardRead = previous.tools.find(
    (tool) => tool.id === "env-read-board",
  )?.result;
  const exported = previous.tools.find(
    (tool) => tool.id === "env-export-s0",
  )?.result;
  assert.equal(libraryTool?.ok, true);
  assert.equal(libraryTool.runtimeSync?.ready, true);
  assert.equal(previous.library.originalRequestVerified, true);
  assert.equal(previous.library.runtimeReady, true);
  assert.equal(boardRead?.ok, true);
  assert.equal(
    previous.tools.some((tool) => tool.id === "env-select-board"),
    false,
  );
  assert.equal(
    previous.tools.some((tool) => tool.id === "env-apply-ABC"),
    false,
  );
  assert.equal(exported.generation, previous.s0.generation);
  assert.equal(previous.originalProof.generation, exported.generation);
  const sessionId = previous.startup.ready.sessionId,
    sessionDirectory = path.join(suite, "home/.aily-chat/sessions");
  const originalFailure = await json(
    path.join(path.dirname(resultFile), "failure-session.json"),
  );
  assert.equal(originalFailure.value.sessionId, sessionId);
  assert.ok(same(originalFailure.value.cwd, project));
  const failurePrepared = originalFailure.value.entries
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "aily.abs-workflow",
    )
    .at(-1);
  assert.ok(
    hashPattern.test(
      failurePrepared?.data.retainedCandidateHandoff?.recordHash ?? "",
    ),
  );
  const sessionMatches = [];
  for (const directory of await fs.readdir(sessionDirectory, {
    withFileTypes: true,
  })) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    for (const file of await fs.readdir(
      path.join(sessionDirectory, directory.name),
    ))
      if (file.endsWith("_" + sessionId + ".jsonl"))
        sessionMatches.push(path.join(sessionDirectory, directory.name, file));
  }
  assert.equal(sessionMatches.length, 1);
  const sessionFile = sessionMatches[0],
    sessionBytes = await fs.readFile(sessionFile);
  const entries = sessionBytes
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)),
    header = entries[0];
  assert.equal(header.id, sessionId);
  assert.ok(same(header.cwd, project));
  const chain = [],
    byId = new Map(entries.slice(1).map((entry) => [entry.id, entry]));
  let leaf = entries.at(-1);
  while (leaf) {
    chain.unshift(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : null;
  }
  assert.equal(
    chain.filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    ).length,
    2,
  );
  const boardCall = chain.findLast(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.content?.some(
        (part) => part.type === "toolCall" && part.id === "env-select-board",
      ),
  );
  assert.ok(boardCall);
  assert.equal(
    chain.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.toolCallId === "env-select-board",
    ),
    false,
  );
  const workflows = chain.filter(
    (entry) =>
      entry.type === "custom" && entry.customType === "aily.abs-workflow",
  );
  const completed = workflows.at(-1),
    ref = completed?.data.retainedCandidateHandoff;
  assert.equal(completed.parentId, workflows.at(-2).id);
  assert.ok(hashPattern.test(ref?.recordHash ?? ""));
  assert.equal(completed.data.intentGeneration, exported.generation);
  const recordPath = path.join(
    project,
    ".workspace-history/abs-candidate-handoffs",
    ref.recordHash.slice(7) + ".json",
  );
  const handoff = await json(recordPath),
    record = handoff.value;
  assert.equal(sourceHash(handoff.bytes), ref.recordHash);
  const save = record.saveRequest,
    expectedInput = {
      kind: "board-config",
      configKey: "R2Mode",
      configValue: "two",
    };
  assert.equal(save.state, "completed");
  assert.equal(save.version, 2);
  assert.equal(save.operation, "project_save");
  assert.deepEqual(save.input, expectedInput);
  assert.match(save.requestId, /^pub2-[a-f0-9-]{36}$/i);
  assert.equal(save.targetPid, previous.hostPid);
  assert.equal(record.intentGeneration, exported.generation);
  assert.equal(record.editProof.origin.generation, exported.generation);
  assert.ok(
    samePublicationAttachment(
      save.attachment,
      capturePublicationAttachment(project),
    ),
  );
  assert.ok(same(record.workspaceRoot, project));
  assert.equal(
    record.rootIdentity,
    save.attachment.identity.dev + ":" + save.attachment.identity.ino,
  );
  assert.ok(
    same(record.editProof.origin.sourceKey, path.join(project, "project.abs")),
  );
  const prepared = await json(
    path.join(
      project,
      ".workspace-history/abs-candidate-handoffs",
      record.parent.recordHash.slice(7) + ".json",
    ),
  );
  assert.deepEqual(
    record.parent,
    failurePrepared.data.retainedCandidateHandoff,
    "Successor must descend from the original failed snapshot exact prepared reference",
  );
  assert.equal(sourceHash(prepared.bytes), record.parent.recordHash);
  assert.equal(prepared.value.saveRequest.state, "prepared");
  assert.deepEqual({ ...prepared.value.saveRequest, state: "completed" }, save);
  assert.deepEqual(prepared.value.owner, record.owner);
  assert.ok(
    workflows.some(
      (entry) =>
        entry.data.retainedCandidateHandoff?.recordHash ===
        record.parent.recordHash,
    ),
  );
  const storeSession = (
    await json(
      path.join(
        project,
        ".workspace-history/sessions",
        record.owner.sessionId + ".json",
      ),
    )
  ).value;
  assert.ok(
    storeSession.retainedAbsCandidates.some(
      (item) =>
        item.turnId === record.owner.turnId &&
        item.reference.recordHash === ref.recordHash,
    ),
  );
  const oldBackup = previous.privateA;
  assert.ok(
    same(
      oldBackup.path,
      path.join(
        project,
        ".aily/abs-sync/recoveries",
        "candidate-" + oldBackup.recordHash.slice(7) + ".json",
      ),
    ),
  );
  const archive = await json(oldBackup.path);
  assert.equal(sourceHash(archive.bytes), oldBackup.recordHash);
  const sourceA = archive.value.candidate.source;
  assert.equal(sourceHash(sourceA), oldBackup.hash);
  assert.equal(oldBackup.hash, save.candidateHash);
  assertColdCandidateProof(archive.value, {
    project,
    source: sourceA,
    baseSource: exported.abs,
    generation: exported.generation,
  });
  assert.equal(record.editProof.hash, oldBackup.hash);
  assert.deepEqual(
    record.editProof.steps,
    archive.value.candidate.editProof.steps,
  );
  assert.equal(record.editProof.origin.baseAbsHash, sourceHash(exported.abs));
  assert.equal(
    record.editProof.origin.mapHash,
    archive.value.candidate.editProof.origin.mapHash,
  );
  const object = path.join(
    project,
    ".workspace-history/objects",
    record.candidateHash.slice(7, 9),
    record.candidateHash.slice(7) + ".blob",
  );
  const objectBytes = await fs.readFile(object);
  assert.equal(sourceHash(objectBytes), record.candidateHash);
  assert.equal(objectBytes.toString("utf8"), sourceA);
  assert.equal(record.editProof.steps.length, 1);
  assert.equal(record.editProof.steps[0].after, record.candidateHash);
  const baseline = previous.s0.document,
    first = baseline.pages[0].content.blocks.blocks.find(
      (block) => block.type === "arduino_global",
    ).inputs.ARDUINO_GLOBAL.block;
  const fixture = {
    blockType: first.type,
    blockId: first.id,
    cId: first.next.block.id,
    bId: first.next.block.next.block.id,
    boardPackage: boardRead.boardPackage,
    addedLibraryName: libraryTool.packageName,
  };
  assert.equal(first.fields.VALUE, 100);
  assert.equal(first.next.block.fields.VALUE, 200);
  assert.equal(first.next.block.next.block.fields.VALUE, 300);
  const expectedC = singleFieldExpectedDocument(
    baseline,
    fixture.cId,
    "VALUE",
    200,
    201,
  );
  assert.deepEqual(
    (await json(path.join(project, "project.abi"))).value,
    expectedC,
  );
  const pointer = (
    await json(path.join(project, ".aily/abs-sync/committed.json"))
  ).value;
  await assert.rejects(
    fs.stat(path.join(project, ".aily/abs-sync/prepared.json")),
    { code: "ENOENT" },
  );
  const committed = await json(
    path.join(
      project,
      ".aily/abs-sync/baselines",
      pointer.generation + ".json",
    ),
  );
  assert.equal(sourceHash(committed.bytes), pointer.hash);
  const mirrors = {};
  for (const [name, key] of [
    ["project.abi", "abi"],
    ["project.abs", "abs"],
    ["project.abs.map.json", "map"],
  ]) {
    mirrors[name] = sourceHash(await fs.readFile(path.join(project, name)));
    assert.equal(mirrors[name], record.hashes[key]);
  }
  mirrors[".aily/abs-sync/committed.json"] = sourceHash(
    await fs.readFile(path.join(project, ".aily/abs-sync/committed.json")),
  );
  const map = (await json(path.join(project, "project.abs.map.json"))).value;
  assert.equal(map.generation, pointer.generation);
  assert.equal(
    record.editProof.origin.acceptedMapHash,
    record.hashes.map.slice(7),
  );
  assert.equal(
    (await json(path.join(project, "package.json"))).value.projectConfig.R2Mode,
    "two",
  );
  const recoveries = path.join(project, ".aily/abs-sync/recoveries"),
    matching = [];
  for (const file of await fs.readdir(recoveries))
    if (file.startsWith("request-") && file.endsWith(".json")) {
      const value = (await json(path.join(recoveries, file))).value;
      if ((value.ref ?? value).request?.requestId === save.requestId)
        matching.push(value.ref ?? value);
    }
  assert.equal(matching.length, 1);
  const nativeRef = matching[0];
  assert.equal(nativeRef.request.version, 2);
  assert.equal(nativeRef.request.operation, "project_save");
  assert.equal(nativeRef.request.requestId, save.requestId);
  assert.equal(nativeRef.executor.hostPid, save.targetPid);
  assert.deepEqual(nativeRef.attachment, save.attachment);
  const projectKey = project
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  assert.equal(
    nativeRef.request.inputDigest,
    sourceHash(
      canonical({
        version: 2,
        project: projectKey,
        operation: "project_save",
        input: expectedInput,
      }),
    ),
  );
  const terminal = (
    await json(
      path.join(
        recoveries,
        "application-result-" + nativeRef.operationId + ".json",
      ),
    )
  ).value;
  for (const key of ["operationId", "request", "attachment", "executor"])
    assert.deepEqual(terminal.ref[key], nativeRef[key]);
  assert.equal(terminal.snapshotHash, nativeRef.snapshotHash);
  assert.ok(same(nativeRef.project, project));
  assert.equal(terminal.terminal, "committed");
  assert.equal(terminal.result.partial, false);
  assert.equal(terminal.result.publication.status, "COMMITTED");
  assert.equal(terminal.result.publication.generation, pointer.generation);
  const nativeEnvironment = previous.library.originalEnvironment.environment;
  assert.equal(nativeEnvironment.executor.hostPid, previous.hostPid);
  assert.equal(nativeEnvironment.requestId, libraryTool.originalRequestId);
  const canonicalLibrary = path.join(
      project,
      "local-libraries",
      ...fixture.addedLibraryName.split("/"),
    ),
    installedLibrary = path.join(
      project,
      "node_modules",
      ...fixture.addedLibraryName.split("/"),
    );
  assert.equal((await fs.lstat(installedLibrary)).isSymbolicLink(), true);
  assert.ok(same(await fs.realpath(installedLibrary), canonicalLibrary));
  const owned = nativeEnvironment.ownedPaths[0];
  assert.equal(owned.path, "local-libraries/" + fixture.addedLibraryName);
  assert.equal(
    captureDependencyEnvironmentTree(project, owned.path).hash,
    owned.hash,
  );
  const blockDefinitions = (
    await json(path.join(canonicalLibrary, "block.json"))
  ).value;
  fixture.addedBlockType = blockDefinitions[0].type;
  // Board configuration has its own actual environment operation. Its five
  // current file hashes, unlike the old library operation, include R2Mode two.
  const environmentMatches = [];
  for (const directory of await fs.readdir(
    path.join(project, ".aily/dependency-recovery"),
  )) {
    if (!directory.startsWith("environment-")) continue;
    const checkpoint = (
      await json(
        path.join(
          project,
          ".aily/dependency-recovery",
          directory,
          "checkpoint.json",
        ),
      )
    ).value;
    if (
      checkpoint.payload?.request?.programRef?.request?.requestId ===
      save.requestId
    )
      environmentMatches.push({ directory, checkpoint });
  }
  assert.equal(environmentMatches.length, 1);
  const envEntry = environmentMatches[0];
  assert.equal(
    envEntry.checkpoint.hash,
    sourceHash(JSON.stringify(envEntry.checkpoint.payload)),
  );
  for (const key of ["operationId", "request", "attachment", "executor"])
    assert.deepEqual(
      envEntry.checkpoint.payload.request.programRef[key],
      nativeRef[key],
    );
  const envDirectory = path.join(
      project,
      ".aily/dependency-recovery",
      envEntry.directory,
    ),
    envResult = (await json(path.join(envDirectory, "result.json"))).value;
  assert.equal(envResult.hash, sourceHash(JSON.stringify(envResult.payload)));
  assert.equal(envResult.payload.status, "completed");
  assert.equal(envResult.payload.candidateApplied, false);
  const environmentHashes = {};
  for (const [key, name] of Object.entries(dependencyEnvironmentFiles)) {
    let actual = null;
    try {
      actual = sourceHash(await fs.readFile(path.join(project, name)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.ok(Object.hasOwn(envResult.payload.after, name));
    const original = envResult.payload.after[name];
    assert.ok(original === null || typeof original === "string");
    assert.equal(original === null ? null : sourceHash(original), actual);
    environmentHashes[key] = actual;
  }
  const originalToolCallIds = chain
    .filter(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    )
    .flatMap((entry) => entry.message.content ?? [])
    .filter((part) => part.type === "toolCall")
    .map((part) => part.id);
  return {
    previous,
    suite,
    project,
    fixture,
    sessionId,
    sessionFile,
    sessionBytes,
    originalToolCallIds,
    generation: exported.generation,
    baseline,
    baseSource: exported.abs,
    sourceA,
    expectedC,
    backup: oldBackup,
    archiveBytes: archive.bytes,
    record,
    reference: ref,
    mirrors,
    environmentHashes,
    environmentRequestId: envResult.payload.requestId,
    boardRequestId: save.requestId,
    provenance: {
      originalResultFile: resultFile,
      originalResultHash: sourceHash(original.bytes),
      originalResultModified: false,
      originalHostHash: hostHash,
      originalArtifact: artifact,
      originalSuite: suite,
      originalSessionId: sessionId,
      originalSessionFile: sessionFile,
      originalSessionHash: sourceHash(sessionBytes),
      originalFailureSnapshotHash: sourceHash(originalFailure.bytes),
      originalPreparedEntryId: failurePrepared.id,
      originalPreparedReference: failurePrepared.data.retainedCandidateHandoff,
      originalLeafId: entries.at(-1).id,
      originalCompletedEntryId: completed.id,
      originalHandoff: ref,
      originalNativeRequestId: save.requestId,
      originalInput: save.input,
      originalAttachment: save.attachment,
      originalBackupHash: sourceHash(archive.bytes),
      mirrorsBeforeLaunch: mirrors,
      priorLibraryAndBoardReplayed: false,
      standalonePass: false,
    },
  };
}

/** UI-save-only continuation after actual ABC committed and the old test's
 * flattened-call assertion failed. This reads facts; it never executes tools. */
export async function loadEnvironmentSaveResume({
  resultFile,
  testRoot,
  artifact,
  hostHash,
}) {
  const tail = await json(resultFile),
    previous = tail.value,
    provenance = previous.resumedProvenance;
  assert.equal(previous.ok, false);
  assert.equal(previous.error?.code, "ERR_ASSERTION");
  assert.match(previous.error.message, /name: 'abs_apply'/);
  assert.equal(previous.uiSave, undefined);
  assert.equal(previous.hostHash, hostHash);
  assert.deepEqual(previous.artifact, artifact);
  assert.equal(previous.combinedSameSuite, true);
  assert.equal(previous.standalonePass, false);
  assert.equal(
    previous.phases.at(-1)?.name,
    "third-user-read-A-edit-B-apply-omitted-generation",
  );
  const original = await json(provenance.originalResultFile),
    raw = original.value;
  assert.equal(sourceHash(original.bytes), provenance.originalResultHash);
  assert.equal(raw.ok, false);
  assert.equal(raw.hostHash, hostHash);
  assert.deepEqual(raw.artifact, artifact);
  assert.equal(provenance.priorLibraryAndBoardReplayed, false);
  const suite = path.resolve(raw.suite),
    project = path.join(suite, "project"),
    sessionId = raw.startup.ready.sessionId;
  assert.ok(same(path.dirname(suite), testRoot));
  assert.ok(path.basename(suite).startsWith("r2-environment-"));
  assert.ok(same(previous.suite, suite) && same(previous.project, project));
  assert.equal(provenance.originalSessionId, sessionId);
  for (const directory of [
    suite,
    project,
    path.join(suite, "home"),
    path.join(suite, "appdata"),
    path.join(suite, "electron-profile"),
  ])
    await physical(directory);
  const before = await fs.lstat(project, { bigint: true }),
    fd = await fs.open(project, "r");
  try {
    const handle = await fd.stat({ bigint: true }),
      after = await fs.lstat(project, { bigint: true });
    for (const stat of [before, after]) {
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
      assert.equal(stat.ino, handle.ino);
      assert.equal(stat.birthtimeNs, handle.birthtimeNs);
      if (stat.dev !== 0n) assert.equal(stat.dev, handle.dev);
    }
    assert.deepEqual(provenance.originalAttachment.identity, {
      dev: String(handle.dev),
      ino: String(handle.ino),
      birthtimeNs: String(handle.birthtimeNs),
    });
    assert.ok(same(provenance.originalAttachment.root, project));
  } finally {
    await fd.close();
  }
  const snapshot = (
    await json(path.join(path.dirname(resultFile), "session-ABC.json"))
  ).value;
  assert.equal(snapshot.sessionId, sessionId);
  assert.ok(same(snapshot.cwd, project));
  assert.equal(snapshot.isIdle, true);
  assert.equal(snapshot.isStreaming, false);
  assert.equal(
    snapshot.messages.filter((message) => message.role === "user").length,
    3,
  );
  const calls = snapshot.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter(
      (part) => part.type === "toolCall" && part.id.startsWith("env-resume-"),
    );
  assert.deepEqual(
    calls.map((call) => call.id),
    ["env-resume-read-A", "env-resume-edit-B", "env-resume-apply-ABC"],
  );
  assertEnvironmentApplyCall(
    calls[2],
    project,
    path.join(project, "project.abs"),
  );
  const apply = previous.tools.find(
    (tool) => tool.id === "env-resume-apply-ABC",
  );
  assert.equal(apply.name, "abs_apply");
  assert.equal(apply.isError, false);
  const result = apply.result,
    binding = result.receipt.output.binding;
  assert.equal(result.ok, true);
  assert.equal(result.publication.status, "COMMITTED");
  assert.equal(result.applyVerification.ok, true);
  assert.equal(result.absPersistence.verified, true);
  assert.equal(result.requiresReload, false);
  assert.equal(result.receipt.validation.ok, true);
  assert.equal(result.receipt.validation.scope, "complete-generation");
  assert.equal(result.receipt.intentGeneration, raw.s0.generation);
  const first = raw.s0.document.pages[0].content.blocks.blocks.find(
    (block) => block.type === "arduino_global",
  ).inputs.ARDUINO_GLOBAL.block;
  const expected = singleFieldExpectedDocument(
    singleFieldExpectedDocument(
      singleFieldExpectedDocument(raw.s0.document, first.id, "VALUE", 100, 101),
      first.next.block.id,
      "VALUE",
      200,
      201,
    ),
    first.next.block.next.block.id,
    "VALUE",
    300,
    301,
  );
  assert.deepEqual(
    (await json(path.join(project, "project.abi"))).value,
    expected,
  );
  const mirrors = {};
  for (const [name, key] of [
    ["project.abi", "abiHash"],
    ["project.abs", "absHash"],
    ["project.abs.map.json", "mapHash"],
  ]) {
    mirrors[name] = sourceHash(await fs.readFile(path.join(project, name)));
    assert.equal(mirrors[name], binding[key]);
  }
  const map = (await json(path.join(project, "project.abs.map.json"))).value,
    pointerFile = await json(
      path.join(project, ".aily/abs-sync/committed.json"),
    ),
    pointer = pointerFile.value;
  assert.equal(pointer.generation, binding.generation);
  assert.equal(map.generation, binding.generation);
  assert.equal(map.baseAbsHash, binding.absHash);
  assert.equal(
    pointer.hash,
    sourceHash(
      (
        await json(
          path.join(
            project,
            ".aily/abs-sync/baselines",
            pointer.generation + ".json",
          ),
        )
      ).bytes,
    ),
  );
  mirrors[".aily/abs-sync/committed.json"] = sourceHash(pointerFile.bytes);
  await assert.rejects(
    fs.stat(path.join(project, ".aily/abs-sync/prepared.json")),
    { code: "ENOENT" },
  );
  const recovery = path.join(project, ".aily/abs-sync/recoveries"),
    indexes = [];
  for (const file of await fs.readdir(recovery))
    if (file.startsWith("request-") && file.endsWith(".json")) {
      const index = (await json(path.join(recovery, file))).value;
      if (index.requestId === result.receipt.requestId) indexes.push(index);
    }
  assert.equal(indexes.length, 1);
  const index = indexes[0],
    operation = (
      await json(path.join(project, ".aily/abs-sync/operation.json"))
    ).value;
  assert.equal(operation.id, index.operationId);
  assert.equal(operation.state, "completed");
  assert.equal(operation.hash, index.snapshotHash);
  const terminal = (
    await json(
      path.join(recovery, "application-result-" + index.operationId + ".json"),
    )
  ).value;
  assert.equal(terminal.operationId, index.operationId);
  assert.deepEqual(terminal.outcome.evidence.binding, binding);
  assert.equal(terminal.outcome.publication.status, "COMMITTED");
  assert.equal(terminal.outcome.requiresReload, false);
  const archive = await json(raw.privateA.path);
  assert.equal(sourceHash(archive.bytes), raw.privateA.recordHash);
  assertColdCandidateProof(archive.value, {
    project,
    source: archive.value.candidate.source,
    baseSource: raw.tools.find((tool) => tool.id === "env-export-s0").result
      .abs,
    generation: raw.s0.generation,
  });
  const handoff = await json(
    path.join(
      project,
      ".workspace-history/abs-candidate-handoffs",
      provenance.originalHandoff.recordHash.slice(7) + ".json",
    ),
  );
  assert.equal(
    sourceHash(handoff.bytes),
    provenance.originalHandoff.recordHash,
  );
  assert.equal(
    handoff.value.saveRequest.requestId,
    provenance.originalNativeRequestId,
  );
  assert.deepEqual(handoff.value.saveRequest.input, provenance.originalInput);
  assert.equal(handoff.value.intentGeneration, raw.s0.generation);
  const sessionFile = provenance.originalSessionFile,
    sessionBytes = await fs.readFile(sessionFile),
    lines = sessionBytes.toString("utf8").trimEnd().split("\n"),
    entries = lines.map((line) => JSON.parse(line));
  assert.equal(entries[0].id, sessionId);
  assert.ok(same(entries[0].cwd, project));
  const prefixIndex = entries.findIndex(
    (entry) => entry.id === provenance.originalLeafId,
  );
  assert.ok(prefixIndex > 0);
  assert.equal(
    sourceHash(lines.slice(0, prefixIndex + 1).join("\n") + "\n"),
    provenance.originalSessionHash,
  );
  const byId = new Map(entries.slice(1).map((entry) => [entry.id, entry])),
    chain = [];
  let leaf = entries.at(-1);
  while (leaf) {
    chain.unshift(leaf);
    leaf = leaf.parentId ? byId.get(leaf.parentId) : null;
  }
  assert.equal(
    chain.filter(
      (entry) => entry.type === "message" && entry.message.role === "user",
    ).length,
    3,
  );
  assert.ok(chain.some((entry) => entry.id === snapshot.leafId));
  const stored = chain.find(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolCallId === "env-resume-apply-ABC",
  );
  assert.ok(stored);
  const storedResult =
    stored.message.details?.result ??
    JSON.parse(
      stored.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  assert.deepEqual(storedResult.receipt, result.receipt);
  return {
    suite,
    project,
    sessionId,
    sessionFile,
    sessionBytes,
    expected,
    mirrors,
    binding,
    backup: raw.privateA,
    archiveBytes: archive.bytes,
    provenance: {
      original17ResultFile: provenance.originalResultFile,
      original17ResultHash: sourceHash(original.bytes),
      resume02ResultFile: resultFile,
      resume02ResultHash: sourceHash(tail.bytes),
      originalHostHash: hostHash,
      originalArtifact: artifact,
      originalSuite: suite,
      originalSessionId: sessionId,
      originalAttachment: provenance.originalAttachment,
      originalNativeBoardRequestId: provenance.originalNativeRequestId,
      originalBoardInput: provenance.originalInput,
      originalApplyRequestId: result.receipt.requestId,
      originalIntentGeneration: result.receipt.intentGeneration,
      originalAArchiveHash: sourceHash(archive.bytes),
      originalSessionHash: sourceHash(sessionBytes),
      originalLeafId: entries.at(-1).id,
      mirrorsBeforeLaunch: mirrors,
      previousABCCommitted: true,
      toolsReplayed: false,
      standalonePass: false,
    },
  };
}
