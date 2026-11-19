import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readOwnedSessionFile } from "./r2-owned-session-file.mjs";
import { assertBoardPreparedProof } from "./r2-board-prepared-proof.mjs";
import {
  assertUserStoppedAssistant,
  assertUserStopTerminalUi,
} from "./abs-stop-presentation.mjs";
import { assertColdCandidateProof } from "./abs-cold-continuity.mjs";
import {
  boardMainIdentity,
  boardStorageIdentity,
  assertBoardResumeProcesses,
} from "./r2-board-processes.mjs";

const hash = (value) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
export function assertBoardResumeEvidence(previous, { artifact, hostHash }) {
  assert.equal(previous.ok, false);
  assert.match(
    previous.error?.message ?? "",
    /^Owned host descendants remain;/,
  );
  assert.deepEqual(previous.artifact, artifact);
  assert.equal(previous.hostHash, hostHash);
  assert.equal(previous.realInstalledChat, true);
  assert.equal(previous.realAsarHost, true);
  assert.equal(previous.manualSessionRestore, false);
  assert.equal(previous.manualProofBinding, false);
  assert.equal(previous.modelSuppliedGeneration, false);
  assert.equal(previous.launches.length, 1);
  assert.equal(previous.launches[0].attempt, 0);
  assert.equal(previous.firstTurnStop.stopReason, "aborted");
  assert.equal(previous.firstTurnStop.stopEntryAncestorVerified, true);
  assert.equal(previous.firstTurnStop.source, "user");
  assert.equal(previous.firstTurnStop.reason, "user_stop");
  assertUserStopTerminalUi(previous.firstTurnStopUi);
  assert.equal(previous.abortCommands.length, 1);
  assert.equal(
    previous.abortCommands[0].sessionId,
    previous.preDispatchCheckpoint.sessionId,
  );
  assert.equal(
    previous.firstTurnStop.rawAbortRequestEntry.data.sessionId,
    previous.preDispatchCheckpoint.sessionId,
  );
  assert.ok(
    previous.abortResponses.some(
      (value) => value.ok === true && value.accepted === true,
    ),
  );
  const fault = previous.finalInitialFault;
  assert.ok(fault.drops >= 1);
  assert.deepEqual(fault.failures, []);
  assert.deepEqual(fault.unverifiedTerminalReplies, []);
  assert.equal(
    fault.commands.filter((value) => value.operation === "set_board_config")
      .length,
    1,
  );
  assert.ok(
    fault.commands.every((value) => value.requestId === fault.requestId),
  );
  const request = previous.preDispatchCheckpoint.saveRequest;
  assert.deepEqual(
    previous.beforeStop.pending.retainedCandidateHandoff,
    previous.preDispatchCheckpoint.reference,
  );
  assert.equal(request.requestId, fault.requestId);
  assert.equal(request.state, "prepared");
  assert.equal(request.targetPid, previous.launches[0].hostPid);
  assert.deepEqual(request.input, {
    kind: "board-config",
    configKey: "R2Mode",
    configValue: "two",
  });
  assert.ok(fault.terminals.length);
  assert.ok(
    fault.terminals.every(
      (value) =>
        value.requestId === request.requestId &&
        value.completeGuiCVerified === true,
    ),
  );
  const uncertain = previous.tools.find(
    (value) => value.id === "uncertain-original-board",
  );
  assert.equal(uncertain.isError, true);
  assert.equal(uncertain.result.saveOutcome, "unknown");
  assert.equal(uncertain.result.observation.reason, "transport");
  assert.equal(uncertain.result.observation.resultKnown, false);
  assert.equal(uncertain.result.observation.operationCancelled, false);
  return request;
}

/** One stopped, committed original board operation only. No session open,
 * metadata repair, new candidate, project clone, publication or tool execution. */
export async function loadBoardColdResume({
  resultFile,
  testRoot,
  artifact,
  hostHash,
  executable,
  installedRoot,
  priorAttemptFile,
  previousInstalledRoot,
  sourceReadyFile,
  capturePublicationAttachment,
  processes,
  collectorPids = [],
}) {
  assert.ok(path.isAbsolute(resultFile));
  const originalBytes = await fs.readFile(resultFile),
    previous = JSON.parse(originalBytes);
  let priorAttempt, priorAttemptBytes, upgrade;
  if (priorAttemptFile) {
    assert.ok(
      path.isAbsolute(priorAttemptFile) &&
        path.isAbsolute(previousInstalledRoot) &&
        path.isAbsolute(sourceReadyFile),
    );
    priorAttemptBytes = await fs.readFile(priorAttemptFile);
    priorAttempt = JSON.parse(priorAttemptBytes);
    assert.equal(priorAttempt.ok, false);
    assert.match(
      priorAttempt.error?.message ?? "",
      /Local deterministic provider setup failed:[\s\S]*'prepared'[\s\S]*'completed'/,
    );
    assert.equal(
      priorAttempt.resumedProvenance.originalResultHash,
      hash(originalBytes),
    );
    assert.ok(
      same(priorAttempt.resumedProvenance.originalResultFile, resultFile),
    );
    assert.deepEqual(priorAttempt.artifact, previous.artifact);
    assert.equal(priorAttempt.hostHash, hostHash);
    assert.ok(
      same(priorAttempt.project, previous.project) &&
        same(priorAttempt.suite, previous.suite),
    );
    assert.equal(priorAttempt.tools.length, 0);
    assert.equal(priorAttempt.launches.length, 1);
    assert.equal(priorAttempt.launches[0].attempt, 1);
    assert.equal(
      priorAttempt.launches[0].originalSessionOpen.registryReady,
      true,
    );
    assert.equal(
      priorAttempt.launches[0].originalSessionOpen.command.sessionId,
      previous.preDispatchCheckpoint.sessionId,
    );
    assert.deepEqual(priorAttempt.abortCommands, []);
    assert.ok(
      !processes.some((p) => p.ProcessId === priorAttempt.launches[0].hostPid),
      "The exact previous test observer must no longer be running",
    );
    assert.ok(
      same(previousInstalledRoot, previous.launches[0].chat.installedRoot),
      "Use the exact sealed root recorded by the original actual launch",
    );
    const oldSeal = JSON.parse(
      await fs.readFile(
        path.join(previousInstalledRoot, "runtime/build-evidence.json"),
      ),
    );
    const nextSeal = JSON.parse(
      await fs.readFile(
        path.join(installedRoot, "runtime/build-evidence.json"),
      ),
    );
    const sourceReady = JSON.parse(await fs.readFile(sourceReadyFile));
    assert.equal(sourceReady.productionFrozen, true);
    assert.equal(sourceReady.source.pass, 9);
    assert.equal(sourceReady.typecheckExit, 0);
    assert.equal(oldSeal.inputHash, previous.artifact.inputHash);
    assert.equal(oldSeal.outputHash, previous.artifact.outputHash);
    assert.equal(nextSeal.inputHash, artifact.inputHash);
    assert.equal(nextSeal.outputHash, artifact.outputHash);
    const expected = sourceReady.files
      .filter((f) => f.path.startsWith("src/"))
      .map((f) => "packages/aily-agent/" + f.path)
      .sort();
    assert.deepEqual(
      expected,
      [
        "packages/aily-agent/src/extensions/pi-workspace-history/overlay-controller.ts",
        "packages/aily-agent/src/extensions/pi-workspace-history/program-draft.ts",
        "packages/aily-agent/src/extensions/pi-workspace-history/record-types.ts",
      ].sort(),
    );
    assert.deepEqual(
      Object.keys(oldSeal.inputs).sort(),
      Object.keys(nextSeal.inputs).sort(),
    );
    assert.deepEqual(
      Object.keys(oldSeal.inputs)
        .filter((k) => oldSeal.inputs[k] !== nextSeal.inputs[k])
        .sort(),
      expected,
    );
    for (const f of sourceReady.files.filter((f) => f.path.startsWith("src/")))
      assert.equal(nextSeal.inputs["packages/aily-agent/" + f.path], f.sha256);
    upgrade = {
      from: {
        root: previousInstalledRoot,
        inputHash: oldSeal.inputHash,
        outputHash: oldSeal.outputHash,
      },
      to: {
        root: installedRoot,
        inputHash: nextSeal.inputHash,
        outputHash: nextSeal.outputHash,
      },
      sourceDelta: expected,
      sourceReadyHash: hash(await fs.readFile(sourceReadyFile)),
    };
  } else assert.deepEqual(previous.artifact, artifact);
  const request = assertBoardResumeEvidence(previous, {
    artifact: previous.artifact,
    hostHash,
  });
  const suite = path.resolve(previous.suite),
    project = path.join(suite, "project"),
    home = path.join(suite, "home");
  assert.ok(same(path.dirname(suite), testRoot));
  assert.ok(path.basename(suite).startsWith("r2-board-cold-"));
  assert.ok(same(previous.project, project));
  const attachment = capturePublicationAttachment(project);
  assert.deepEqual(attachment, request.attachment);
  const { sessionFile, bytes: sessionBytes } = await readOwnedSessionFile({
    suite,
    project,
    home,
    sessionId: previous.preDispatchCheckpoint.sessionId,
  });
  assert.ok(same(sessionFile, previous.preDispatchCheckpoint.sessionFile));
  const entries = sessionBytes
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const byId = new Map(entries.slice(1).map((entry) => [entry.id, entry])),
    chain = [];
  let leaf = entries.at(-1);
  while (leaf) {
    assert.ok(!chain.some((value) => value.id === leaf.id));
    chain.unshift(leaf);
    leaf = byId.get(leaf.parentId);
  }
  const snapshot = {
    sessionId: previous.preDispatchCheckpoint.sessionId,
    entries: chain,
    messages: chain
      .filter((value) => value.type === "message")
      .map((value) => value.message),
  };
  const stopEntries = priorAttempt
    ? chain.slice(
        0,
        chain.findIndex(
          (e) => e.id === priorAttempt.resumedProvenance.originalLeafId,
        ) + 1,
      )
    : chain;
  assert.ok(stopEntries.length);
  const stopped = assertUserStoppedAssistant({
    ...snapshot,
    entries: stopEntries,
    messages: stopEntries
      .filter((e) => e.type === "message")
      .map((e) => e.message),
  });
  assert.equal(stopped.entryId, previous.firstTurnStop.entryId);
  assert.equal(
    stopped.abortRequestEntryId,
    previous.firstTurnStop.abortRequestEntryId,
  );
  assert.equal(
    snapshot.messages.filter((value) => value.role === "user").length,
    priorAttempt ? 2 : 1,
  );
  if (priorAttempt) {
    const terminal = snapshot.messages.findLast((m) => m.role === "assistant");
    assert.equal(terminal.stopReason, "error");
    assert.equal(
      terminal.errorMessage,
      "Aily chat returned 409 [local_stop_model_contract_failed] Request conflict.",
    );
    const failed = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(priorAttemptFile), "failure-session.json"),
      ),
    );
    assert.deepEqual(
      terminal,
      failed.messages.findLast((m) => m.role === "assistant"),
    );
    assert.ok(chain.some((e) => e.id === failed.entries.at(-1).id));
  }
  const calls = snapshot.messages
    .filter((value) => value.role === "assistant")
    .flatMap((value) => value.content ?? [])
    .filter((value) => value.type === "toolCall");
  const actualName = (value) =>
    value.name === "tool_invoke" ? value.arguments.name : value.name;
  assert.equal(
    calls.filter((value) => actualName(value) === "set_board_config").length,
    1,
  );
  assert.equal(
    calls.filter((value) => actualName(value) === "abs_apply").length,
    0,
  );
  const pending = chain.findLast(
    (entry) => entry.customType === "aily.abs-workflow",
  )?.data;
  assert.equal(pending.status, "blocked");
  assert.equal(pending.intentGeneration, previous.g0.generation);
  assert.deepEqual(
    pending.retainedCandidateHandoff,
    previous.beforeStop.pending.retainedCandidateHandoff,
  );
  assert.equal(pending.applicationRequestId, undefined);
  const exported = previous.tools.find(
    (value) => value.id === "export-g0",
  ).result;
  const baseline = previous.g0.document;
  const first = baseline.pages[0].content.blocks.blocks.find(
    (value) => value.type === "arduino_global",
  ).inputs.ARDUINO_GLOBAL.block;
  const fixture = {
    blockType: first.type,
    blockId: first.id,
    cId: first.next.block.id,
    bId: first.next.block.next.block.id,
  };
  const baseSource = exported.abs,
    sourceA = baseSource.replace(
      `${fixture.blockType}(100)`,
      `${fixture.blockType}(101)`,
    );
  assert.notEqual(sourceA, baseSource);
  const reference = pending.retainedCandidateHandoff;
  const handoffPath = path.join(
    project,
    ".workspace-history/abs-candidate-handoffs",
    reference.recordHash.slice(7) + ".json",
  );
  const handoffBytes = await fs.readFile(handoffPath);
  assertBoardPreparedProof({
    bytes: handoffBytes,
    reference,
    project,
    generation: previous.g0.generation,
    baseSource,
    source: sourceA,
    mirrors: previous.g0.mirrors,
    requestId: request.requestId,
    input: request.input,
    targetPid: request.targetPid,
    attachment,
  });
  const record = JSON.parse(handoffBytes);
  assert.deepEqual(record.owner, previous.preDispatchCheckpoint.owner);
  const backup = pending.retainedCandidateBackup;
  const archivePath = path.join(
    project,
    ".aily/abs-sync/recoveries/candidate-" +
      backup.recordHash.slice(7) +
      ".json",
  );
  assert.ok(same(backup.path, archivePath));
  const archiveBytes = await fs.readFile(archivePath);
  assert.equal(hash(archiveBytes), backup.recordHash);
  assertColdCandidateProof(JSON.parse(archiveBytes), {
    project,
    source: sourceA,
    baseSource,
    generation: previous.g0.generation,
  });
  const expectedSaved = previous.guiC.document;
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(project, "project.abi"), "utf8")),
    expectedSaved,
  );
  for (const [name, expected] of Object.entries(previous.beforeStop.mirrors))
    assert.equal(hash(await fs.readFile(path.join(project, name))), expected);
  const pointerBytes = await fs.readFile(
      path.join(project, ".aily/abs-sync/committed.json"),
    ),
    pointer = JSON.parse(pointerBytes);
  assert.equal(pointer.generation, previous.beforeStop.binding.generation);
  assert.equal(
    hash(pointerBytes),
    previous.finalInitialFault.terminals.at(-1).committedHash,
  );
  assert.equal(
    pointer.hash,
    hash(
      await fs.readFile(
        path.join(
          project,
          ".aily/abs-sync/baselines",
          pointer.generation + ".json",
        ),
      ),
    ),
  );
  const originalExecutor = previous.finalInitialFault.terminals.find(
    (value) => value.originalExecutor?.storagePid === request.targetPid,
  )?.originalExecutor;
  assert.ok(
    originalExecutor,
    "The actual Main actor, not a separate storage executor, identifies the killed process",
  );
  assert.equal(originalExecutor.hostPid, request.targetPid);
  const originalMain = boardMainIdentity(originalExecutor, executable);
  const seal = JSON.parse(
    await fs.readFile(
      path.join(installedRoot, "runtime/build-evidence.json"),
      "utf8",
    ),
  );
  assert.equal(seal.inputHash, artifact.inputHash);
  assert.equal(seal.outputHash, artifact.outputHash);
  const nodeExecutable = path.join(
    path.dirname(executable),
    "resources/child/node/node.exe",
  );
  assert.ok((await fs.lstat(nodeExecutable)).isFile());
  const nodeExecutables = [nodeExecutable];
  const originalStorage = boardStorageIdentity(
    previous.finalInitialFault.terminals.at(-1).originalExecutor,
    nodeExecutable,
  );
  const processAudit = assertBoardResumeProcesses(processes, {
    originalMain,
    originalStorage,
    installedRoot,
    nodeExecutables,
    collectorPids,
  });
  return {
    previous,
    priorAttempt,
    upgrade,
    continuationUserTurn: priorAttempt ? 3 : 2,
    suite,
    project,
    home,
    fixture,
    sessionId: snapshot.sessionId,
    generation: previous.g0.generation,
    baseline,
    baseSource,
    sourceA,
    expectedSaved,
    requestId: request.requestId,
    originalHostPid: request.targetPid,
    backup,
    archiveBytes,
    processAudit,
    originalCallIds: calls.map((value) => value.id),
    provenance: {
      originalResultFile: resultFile,
      originalResultHash: hash(originalBytes),
      originalResultModified: false,
      originalHostHash: hostHash,
      originalArtifact: previous.artifact,
      continuationArtifact: artifact,
      originalRuntimeNode: {
        path: nodeExecutable,
        hash: hash(await fs.readFile(nodeExecutable)),
      },
      originalSuite: suite,
      originalSessionId: snapshot.sessionId,
      originalSessionFile: sessionFile,
      originalSessionHash: hash(sessionBytes),
      originalLeafId: entries.at(-1).id,
      originalReference: reference,
      originalRequestId: request.requestId,
      originalInput: request.input,
      originalAttachment: attachment,
      originalIntentGeneration: previous.g0.generation,
      originalAArchiveHash: hash(archiveBytes),
      priorStopVerified: true,
      initialToolsReplayed: false,
      standalonePass: false,
      ...(priorAttempt
        ? {
            priorAttemptFile,
            priorAttemptHash: hash(priorAttemptBytes),
            priorAttemptPreserved: true,
            priorAttemptTerminal: "error",
            priorAttemptToolsReplayed: false,
            original05LeafId: priorAttempt.resumedProvenance.originalLeafId,
            original05SessionPrefixHash:
              priorAttempt.resumedProvenance.originalSessionHash,
            continuationUserTurn: 3,
            upgrade,
            priorAttemptObserverPid: priorAttempt.launches[0].hostPid,
          }
        : {}),
    },
  };
}

/** Current persisted branch evidence, never a cached UI snapshot or a worker call. */
export async function readCurrentBoardColdHandoff({
  suite,
  project,
  home,
  sessionId,
  expectedUserTurns,
  previousLeafId,
  generation,
  requestId,
  input,
  candidateHash,
  binding,
  originalReference,
}) {
  const { bytes } = await readOwnedSessionFile({
    suite,
    project,
    home,
    sessionId,
  });
  const entries = bytes
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  const byId = new Map(entries.slice(1).map((e) => [e.id, e])),
    branch = [];
  let cursor = entries.at(-1);
  while (cursor) {
    assert.ok(!branch.some((e) => e.id === cursor.id));
    branch.unshift(cursor);
    cursor = byId.get(cursor.parentId);
  }
  assert.ok(branch.some((e) => e.id === previousLeafId));
  assert.equal(
    branch.filter((e) => e.type === "message" && e.message.role === "user")
      .length,
    expectedUserTurns,
  );
  const workflow = branch.findLast((e) => e.customType === "aily.abs-workflow");
  assert.equal(workflow.data.status, "blocked");
  assert.equal(workflow.data.intentGeneration, generation);
  assert.equal(workflow.data.retainedCandidate.hash, candidateHash);
  const reference = workflow.data.retainedCandidateHandoff;
  const raw = await fs.readFile(
    path.join(
      project,
      ".workspace-history/abs-candidate-handoffs",
      reference.recordHash.slice(7) + ".json",
    ),
  );
  assert.equal(hash(raw), reference.recordHash);
  const record = JSON.parse(raw);
  assert.ok(same(record.workspaceRoot, project));
  assert.deepEqual(record.parent, originalReference);
  assert.equal(record.saveRequest.version, 2);
  assert.equal(record.saveRequest.operation, "project_save");
  assert.equal(record.saveRequest.requestId, requestId);
  assert.equal(record.saveRequest.state, "completed");
  const originalBytes = await fs.readFile(
    path.join(
      project,
      ".workspace-history/abs-candidate-handoffs",
      originalReference.recordHash.slice(7) + ".json",
    ),
  );
  assert.equal(hash(originalBytes), originalReference.recordHash);
  const original = JSON.parse(originalBytes);
  assert.deepEqual(record.owner, original.owner);
  assert.deepEqual(record.saveRequest, {
    ...original.saveRequest,
    state: "completed",
  });
  assert.deepEqual(record.editProof, {
    ...original.editProof,
    origin: {
      ...original.editProof.origin,
      acceptedMapHash: binding.mapHash.slice(7),
    },
  });
  assert.deepEqual(record.saveRequest.input, input);
  assert.equal(record.candidateHash, candidateHash);
  assert.equal(record.intentGeneration, generation);
  assert.equal(record.editProof.origin.generation, generation);
  assert.equal(
    record.editProof.origin.acceptedMapHash,
    binding.mapHash.slice(7),
  );
  for (const [key, name] of [
    ["abi", "abiHash"],
    ["abs", "absHash"],
    ["map", "mapHash"],
  ])
    assert.equal(record.hashes[key], binding[name]);
  assert.equal(record.editProof.steps.length, 1);
  return {
    reference,
    record,
    workflowEntryId: workflow.id,
    jsonlHash: hash(bytes),
    leafId: entries.at(-1).id,
  };
}
